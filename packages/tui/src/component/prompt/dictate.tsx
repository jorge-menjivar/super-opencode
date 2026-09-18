import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useToast } from "../../ui/toast"
import { useTuiConfig } from "../../config"
import { errorMessage } from "../../util/error"
import { authorize, available, socketPath, SttError, status, stop, transcribe, valid } from "../../stt/client"
import { read, write } from "../../stt/session"
import type { Session } from "../../stt/client"

export type DictationState = "idle" | "starting" | "recording" | "transcribing"

export type Dictation = ReturnType<typeof usePromptDictation>

/**
 * Live transcription as the daemon hears it, on its own full-width line so the
 * text is actually readable while speaking. What the text spans depends on the
 * model: a realtime model streams everything heard so far, while for every
 * other model the daemon re-transcribes a sliding window, so the line shows the
 * last few seconds and replaces itself. Neither is the final transcript — that
 * arrives when the capture ends and goes into the prompt.
 */
export function DictatePreview(props: { dictation: Dictation }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={props.dictation.state === "recording" || props.dictation.state === "transcribing"}>
      <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} width="100%">
        <text fg={theme.error} flexShrink={0}>
          ●
        </text>
        <text fg={props.dictation.preview ? theme.text : theme.textMuted} flexShrink={1}>
          {props.dictation.preview
            ? Locale.truncateLeft(props.dictation.preview, Math.max(20, dimensions().width - 12))
            : props.dictation.state === "transcribing"
              ? "transcribing…"
              : "listening…"}
        </text>
      </box>
    </Show>
  )
}

/**
 * The prompt's dictation control: a button that starts the capture and stops
 * it again.
 */
export function DictateButton(props: { dictation: Dictation; disabled?: boolean }) {
  const { theme } = useTheme()

  return (
    <>
      <box
        flexDirection="row"
        gap={1}
        flexShrink={0}
        onMouseDown={() => {
          if (props.disabled) return
          props.dictation.toggle()
        }}
      >
        <Switch>
          <Match when={props.dictation.state === "recording"}>
            <text fg={theme.error}>● stop</text>
          </Match>
          <Match when={props.dictation.state === "starting"}>
            <text fg={theme.textMuted}>◌ starting</text>
          </Match>
          <Match when={props.dictation.state === "transcribing"}>
            <text fg={theme.textMuted}>◌ transcribing</text>
          </Match>
          <Match when={true}>
            <text fg={props.disabled ? theme.border : theme.textMuted}>◉ dictate</text>
          </Match>
        </Switch>
      </box>
    </>
  )
}

/**
 * Dictation through the Super STT daemon. The daemon owns the microphone and
 * the model — opencode asks it to capture, streams back preview text while the
 * user speaks, and inserts the final transcription into the prompt.
 */
export function usePromptDictation(input: { insert: (text: string) => void }) {
  const toast = useToast()
  const config = useTuiConfig()
  const [state, setState] = createSignal<DictationState>("idle")
  const [preview, setPreview] = createSignal("")
  const [ready, setReady] = createSignal(false)

  const socket = socketPath()
  let controller: AbortController | undefined
  let session: Session | undefined

  onMount(() => {
    if (!config.stt.enabled || !socket) return
    void available(socket).then(setReady)
  })

  onCleanup(() => controller?.abort())

  const notify = (message: string) => toast.show({ title: "Dictation", message, variant: "error" })

  // A token is minted once and persisted; the daemon binds it to the opencode
  // binary, so a reinstall invalidates it (`exe_changed`) and we mint again.
  async function authenticate(force?: boolean) {
    if (!socket) return undefined
    if (!force) {
      session = session ?? (await read())
      if (session && (await valid(socket, session.token))) return session
    }
    session = await authorize(socket, InstallationVersion)
    await write(session).catch((error) => {
      // A token we cannot persist still works for this run.
      console.debug("failed to persist super-stt session", { error })
    })
    return session
  }

  async function run(token: string) {
    controller = new AbortController()
    return transcribe(socket!, token, {
      language: config.stt.language,
      stopMode: config.stt.stop_mode,
      signal: controller.signal,
      onCapture: () => setState("recording"),
      onPreview: (value) => setPreview(value.text),
    })
  }

  async function start() {
    if (!socket) {
      notify("Super STT is unavailable: XDG_RUNTIME_DIR is not set.")
      return
    }
    // Claim the state before the first await so a double press cannot open two
    // captures against the daemon.
    setState("starting")
    setPreview("")

    if (!(await available(socket))) {
      setState("idle")
      notify("The Super STT daemon is not running. Start it with: systemctl --user start super-stt")
      setReady(false)
      return
    }

    const authenticated = await authenticate().catch((error) => {
      setState("idle")
      if (error instanceof SttError && (error.code === "user_denied" || error.code === "user_denied_cached")) {
        notify("Super STT access was denied. Approve opencode in the consent dialog to dictate.")
        return undefined
      }
      if (error instanceof SttError && error.code === "user_dismissed") return undefined
      if (error instanceof SttError && error.code === "popup_failed") {
        // The daemon only looks for its consent helper next to its own binary,
        // so this is what a daemon run straight out of a build tree reports.
        notify("Super STT could not show its consent dialog. Check that super-stt-consent sits beside the daemon.")
        return undefined
      }
      notify(errorMessage(error))
      return undefined
    })
    if (!authenticated) {
      setState("idle")
      return
    }

    const current = await status(socket, authenticated.token).catch(() => undefined)
    if (current && !current.model_loaded) {
      setState("idle")
      notify("No speech model is loaded. Load one in the Super STT app, then try again.")
      return
    }
    if (current?.busy) {
      setState("idle")
      notify("Super STT is already recording for another app.")
      return
    }

    // A token rejected mid-flight is re-minted once: the daemon revokes on
    // expiry and on a changed binary, neither of which the caller can predict.
    const text = await run(authenticated.token)
      .catch(async (error) => {
        if (!(error instanceof SttError) || error.status !== 401) throw error
        const renewed = await authenticate(true)
        if (!renewed) throw error
        return run(renewed.token)
      })
      .catch((error) => {
        if (controller?.signal.aborted) return ""
        notify(errorMessage(error))
        return ""
      })

    controller = undefined
    setState("idle")
    setPreview("")
    if (text.trim()) input.insert(text.trim())
  }

  async function finish() {
    if (!socket || !session) return
    setState("transcribing")
    // Stop over the protocol rather than closing our stream: a disconnect is an
    // implicit stop that drops the result, and the final transcription is only
    // delivered on the connection that started the capture.
    await stop(socket, session.token).catch((error) => notify(errorMessage(error)))
  }

  function cancel() {
    if (state() === "idle") return
    // The controller stays put so the in-flight catch can tell a deliberate
    // cancel from a real failure and skip the error toast.
    controller?.abort()
    setState("idle")
    setPreview("")
  }

  function toggle() {
    const current = state()
    if (current === "idle") {
      void start()
      return
    }
    if (current === "recording") {
      void finish()
      return
    }
  }

  return {
    get state() {
      return state()
    },
    get preview() {
      return preview()
    },
    get active() {
      return state() !== "idle"
    },
    // The button and keybind stay hidden unless the daemon is actually there,
    // so the affordance never promises something that cannot work.
    get ready() {
      return ready()
    },
    toggle,
    cancel,
  }
}
