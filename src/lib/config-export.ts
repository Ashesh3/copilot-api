import { zipSync } from "fflate"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"

export const CONFIG_EXPORT_FILENAMES = [
  "config.json",
  "feature_flags.json",
  "statsig_overrides.json",
  "model_redirects.json",
  "model_settings.json",
  "model_routing.json",
  "replacements.json",
  "ip_allowlist.json",
] as const

export interface ConfigExportOptions {
  appDir?: string
  now?: Date
}

export interface ConfigExportArchive {
  filename: string
  zip: Uint8Array<ArrayBuffer>
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0")
}

export function formatConfigExportTimestamp(date: Date): string {
  return [
    padDatePart(date.getDate()),
    padDatePart(date.getMonth() + 1),
    String(date.getFullYear()),
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
  ].join("-")
}

export function getConfigExportFilename(date = new Date()): string {
  return `copilot-api-config-${formatConfigExportTimestamp(date)}.zip`
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
}

export async function createConfigExportZip(
  options: ConfigExportOptions = {},
): Promise<ConfigExportArchive> {
  const appDir = options.appDir ?? PATHS.APP_DIR
  const files: Record<string, Uint8Array> = {}

  for (const filename of CONFIG_EXPORT_FILENAMES) {
    try {
      files[filename] = await fs.readFile(path.join(appDir, filename))
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }
  }

  const zip = zipSync(files)
  return { filename: getConfigExportFilename(options.now), zip }
}
