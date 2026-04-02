import fs from "node:fs"

import { PATHS } from "~/lib/paths"

export type FeatureFlagValue =
  | boolean
  | string
  | number
  | Record<string, unknown>
export type FeatureFlags = Record<string, FeatureFlagValue>

const DEFAULT_FLAGS: FeatureFlags = {
  // Enable the env-less bridge (v2 protocol) for Remote Control
  tengu_bridge_repl_v2: true,
  // Enable bridge/Remote Control entitlement
  tengu_ccr_bridge: true,
  // Enable voice mode
  tengu_amber_quartz_disabled: false,
  // Enable remote TUI backend
  tengu_remote_backend: true,
}

let cachedFlags: FeatureFlags | null = null

function readFlagsFromDisk(): FeatureFlags {
  try {
    const raw = fs.readFileSync(PATHS.FEATURE_FLAGS_PATH, "utf8")
    if (!raw.trim()) return {}
    return JSON.parse(raw) as FeatureFlags
  } catch {
    return {}
  }
}

function writeFlagsToDisk(flags: FeatureFlags): void {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.writeFileSync(
    PATHS.FEATURE_FLAGS_PATH,
    `${JSON.stringify(flags, null, 2)}\n`,
    "utf8",
  )
}

export function getFeatureFlags(): FeatureFlags {
  cachedFlags ??= { ...DEFAULT_FLAGS, ...readFlagsFromDisk() }
  return cachedFlags
}

export function setFeatureFlag(
  name: string,
  value: FeatureFlagValue,
): FeatureFlags {
  const flags = getFeatureFlags()
  flags[name] = value
  cachedFlags = flags
  writeFlagsToDisk(flags)
  return flags
}

export function removeFeatureFlag(name: string): boolean {
  const flags = getFeatureFlags()
  if (!Object.hasOwn(flags, name)) return false
  const { [name]: _, ...rest } = flags
  cachedFlags = rest
  writeFlagsToDisk(rest)
  return true
}
