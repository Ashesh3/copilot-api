import type { AttachmentFetchResolver } from "~/lib/attachments"

import { createAttachmentFetchResolver } from "~/lib/attachments"

export interface ResponsesAttachmentCache {
  readonly resolve: AttachmentFetchResolver
}

export function createResponsesAttachmentCache(): ResponsesAttachmentCache {
  return { resolve: createAttachmentFetchResolver() }
}
