import { homedir } from "node:os"
import { join, resolve } from "node:path"

export interface StorageConfig {
  readonly kind: "sqlite"
  readonly path: string
}

export function resolveStorageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StorageConfig {
  const directory =
    env.DATA_DIR?.trim() || join(homedir(), ".local", "share", "copilot-api")
  const isLocalWindowsNamespace =
    process.platform === "win32"
    && /^\\\\[?.]\\(?:[a-z]:\\|Volume\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\}\\)/i.test(
      directory,
    )
  if (
    directory.includes("\0")
    || /^[a-z][\w+.-]*:\/\//i.test(directory)
    || (/^[\\/]{2}/.test(directory) && !isLocalWindowsNamespace)
  )
    throw new Error("DATA_DIR must be a local directory")
  return Object.freeze({
    kind: "sqlite",
    path: join(resolve(directory), "copilot-api.sqlite"),
  })
}
