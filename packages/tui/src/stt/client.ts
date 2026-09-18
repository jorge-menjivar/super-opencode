import path from "path"
import { stat } from "fs/promises"

// Client for the Super STT daemon protocol: HTTP/1.1 + JSON over a Unix domain
// socket, with Server-Sent Events for streaming transcriptions. Every route is
// served under the /v1 prefix.
// See ../../../../../super-stt/docs/protocol/ for the wire reference.

export const SCOPES = ["transcribe", "status"]

export const APP_NAME = "opencode"

const PREFIX = "/v1"

export type StopMode = "silence_only" | "silence_and_manual" | "manual_only"

export type Session = {
  token: string
  scopes: string[]
  expires?: string
}

export type Preview = {
  text: string
  // "stream" extends the previous frame (realtime models), "window" replaces it
  // (the daemon re-transcribing a sliding window). Absent on older daemons.
  source?: "stream" | "window"
}

export type Status = {
  device: string
  model_loaded: boolean
  current_model?: string
  busy: boolean
}

export class SttError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = "SttError"
    this.code = code
    this.status = status
  }
}

export function socketPath() {
  if (process.env.SUPER_STT_HTTP_SOCKET) return process.env.SUPER_STT_HTTP_SOCKET
  if (!process.env.XDG_RUNTIME_DIR) return undefined
  return path.join(process.env.XDG_RUNTIME_DIR, "stt", "super-stt-http.sock")
}

export async function available(socket: string) {
  // Bun.file().exists() is false for a socket — it only reports regular files.
  const info = await stat(socket).catch(() => undefined)
  return info?.isSocket() ?? false
}

function url(endpoint: string) {
  return `http://stt.local${PREFIX}${endpoint}`
}

async function fail(response: Response) {
  // Error envelope: { status, error_code?, message, data? }. error_code is the
  // stable identifier; message carries the auth identifiers verbatim on older
  // daemons, so fall back to it before the bare status.
  const body = (await response.json().catch(() => undefined)) as
    | { error_code?: string; message?: string; data?: { reason?: string } }
    | undefined
  const code = body?.error_code ?? body?.message ?? `http_${response.status}`
  const reason = body?.data?.reason
  return new SttError(body?.message ?? `request failed (${response.status})`, reason ?? code, response.status)
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
      ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options?.accept ? { Accept: options.accept } : {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }).catch((error) => {
    throw new SttError(`cannot reach the Super STT daemon: ${error.message}`, "daemon_unreachable", 0)
  })
  if (!response.ok) throw await fail(response)
  return response
}

/**
 * Trigger the consent popup and mint a session token. The daemon binds the
 * token to the calling binary, so a token minted here stops working if the
 * opencode executable changes (`exe_changed`).
 */
export async function authorize(socket: string, version: string): Promise<Session> {
  const response = await send(socket, "POST", "/auth/request", {
    body: { app_name: APP_NAME, scopes: SCOPES, version },
  })
  const body = (await response.json()) as { session_token: string; scopes?: string[]; expires_at?: string }
  return { token: body.session_token, scopes: body.scopes ?? SCOPES, expires: body.expires_at }
}

/** Probe token validity without spawning a consent popup. */
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

/**
 * Stop an in-flight daemon-mic capture. The final transcription still arrives
 * on the connection that started it, which is why a toggle-off calls this
 * rather than closing that connection — a disconnect drops undelivered output.
 */
export async function stop(socket: string, token: string) {
  await send(socket, "POST", "/transcribe/stop", { token })
}

/**
 * Start a daemon-mic capture and resolve with the final transcription. The
 * daemon owns the microphone; opencode never touches audio. Aborting the
 * signal closes the stream, which the daemon treats as a stop that discards
 * any result still in flight.
 */
export async function transcribe(
  socket: string,
  token: string,
  options: {
    language?: string
    stopMode?: StopMode
    signal?: AbortSignal
    onPreview?: (preview: Preview) => void
    onCapture?: () => void
  },
) {
  const response = await send(socket, "POST", "/transcribe", {
    token,
    accept: "text/event-stream",
    signal: options.signal,
    body: {
      wait: true,
      stream_realtime: true,
      write_mode: false,
      ...(options.language ? { language: options.language } : {}),
      ...(options.stopMode ? { stop_mode: options.stopMode } : {}),
    },
  })
  if (!response.body) throw new SttError("daemon returned no transcription stream", "empty_stream", response.status)

  options.onCapture?.()

  let transcription = ""
  for await (const frame of frames(response.body, options.signal)) {
    if (frame.event === "preview") {
      const data = parse(frame.data) as Preview | undefined
      if (data?.text !== undefined) options.onPreview?.(data)
      continue
    }
    if (frame.event === "done") {
      transcription = (parse(frame.data) as { transcription?: string } | undefined)?.transcription ?? ""
      break
    }
    if (frame.event === "error") {
      const message = (parse(frame.data) as { message?: string } | undefined)?.message
      throw new SttError(message ?? "transcription failed", "transcribe_failed", 500)
    }
  }
  return transcription
}

function parse(data: string) {
  if (!data) return undefined
  return JSON.parse(data) as unknown
}

/**
 * Minimal SSE reader: yields one frame per blank-line-delimited block and drops
 * the comment frames (`: stream-open`, `: keepalive`) the daemon writes to hold
 * the connection open through silent phases.
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
