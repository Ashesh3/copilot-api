import type { TranslationFinding } from "~/lib/endpoint-routing"

import { snapshotPlainDataRecord } from "~/lib/plain-data-snapshot"

export interface PreparedGoogleRequest {
  readonly source: Readonly<Record<string, unknown>>
  readonly findings: ReadonlyArray<TranslationFinding>
}

export class InvalidGoogleRequestBodyError extends Error {
  constructor() {
    super("Invalid Google request body")
    this.name = "InvalidGoogleRequestBodyError"
  }
}

export function prepareGoogleRequest(payload: unknown): PreparedGoogleRequest {
  const source = snapshotPlainDataRecord(payload)
  if (!source) throw new InvalidGoogleRequestBodyError()
  return { source, findings: [] }
}

export function googleRecordEntries(
  value: unknown,
  onMalformed: () => void,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (value === undefined || value === null) return []
  if (isRecord(value)) return [value]
  if (!Array.isArray(value)) {
    onMalformed()
    return []
  }
  const records: Array<Readonly<Record<string, unknown>>> = []
  for (const entry of value) {
    if (isRecord(entry)) records.push(entry)
    else onMalformed()
  }
  return records
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
