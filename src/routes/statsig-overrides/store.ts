import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigDynamicConfig = Record<string, unknown>

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}

export interface StatsigOverrideStore {
  readonly filePath: string
  get(): StatsigOverrides
  set(kind: StatsigOverrideKind, name: string, value: unknown): StatsigOverrides
  remove(kind: StatsigOverrideKind, name: string): boolean
  count(): number
  replaceForTest(overrides: StatsigOverrides): void
}

export class StatsigOverrideValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StatsigOverrideValidationError"
  }
}

const BLOCKED_NAMES = new Set(["__proto__", "prototype", "constructor"])

function createStringMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function createEmptyOverrides(): StatsigOverrides {
  return {
    featureGates: createStringMap<boolean>(),
    dynamicConfigs: createStringMap<StatsigDynamicConfig>(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonObject(value: unknown): value is StatsigDynamicConfig {
  return (
    isRecord(value)
    && Object.prototype.toString.call(value) === "[object Object]"
  )
}

function cloneDynamicConfig(value: StatsigDynamicConfig): StatsigDynamicConfig {
  return structuredClone(value)
}

function cloneOverrides(overrides: StatsigOverrides): StatsigOverrides {
  return {
    featureGates: { ...overrides.featureGates },
    dynamicConfigs: Object.fromEntries(
      Object.entries(overrides.dynamicConfigs).map(([name, value]) => [
        name,
        cloneDynamicConfig(value),
      ]),
    ),
  }
}

function normalizeName(name: string): string {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new StatsigOverrideValidationError("name is required")
  }
  if (BLOCKED_NAMES.has(trimmedName)) {
    throw new StatsigOverrideValidationError("name is not allowed")
  }
  return trimmedName
}

function validateFeatureGateValue(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new StatsigOverrideValidationError(
      "feature gate value must be boolean",
    )
  }
  return value
}

function validateDynamicConfigValue(value: unknown): StatsigDynamicConfig {
  if (!isJsonObject(value)) {
    throw new StatsigOverrideValidationError(
      "dynamic config value must be a JSON object",
    )
  }
  return cloneDynamicConfig(value)
}

function validateFeatureGates(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError("featureGates must be an object")
  }

  const featureGates = createStringMap<boolean>()
  for (const [name, gateValue] of Object.entries(value)) {
    featureGates[normalizeName(name)] = validateFeatureGateValue(gateValue)
  }
  return featureGates
}

function validateDynamicConfigs(
  value: unknown,
): Record<string, StatsigDynamicConfig> {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError("dynamicConfigs must be an object")
  }

  const dynamicConfigs = createStringMap<StatsigDynamicConfig>()
  for (const [name, configValue] of Object.entries(value)) {
    dynamicConfigs[normalizeName(name)] =
      validateDynamicConfigValue(configValue)
  }
  return dynamicConfigs
}

function validateOverrides(value: unknown): StatsigOverrides {
  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError(
      "statsig overrides must be an object",
    )
  }

  return {
    featureGates: validateFeatureGates(value.featureGates),
    dynamicConfigs: validateDynamicConfigs(value.dynamicConfigs),
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
}

export function createStatsigOverrideStore(
  filePath = PATHS.STATSIG_OVERRIDES_PATH,
): StatsigOverrideStore {
  let cachedOverrides: StatsigOverrides | null = null
  let persistenceEnabled = true

  function readFromDisk(): StatsigOverrides {
    try {
      const raw = fs.readFileSync(filePath)
      return validateOverrides(JSON.parse(raw.toString("utf8")) as unknown)
    } catch (error) {
      if (isMissingFileError(error)) {
        return createEmptyOverrides()
      }
      throw error
    }
  }

  function getCachedOverrides(): StatsigOverrides {
    cachedOverrides ??= readFromDisk()
    return cachedOverrides
  }

  function persist(overrides: StatsigOverrides): void {
    if (!persistenceEnabled) return

    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(cloneOverrides(overrides), null, 2)}\n`,
      "utf8",
    )
  }

  return {
    filePath,
    get(): StatsigOverrides {
      return cloneOverrides(getCachedOverrides())
    },
    set(
      kind: StatsigOverrideKind,
      name: string,
      value: unknown,
    ): StatsigOverrides {
      const overrides = getCachedOverrides()
      const nextOverrides = cloneOverrides(overrides)
      const normalizedName = normalizeName(name)

      if (kind === "featureGate") {
        nextOverrides.featureGates[normalizedName] =
          validateFeatureGateValue(value)
      } else {
        nextOverrides.dynamicConfigs[normalizedName] =
          validateDynamicConfigValue(value)
      }

      persist(nextOverrides)
      cachedOverrides = nextOverrides
      return cloneOverrides(nextOverrides)
    },
    remove(kind: StatsigOverrideKind, name: string): boolean {
      const overrides = getCachedOverrides()
      const nextOverrides = cloneOverrides(overrides)
      const normalizedName = normalizeName(name)
      const bucket =
        kind === "featureGate" ?
          nextOverrides.featureGates
        : nextOverrides.dynamicConfigs

      if (!Object.hasOwn(bucket, normalizedName)) {
        return false
      }

      if (kind === "featureGate") {
        const { [normalizedName]: _removedFeatureGate, ...restFeatureGates } =
          nextOverrides.featureGates
        nextOverrides.featureGates = restFeatureGates
      } else {
        const {
          [normalizedName]: _removedDynamicConfig,
          ...restDynamicConfigs
        } = nextOverrides.dynamicConfigs
        nextOverrides.dynamicConfigs = restDynamicConfigs
      }

      persist(nextOverrides)
      cachedOverrides = nextOverrides
      return true
    },
    count(): number {
      const overrides = getCachedOverrides()
      return (
        Object.keys(overrides.featureGates).length
        + Object.keys(overrides.dynamicConfigs).length
      )
    },
    replaceForTest(overrides: StatsigOverrides): void {
      cachedOverrides = validateOverrides(overrides)
      persistenceEnabled = false
    },
  }
}

export const statsigOverrideStore: StatsigOverrideStore =
  createStatsigOverrideStore()
