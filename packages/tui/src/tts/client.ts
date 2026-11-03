import path from "path"
import { open as openSocket, WebSocketError } from "./websocket"

// Client for the Super TTS daemon protocol: HTTP/1.1 + JSON over a Unix domain
// socket, with a WebSocket for speaking text as it is generated. Every route is
// served under the /v1 prefix.
// See ../../../../../super-tts/docs/protocol/ for the wire reference.

export const SCOPES = ["speak", "status", "playback_events"]

export const APP_NAME = "opencode"

const PREFIX = "/v1"

export type Session = {
  token: string
  scopes: string[]
  expires?: string
}

/** A `speaking_state` frame: whether the speakers are busy, and with whose utterance. */
export type Speaking = {
  speaking: boolean
  utterance?: string
}

export type Status = {
  device: string
  model_loaded: boolean
  current_model?: string
  busy: boolean
}

export class TtsError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "TtsError"
    this.code = code
    this.status = status
  }
}

export function socketPath() {
  if (process.env.SUPER_TTS_HTTP_SOCKET) return process.env.SUPER_TTS_HTTP_SOCKET
  if (!process.env.XDG_RUNTIME_DIR) return undefined
  return path.join(process.env.XDG_RUNTIME_DIR, "tts", "super-tts-http.sock")
}

/**
 * Whether the daemon is taking connections. The socket file is no answer: a
 * daemon that crashed leaves it behind. Connects and hangs up without a
 * request, because every request counts toward the daemon's per-client quota
 * and interactive mode asks this every few seconds.
 */
export async function available(socket: string) {
  return Bun.connect({ unix: socket, socket: { data() {} } }).then(
    (connection) => {
      connection.end()
      return true
    },
    () => false,
  )
}

function url(endpoint: string) {
  return `http://tts.local${PREFIX}${endpoint}`
}

async function fail(response: Response) {
  const body = (await response.json().catch(() => undefined)) as
    | { error_code?: string; message?: string; data?: { reason?: string } }
    | undefined
  const code = body?.error_code ?? body?.message ?? `http_${response.status}`
  const reason = body?.data?.reason
  return new TtsError(body?.message ?? `request failed (${response.status})`, reason ?? code, response.status)
}

async function send(
  socket: string,
  method: string,
  endpoint: string,
  options?: { token?: string; body?: unknown; accept?: string; signal?: AbortSignal },
) {
  const response = await fetch(url(endpoint), {
    unix: socket,
    method,
    signal: options?.signal,
    headers: {
      ...(options?.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options?.accept ? { Accept: options.accept } : {}),
      ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).catch((error) => {
    throw new TtsError(`cannot reach the Super TTS daemon: ${error.message}`, "daemon_unreachable", 0)
  })
  if (!response.ok) throw await fail(response)
  return response
}

export async function authorize(socket: string, version: string): Promise<Session> {
  const response = await send(socket, "POST", "/auth/request", {
    body: { app_name: APP_NAME, scopes: SCOPES, version },
  })
  const body = (await response.json()) as { session_token: string; scopes?: string[]; expires_at?: string }
  return { token: body.session_token, scopes: body.scopes ?? SCOPES, expires: body.expires_at }
}

/**
 * Whether a stored session still covers what this build asks for. A token minted
 * by an older build carries the scopes of its day, and the endpoints added since
 * would fail with `scope_denied` rather than anything the user could act on.
 */
export function satisfies(session: Session) {
  return SCOPES.every((scope) => session.scopes.includes(scope))
}

export async function valid(socket: string, token: string) {
  const response = await fetch(url("/auth/status"), {
    unix: socket,
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined)
  return response?.ok === true
}

export async function status(socket: string, token: string) {
  const response = await send(socket, "GET", "/status", { token })
  return (await response.json()) as Status
}

/** Speak complete text. Newest wins: this interrupts whatever is playing. */
export async function speak(socket: string, token: string, text: string) {
  const response = await send(socket, "POST", "/speak", { token, body: { text } })
  return ((await response.json()) as { utterance_id?: string }).utterance_id
}

/** Stop the current utterance and drop what is queued. Idempotent. */
export async function silence(socket: string, token: string) {
  await send(socket, "POST", "/speak/stop", { token })
}

export type Stream = {
  /** Append generated text. Partial words and split markup are fine — the daemon holds an ambiguous tail. */
  text: (delta: string) => void
  /** No more text is coming; play out what remains. */
  end: () => void
  /** Stop now and drop queued audio. */
  cancel: () => void
  readonly closed: boolean
}

/**
 * Speak text as it is generated. The daemon synthesizes each sentence as it
 * completes, so speech starts while the model is still writing. Resolves once
 * the session is open and `start` has been accepted.
 */
export async function stream(
  socket: string,
  token: string,
  options: {
    /** The daemon's id for this utterance, as soon as it names one. */
    onUtterance?: (id: string) => void
    onProgress?: (spokenMs: number, queuedMs: number) => void
    onDone?: () => void
    onError?: (message: string) => void
  } = {},
): Promise<Stream> {
  const connection = await openSocket({
    unix: socket,
    endpoint: `${PREFIX}/speak/stream`,
    host: "tts.local",
    headers: { Authorization: `Bearer ${token}` },
    handlers: {
      onMessage: (raw) => {
        const frame = parse(raw)
        if (frame?.type === "utterance" && frame.id) options.onUtterance?.(frame.id)
        if (frame?.type === "progress") options.onProgress?.(frame.spoken_ms ?? 0, frame.queued_ms ?? 0)
        if (frame?.type === "done") options.onDone?.()
        if (frame?.type === "error") options.onError?.(frame.message ?? "synthesis failed")
      },
      onClose: () => options.onDone?.(),
      onError: (error) => options.onError?.(error.message),
    },
  }).catch((error) => {
    if (error instanceof WebSocketError && error.status === 401)
      throw new TtsError("session rejected", "invalid_session", 401)
    if (error instanceof WebSocketError && error.status === 503)
      throw new TtsError("too many speak sessions", "speak_sessions_busy", 503)
    throw new TtsError(
      error instanceof Error ? error.message : "could not open the speak stream",
      "stream_failed",
      error instanceof WebSocketError && error.status ? error.status : 0,
    )
  })

  // The first frame must be `start`. It carries nothing: `voice`, `language`,
  // `speed` and `instructions` each override something the user configured in
  // Super TTS, so each needs the `settings` scope, and a session that names one
  // without it is closed rather than quietly given the configured value.
  connection.send(JSON.stringify({ type: "start" }))

  return {
    text: (delta) => {
      if (!delta || connection.closed) return
      connection.send(JSON.stringify({ type: "text", delta }))
    },
    end: () => {
      if (connection.closed) return
      connection.send(JSON.stringify({ type: "end" }))
    },
    cancel: () => {
      if (connection.closed) return
      connection.send(JSON.stringify({ type: "cancel" }))
      connection.close()
    },
    get closed() {
      return connection.closed
    },
  }
}

function parse(raw: string) {
  try {
    return JSON.parse(raw) as {
      type?: string
      id?: string
      message?: string
      spoken_ms?: number
      queued_ms?: number
    }
  } catch {
    return undefined
  }
}

/**
 * Follow the speakers until `signal` aborts.
 *
 * This is the only thing that knows when an utterance has actually been heard.
 * The streaming session's `done` frame means every sample is *queued*: a local
 * backend synthesizes several times faster than realtime, so it arrives while
 * most of the reply is still buffered ahead of the speakers, and for a short
 * reply before a single word has played. The daemon holds the utterance open
 * for the whole playout and publishes the stop here at the end of it.
 *
 * The events describe the *device*, not our requests — another app's utterance
 * raises them too — so callers match `utterance` against their own id.
 */
export async function* speaking(socket: string, token: string, signal?: AbortSignal): AsyncGenerator<Speaking> {
  const response = await send(socket, "GET", "/events?topics=speaking_state", {
    token,
    accept: "text/event-stream",
    signal,
  })
  if (!response.body) return

  for await (const frame of frames(response.body, signal)) {
    if (frame.event !== "speaking_state") continue
    const data = (() => {
      try {
        return JSON.parse(frame.data) as { is_speaking?: boolean; utterance_id?: string }
      } catch {
        return undefined
      }
    })()
    if (!data) continue
    yield { speaking: data.is_speaking === true, utterance: data.utterance_id }
  }
}

/**
 * Split an SSE body into frames, skipping the comment lines (`: keepalive`) the
 * daemon writes to hold the connection open.
 */
async function* frames(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const release = () => reader.cancel().catch(() => undefined)
  signal?.addEventListener("abort", release, { once: true })

  let buffer = ""
  while (true) {
    const chunk = await reader.read().catch(() => undefined)
    if (!chunk || chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(buffer)
      if (!boundary) break
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const frame = block.split(/\r?\n/).reduce(
        (acc, line) => {
          if (line.startsWith(":")) return acc
          if (line.startsWith("event:")) return { ...acc, event: line.slice(6).trim() }
          if (line.startsWith("data:")) return { ...acc, data: acc.data + line.slice(5).trim() }
          return acc
        },
        { event: "", data: "" },
      )
      if (frame.event) yield frame
    }
  }
  signal?.removeEventListener("abort", release)
}
