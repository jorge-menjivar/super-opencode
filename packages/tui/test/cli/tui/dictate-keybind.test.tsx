/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createMemo, onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { TuiKeybind } from "../../../src/config/keybind"

// Mirrors how the prompt registers the dictation command, so the test exercises
// the real definition → command-map → binding path rather than a stand-in.
async function mountDictateBinding(input: { root: string; keybinds?: Partial<TuiKeybind.Keybinds> }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, useCommandShortcut, OPENCODE_BASE_MODE },
  ] = await Promise.all([
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/keymap"),
  ])

  const fired: string[] = []

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ keybinds: input.keybinds, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    function Commands() {
      // The hint reads its label from the resolved binding, exactly as the
      // prompt footer does, so a rebind retitles it without any other change.
      const shortcut = useCommandShortcut("prompt.dictate")
      const commands = createMemo(() =>
        [
          { title: "Start dictation", name: "prompt.dictate", category: "Prompt", run: () => fired.push("toggle") },
          {
            title: "Cancel dictation",
            name: "prompt.dictate.cancel",
            category: "Prompt",
            run: () => fired.push("cancel"),
          },
        ].map((entry) => ({ namespace: "palette", ...entry })),
      )
      useBindings(() => ({ commands: commands() }))
      useBindings(() => ({
        mode: OPENCODE_BASE_MODE,
        bindings: config.keybinds.gather("prompt.palette", ["prompt.dictate"]),
      }))
      return <text>{shortcut()} dictate</text>
    }

    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <Commands />
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 60, height: 6 })
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
  const { app, fired } = await mountDictateBinding({ root: tmp.path, keybinds: { prompt_dictate: "ctrl+g" } })
  try {
    app.mockInput.pressKey("g", { ctrl: true })
    expect(fired).toEqual(["toggle"])
  } finally {
    app.renderer.destroy()
  }
})

test("the hint shows the bound key", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountDictateBinding({ root: tmp.path })
  try {
    expect(app.captureCharFrame()).toContain("ctrl+s dictate")
  } finally {
    app.renderer.destroy()
  }
})

test("the hint follows a rebind", async () => {
  await using tmp = await tmpdir()
  const { app } = await mountDictateBinding({ root: tmp.path, keybinds: { prompt_dictate: "ctrl+g" } })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("ctrl+g dictate")
    expect(frame).not.toContain("ctrl+s")
  } finally {
    app.renderer.destroy()
  }
})

test("dictation can be unbound", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountDictateBinding({ root: tmp.path, keybinds: { prompt_dictate: "none" } })
  try {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressKey("d")
    expect(fired).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
