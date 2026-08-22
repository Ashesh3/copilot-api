import type { AttachmentFetchResolver } from "~/lib/attachments"

import { createAttachmentFetchResolver } from "~/lib/attachments"

export interface ResponsesAttachmentCache {
  readonly resolve: AttachmentFetchResolver
}

export function createResponsesAttachmentCache(options?: {
  readonly resolveRemote?: boolean
}): ResponsesAttachmentCache {
  return {
    resolve:
      options?.resolveRemote === false ?
        ({ signal }) => {
          signal?.throwIfAborted()
          return Promise.resolve(null)
        }
      : createAttachmentFetchResolver(),
  }
}
