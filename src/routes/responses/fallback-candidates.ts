import type {
  EvaluatedEndpointCandidate,
  EvaluatedEndpointSelection,
  EndpointRouteFailure,
} from "~/lib/endpoint-routing"
import type { ModelRedirectVerbosity } from "~/lib/model-redirect"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"
import type {
  FinalizedNativeResponsesRequest,
  PreparedResponsesSource,
  ResponsesWireBody,
} from "~/services/copilot/responses-contract"

import {
  createEvaluatedTranslationCheck,
  getModelEndpointSupport,
  selectEvaluatedCopilotCandidate,
} from "~/lib/endpoint-routing"
import { normalizeResponsesAttachmentsForDispatch } from "~/services/copilot/responses-attachments"

import { createResponsesAttachmentCache } from "./attachment-cache"
import {
  adaptResponsesToMessagesCandidate,
  type ResponsesMessagesCandidate,
} from "./messages-bridge"
import {
  adaptResponsesToChatCandidate,
  type ResponsesChatCandidate,
} from "./responses-chat-adapter"
import { applyResponsesVerbosity } from "./utils"

export type ResponsesNativeCandidate = EvaluatedEndpointCandidate<
  "/responses",
  ResponsesPayload
> & {
  readonly prepareForDispatch: () => Promise<void>
}

export type ResponsesEndpointCandidate =
  | ResponsesNativeCandidate
  | ResponsesChatCandidate
  | ResponsesMessagesCandidate

export interface PreparedResponsesCandidates {
  readonly chat?: ResponsesChatCandidate
  readonly messages?: ResponsesMessagesCandidate
  readonly native: ResponsesNativeCandidate
  readonly ordered: ReadonlyArray<ResponsesEndpointCandidate>
}

export interface PrepareResponsesCandidatesOptions {
  readonly adaptationSource: ResponsesWireBody
  readonly finalReasoningEffort?: string | number
  readonly nativeBody: FinalizedNativeResponsesRequest
  readonly preservedSource: PreparedResponsesSource
  readonly resolveRemoteAttachments?: boolean
  readonly responsesVerbosity?: ModelRedirectVerbosity
  readonly selectedModel: Model | undefined
  readonly signal?: AbortSignal
}

export async function prepareResponsesCandidates(
  options: PrepareResponsesCandidatesOptions,
): Promise<PreparedResponsesCandidates> {
  const finalModel = options.adaptationSource.model
  const attachmentCache = createResponsesAttachmentCache({
    resolveRemote: options.resolveRemoteAttachments,
  })
  const support = getModelEndpointSupport(options.selectedModel)
  const nativePayload = structuredClone(options.nativeBody.body)
  applyResponsesVerbosity(nativePayload, options.responsesVerbosity)
  let nativePreparation: Promise<void> | undefined
  const native: ResponsesNativeCandidate = {
    endpoint: "/responses",
    reason: "endpoint_unavailable",
    payload: nativePayload,
    check: createEvaluatedTranslationCheck([]),
    prepareForDispatch: () => {
      // Defer native media work until real dispatch, then reuse any remote
      // resources fetched while evaluating translated candidates.
      nativePreparation ??= normalizeResponsesAttachmentsForDispatch(
        nativePayload,
        {
          signal: options.signal,
          resolveAttachment: attachmentCache.resolve,
        },
      )
      return nativePreparation
    },
  }
  const chat =
    support.chat ?
      await adaptResponsesToChatCandidate({
        finalModel,
        finalReasoningEffort: options.finalReasoningEffort,
        signal: options.signal,
        source: structuredClone(options.adaptationSource),
        attachmentCache,
      })
    : undefined
  const messages =
    support.messages ?
      await adaptResponsesToMessagesCandidate({
        finalModel,
        finalReasoningEffort: options.finalReasoningEffort,
        signal: options.signal,
        source: structuredClone(options.adaptationSource),
        attachmentCache,
      })
    : undefined
  // Touch the preserved source only to assert cloneability at this boundary;
  // adapters consume the route-neutral clone, never the native-finalized body.
  structuredClone(options.preservedSource.source)
  const ordered: Array<ResponsesEndpointCandidate> = []
  if (support.responses) ordered.push(native)
  if (chat) ordered.push(chat)
  if (messages) ordered.push(messages)
  return { native, chat, messages, ordered }
}

export function selectResponsesCandidate(options: {
  readonly candidates: PreparedResponsesCandidates
  readonly selectedModel: Model | undefined
}):
  | EvaluatedEndpointSelection<ResponsesEndpointCandidate>
  | EndpointRouteFailure {
  const hasFileAttachment =
    Array.isArray(options.candidates.native.payload.input)
    && options.candidates.native.payload.input.some((item) => {
      if (typeof item !== "object") return false
      const content = (item as Record<string, unknown>).content
      return (
        Array.isArray(content)
        && content.some(
          (part) =>
            part
            && typeof part === "object"
            && (part as Record<string, unknown>).type === "input_file",
        )
      )
    })
  const ordered =
    hasFileAttachment ?
      [...options.candidates.ordered].sort((left, right) => {
        const priority = {
          "/responses": 0,
          "/v1/messages": 1,
          "/chat/completions": 2,
        } as const
        return priority[left.endpoint] - priority[right.endpoint]
      })
    : options.candidates.ordered
  return selectEvaluatedCopilotCandidate({
    source: "responses",
    support: getModelEndpointSupport(options.selectedModel),
    candidates: ordered,
  })
}
