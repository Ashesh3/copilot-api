import consola from "consola"
import fs from "node:fs/promises"

import { isEnvOnlyTokens, PATHS } from "~/lib/paths"

/**
 * Persistent storage for GitHub account tokens.
 *
 * File format (github_tokens.json):
 * [
 *   { "token": "ghu_...", "label": "personal" },
 *   { "token": "ghu_...", "label": "work" }
 * ]
 *
 * Backwards-compatible: on first load, migrates the legacy single-token
 * file (github_token) into the new format.
 */

export interface StoredAccount {
  token: string
  label?: string
}

async function readFile(): Promise<string | undefined> {
  try {
    const content = await fs.readFile(PATHS.GITHUB_TOKENS_PATH, "utf8")
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

async function readLegacyToken(): Promise<string | undefined> {
  try {
    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Load all stored accounts. Migrates legacy single-token file if needed.
 */
export async function loadAccounts(): Promise<Array<StoredAccount>> {
  if (isEnvOnlyTokens()) return []

  const raw = await readFile()

  if (raw) {
    try {
      return JSON.parse(raw) as Array<StoredAccount>
    } catch {
      consola.warn("Invalid github_tokens.json, starting fresh")
    }
  }

  // Migration: check legacy single-token file
  const legacyToken = await readLegacyToken()
  if (legacyToken) {
    const accounts: Array<StoredAccount> = [{ token: legacyToken }]
    await saveAccounts(accounts)
    consola.debug("Migrated legacy github_token to github_tokens.json")
    return accounts
  }

  return []
}

/**
 * Save accounts to disk.
 */
export async function saveAccounts(
  accounts: Array<StoredAccount>,
): Promise<void> {
  if (isEnvOnlyTokens()) {
    consola.debug("Env-only token mode: skipping accounts file write")
    return
  }
  await fs.writeFile(
    PATHS.GITHUB_TOKENS_PATH,
    JSON.stringify(accounts, null, 2),
  )
}

/**
 * Add a token to the store. Returns the updated list.
 */
export async function addAccount(
  token: string,
  label?: string,
): Promise<Array<StoredAccount>> {
  const accounts = await loadAccounts()

  // Deduplicate
  if (accounts.some((a) => a.token === token)) {
    consola.warn("Token already exists in accounts store")
    return accounts
  }

  accounts.push({ token, label })
  await saveAccounts(accounts)
  return accounts
}

/**
 * Remove a token by index. Returns the updated list.
 */
export async function removeAccount(
  index: number,
): Promise<Array<StoredAccount>> {
  const accounts = await loadAccounts()
  if (index < 0 || index >= accounts.length) {
    consola.warn("Invalid account index")
    return accounts
  }
  accounts.splice(index, 1)
  await saveAccounts(accounts)
  return accounts
}

/**
 * Get all stored tokens as a flat array (for startup loading).
 */
export async function getStoredTokens(): Promise<Array<string>> {
  const accounts = await loadAccounts()
  return accounts.map((a) => a.token)
}
