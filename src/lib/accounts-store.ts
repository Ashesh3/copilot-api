import consola from "consola"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { isEnvOnlyTokens, PATHS } from "~/lib/paths"

import {
  DEFAULT_GITHUB_DOMAIN,
  type GitHubCredential,
  normalizeGitHubDomain,
} from "./github-instance"

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
  instanceDomain?: string
  label?: string
}

function invalidAccountWarning(index: number, reason: string): void {
  consola.warn(`Invalid github_tokens.json account #${index + 1}: ${reason}`)
}

function parseStoredAccount(
  value: unknown,
  index: number,
): StoredAccount | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidAccountWarning(index, "expected an object; skipping entry")
    return undefined
  }

  const record = value as Record<string, unknown>
  if (typeof record.token !== "string" || !record.token.trim()) {
    invalidAccountWarning(
      index,
      "token must be a non-empty string; skipping entry",
    )
    return undefined
  }

  if (record.label !== undefined && typeof record.label !== "string") {
    invalidAccountWarning(index, "label must be a string; skipping entry")
    return undefined
  }

  let instanceDomain: string | undefined
  if (record.instanceDomain !== undefined) {
    if (typeof record.instanceDomain !== "string") {
      invalidAccountWarning(
        index,
        "instanceDomain must be a string; skipping entry",
      )
      return undefined
    }
    try {
      instanceDomain = normalizeGitHubDomain(record.instanceDomain)
    } catch {
      invalidAccountWarning(index, "instanceDomain is invalid; skipping entry")
      return undefined
    }
  }

  const label = record.label?.trim()
  return {
    token: record.token.trim(),
    ...(instanceDomain && instanceDomain !== DEFAULT_GITHUB_DOMAIN ?
      { instanceDomain }
    : {}),
    ...(label ? { label } : {}),
  }
}

function parseStoredAccounts(raw: string): Array<StoredAccount> | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    consola.warn(
      "Invalid github_tokens.json: expected valid JSON; checking legacy token storage",
    )
    return undefined
  }

  if (!Array.isArray(value)) {
    consola.warn(
      "Invalid github_tokens.json: expected an array; checking legacy token storage",
    )
    return undefined
  }

  const accounts: Array<StoredAccount> = []
  for (const [index, entry] of value.entries()) {
    const account = parseStoredAccount(entry, index)
    if (account) accounts.push(account)
  }
  return accounts
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
    const accounts = parseStoredAccounts(raw)
    if (accounts) return accounts
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

  const directory = path.dirname(PATHS.GITHUB_TOKENS_PATH)
  const temporaryPath = `${PATHS.GITHUB_TOKENS_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700).catch(() => undefined)
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(accounts, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
    await fs.chmod(temporaryPath, 0o600).catch(() => undefined)
    await fs.rename(temporaryPath, PATHS.GITHUB_TOKENS_PATH)
    await fs.chmod(PATHS.GITHUB_TOKENS_PATH, 0o600).catch(() => undefined)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

/**
 * Add a token to the store. Returns the updated list.
 */
export async function addAccount(
  token: string,
  label?: string,
  instanceDomain = DEFAULT_GITHUB_DOMAIN,
): Promise<Array<StoredAccount>> {
  const accounts = await loadAccounts()
  const normalizedDomain = normalizeGitHubDomain(instanceDomain)

  // Deduplicate
  if (
    accounts.some(
      (account) =>
        account.token === token
        && normalizeGitHubDomain(
          account.instanceDomain ?? DEFAULT_GITHUB_DOMAIN,
        ) === normalizedDomain,
    )
  ) {
    consola.warn("Token already exists in accounts store")
    return accounts
  }

  accounts.push({
    token,
    ...(normalizedDomain === DEFAULT_GITHUB_DOMAIN ?
      {}
    : { instanceDomain: normalizedDomain }),
    ...(label ? { label } : {}),
  })
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

export async function getStoredCredentials(): Promise<Array<GitHubCredential>> {
  const accounts = await loadAccounts()
  return accounts.map((account) => ({
    instanceDomain: normalizeGitHubDomain(
      account.instanceDomain ?? DEFAULT_GITHUB_DOMAIN,
    ),
    token: account.token,
  }))
}
