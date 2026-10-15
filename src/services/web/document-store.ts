import { randomUUID } from "node:crypto"

import type { WebDocument } from "./types"

interface StoredDocument {
  document: WebDocument
  scope: string
  expires: number
  bytes: number
}
export interface DocumentStoreOptions {
  now?: () => number
  ttlMs?: number
  maxDocumentsPerScope?: number
  maxBytes?: number
}
export class WebDocumentStore {
  private readonly entries = new Map<string, StoredDocument>()
  private bytes = 0
  private readonly options: DocumentStoreOptions
  constructor(options: DocumentStoreOptions = {}) {
    this.options = options
  }
  private prune(): void {
    const now = this.options.now?.() ?? Date.now()
    for (const [ref, entry] of this.entries)
      if (entry.expires <= now) this.remove(ref)
  }
  private remove(ref: string): void {
    const entry = this.entries.get(ref)
    if (entry) {
      this.bytes -= entry.bytes
      this.entries.delete(ref)
    }
  }
  put(scope: string, document: WebDocument): string | null {
    this.prune()
    const bytes = Buffer.byteLength(JSON.stringify(document))
    const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024
    if (bytes > maxBytes) return null
    const sameScope = [...this.entries].filter(
      ([, entry]) => entry.scope === scope,
    )
    const cap = this.options.maxDocumentsPerScope ?? 8
    if (cap < 1) return null
    while (sameScope.length >= cap) {
      const oldest = sameScope.shift()
      if (oldest) this.remove(oldest[0])
    }
    while (this.bytes + bytes > maxBytes && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.remove(oldest)
    }
    const ref = `capi_fetch_${randomUUID().replaceAll("-", "")}`
    this.entries.set(ref, {
      scope,
      document,
      bytes,
      expires:
        (this.options.now?.() ?? Date.now())
        + (this.options.ttlMs ?? 15 * 60_000),
    })
    this.bytes += bytes
    return ref
  }
  get(scope: string, reference: string): WebDocument | undefined {
    this.prune()
    const entry = this.entries.get(reference)
    if (!entry || entry.scope !== scope) return undefined
    this.entries.delete(reference)
    this.entries.set(reference, entry)
    return entry.document
  }
}
export const webDocuments = new WebDocumentStore()
