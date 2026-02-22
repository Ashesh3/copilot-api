import { defineCommand } from "citty"
import consola from "consola"

import {
  addReplacement,
  applyReplacements,
  clearUserReplacements,
  getAllReplacements,
  getUserReplacements,
  removeReplacement,
  toggleReplacement,
  updateReplacement,
  type ReplacementRule,
} from "~/lib/auto-replace"
import { ensurePaths, PATHS } from "~/lib/paths"

type MenuAction =
  | "list"
  | "add"
  | "edit"
  | "remove"
  | "toggle"
  | "test"
  | "clear"
  | "exit"

function formatRule(rule: ReplacementRule, index: number): string {
  const status = rule.enabled ? "✓" : "✗"
  const type = rule.isRegex ? "regex" : "string"
  const system = rule.isSystem ? " [system]" : ""
  const name = rule.name ? ` "${rule.name}"` : ""
  const replacement = rule.replacement || "(empty)"
  return `${index + 1}. [${status}] (${type})${system}${name} "${rule.pattern}" → "${replacement}"`
}

function isValidPatternForMatchType(
  pattern: string,
  matchType: "string" | "regex",
): boolean {
  if (matchType !== "regex") return true
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

async function listReplacements(): Promise<void> {
  const all = await getAllReplacements()

  if (all.length === 0) {
    consola.info("No replacement rules configured.")
    return
  }

  consola.info("\n📋 Replacement Rules:\n")
  for (const [i, element] of all.entries()) {
    console.log(formatRule(element, i))
  }
  console.log()
}

async function addNewReplacement(): Promise<void> {
  const name = await consola.prompt("Name (optional, short description):", {
    type: "text",
    default: "",
  })

  if (typeof name === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const matchType = await consola.prompt("Match type:", {
    type: "select",
    options: [
      { label: "String (exact match)", value: "string" },
      { label: "Regex (regular expression)", value: "regex" },
    ],
  })

  if (typeof matchType === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const pattern = await consola.prompt("Pattern to match:", {
    type: "text",
  })

  if (typeof pattern === "symbol" || !pattern) {
    consola.info("Cancelled.")
    return
  }

  if (!isValidPatternForMatchType(pattern, matchType as "string" | "regex")) {
    consola.error(`Invalid regex pattern: ${pattern}`)
    return
  }

  const replacement = await consola.prompt(
    "Replacement text (leave empty to delete matches):",
    {
      type: "text",
      default: "",
    },
  )

  if (typeof replacement === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = await addReplacement(pattern, replacement, {
    isRegex: matchType === "regex",
    name: name || undefined,
  })

  consola.success(`Added rule: ${rule.name || rule.id}`)
}

async function editExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to edit.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to edit:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = userRules.find((r) => r.id === selected)
  if (!rule) {
    consola.error("Rule not found.")
    return
  }

  consola.info(`\nEditing rule: ${rule.name || rule.id}`)
  consola.info("Press Enter to keep current value.\n")

  const name = await consola.prompt("Name:", {
    type: "text",
    default: rule.name || "",
  })

  if (typeof name === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const matchType = await consola.prompt("Match type:", {
    type: "select",
    options: [
      { label: "String (exact match)", value: "string" },
      { label: "Regex (regular expression)", value: "regex" },
    ],
    initial: rule.isRegex ? "regex" : "string",
  })

  if (typeof matchType === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const pattern = await consola.prompt("Pattern to match:", {
    type: "text",
    default: rule.pattern,
  })

  if (typeof pattern === "symbol" || !pattern) {
    consola.info("Cancelled.")
    return
  }

  if (!isValidPatternForMatchType(pattern, matchType as "string" | "regex")) {
    consola.error(`Invalid regex pattern: ${pattern}`)
    return
  }

  const replacement = await consola.prompt("Replacement text:", {
    type: "text",
    default: rule.replacement,
  })

  if (typeof replacement === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const updated = await updateReplacement(selected, {
    name: name || undefined,
    pattern,
    replacement,
    isRegex: matchType === "regex",
  })

  if (updated) {
    consola.success(`Updated rule: ${updated.name || updated.id}`)
  } else {
    consola.error("Failed to update rule.")
  }
}

async function removeExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to remove.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to remove:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const success = await removeReplacement(selected)
  if (success) {
    consola.success("Rule removed.")
  } else {
    consola.error("Failed to remove rule.")
  }
}

async function toggleExistingReplacement(): Promise<void> {
  const userRules = await getUserReplacements()

  if (userRules.length === 0) {
    consola.info("No user rules to toggle.")
    return
  }

  const options = userRules.map((rule, i) => ({
    label: formatRule(rule, i),
    value: rule.id,
  }))

  const selected = await consola.prompt("Select rule to toggle:", {
    type: "select",
    options,
  })

  if (typeof selected === "symbol") {
    consola.info("Cancelled.")
    return
  }

  const rule = await toggleReplacement(selected)
  if (rule) {
    consola.success(`Rule ${rule.enabled ? "enabled" : "disabled"}.`)
  } else {
    consola.error("Failed to toggle rule.")
  }
}

async function testReplacements(): Promise<void> {
  const testText = await consola.prompt("Enter text to test replacements:", {
    type: "text",
  })

  if (typeof testText === "symbol" || !testText) {
    consola.info("Cancelled.")
    return
  }

  const { text: result } = await applyReplacements(testText)

  consola.info("\n📝 Original:")
  console.log(testText)
  consola.info("\n✨ After replacements:")
  console.log(result)
  console.log()
}

async function clearAllReplacements(): Promise<void> {
  const confirm = await consola.prompt(
    "Are you sure you want to clear all user replacements?",
    {
      type: "confirm",
      initial: false,
    },
  )

  if (confirm) {
    await clearUserReplacements()
    consola.success("All user replacements cleared.")
  } else {
    consola.info("Cancelled.")
  }
}

async function mainMenu(): Promise<void> {
  consola.info(`\n🔧 Copilot API - Replacement Configuration`)
  consola.info(`Config file: ${PATHS.REPLACEMENTS_CONFIG_PATH}\n`)

  let running = true

  while (running) {
    const action = await consola.prompt("What would you like to do?", {
      type: "select",
      options: [
        { label: "📋 List all rules", value: "list" as MenuAction },
        { label: "➕ Add new rule", value: "add" as MenuAction },
        { label: "✏️  Edit rule", value: "edit" as MenuAction },
        { label: "➖ Remove rule", value: "remove" as MenuAction },
        { label: "🔄 Toggle rule on/off", value: "toggle" as MenuAction },
        { label: "🧪 Test replacements", value: "test" as MenuAction },
        { label: "🗑️  Clear all user rules", value: "clear" as MenuAction },
        { label: "🚪 Exit", value: "exit" as MenuAction },
      ],
    })

    if (typeof action === "symbol") {
      break
    }

    switch (action) {
      case "list": {
        await listReplacements()
        break
      }
      case "add": {
        await addNewReplacement()
        break
      }
      case "edit": {
        await editExistingReplacement()
        break
      }
      case "remove": {
        await removeExistingReplacement()
        break
      }
      case "toggle": {
        await toggleExistingReplacement()
        break
      }
      case "test": {
        await testReplacements()
        break
      }
      case "clear": {
        await clearAllReplacements()
        break
      }
      case "exit": {
        running = false
        break
      }
      default: {
        break
      }
    }
  }

  consola.info("Goodbye! 👋")
}

export const config = defineCommand({
  meta: {
    name: "config",
    description: "Configure replacement rules interactively",
  },
  run: async () => {
    await ensurePaths()
    await mainMenu()
  },
})
