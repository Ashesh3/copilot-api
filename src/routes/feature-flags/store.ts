import { randomUUID } from "node:crypto"
import fs from "node:fs"

import { PATHS } from "~/lib/paths"

export type FeatureFlagValue =
  | boolean
  | string
  | number
  | Record<string, unknown>
export type FeatureFlags = Record<string, FeatureFlagValue>

const FORBIDDEN_FLAG_NAMES = new Set(["__proto__", "constructor", "prototype"])

export class FeatureFlagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeatureFlagValidationError"
  }
}

export function isValidFeatureFlagName(name: string): boolean {
  return (
    name.length > 0 && /^[\w.-]+$/.test(name) && !FORBIDDEN_FLAG_NAMES.has(name)
  )
}

function createFlagMap(): FeatureFlags {
  return Object.create(null) as FeatureFlags
}

function normalizeFlags(raw: unknown): FeatureFlags {
  const result = createFlagMap()
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return result
  }

  for (const [name, value] of Object.entries(raw)) {
    if (!isValidFeatureFlagName(name)) continue
    if (
      typeof value !== "boolean"
      && typeof value !== "string"
      && typeof value !== "number"
      && (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      continue
    }
    try {
      JSON.stringify(value)
    } catch {
      continue
    }
    result[name] = value as FeatureFlagValue
  }
  return result
}

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
let skipPersistForTest = false

function cloneFlags(flags: FeatureFlags): FeatureFlags {
  return Object.assign(createFlagMap(), flags)
}

function readFlagsFromDisk(): FeatureFlags {
  try {
    const raw = fs.readFileSync(PATHS.FEATURE_FLAGS_PATH, "utf8")
    if (!raw.trim()) return createFlagMap()
    return normalizeFlags(JSON.parse(raw) as unknown)
  } catch {
    return createFlagMap()
  }
}

function writeFlagsToDisk(flags: FeatureFlags): void {
  if (skipPersistForTest) return
  const temporaryPath = `${PATHS.FEATURE_FLAGS_PATH}.${process.pid}.${randomUUID()}.tmp`
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(PATHS.APP_DIR, 0o700)
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(flags, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, PATHS.FEATURE_FLAGS_PATH)
    fs.chmodSync(PATHS.FEATURE_FLAGS_PATH, 0o600)
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true })
    throw error
  }
}

export function getFeatureFlags(): FeatureFlags {
  if (!cachedFlags) {
    cachedFlags = Object.assign(
      createFlagMap(),
      DEFAULT_FLAGS,
      readFlagsFromDisk(),
    )
  }
  return cloneFlags(cachedFlags)
}

export function setFeatureFlag(
  name: string,
  value: FeatureFlagValue,
): FeatureFlags {
  const flags = getFeatureFlags()
  if (!isValidFeatureFlagName(name)) {
    throw new FeatureFlagValidationError("Invalid feature flag name")
  }
  try {
    JSON.stringify(value)
  } catch {
    throw new FeatureFlagValidationError(
      "Feature flag value is not serializable",
    )
  }
  flags[name] = value
  writeFlagsToDisk(flags)
  cachedFlags = flags
  return cloneFlags(flags)
}

export function removeFeatureFlag(name: string): boolean {
  if (!isValidFeatureFlagName(name)) return false
  const flags = getFeatureFlags()
  if (!Object.hasOwn(flags, name)) return false
  const { [name]: _, ...rest } = flags
  writeFlagsToDisk(rest)
  cachedFlags = rest
  return true
}

export function setFeatureFlagsForTest(
  flags: FeatureFlags = createFlagMap(),
): void {
  cachedFlags = Object.assign(
    createFlagMap(),
    DEFAULT_FLAGS,
    normalizeFlags(flags),
  )
  skipPersistForTest = true
}
