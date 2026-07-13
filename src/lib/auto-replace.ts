import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { RE2JS } from "re2js"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { PATHS } from "./paths"

export interface ReplacementRule {
  id: string
  name?: string // Human-readable name/description
  pattern: string
  replacement: string
  isRegex: boolean
  enabled: boolean
  isSystem?: boolean // System rules cannot be deleted by user
}

export class ReplacementValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReplacementValidationError"
  }
}

function validateRuleFields(
  pattern: string,
  options: { isRegex: boolean },
): void {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new ReplacementValidationError("Pattern is required")
  }
  if (options.isRegex) {
    try {
      RE2JS.compile(pattern)
    } catch {
      throw new ReplacementValidationError(
        "Pattern is not valid RE2-compatible syntax",
      )
    }
  }
}

function normalizeStoredRule(value: unknown): ReplacementRule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (
    typeof raw.id !== "string"
    || typeof raw.pattern !== "string"
    || typeof raw.replacement !== "string"
    || typeof raw.isRegex !== "boolean"
    || typeof raw.enabled !== "boolean"
  ) {
    return null
  }
  const name = typeof raw.name === "string" ? raw.name : undefined
  try {
    validateRuleFields(raw.pattern, { isRegex: raw.isRegex })
  } catch {
    return null
  }
  return {
    id: raw.id,
    pattern: raw.pattern,
    replacement: raw.replacement,
    isRegex: raw.isRegex,
    enabled: raw.enabled,
    ...(name ? { name } : {}),
    isSystem: false,
  }
}

// Built-in system replacement that cannot be removed
const SYSTEM_REPLACEMENTS: Array<ReplacementRule> = [
  {
    id: "system-anthropic-billing",
    name: "Remove Anthropic billing header",
    pattern: String.raw`x-anthropic-billing-header:[^\n]*\n?`,
    replacement: "",
    isRegex: true,
    enabled: true,
    isSystem: true,
  },
]

// User-configured replacements (loaded from disk)
let userReplacements: Array<ReplacementRule> = []
let isLoaded = false
let skipPersistForTest = false
let mutationQueue: Promise<void> = Promise.resolve()

function noop(): void {}

async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueue
  let release = noop
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

/**
 * Load user replacements from disk
 */
export async function loadReplacements(): Promise<void> {
  skipPersistForTest = false
  try {
    const data = await fs.readFile(PATHS.REPLACEMENTS_CONFIG_PATH)
    const parsed = JSON.parse(data.toString()) as unknown
    userReplacements =
      Array.isArray(parsed) ?
        parsed
          .map((value) => normalizeStoredRule(value))
          .filter((rule): rule is ReplacementRule => rule !== null)
      : []
    isLoaded = true
    consola.debug(`Loaded ${userReplacements.length} user replacement rules`)
  } catch {
    // File doesn't exist or is invalid - start with empty array
    userReplacements = []
    isLoaded = true
  }
}

/**
 * Save user replacements to disk
 */
export async function saveReplacements(): Promise<void> {
  if (skipPersistForTest) return
  const temporaryPath = `${PATHS.REPLACEMENTS_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
    await fs.chmod(PATHS.APP_DIR, 0o700)
    await fs.writeFile(
      temporaryPath,
      JSON.stringify(userReplacements, null, 2),
      { encoding: "utf8", mode: 0o600 },
    )
    await fs.chmod(temporaryPath, 0o600)
    await fs.rename(temporaryPath, PATHS.REPLACEMENTS_CONFIG_PATH)
    await fs.chmod(PATHS.REPLACEMENTS_CONFIG_PATH, 0o600)
    consola.debug(`Saved ${userReplacements.length} user replacement rules`)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    consola.error("Failed to save replacement rules:", error)
    throw error
  }
}

/**
 * Ensure replacements are loaded before accessing
 */
export async function ensureLoaded(): Promise<void> {
  if (!isLoaded) {
    await loadReplacements()
  }
}

/**
 * Get all replacement rules (system + user)
 */
export async function getAllReplacements(): Promise<Array<ReplacementRule>> {
  await ensureLoaded()
  return [...SYSTEM_REPLACEMENTS, ...userReplacements]
}

/**
 * Get only user-configurable replacements
 */
export async function getUserReplacements(): Promise<Array<ReplacementRule>> {
  await ensureLoaded()
  return userReplacements
}

/**
 * Add a new user replacement rule
 */
export async function addReplacement(
  pattern: string,
  replacement: string,
  options?: { isRegex?: boolean; name?: string },
): Promise<ReplacementRule> {
  return await serializeMutation(async () => {
    const { isRegex = false, name } = options ?? {}
    await ensureLoaded()
    validateRuleFields(pattern, { isRegex })
    const rule: ReplacementRule = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name,
      pattern,
      replacement,
      isRegex,
      enabled: true,
      isSystem: false,
    }
    userReplacements.push(rule)
    await saveReplacements()
    consola.info(`Added replacement rule: "${pattern}" -> "${replacement}"`)
    return rule
  })
}

/**
 * Remove a user replacement rule by ID
 */
export async function removeReplacement(id: string): Promise<boolean> {
  return await serializeMutation(async () => {
    await ensureLoaded()
    const rule = userReplacements.find((r) => r.id === id)
    if (!rule) return false
    if (rule.isSystem) {
      consola.warn("Cannot remove system replacement rule")
      return false
    }

    userReplacements = userReplacements.filter((r) => r.id !== id)
    await saveReplacements()
    consola.info(`Removed replacement rule: ${id}`)
    return true
  })
}

/**
 * Update an existing user replacement rule
 */
export async function updateReplacement(
  id: string,
  updates: {
    name?: string
    pattern?: string
    replacement?: string
    isRegex?: boolean
    enabled?: boolean
  },
): Promise<ReplacementRule | null> {
  return await serializeMutation(async () => {
    await ensureLoaded()

    const rule = userReplacements.find((r) => r.id === id)
    if (!rule) return null
    if (rule.isSystem) {
      consola.warn("Cannot update system replacement rule")
      return null
    }

    const nextPattern = updates.pattern ?? rule.pattern
    const nextIsRegex = updates.isRegex ?? rule.isRegex
    validateRuleFields(nextPattern, { isRegex: nextIsRegex })

    if (updates.name !== undefined) rule.name = updates.name
    if (updates.pattern !== undefined) rule.pattern = updates.pattern
    if (updates.replacement !== undefined)
      rule.replacement = updates.replacement
    if (updates.isRegex !== undefined) rule.isRegex = updates.isRegex
    if (updates.enabled !== undefined) rule.enabled = updates.enabled

    await saveReplacements()
    consola.info(`Updated replacement rule: ${rule.name || rule.id}`)
    return rule
  })
}

/**
 * Toggle a replacement rule on/off
 */
export async function toggleReplacement(
  id: string,
): Promise<ReplacementRule | null> {
  return await serializeMutation(async () => {
    await ensureLoaded()
    const userRule = userReplacements.find((r) => r.id === id)
    if (userRule) {
      userRule.enabled = !userRule.enabled
      await saveReplacements()
      consola.info(
        `Toggled replacement rule ${id}: ${userRule.enabled ? "enabled" : "disabled"}`,
      )
      return userRule
    }

    const systemRule = SYSTEM_REPLACEMENTS.find((r) => r.id === id)
    if (systemRule) consola.warn("Cannot toggle system replacement rule")
    return null
  })
}

/**
 * Clear all user replacements
 */
export async function clearUserReplacements(): Promise<void> {
  await serializeMutation(async () => {
    userReplacements = []
    await saveReplacements()
    consola.info("Cleared all user replacement rules")
  })
}

/**
 * Apply a single replacement rule to text and return info about whether it matched
 */
function applyRule(
  text: string,
  rule: ReplacementRule,
): { result: string; matched: boolean } {
  if (!rule.enabled) return { result: text, matched: false }

  if (rule.isRegex) {
    try {
      const regex = RE2JS.compile(rule.pattern)
      const matcher = regex.matcher(text)
      const chunks: Array<string> = []
      let cursor = 0
      let matched = false

      while (matcher.find()) {
        matched = true
        const start = matcher.start()
        const end = matcher.end()
        const prefix = text.slice(cursor, start)
        const replacement = expandReplacement(rule.replacement, {
          matcher,
          input: text,
          span: { start, end },
        })
        chunks.push(prefix, replacement)
        cursor = end
      }

      if (!matched) return { result: text, matched: false }
      const suffix = text.slice(cursor)
      chunks.push(suffix)
      return { result: chunks.join(""), matched: true }
    } catch {
      consola.warn(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`)
      return { result: text, matched: false }
    }
  }

  if (!text.includes(rule.pattern)) return { result: text, matched: false }
  return {
    result: text.replaceAll(rule.pattern, rule.replacement),
    matched: true,
  }
}

interface ReplacementMatcher {
  group(group?: string | number): string | null
  groupCount(): number
  getNamedGroups(): Record<string, string | null>
}

interface ReplacementExpansion {
  input: string
  matcher: ReplacementMatcher
  span: { start: number; end: number }
}

function expandReplacement(
  template: string,
  { matcher, input, span }: ReplacementExpansion,
): string {
  const namedGroups = matcher.getNamedGroups()
  return template.replaceAll(
    /\$([$&`']|<[^>]+>|\d{1,2})/g,
    (token, reference: string) => {
      if (reference === "$") return "$"
      if (reference === "&") return matcher.group() ?? ""
      if (reference === "`") return input.slice(0, span.start)
      if (reference === "'") return input.slice(span.end)
      if (reference.startsWith("<")) {
        return namedGroups[reference.slice(1, -1)] ?? token
      }
      const group = Number(reference)
      if (group < 1 || group > matcher.groupCount()) return token
      return matcher.group(group) ?? ""
    },
  )
}

export interface ReplacementResult {
  text: string
  appliedRules: Array<string>
}

/**
 * Apply all replacement rules to text
 */
export async function applyReplacements(
  text: string,
): Promise<ReplacementResult> {
  let result = text
  const allRules = await getAllReplacements()
  const appliedRules: Array<string> = []

  for (const rule of allRules) {
    const { result: newResult, matched } = applyRule(result, rule)
    if (matched) {
      result = newResult
      appliedRules.push(rule.name || rule.id)
    }
  }

  return { text: result, appliedRules }
}

export interface PayloadReplacementResult {
  payload: ChatCompletionsPayload
  appliedRules: Array<string>
}

/**
 * Apply replacements to a chat completions payload
 * This modifies message content in place
 */
export async function applyReplacementsToPayload(
  payload: ChatCompletionsPayload,
): Promise<PayloadReplacementResult> {
  const allAppliedRules: Array<string> = []

  const processedMessages = await Promise.all(
    payload.messages.map(async (message) => {
      if (typeof message.content === "string") {
        const { text, appliedRules } = await applyReplacements(message.content)
        allAppliedRules.push(...appliedRules)
        return { ...message, content: text }
      }

      // Handle array content (multimodal)
      if (Array.isArray(message.content)) {
        return {
          ...message,
          content: await Promise.all(
            message.content.map(async (part) => {
              if (
                typeof part === "object"
                && part.type === "text"
                && part.text
              ) {
                const { text, appliedRules } = await applyReplacements(
                  part.text,
                )
                allAppliedRules.push(...appliedRules)
                return { ...part, text }
              }
              return part
            }),
          ),
        }
      }

      return message
    }),
  )

  // Deduplicate rule names
  const uniqueRules = [...new Set(allAppliedRules)]

  return {
    payload: { ...payload, messages: processedMessages },
    appliedRules: uniqueRules,
  }
}

export function setReplacementsForTest(rules: Array<ReplacementRule>): void {
  userReplacements = rules
  isLoaded = true
  skipPersistForTest = true
  mutationQueue = Promise.resolve()
}
