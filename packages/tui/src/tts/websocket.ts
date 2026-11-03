import { createHash, randomBytes } from "crypto"

// A minimal RFC 6455 client, because Bun's WebSocket ignores the `unix` option
// and dials TCP instead — verified by a server that never saw the connection.
// Only what the Super TTS stream protocol uses is implemented: text frames in
// both directions, plus the ping/close housekeeping a well-behaved peer owes.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

export type Socket = {
  send: (text: string) => void
  close: () => void
  readonly closed: boolean
}

export type Handlers = {
  onMessage: (text: string) => void
  onClose?: (reason?: string) => void
  onError?: (error: Error) => void
}

export class WebSocketError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "WebSocketError"
    this.status = status
  }
}

/**
 * Open a WebSocket to `endpoint` over a Unix domain socket and complete the
 * handshake before resolving, so a caller that gets a session can send on it.
 */
export async function open(input: {
  unix: string
  endpoint: string
  host?: string
  headers?: Record<string, string>
  handlers: Handlers
}): Promise<Socket> {
  const key = randomBytes(16).toString("base64")
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64")

  let buffer = new Uint8Array(0)
  let upgraded = false
  let closed = false
  let settle: ((error?: Error) => void) | undefined

  const fragments: Uint8Array[] = []
  let fragmentOpcode = 0

  const connection = await Bun.connect({
    unix: input.unix,
    socket: {
      data(socket, chunk) {
        buffer = concat(buffer, chunk)
        if (!upgraded) {
          const end = indexOfHeaderEnd(buffer)
          if (end === -1) return
          const head = new TextDecoder().decode(buffer.subarray(0, end))
          buffer = buffer.subarray(end + 4)
          const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1])
          if (status !== 101) {
            settle?.(new WebSocketError(`upgrade refused (${status || "no status"})`, status || undefined))
            socket.end()
            return
          }
          if (!new RegExp(`sec-websocket-accept:\\s*${escape(accept)}`, "i").test(head)) {
            settle?.(new WebSocketError("handshake key mismatch"))
            socket.end()
            return
          }
          upgraded = true
          settle?.()
        }

        while (true) {
          const frame = decode(buffer)
          if (!frame) break
          buffer = buffer.subarray(frame.size)

          if (frame.opcode === OPCODE.ping) {
            socket.write(encode(OPCODE.pong, frame.payload))
            continue
          }
          if (frame.opcode === OPCODE.pong) continue
          if (frame.opcode === OPCODE.close) {
            closed = true
            socket.end()
            input.handlers.onClose?.()
            return
          }

          // Text can arrive fragmented; hold the pieces until FIN.
          if (frame.opcode === OPCODE.continuation) fragments.push(frame.payload)
          else {
            fragments.length = 0
            fragments.push(frame.payload)
            fragmentOpcode = frame.opcode
          }
          if (!frame.fin) continue

          const payload = concatAll(fragments)
          fragments.length = 0
          if (fragmentOpcode === OPCODE.text) input.handlers.onMessage(new TextDecoder().decode(payload))
        }
      },
      close() {
        if (closed) return
        closed = true
        if (!upgraded) settle?.(new WebSocketError("connection closed during handshake"))
        input.handlers.onClose?.()
      },
      error(_socket, error) {
        if (!upgraded) settle?.(error)
        else input.handlers.onError?.(error)
      },
    },
  }).catch((error: Error) => {
    throw new WebSocketError(`cannot reach the daemon socket: ${error.message}`)
  })

  const handshake = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      settle = undefined
      if (error) reject(error)
      else resolve()
    }
  })

  connection.write(
    [
      `GET ${input.endpoint} HTTP/1.1`,
      `Host: ${input.host ?? "localhost"}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  )

  await handshake

  return {
    send(text) {
      if (closed) return
      connection.write(encode(OPCODE.text, new TextEncoder().encode(text)))
    },
    close() {
      if (closed) return
      closed = true
      connection.write(encode(OPCODE.close, new Uint8Array(0)))
      connection.end()
    },
    get closed() {
      return closed
    },
  }
}

// Client frames must be masked; the mask is XORed over the payload.
function encode(opcode: number, payload: Uint8Array) {
  const mask = randomBytes(4)
  const length = payload.length
  const header = length < 126 ? 2 : length < 65536 ? 4 : 10
  const frame = new Uint8Array(header + 4 + length)
  frame[0] = 0x80 | opcode
  if (length < 126) frame[1] = 0x80 | length
  else if (length < 65536) {
    frame[1] = 0x80 | 126
    new DataView(frame.buffer).setUint16(2, length)
  } else {
    frame[1] = 0x80 | 127
    new DataView(frame.buffer).setBigUint64(2, BigInt(length))
  }
  frame.set(mask, header)
  for (let index = 0; index < length; index++) frame[header + 4 + index] = payload[index]! ^ mask[index % 4]!
  return frame
}

function decode(buffer: Uint8Array) {
  if (buffer.length < 2) return undefined
  const fin = (buffer[0]! & 0x80) !== 0
  const opcode = buffer[0]! & 0x0f
  const masked = (buffer[1]! & 0x80) !== 0
  const indicator = buffer[1]! & 0x7f

  let offset = 2
  let length = indicator
  if (indicator === 126) {
    if (buffer.length < 4) return undefined
    length = new DataView(buffer.buffer, buffer.byteOffset).getUint16(2)
    offset = 4
  } else if (indicator === 127) {
    if (buffer.length < 10) return undefined
    length = Number(new DataView(buffer.buffer, buffer.byteOffset).getBigUint64(2))
    offset = 10
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
  if (masked) offset += 4
  if (buffer.length < offset + length) return undefined

  const payload = buffer.slice(offset, offset + length)
  if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]!
  return { fin, opcode, payload, size: offset + length }
}

function indexOfHeaderEnd(buffer: Uint8Array) {
  for (let index = 3; index < buffer.length; index++) {
    if (buffer[index - 3] === 13 && buffer[index - 2] === 10 && buffer[index - 1] === 13 && buffer[index] === 10)
      return index - 3
  }
  return -1
}

function concat(left: Uint8Array, right: Uint8Array) {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function concatAll(chunks: Uint8Array[]) {
  if (chunks.length === 1) return chunks[0]!
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  chunks.reduce((offset, chunk) => {
    result.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return result
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
