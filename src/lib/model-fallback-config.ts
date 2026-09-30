import { z } from "zod"

import {
  getLoadedSetting,
  getLoadedSettingRevision,
  getLiveSettingRevision,
  readSetting,
  updateSetting,
} from "~/lib/storage/domain-settings"
import { StorageConflictError } from "~/lib/storage/errors"
import { getRequestSnapshot } from "~/lib/storage/request-snapshot"
import { peekStorageRuntime } from "~/lib/storage/runtime"

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[\x21-\x7E]+$/,
    "Model IDs must contain printable ASCII without spaces",
  )
const fallbackRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    sourceModel: modelId,
    targetModel: modelId,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((rule) => rule.sourceModel !== rule.targetModel, {
    message: "Fallback source and target models must differ",
  })

const fallbackConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    conversationAffinity: z.unknown().optional(),
    notifyClient: z.boolean().default(false),
    nativeClientNotice: z.boolean().default(false),
    affinityTtlSeconds: z.unknown().optional(),
    affinityMaxEntries: z.unknown().optional(),
    rules: z.array(fallbackRuleSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>()
    const sources = new Set<string>()
    for (const rule of config.rules) {
      if (ids.has(rule.id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate fallback rule ID",
        })
      }
      if (rule.enabled && sources.has(rule.sourceModel)) {
        context.addIssue({
          code: "custom",
          message: "Only one enabled fallback is allowed per source model",
        })
      }
      ids.add(rule.id)
      if (rule.enabled) sources.add(rule.sourceModel)
    }
  })
  .transform(({ enabled, notifyClient, nativeClientNotice, rules }) => ({
    enabled,
    notifyClient,
    nativeClientNotice,
    rules,
  }))

export type ModelFallbackConfig = z.infer<typeof fallbackConfigSchema>
export type ModelFallbackRule = ModelFallbackConfig["rules"][number]

let testConfig: ModelFallbackConfig | undefined
let testRevision = 0

export function getModelFallbackConfigForRoutingSafety(): ModelFallbackConfig {
  return testConfig || peekStorageRuntime() ?
      getLoadedModelFallbackConfig()
    : validateModelFallbackConfig({})
}

export function validateModelFallbackConfig(
  value: unknown,
): ModelFallbackConfig {
  return fallbackConfigSchema.parse(value)
}

export function getLoadedModelFallbackConfig(): ModelFallbackConfig {
  const value = testConfig ?? getLoadedSetting("model_fallbacks")
  return structuredClone(
    validateModelFallbackConfig(value === undefined ? {} : value),
  )
}

export function getModelFallbackConfigRevision(): number {
  return testConfig ? testRevision : getLiveSettingRevision("model_fallbacks")
}

export function getCapturedModelFallbackConfigRevision(): number {
  return testConfig ? testRevision : getLoadedSettingRevision("model_fallbacks")
}

export async function getModelFallbackConfig(): Promise<ModelFallbackConfig> {
  if (testConfig || getRequestSnapshot()) return getLoadedModelFallbackConfig()
  const value = await readSetting("model_fallbacks")
  return validateModelFallbackConfig(value === undefined ? {} : value)
}

export async function setModelFallbackConfig(
  value: unknown,
  expectedRevision?: number,
): Promise<ModelFallbackConfig> {
  const next = validateModelFallbackConfig(value)
  if (testConfig) {
    assertFallbackRevision(expectedRevision)
    testConfig = next
    testRevision++
  } else {
    await updateSetting("model_fallbacks", () => {
      // updateSetting refreshes the snapshot inside its serialized write slot.
      // The transaction also guards the global revision against peer writers.
      assertFallbackRevision(expectedRevision)
      return next
    })
  }
  return structuredClone(next)
}

function assertFallbackRevision(expected: number | undefined): void {
  if (expected !== undefined && expected !== getModelFallbackConfigRevision())
    throw new StorageConflictError(
      "Fallback settings changed. Refresh and review your draft before saving.",
    )
}

export function setModelFallbackConfigForTest(
  value: ModelFallbackConfig | null,
): void {
  testConfig = value === null ? undefined : validateModelFallbackConfig(value)
  testRevision++
}
