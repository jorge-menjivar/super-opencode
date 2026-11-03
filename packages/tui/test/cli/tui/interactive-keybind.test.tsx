/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { TuiKeybind } from "../../../src/config/keybind"
import { Keymap } from "../../../src/context/keymap"
import { tmpdir } from "../../fixture/fixture"
import { VoiceTestContexts } from "../../fixture/voice"

/**
 * Mirrors how the prompt registers interactive mode, so the test presses
 * through the real definition → binding path: the commands registered with no
 * keys of their own, the toggle and the application's keys in the base layer,
 * the conversation's bare keys in a layer above it for as long as the mode is
 * on, and a prompt that refuses every key while it is up.
 */
async function mountInteractiveBindings(input: { root: string; keybinds?: Partial<TuiKeybind.Keybinds> }) {
  const fired: string[] = []
  const [interactive, setInteractive] = createSignal(false)
  let prompt: TextareaRenderable | undefined

  function Harness() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "prompt.interactive", title: "Interactive mode", run: () => void fired.push("mode") },
        { id: "prompt.voice.talk", title: "Talk", run: () => void fired.push("talk") },
        { id: "prompt.voice.send", title: "Send", run: () => void fired.push("send") },
        { id: "prompt.voice.listen", title: "Listening", run: () => void fired.push("listen") },
        { id: "prompt.voice.escape", title: "Escape", run: () => void fired.push("escape") },
        { id: "prompt.voice.escape.release", title: "Escape let go", run: () => void fired.push("escape up") },
        { id: "app.exit", title: "Exit", run: () => void fired.push("exit") },
        { id: "command.palette.show", title: "Palette", run: () => void fired.push("palette") },
      ].map((command) => ({ bind: false as const, ...command })),
    }))
    Keymap.createLayer(() => ({ bindings: ["prompt.interactive", "app.exit", "command.palette.show"] }))
    Keymap.createLayer(() => ({
      priority: 2,
      enabled: interactive(),
      bindings: [
        "prompt.voice.talk",
        "prompt.voice.send",
        "prompt.voice.listen",
        "prompt.voice.escape",
        "prompt.voice.escape.release",
      ],
    }))
    // Hidden in the mode, with the meter on the row it leaves, and focused
    // throughout: the prompt's keys answer to that focus.
    return (
      <>
        <box width="100%" visible={!interactive()}>
          <textarea
            width="100%"
            showCursor={!interactive()}
            onKeyDown={(event: { preventDefault(): void }) => {
              if (interactive()) event.preventDefault()
            }}
            ref={(value: TextareaRenderable) => {
              prompt = value
              value.focus()
            }}
          />
        </box>
        <Show when={interactive()}>
          <text>meter</text>
        </Show>
      </>
    )
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
  return {
    app,
    fired,
    enter: () => {
      setInteractive(true)
      return () => setInteractive(false)
    },
    typed: () => prompt?.plainText ?? "",
    // The terminal reports a key going up as its own kitty event; nothing in
    // the mock presses and lets go, so the sequence is written directly.
    release: (key: string) => app.renderer.stdin.emit("data", Buffer.from(`\x1b[${key.codePointAt(0)};1:3u`)),
    releaseEscape: () => app.renderer.stdin.emit("data", Buffer.from("\x1b[27;1:3u")),
  }
}

test("ctrl+i turns interactive mode on", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountInteractiveBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey("i", { ctrl: true })
    expect(fired).toEqual(["mode"])
  } finally {
    app.renderer.destroy()
  }
})

test("space opens the microphone and letting it go sends", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter, release } = await mountInteractiveBindings({ root: tmp.path })
  try {
    // Outside the mode the space bar is the prompt's.
    app.mockInput.pressKey(" ")
    release(" ")
    expect(fired).toEqual([])

    enter()
    app.mockInput.pressKey(" ")
    expect(fired).toEqual(["talk"])
    release(" ")
    expect(fired).toEqual(["talk", "send"])

    // And again, because a conversation is more than one turn.
    app.mockInput.pressKey(" ")
    release(" ")
    expect(fired).toEqual(["talk", "send", "talk", "send"])
  } finally {
    app.renderer.destroy()
  }
})

test("v and escape belong to the mode", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter } = await mountInteractiveBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey("v")
    app.mockInput.pressEscape()
    expect(fired).toEqual([])

    const leave = enter()
    app.mockInput.pressKey("v")
    expect(fired).toEqual(["listen"])
    app.mockInput.pressEscape()
    expect(fired).toEqual(["listen", "escape"])

    leave()
    app.mockInput.pressKey("v")
    expect(fired).toEqual(["listen", "escape"])
  } finally {
    app.renderer.destroy()
  }
})

// The mode takes both halves of the stroke: what escape means in it — quiet the
// voice, interrupt the agent, leave — depends on how the key was used, and the
// release is half of how a terminal that reports one says so.
test("the mode takes escape on the way down and on the way up", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter, releaseEscape } = await mountInteractiveBindings({ root: tmp.path })
  try {
    // Outside the mode neither half is ours: escape stays the base binding.
    app.mockInput.pressEscape()
    releaseEscape()
    expect(fired).toEqual([])

    const leave = enter()
    app.mockInput.pressEscape()
    expect(fired).toEqual(["escape"])
    releaseEscape()
    expect(fired).toEqual(["escape", "escape up"])

    leave()
    releaseEscape()
    expect(fired).toEqual(["escape", "escape up"])
  } finally {
    app.renderer.destroy()
  }
})

test("nothing typed reaches the prompt while the mode is on", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter, typed, release } = await mountInteractiveBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey("h")
    expect(typed()).toBe("h")

    const leave = enter()
    app.mockInput.pressKey(" ")
    release(" ")
    app.mockInput.pressKey("v")
    app.mockInput.pressKey("z")
    expect(typed()).toBe("h")
    expect(fired).toEqual(["talk", "send", "listen"])

    leave()
    app.mockInput.pressKey("i")
    expect(typed()).toBe("hi")
  } finally {
    app.renderer.destroy()
  }
})

// The mode adds a few bare keys; it does not take the keyboard. A mode of its
// own would replace the base one outright, and for as long as interactive mode
// was up there would be no way to quit the application.
test("the application's own keys still work inside the mode", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter } = await mountInteractiveBindings({ root: tmp.path })
  try {
    const leave = enter()
    app.mockInput.pressKey("c", { ctrl: true })
    expect(fired).toEqual(["exit"])

    app.mockInput.pressKey("p", { ctrl: true })
    expect(fired).toEqual(["exit", "palette"])

    // And the mode's own keys are still the mode's.
    app.mockInput.pressKey("v")
    expect(fired).toEqual(["exit", "palette", "listen"])

    leave()
    app.mockInput.pressKey("c", { ctrl: true })
    expect(fired).toEqual(["exit", "palette", "listen", "exit"])
  } finally {
    app.renderer.destroy()
  }
})

// A key the mode claims is the mode's for as long as it is up, even when the
// application binds it too.
test("a key the mode claims wins over the same key underneath", async () => {
  await using tmp = await tmpdir()
  const { app, fired, enter } = await mountInteractiveBindings({
    root: tmp.path,
    keybinds: { "app.exit": "ctrl+c,escape" },
  })
  try {
    app.mockInput.pressEscape()
    expect(fired).toEqual(["exit"])

    const leave = enter()
    app.mockInput.pressEscape()
    // The mode's arm-the-exit, not the application's quit.
    expect(fired).toEqual(["exit", "escape"])

    leave()
    app.mockInput.pressEscape()
    expect(fired).toEqual(["exit", "escape", "exit"])
  } finally {
    app.renderer.destroy()
  }
})

test("the terminal's cursor goes with the prompt, rather than staying on the meter's row", async () => {
  await using tmp = await tmpdir()
  const { app, enter } = await mountInteractiveBindings({ root: tmp.path })
  try {
    await app.renderOnce()
    expect(app.renderer.getCursorState().visible).toBe(true)

    // A hidden textarea draws nothing, so the cursor it last placed would stay
    // where it was: on the first cell of the row the meter now draws on.
    const leave = enter()
    await app.renderOnce()
    expect(app.renderer.getCursorState().visible).toBe(false)

    leave()
    await app.renderOnce()
    expect(app.renderer.getCursorState().visible).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
