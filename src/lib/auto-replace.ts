import consola from "consola"
import fs from "node:fs/promises"

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

// Built-in system replacement that cannot be removed
const SYSTEM_REPLACEMENTS: Array<ReplacementRule> = [
  {
    id: "system-anthropic-billing",
    name: "Remove Anthropic billing header",
    pattern: "x-anthropic-billing-header:[^\\n]*\\n?",
    replacement: "",
    isRegex: true,
    enabled: true,
    isSystem: true,
  },
]

// User-configured replacements (loaded from disk)
let userReplacements: Array<ReplacementRule> = []
let isLoaded = false

/**
 * Load user replacements from disk
 */
export async function loadReplacements(): Promise<void> {
  try {
    const data = await fs.readFile(PATHS.REPLACEMENTS_CONFIG_PATH)
    const parsed = JSON.parse(data.toString()) as Array<ReplacementRule>
    userReplacements = parsed.filter((r) => !r.isSystem)
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
  try {
    await fs.writeFile(
      PATHS.REPLACEMENTS_CONFIG_PATH,
      JSON.stringify(userReplacements, null, 2),
      "utf8",
    )
    consola.debug(`Saved ${userReplacements.length} user replacement rules`)
  } catch (error) {
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
  isRegex = false,
  name?: string,
): Promise<ReplacementRule> {
  await ensureLoaded()
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
}

/**
 * Remove a user replacement rule by ID
 */
export async function removeReplacement(id: string): Promise<boolean> {
  await ensureLoaded()
  const rule = userReplacements.find((r) => r.id === id)
  if (!rule) {
    return false
  }
  if (rule.isSystem) {
    consola.warn("Cannot remove system replacement rule")
    return false
  }
  userReplacements = userReplacements.filter((r) => r.id !== id)
  await saveReplacements()
  consola.info(`Removed replacement rule: ${id}`)
  return true
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
  await ensureLoaded()

  const rule = userReplacements.find((r) => r.id === id)
  if (!rule) {
    return null
  }

  if (rule.isSystem) {
    consola.warn("Cannot update system replacement rule")
    return null
  }

  if (updates.name !== undefined) rule.name = updates.name
  if (updates.pattern !== undefined) rule.pattern = updates.pattern
  if (updates.replacement !== undefined) rule.replacement = updates.replacement
  if (updates.isRegex !== undefined) rule.isRegex = updates.isRegex
  if (updates.enabled !== undefined) rule.enabled = updates.enabled

  await saveReplacements()
  consola.info(`Updated replacement rule: ${rule.name || rule.id}`)
  return rule
}

/**
 * Toggle a replacement rule on/off
 */
export async function toggleReplacement(
  id: string,
): Promise<ReplacementRule | null> {
  await ensureLoaded()
  // Check user replacements first
  const userRule = userReplacements.find((r) => r.id === id)
  if (userRule) {
    userRule.enabled = !userRule.enabled
    await saveReplacements()
    consola.info(
      `Toggled replacement rule ${id}: ${userRule.enabled ? "enabled" : "disabled"}`,
    )
    return userRule
  }

  // System rules cannot be toggled
  const systemRule = SYSTEM_REPLACEMENTS.find((r) => r.id === id)
  if (systemRule) {
    consola.warn("Cannot toggle system replacement rule")
    return null
  }

  return null
}

/**
 * Clear all user replacements
 */
export async function clearUserReplacements(): Promise<void> {
  userReplacements = []
  await saveReplacements()
  consola.info("Cleared all user replacement rules")
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
      const regex = new RegExp(rule.pattern, "g")
      const result = text.replace(regex, rule.replacement)
      return { result, matched: result !== text }
    } catch {
      consola.warn(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`)
      return { result: text, matched: false }
    }
  }

  const result = text.split(rule.pattern).join(rule.replacement)
  return { result, matched: result !== text }
}

/**
 * Apply all replacement rules to text
 */
export async function applyReplacements(text: string): Promise<string> {
  let result = text
  const allRules = await getAllReplacements()
  const appliedRules: string[] = []

  for (const rule of allRules) {
    const { result: newResult, matched } = applyRule(result, rule)
    if (matched) {
      result = newResult
      appliedRules.push(rule.name || rule.id)
    }
  }

  if (appliedRules.length > 0) {
    consola.info(`Replacements applied: ${appliedRules.join(", ")}`)
  }

  return result
}

/**
 * Apply replacements to a chat completions payload
 * This modifies message content in place
 */
export async function applyReplacementsToPayload(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionsPayload> {
  const processedMessages = await Promise.all(
    payload.messages.map(async (message) => {
      if (typeof message.content === "string") {
        return {
          ...message,
          content: await applyReplacements(message.content),
        }
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
                return {
                  ...part,
                  text: await applyReplacements(part.text),
                }
              }
              return part
            }),
          ),
        }
      }

      return message
    }),
  )

  return {
    ...payload,
    messages: processedMessages,
  }
}
