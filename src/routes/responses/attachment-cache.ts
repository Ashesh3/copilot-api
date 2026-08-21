import type { ParsedDataUri } from "~/lib/attachments"

export interface ResponsesAttachmentCache {
  readonly values: Map<string, ParsedDataUri | null>
}

export function createResponsesAttachmentCache(): ResponsesAttachmentCache {
  return { values: new Map() }
}
