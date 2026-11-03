/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { TuiKeybind } from "../../../src/config/keybind"
import { Keymap } from "../../../src/context/keymap"
import { tmpdir } from "../../fixture/fixture"
import { VoiceTestContexts } from "../../fixture/voice"

// Mirrors how the session route registers the highlight commands, so the test
// exercises the real definition → binding path rather than a stand-in: moving
// the selection in the base layer, and the bare keys in a layer above it that
// is only there while a message is selected.
async function mountHighlightBindings(input: { root: string; keybinds?: Partial<TuiKeybind.Keybinds> }) {
  const fired: string[] = []
  const [highlighted, setHighlighted] = createSignal(false)
  let prompt: TextareaRenderable | undefined
  // The session route disables the prompt for as long as a reply is selected,
  // exactly as it does for a pending permission; the prompt answers that by
  // refusing every key. Mirrored here so the test presses through the real
  // arrangement rather than a stand-in for it.
  const [disabled, setDisabled] = createSignal(false)

  function Harness() {
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "session.highlight.next", title: "Select next message", run: () => void fired.push("next") },
        { id: "session.highlight.previous", title: "Select previous message", run: () => void fired.push("previous") },
        { id: "session.highlight.speak", title: "Speak the selected message", run: () => void fired.push("speak") },
        { id: "session.highlight.expand", title: "Expand the thoughts", run: () => void fired.push("expand") },
        { id: "session.highlight.clear", title: "Clear the selection", run: () => void fired.push("clear") },
      ].map((command) => ({ bind: false as const, ...command })),
    }))
    Keymap.createLayer(() => ({ bindings: ["session.highlight.next", "session.highlight.previous"] }))
    Keymap.createLayer(() => ({
      priority: 2,
      enabled: highlighted(),
      bindings: ["session.highlight.speak", "session.highlight.expand", "session.highlight.clear"],
    }))
    // The prompt keeps the keyboard while the transcript is read, so the
    // test types into one: a shortcut that quietly ate a letter would be a
    // worse bug than one that never fired.
    return (
      <textarea
        width="100%"
        onKeyDown={(event: { preventDefault(): void }) => {
          if (disabled()) event.preventDefault()
        }}
        ref={(value: TextareaRenderable) => {
          prompt = value
          value.focus()
        }}
      />
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
    highlight: () => {
      setHighlighted(true)
      return () => setHighlighted(false)
    },
    typed: () => prompt?.plainText ?? "",
    setDisabled,
  }
}

test("ctrl+shift+j and ctrl+shift+k move the highlight", async () => {
  await using tmp = await tmpdir()
  const { app, fired, highlight } = await mountHighlightBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey("j", { ctrl: true, shift: true })
    expect(fired).toEqual(["next"])

    app.mockInput.pressKey("k", { ctrl: true, shift: true })
    expect(fired).toEqual(["next", "previous"])

    // The arrows say the same thing for anyone who does not think in hjkl.
    app.mockInput.pressArrow("down", { ctrl: true, shift: true })
    app.mockInput.pressArrow("up", { ctrl: true, shift: true })
    expect(fired).toEqual(["next", "previous", "next", "previous"])

    // And they keep moving it once there is one, with the selection's own
    // keys layered over the base ones.
    highlight()
    app.mockInput.pressKey("k", { ctrl: true, shift: true })
    app.mockInput.pressArrow("up", { ctrl: true, shift: true })
    expect(fired).toEqual(["next", "previous", "next", "previous", "previous", "previous"])
  } finally {
    app.renderer.destroy()
  }
})

test("ctrl+j stays the prompt's newline", async () => {
  await using tmp = await tmpdir()
  const { app, fired } = await mountHighlightBindings({ root: tmp.path })
  try {
    // Shift is what separates these from the input bindings; without the kitty
    // protocol a terminal cannot tell them apart, and this is the pairing that
    // would go wrong first.
    app.mockInput.pressKey("j", { ctrl: true })
    expect(fired).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("the bare keys wait for a reply to be highlighted", async () => {
  await using tmp = await tmpdir()
  const { app, fired, highlight, typed } = await mountHighlightBindings({ root: tmp.path })
  try {
    // With nothing highlighted `p` is a letter being typed, not a shortcut.
    app.mockInput.pressKey("p")
    app.mockInput.pressEscape()
    expect(fired).toEqual([])
    expect(typed()).toBe("p")

    const clear = highlight()
    app.mockInput.pressKey("p")
    expect(fired).toEqual(["speak"])
    // And now it is the shortcut, so it leaves the prompt alone.
    expect(typed()).toBe("p")
    app.mockInput.pressEscape()
    expect(fired).toEqual(["speak", "clear"])

    // Both go back to the prompt when the highlight does.
    clear()
    app.mockInput.pressKey("p")
    expect(fired).toEqual(["speak", "clear"])
    expect(typed()).toBe("pp")
  } finally {
    app.renderer.destroy()
  }
})

test("space opens the selected reply's thoughts", async () => {
  await using tmp = await tmpdir()
  const { app, fired, highlight } = await mountHighlightBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey(" ")
    expect(fired).toEqual([])

    highlight()
    app.mockInput.pressKey(" ")
    app.mockInput.pressKey(" ")
    expect(fired).toEqual(["expand", "expand"])
  } finally {
    app.renderer.destroy()
  }
})

test("a selected reply takes the keyboard off the prompt", async () => {
  await using tmp = await tmpdir()
  const { app, fired, highlight, typed, setDisabled } = await mountHighlightBindings({ root: tmp.path })
  try {
    app.mockInput.pressKey("h")
    expect(typed()).toBe("h")

    const clear = highlight()
    setDisabled(true)
    // Nothing reaches the prompt while a reply is selected — not the letters a
    // shortcut is bound to, and not the ones that are only letters.
    app.mockInput.pressKey("p")
    app.mockInput.pressKey(" ")
    app.mockInput.pressKey("z")
    expect(typed()).toBe("h")
    expect(fired).toEqual(["speak", "expand"])

    // Letting the reply go hands it back.
    clear()
    setDisabled(false)
    app.mockInput.pressKey("i")
    expect(typed()).toBe("hi")
  } finally {
    app.renderer.destroy()
  }
})

test("the highlight keys can be rebound", async () => {
  await using tmp = await tmpdir()
  const { app, fired, highlight } = await mountHighlightBindings({
    root: tmp.path,
    keybinds: { "session.highlight.next": "ctrl+alt+n", "session.highlight.speak": "y" },
  })
  try {
    app.mockInput.pressKey("n", { ctrl: true, meta: true })
    expect(fired).toEqual(["next"])

    highlight()
    app.mockInput.pressKey("y")
    expect(fired).toEqual(["next", "speak"])

    // The default is gone once it has been rebound.
    app.mockInput.pressKey("p")
    expect(fired).toEqual(["next", "speak"])
  } finally {
    app.renderer.destroy()
  }
})
