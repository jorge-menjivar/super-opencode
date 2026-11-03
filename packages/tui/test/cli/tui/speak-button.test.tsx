/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { ListenButton, PlayButton, SpeakButton, type Speech } from "../../../src/component/prompt/speak"
import { VoiceTestContexts } from "../../fixture/voice"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

function stub(input: {
  interactive: boolean
  speaking?: boolean
  source?: string
  listen?: "push" | "open"
  onToggle?: () => void
  onCycle?: () => void
}) {
  return {
    interactive: input.interactive,
    listen: input.listen ?? "push",
    speaking: input.speaking ?? false,
    ready: true,
    reachable: true,
    source: input.source,
    toggle: input.onToggle ?? (() => {}),
    prepare: async () => {},
    follow: () => {},
    cycleListening: input.onCycle ?? (() => {}),
    stop: () => {},
    play: async () => {},
    test: async () => {},
  } as Speech
}

async function mount(speech: Speech, children?: (speech: Speech) => JSX.Element) {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })

  const app = await testRender(
    () => (
      <VoiceTestContexts state={state}>
        <box flexDirection="row" gap={1}>
          {children ? children(speech) : <SpeakButton speech={speech} />}
        </box>
      </VoiceTestContexts>
    ),
    { width: 60, height: 5 },
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

test("offers interactive mode when off", async () => {
  const app = await mount(stub({ interactive: false }))
  expect(app.captureCharFrame()).toContain("♪ interactive")
  await app.destroy()
})

test("shows the mode is on while waiting for a reply", async () => {
  const app = await mount(stub({ interactive: true }))
  expect(app.captureCharFrame()).toContain("♪ interactive")
  await app.destroy()
})

test("reports an utterance in flight", async () => {
  const app = await mount(stub({ interactive: true, speaking: true }))
  expect(app.captureCharFrame()).toContain("♪ speaking")
  await app.destroy()
})

test("an open microphone outranks the mode it is part of", async () => {
  const app = await mount(stub({ interactive: true }), (speech) => <SpeakButton speech={speech} listening={true} />)
  expect(app.captureCharFrame()).toContain("● listening")
  await app.destroy()
})

test("a reply being read is not the microphone being open", async () => {
  const app = await mount(stub({ interactive: true, speaking: true }), (speech) => (
    <SpeakButton speech={speech} listening={false} />
  ))
  expect(app.captureCharFrame()).toContain("♪ speaking")
  await app.destroy()
})

test("says which way the microphone is held open", async () => {
  const push = await mount(stub({ interactive: true }), (speech) => <ListenButton speech={speech} />)
  expect(push.captureCharFrame()).toContain("◉ push")
  await push.destroy()

  const open = await mount(stub({ interactive: true, listen: "open" }), (speech) => <ListenButton speech={speech} />)
  expect(open.captureCharFrame()).toContain("◉ open")
  await open.destroy()
})

test("offers to play a reply from the transcript", async () => {
  const app = await mount(stub({ interactive: false }), (speech) => (
    <PlayButton speech={speech} text="The kettle is boiling." source="msg_1" />
  ))
  expect(app.captureCharFrame()).toContain("↻ play")
  await app.destroy()
})

test("shows which reply the voice is on", async () => {
  const playing = await mount(stub({ interactive: false, speaking: true, source: "msg_1" }), (speech) => (
    <PlayButton speech={speech} text="The kettle is boiling." source="msg_1" />
  ))
  expect(playing.captureCharFrame()).toContain("♪ playing")
  await playing.destroy()

  // Another reply speaking is not this one speaking.
  const other = await mount(stub({ interactive: false, speaking: true, source: "msg_2" }), (speech) => (
    <PlayButton speech={speech} text="The kettle is boiling." source="msg_1" />
  ))
  expect(other.captureCharFrame()).toContain("↻ play")
  await other.destroy()
})

test("tracks state changes", async () => {
  const [speaking, setSpeaking] = createSignal(false)
  const speech = {
    get interactive() {
      return true
    },
    get listen() {
      return "push" as const
    },
    get speaking() {
      return speaking()
    },
    get ready() {
      return true
    },
    get reachable() {
      return true
    },
    get source() {
      return undefined
    },
    toggle: () => setSpeaking((value) => !value),
    prepare: async () => {},
    follow: () => {},
    cycleListening: () => {},
    stop: () => setSpeaking(false),
    play: async () => {},
    test: async () => {},
  } as Speech

  const app = await mount(speech)
  expect(app.captureCharFrame()).toContain("♪ interactive")

  speech.toggle()
  await Bun.sleep(20)
  expect(app.captureCharFrame()).toContain("♪ speaking")

  speech.stop()
  await Bun.sleep(20)
  expect(app.captureCharFrame()).not.toContain("speaking")
  await app.destroy()
})
