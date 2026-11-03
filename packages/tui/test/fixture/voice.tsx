/** @jsxImportSource @opentui/solid */
import type { ParentProps } from "solid-js"
import { ConfigProvider } from "../../src/config"
import { TuiAppProvider } from "../../src/context/runtime"
import { StorageProvider } from "../../src/context/storage"
import { ThemeProvider } from "../../src/context/theme"
import { ToastProvider } from "../../src/ui/toast"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"

/**
 * What a voice control needs around it: the configuration, saved state to
 * remember interactive mode in, a theme, and somewhere to raise a toast.
 */
export function VoiceTestContexts(
  props: ParentProps<{ state: string; config?: Parameters<typeof createTuiResolvedConfig>[0] }>,
) {
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
        <StorageProvider>
          <ConfigProvider config={createTuiResolvedConfig(props.config)}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <ToastProvider>{props.children}</ToastProvider>
            </ThemeProvider>
          </ConfigProvider>
        </StorageProvider>
      </TuiAppProvider>
    </TestTuiContexts>
  )
}
