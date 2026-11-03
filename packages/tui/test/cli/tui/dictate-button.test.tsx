/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import {
  DictateButton,
  DictatePreview,
  type Dictation,
  type DictationState,
} from "../../../src/component/prompt/dictate"
import { VoiceTestContexts } from "../../fixture/voice"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

function stub(input: { state: DictationState; preview?: string; onToggle?: () => void }) {
  return {
    state: input.state,
    preview: input.preview ?? "",
    active: input.state !== "idle",
    ready: true,
    reachable: true,
    toggle: input.onToggle ?? (() => {}),
    prepare: async () => {},
    begin: () => {},
    end: () => {},
    bands: undefined,
    hold: () => false,
    release: () => {},
    cancel: () => {},
  } as Dictation
}

async function mount(dictation: Dictation, disabled?: boolean) {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state}>
        <DictatePreview dictation={dictation} />
        <box flexDirection="row" gap={1}>
          <DictateButton dictation={dictation} disabled={disabled} />
        </box>
      </VoiceTestContexts>
    ),
    { width: 80, height: 6 },
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

test("offers dictation when idle", async () => {
  const app = await mount(stub({ state: "idle" }))
  expect(app.captureCharFrame()).toContain("◉ dictate")
  await app.destroy()
})

test("offers a stop control while recording, with the live preview on its own line", async () => {
  const app = await mount(stub({ state: "recording", preview: "hello world" }))
  const frame = app.captureCharFrame()
  expect(frame).toContain("● stop")
  expect(frame).toContain("hello world")
  await app.destroy()
})

test("says it is listening before the first preview arrives", async () => {
  const app = await mount(stub({ state: "recording" }))
  expect(app.captureCharFrame()).toContain("listening…")
  await app.destroy()
})

test("reports the post-capture decode", async () => {
  const app = await mount(stub({ state: "transcribing" }))
  const frame = app.captureCharFrame()
  expect(frame).toContain("◌ transcribing")
  await app.destroy()
})

test("keeps the last heard text up while the model decodes", async () => {
  const app = await mount(stub({ state: "transcribing", preview: "hello world" }))
  expect(app.captureCharFrame()).toContain("hello world")
  await app.destroy()
})

test("hides the preview until a capture is running", async () => {
  const app = await mount(stub({ state: "starting", preview: "stale" }))
  const frame = app.captureCharFrame()
  expect(frame).toContain("◌ starting")
  expect(frame).not.toContain("stale")
  await app.destroy()
})

test("tracks state changes", async () => {
  const [state, setState] = createSignal<DictationState>("idle")
  const dictation = {
    get state() {
      return state()
    },
    get preview() {
      return ""
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
    toggle: () => setState((current) => (current === "idle" ? "recording" : "idle")),
    prepare: async () => {},
    begin: () => setState("recording"),
    end: () => setState("idle"),
    bands: undefined,
    hold: () => {
      setState("recording")
      return true
    },
    release: () => setState("idle"),
    cancel: () => setState("idle"),
  } as Dictation

  const app = await mount(dictation)
  expect(app.captureCharFrame()).toContain("◉ dictate")

  dictation.toggle()
  await Bun.sleep(20)
  expect(app.captureCharFrame()).toContain("● stop")

  dictation.toggle()
  await Bun.sleep(20)
  expect(app.captureCharFrame()).toContain("◉ dictate")
  await app.destroy()
})
