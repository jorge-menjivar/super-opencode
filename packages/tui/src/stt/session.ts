import path from "path"
import { rename, rm, writeFile } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import type { Session } from "./client"

// The Super STT session token is stored the way opencode stores every other
// credential it holds: a 0600 file in the data directory, alongside auth.json.
//
// It is deliberately not an entry *inside* auth.json, because every
// `type: "api"` record there is merged in as an LLM provider (see provider.ts
// loadAuth), which would surface a phantom "super-stt" provider in the model
// list.
const file = path.join(Global.Path.data, "super-stt.json")

const MODE = 0o600

export async function read(): Promise<Session | undefined> {
  const data = (await Bun.file(file)
    .json()
    .catch(() => undefined)) as Partial<Session> | undefined
  if (!data || typeof data.token !== "string" || !data.token) return undefined
  if (expired(data.expires)) return undefined
  return { token: data.token, scopes: data.scopes ?? [], expires: data.expires }
}

export async function write(session: Session) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(session), { mode: MODE }).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  // rename keeps the temporary file's mode, so the credential is never briefly
  // world-readable at its final path.
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

export async function clear() {
  await rm(file, { force: true }).catch(() => undefined)
}

function expired(value?: string) {
  if (!value) return false
  const at = Date.parse(value)
  if (Number.isNaN(at)) return false
  return at <= Date.now()
}
