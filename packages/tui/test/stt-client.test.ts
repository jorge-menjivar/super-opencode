import { expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { SCOPES, satisfies, spectrum, transcribe } from "../src/stt/client"

/** Base64 of little-endian f32s, exactly as the daemon packs its bands. */
function pack(values: number[]) {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return Buffer.from(bytes).toString("base64")
}

test("drawing the microphone is one of the scopes we ask for", () => {
  expect(SCOPES).toContain("audio_visualization")
  // A token minted before the topic existed cannot subscribe to it, and the
  // daemon would refuse the whole stream rather than the one topic.
  expect(satisfies({ token: "t", scopes: ["transcribe", "status"] })).toBe(false)
  expect(satisfies({ token: "t", scopes: SCOPES })).toBe(true)
})

test("reads the spectrum off the daemon's event stream", async () => {
  const socket = path.join(tmpdir(), `opencode-stt-bands-${process.pid}.sock`)
  let asked: string | undefined
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      asked = new URL(request.url).search
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      return new Response(
        [
          ": stream-open\n\n",
          frame("subscribed", { client_id: "c1", topics: ["frequency_bands"] }),
          frame("frequency_bands", { bands_b64: pack([0, 1.5, 3]), sample_rate: 48000, total_energy: 4.5 }),
          // A frame on a topic we did not ask about is not ours to decode.
          frame("recording_state", { is_recording: true }),
          frame("frequency_bands", { bands_b64: pack([2, 2]), sample_rate: 48000, total_energy: 4 }),
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })

  try {
    const seen: { bands: number[]; energy: number }[] = []
    for await (const frame of spectrum(socket, "stt_token")) {
      seen.push({ bands: [...frame.bands], energy: frame.energy })
    }
    expect(asked).toBe("?topics=frequency_bands")
    // Both band frames were sent back to back, so the second lands inside the
    // window and is dropped without being parsed: the daemon publishes one per
    // audio callback, far faster than any of it can be drawn.
    expect(seen).toEqual([{ bands: [0, 1.5, 3], energy: 4.5 }])
  } finally {
    void server.stop(true)
    await rm(socket, { force: true })
  }
})

test("a frame the daemon truncates is skipped rather than guessed at", async () => {
  const socket = path.join(tmpdir(), `opencode-stt-bands-bad-${process.pid}.sock`)
  const server = Bun.serve({
    unix: socket,
    fetch() {
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      return new Response(
        [frame("frequency_bands", { total_energy: 1 }), frame("frequency_bands", { bands_b64: pack([1]) })].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })

  try {
    const seen: number[][] = []
    for await (const frame of spectrum(socket, "stt_token")) seen.push([...frame.bands])
    expect(seen).toEqual([[1]])
  } finally {
    void server.stop(true)
    await rm(socket, { force: true })
  }
})

test("asks for a silent take, without touching the daemon's settings", async () => {
  const socket = path.join(tmpdir(), `opencode-stt-cues-${process.pid}.sock`)
  const bodies: Record<string, unknown>[] = []
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>)
      return new Response('event: done\ndata: {"transcription":"hello"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })

  try {
    expect(await transcribe(socket, "stt_token", { audioCues: false, stopMode: "manual_only" })).toBe("hello")
    // Per-request, so a silent take needs no `settings` scope and leaves
    // nothing to put back if this process dies mid-capture.
    expect(bodies[0]).toMatchObject({ audio_cues: false, stop_mode: "manual_only" })

    // Left out entirely when nothing asked either way, so the daemon's own
    // audio theme still decides.
    await transcribe(socket, "stt_token", {})
    expect(bodies[1]).not.toHaveProperty("audio_cues")
  } finally {
    void server.stop(true)
    await rm(socket, { force: true })
  }
})

test("frames far enough apart are all handed over", async () => {
  const socket = path.join(tmpdir(), `opencode-stt-bands-paced-${process.pid}.sock`)
  const server = Bun.serve({
    unix: socket,
    fetch() {
      const frame = (data: unknown) => `event: frequency_bands\ndata: ${JSON.stringify(data)}\n\n`
      return new Response(
        new ReadableStream({
          async start(controller) {
            const write = (text: string) => controller.enqueue(new TextEncoder().encode(text))
            write(frame({ bands_b64: pack([1]), total_energy: 1 }))
            await Bun.sleep(80)
            write(frame({ bands_b64: pack([2]), total_energy: 2 }))
            controller.close()
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })

  try {
    const seen: number[][] = []
    for await (const frame of spectrum(socket, "stt_token")) seen.push([...frame.bands])
    expect(seen).toEqual([[1], [2]])
  } finally {
    void server.stop(true)
    await rm(socket, { force: true })
  }
})
