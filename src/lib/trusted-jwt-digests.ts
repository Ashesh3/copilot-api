import crypto from "node:crypto"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

export interface TrustedJwtDigestEntry {
  id: string
  label: string
  digest: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export class TrustedJwtDigestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrustedJwtDigestValidationError"
  }
}

export class TrustedJwtDigestConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrustedJwtDigestConflictError"
  }
}

export interface TrustedJwtDigestStore {
  readonly filePath: string
  list(): Array<TrustedJwtDigestEntry>
  add(input: { label: string; digest: string }): TrustedJwtDigestEntry
  setEnabled(id: string, enabled: boolean): TrustedJwtDigestEntry | null
  remove(id: string): boolean
  findEnabledCredential(rawCredential: string): TrustedJwtDigestEntry | null
  /** Match a raw credential against all records, including disabled entries. */
  matchesCredentialDigest(rawCredential: string): boolean
  containsDigestLiteral(value: string): boolean
  replaceForTest(entries: ReadonlyArray<TrustedJwtDigestEntry>): void
  resetAfterTest(): void
}

interface TrustedJwtDigestFile {
  version: 1
  entries: Array<TrustedJwtDigestEntry>
}

const DIGEST_PATTERN = /^[a-f\d]{64}$/i
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex -- labels must reject ASCII controls
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const MAX_LABEL_LENGTH = 80
const FILE_FIELDS = new Set(["entries", "version"])
const ENTRY_FIELDS = new Set([
  "createdAt",
  "digest",
  "enabled",
  "id",
  "label",
  "updatedAt",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validationError(message: string): never {
  throw new TrustedJwtDigestValidationError(message)
}

function hasOnlyFields(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") {
    return validationError("label must be a string")
  }
  const label = value.trim()
  if (!label) return validationError("label is required")
  if (label.length > MAX_LABEL_LENGTH) {
    return validationError("label must not exceed 80 characters")
  }
  if (CONTROL_CHARACTER_PATTERN.test(label)) {
    return validationError("label must not contain control characters")
  }
  return label
}

function normalizeDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return validationError("digest must be 64 hexadecimal characters")
  }
  return value.toLowerCase()
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return validationError("id must be a UUID")
  }
  return value.toLowerCase()
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    return validationError(`${field} must be an ISO timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return validationError(`${field} must be an ISO timestamp`)
  }
  return value
}

function validateEntry(value: unknown): TrustedJwtDigestEntry {
  if (!isRecord(value)) return validationError("entry must be an object")
  if (!hasOnlyFields(value, ENTRY_FIELDS)) {
    return validationError("entry has invalid fields")
  }
  if (typeof value.enabled !== "boolean") {
    return validationError("enabled must be a boolean")
  }
  return {
    id: validateId(value.id),
    label: normalizeLabel(value.label),
    digest: normalizeDigest(value.digest),
    enabled: value.enabled,
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
    updatedAt: validateTimestamp(value.updatedAt, "updatedAt"),
  }
}

function validateEntries(
  values: ReadonlyArray<unknown>,
): Array<TrustedJwtDigestEntry> {
  const entries: Array<TrustedJwtDigestEntry> = []
  const ids = new Set<string>()
  const digests = new Set<string>()
  for (const value of values) {
    const entry = validateEntry(value)
    if (ids.has(entry.id)) return validationError("duplicate entry id")
    if (digests.has(entry.digest)) {
      return validationError("duplicate entry digest")
    }
    ids.add(entry.id)
    digests.add(entry.digest)
    entries.push(entry)
  }
  return entries
}

function validateFile(value: unknown): TrustedJwtDigestFile {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, FILE_FIELDS)
    || value.version !== 1
    || !Array.isArray(value.entries)
  ) {
    return validationError("invalid trusted JWT digest registry")
  }
  return { version: 1, entries: validateEntries(value.entries) }
}

function cloneEntry(entry: TrustedJwtDigestEntry): TrustedJwtDigestEntry {
  return { ...entry }
}

function cloneEntries(
  entries: ReadonlyArray<TrustedJwtDigestEntry>,
): Array<TrustedJwtDigestEntry> {
  return entries.map((entry) => cloneEntry(entry))
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  )
}

function createTemporaryFilePath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
}

function persistEntries(
  filePath: string,
  entries: ReadonlyArray<TrustedJwtDigestEntry>,
): void {
  const contents = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
  const directory = path.dirname(filePath)
  const temporaryPath = createTemporaryFilePath(filePath)

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    })
    fs.renameSync(temporaryPath, filePath)
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "failed to persist trusted JWT digests",
      )
    }
    throw error
  }
}

function digestCredential(rawCredential: string): Buffer {
  // Random bearer/JWT lookup contract, not human-password verification.
  // lgtm [js/insufficient-password-hash]
  return createHash("sha256").update(rawCredential.trim(), "utf8").digest()
}

function matchesDigest(
  credentialDigest: Buffer,
  entry: TrustedJwtDigestEntry,
): boolean {
  return crypto.timingSafeEqual(
    credentialDigest,
    Buffer.from(entry.digest, "hex"),
  )
}

function matchCredentialEntries(
  rawCredential: string,
  entries: ReadonlyArray<TrustedJwtDigestEntry>,
): Array<TrustedJwtDigestEntry> {
  const credentialDigest = digestCredential(rawCredential)
  return entries.filter((entry) => matchesDigest(credentialDigest, entry))
}

function readEntriesFromDisk(filePath: string): Array<TrustedJwtDigestEntry> {
  try {
    const raw = fs.readFileSync(filePath)
    // @ts-expect-error JSON.parse accepts UTF-8 buffers at runtime; this avoids
    // an unnecessary intermediate string for the complete registry read.
    return validateFile(JSON.parse(raw) as unknown).entries
  } catch (error) {
    if (isMissingFileError(error)) return []
    throw error
  }
}

export function createTrustedJwtDigestStore(
  filePath = PATHS.TRUSTED_JWT_DIGESTS_PATH,
): TrustedJwtDigestStore {
  let cachedEntries: Array<TrustedJwtDigestEntry> | null = null
  let persistenceEnabled = true

  function getEntries(): Array<TrustedJwtDigestEntry> {
    if (cachedEntries !== null) return cachedEntries
    cachedEntries = readEntriesFromDisk(filePath)
    return cachedEntries
  }

  function persist(nextEntries: ReadonlyArray<TrustedJwtDigestEntry>): void {
    if (persistenceEnabled) persistEntries(filePath, nextEntries)
  }

  return {
    filePath,
    list(): Array<TrustedJwtDigestEntry> {
      return cloneEntries(getEntries())
    },
    add(input: { label: string; digest: string }): TrustedJwtDigestEntry {
      const entries = getEntries()
      const label = normalizeLabel(input.label)
      const digest = normalizeDigest(input.digest)
      if (entries.some((entry) => entry.digest === digest)) {
        throw new TrustedJwtDigestConflictError("digest is already registered")
      }
      const timestamp = new Date().toISOString()
      const entry: TrustedJwtDigestEntry = {
        id: randomUUID(),
        label,
        digest,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const nextEntries = [...entries, entry]
      persist(nextEntries)
      cachedEntries = nextEntries
      return cloneEntry(entry)
    },
    setEnabled(id: string, enabled: boolean): TrustedJwtDigestEntry | null {
      if (typeof enabled !== "boolean") {
        return validationError("enabled must be a boolean")
      }
      const entries = getEntries()
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return null
      const entry = entries[index]
      const updated: TrustedJwtDigestEntry = {
        ...entry,
        enabled,
        updatedAt: new Date().toISOString(),
      }
      const nextEntries = entries.map((existing, entryIndex) =>
        entryIndex === index ? updated : existing,
      )
      persist(nextEntries)
      cachedEntries = nextEntries
      return cloneEntry(updated)
    },
    remove(id: string): boolean {
      const entries = getEntries()
      const nextEntries = entries.filter((entry) => entry.id !== id)
      if (nextEntries.length === entries.length) return false
      persist(nextEntries)
      cachedEntries = nextEntries
      return true
    },
    findEnabledCredential(rawCredential: string): TrustedJwtDigestEntry | null {
      const entries = getEntries()
      const candidate = rawCredential.trim().toLowerCase()
      if (entries.some((entry) => entry.digest === candidate)) return null
      const match = matchCredentialEntries(rawCredential, entries).find(
        (entry) => entry.enabled,
      )
      return match ? cloneEntry(match) : null
    },
    matchesCredentialDigest(rawCredential: string): boolean {
      return matchCredentialEntries(rawCredential, getEntries()).length > 0
    },
    containsDigestLiteral(value: string): boolean {
      const candidate = value.trim().toLowerCase()
      return getEntries().some((entry) => entry.digest === candidate)
    },
    replaceForTest(entries: ReadonlyArray<TrustedJwtDigestEntry>): void {
      cachedEntries = validateEntries(entries)
      persistenceEnabled = false
    },
    resetAfterTest(): void {
      cachedEntries = null
      persistenceEnabled = true
    },
  }
}

export const trustedJwtDigestStore: TrustedJwtDigestStore =
  createTrustedJwtDigestStore()
