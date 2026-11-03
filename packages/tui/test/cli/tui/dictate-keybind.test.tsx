/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { TuiKeybind } from "../../../src/config/keybind"
import { Keymap } from "../../../src/context/keymap"
import { tmpdir } from "../../fixture/fixture"
import { VoiceTestContexts } from "../../fixture/voice"

// Mirrors how the prompt registers the dictation command, so the test exercises
// the real definition → binding path rather than a stand-in: the commands with
// no keys of their own, and the configured keys switched on in the base layer.
async function mountDictateBinding(input: { root: string; keybinds?: Partial<TuiKeybind.Keybinds> }) {
  const fired: string[] = []

  function Harness() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "prompt.dictate", title: "Start dictation", run: () => void fired.push("toggle") },
        { id: "prompt.interactive", title: "Interactive mode", run: () => void fired.push("interactive") },
        { id: "prompt.dictate.cancel", title: "Cancel dictation", run: () => void fired.push("cancel") },
      ].map((command) => ({ bind: false as const, ...command })),
    }))
    Keymap.createLayer(() => ({ bindings: ["prompt.dictate", "prompt.interactive"] }))
    return <text>dictation</text>
  }

  const app = await testRender(
    () => (
      <VoiceTestContexts state={input.root} config={{ keybinds: input.keybinds }}>
        <Keymap.Provider>
          <Harness />
        </Keymap.Provider>
      </VoiceTestContexts>
    ),
    { kittyKeyboard: true, width: 60, height: 6 },
  )
  await Bun.sleep(80)
  return { app, fired }
}

test("a single keypress starts and stops dictation", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path })
  try {
    app.mockInput.pressKey("s", { ctrl: true })
    expect(fired).toEqual(["toggle"])

    // The same key again is what stops the capture.
    app.mockInput.pressKey("s", { ctrl: true })
    expect(fired).toEqual(["toggle", "toggle"])
  } finally {
    app.renderer.destroy()
  }
})

test("the leader chord still works alongside the single key", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path })
  try {
    // The default leader is ctrl+x.
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("d")
    expect(fired).toEqual(["toggle"])
  } finally {
    app.renderer.destroy()
  }
})

test("dictation can be rebound to a plain key", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path, keybinds: { "prompt.dictate": "ctrl+g" } })
  try {
    app.mockInput.pressKey("g", { ctrl: true })
    expect(fired).toEqual(["toggle"])
  } finally {
    app.renderer.destroy()
  }
})

test("a separate single key toggles interactive voice mode", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path })
  try {
    app.mockInput.pressKey("i", { ctrl: true })
    expect(fired).toEqual(["interactive"])

    // The two controls stay independent.
    app.mockInput.pressKey("s", { ctrl: true })
    expect(fired).toEqual(["interactive", "toggle"])
  } finally {
    app.renderer.destroy()
  }
})

test("dictation can be unbound", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path, keybinds: { "prompt.dictate": "none" } })
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("d")
    expect(fired).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
