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
  type ReplacementRule,
} from "~/lib/auto-replace"
import { ensurePaths, PATHS } from "~/lib/paths"

type MenuAction =
  | "list"
  | "add"
  | "remove"
  | "toggle"
  | "test"
  | "clear"
  | "exit"

function formatRule(rule: ReplacementRule, index: number): string {
  const status = rule.enabled ? "✓" : "✗"
  const type = rule.isRegex ? "regex" : "string"
  const system = rule.isSystem ? " [system]" : ""
  const replacement = rule.replacement || "(empty)"
  return `${index + 1}. [${status}] (${type})${system} "${rule.pattern}" → "${replacement}"`
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

  // Validate regex if needed
  if (matchType === "regex") {
    try {
      new RegExp(pattern)
    } catch {
      consola.error(`Invalid regex pattern: ${pattern}`)
      return
    }
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

  const rule = await addReplacement(pattern, replacement, matchType === "regex")

  consola.success(`Added rule: ${rule.id}`)
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

  const result = await applyReplacements(testText)

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
