/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { VoiceMeter, type Dictation, type DictationState } from "../../../src/component/prompt/dictate"
import { VoiceTestContexts } from "../../fixture/voice"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

const FLAT = "▁".repeat(12)

/** A dictation whose state and preview the test drives, as the daemon would. */
function stub(initial: DictationState) {
  const [state, setState] = createSignal<DictationState>(initial)
  const [preview, setPreview] = createSignal("")
  let bands: Float32Array | undefined
  const setBands = (value: Float32Array | undefined) => (bands = value)
  const dictation = {
    get state() {
      return state()
    },
    get preview() {
      return preview()
    },
    get bands() {
      return bands
    },
    get active() {
      return state() !== "idle"
    },
    get ready() {
      return true
    },
    get reachable() {
      return true
    },
    toggle: () => {},
    prepare: async () => {},
    begin: () => {},
    end: () => {},
    hold: () => false,
    release: () => {},
    cancel: () => {},
  } as Dictation
  return { dictation, setState, setPreview, setBands }
}

async function mount(dictation: Dictation, hint = "hold space to talk", warning?: () => string | undefined) {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state}>
        <VoiceMeter dictation={dictation} hint={hint} warning={warning?.()} />
      </VoiceTestContexts>
    ),
    { width: 80, height: 4 },
  )
  await Bun.sleep(50)
  return {
    ...app,
    destroy: async () => {
      app.renderer.destroy()
      await root[Symbol.asyncDispose]()
    },
  }
}

test("an idle microphone is a flat line and the hint", async () => {
  const { dictation } = stub("idle")
  const app = await mount(dictation)
  expect(app.captureCharFrame()).toContain(FLAT)
  expect(app.captureCharFrame()).toContain("hold space to talk")
  await app.destroy()
})

test("the hint carries whatever the prompt has to say", async () => {
  const { dictation } = stub("idle")
  const app = await mount(dictation, "sent — hold space to talk")
  expect(app.captureCharFrame()).toContain("sent — hold space to talk")
  await app.destroy()
})

test("a daemon sending no spectrum still shows an open microphone", async () => {
  const { dictation } = stub("recording")
  const app = await mount(dictation)
  try {
    // No `frequency_bands` frames at all — an older daemon, or a session
    // without the scope. A flat line would claim the microphone was dead.
    await Bun.sleep(200)
    const frame = app.captureCharFrame()
    expect(frame).toContain("listening…")
    expect(frame).not.toContain("hold space to talk")
    expect(frame).not.toContain(FLAT)
  } finally {
    await app.destroy()
  }
})

test("a voice moves the bars, loudest where the daemon says it is", async () => {
  const { dictation, setBands } = stub("recording")
  const app = await mount(dictation)
  try {
    // 64 bands, with the energy piled into the low end, as a voice would be.
    setBands(Float32Array.from({ length: 64 }, (_, band) => (band < 16 ? 3 : 0)))
    await Bun.sleep(200)

    const bar = app.captureCharFrame().split("\n")[0].trimStart().slice(0, 12)
    // The first quarter of the spectrum is the first three of twelve cells.
    expect(bar.slice(0, 3)).toBe("███")
    expect(bar.slice(3)).toBe("▁".repeat(9))
  } finally {
    await app.destroy()
  }
})

test("the bars follow the voice down again", async () => {
  const { dictation, setBands } = stub("recording")
  const app = await mount(dictation)
  try {
    setBands(Float32Array.from({ length: 64 }, () => 3))
    await Bun.sleep(200)
    expect(app.captureCharFrame()).toContain("█".repeat(12))

    setBands(new Float32Array(64))
    await Bun.sleep(200)
    expect(app.captureCharFrame()).toContain(FLAT)
  } finally {
    await app.destroy()
  }
})

test("a half-loud band fills a cell halfway", async () => {
  const { dictation, setBands } = stub("recording")
  const app = await mount(dictation)
  try {
    // Super STT's applet treats 3.0 as a full bar, so half of that is mid-way:
    // half of eight levels lands on the fifth.
    setBands(Float32Array.from({ length: 64 }, () => 1.5))
    await Bun.sleep(200)
    expect(app.captureCharFrame()).toContain("▅".repeat(12))
  } finally {
    await app.destroy()
  }
})

test("what the daemon settled on stays on the row after the capture", async () => {
  const { dictation, setState, setPreview } = stub("recording")
  const app = await mount(dictation)
  try {
    setState("transcribing")
    await Bun.sleep(30)
    expect(app.captureCharFrame()).toContain("transcribing…")

    // The final transcript is the only text a model that previews nothing ever
    // produces, so it is what the row shows once the capture is over.
    setPreview("Hello there, I am testing this.")
    setState("idle")
    await Bun.sleep(30)
    const frame = app.captureCharFrame()
    expect(frame).toContain("Hello there, I am testing this.")
    expect(frame).not.toContain("hold space to talk")
  } finally {
    await app.destroy()
  }
})

test("a capture being turned into text says so", async () => {
  const { dictation } = stub("transcribing")
  const app = await mount(dictation)
  expect(app.captureCharFrame()).toContain("transcribing…")
  await app.destroy()
})

test("a daemon that cannot be reached is said in place of the hint, for as long as it lasts", async () => {
  const { dictation, setState, setPreview } = stub("idle")
  const [warning, setWarning] = createSignal<string>()
  const app = await mount(dictation, "hold space to talk", warning)
  try {
    // What was last heard stays on the row until the next capture, so a
    // warning that yielded to it would be hidden for as long as it mattered.
    setPreview("put the kettle on")
    setWarning("can't reach Super TTS — replies won't be read aloud")
    await Bun.sleep(50)
    expect(app.captureCharFrame()).toContain("△ can't reach Super TTS — replies won't be read aloud")
    expect(app.captureCharFrame()).not.toContain("put the kettle on")

    // A capture is under way, so the row is the microphone's again.
    setState("recording")
    await Bun.sleep(50)
    expect(app.captureCharFrame()).toContain("put the kettle on")
    expect(app.captureCharFrame()).not.toContain("can't reach")

    setState("idle")
    setPreview("")
    setWarning(undefined)
    await Bun.sleep(50)
    expect(app.captureCharFrame()).toContain("hold space to talk")
    expect(app.captureCharFrame()).not.toContain("△")
  } finally {
    await app.destroy()
  }
})
