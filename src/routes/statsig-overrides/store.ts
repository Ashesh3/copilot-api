import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigJsonValue =
  | null
  | boolean
  | number
  | string
  | StatsigJsonArray
  | StatsigDynamicConfig
export type StatsigJsonArray = Array<StatsigJsonValue>
export interface StatsigDynamicConfig {
  [key: string]: StatsigJsonValue
}

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
const DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE =
  "dynamic config value must be a JSON object"

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  const prototype = Reflect.getPrototypeOf(value)
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function setJsonObjectValue(
  target: StatsigDynamicConfig,
  key: string,
  value: StatsigJsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function cloneJsonArray(
  value: ReadonlyArray<unknown>,
  seen: Set<object>,
): Array<StatsigJsonValue> {
  if (seen.has(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }

  seen.add(value)
  try {
    const clone: Array<StatsigJsonValue> = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new StatsigOverrideValidationError(
          DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE,
        )
      }
      clone.push(cloneJsonValue(value[index], seen))
    }
    return clone
  } finally {
    seen.delete(value)
  }
}

function cloneJsonObject(
  value: Record<string, unknown>,
  seen: Set<object> = new Set<object>(),
): StatsigDynamicConfig {
  if (!isPlainObject(value) || seen.has(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }

  seen.add(value)
  try {
    const clone: StatsigDynamicConfig = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      setJsonObjectValue(clone, key, cloneJsonValue(nestedValue, seen))
    }
    return clone
  } finally {
    seen.delete(value)
  }
}

function cloneJsonValue(value: unknown, seen: Set<object>): StatsigJsonValue {
  if (value === null) {
    return value
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return cloneJsonArray(value, seen)
  }
  if (isPlainObject(value)) {
    return cloneJsonObject(value, seen)
  }

  throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
}

function cloneDynamicConfig(value: StatsigDynamicConfig): StatsigDynamicConfig {
  return cloneJsonObject(value)
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
  if (!isPlainObject(value)) {
    throw new StatsigOverrideValidationError(DYNAMIC_CONFIG_VALUE_ERROR_MESSAGE)
  }
  return cloneJsonObject(value)
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
