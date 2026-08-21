import type {
  EvaluatedEndpointCandidate,
  EvaluatedEndpointSelection,
  EndpointRouteFailure,
} from "~/lib/endpoint-routing"
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

import { createResponsesAttachmentCache } from "./attachment-cache"
import {
  adaptResponsesToMessagesCandidate,
  type ResponsesMessagesCandidate,
} from "./messages-bridge"
import {
  adaptResponsesToChatCandidate,
  type ResponsesChatCandidate,
} from "./responses-chat-adapter"

export type ResponsesNativeCandidate = EvaluatedEndpointCandidate<
  "/responses",
  ResponsesPayload
>

export type ResponsesEndpointCandidate =
  | ResponsesNativeCandidate
  | ResponsesChatCandidate
  | ResponsesMessagesCandidate

export interface PreparedResponsesCandidates {
  readonly chat: ResponsesChatCandidate
  readonly messages: ResponsesMessagesCandidate
  readonly native: ResponsesNativeCandidate
  readonly ordered: ReadonlyArray<ResponsesEndpointCandidate>
}

export interface PrepareResponsesCandidatesOptions {
  readonly adaptationSource: ResponsesWireBody
  readonly finalReasoningEffort?: string | number
  readonly nativeBody: FinalizedNativeResponsesRequest
  readonly preservedSource: PreparedResponsesSource
  readonly selectedModel: Model | undefined
  readonly signal?: AbortSignal
}

export async function prepareResponsesCandidates(
  options: PrepareResponsesCandidatesOptions,
): Promise<PreparedResponsesCandidates> {
  const finalModel = options.adaptationSource.model
  const attachmentCache = createResponsesAttachmentCache()
  const native: ResponsesNativeCandidate = {
    endpoint: "/responses",
    reason: "endpoint_unavailable",
    payload: structuredClone(options.nativeBody.body),
    check: createEvaluatedTranslationCheck([]),
  }
  const chat = await adaptResponsesToChatCandidate({
    finalModel,
    finalReasoningEffort: options.finalReasoningEffort,
    signal: options.signal,
    source: structuredClone(options.adaptationSource),
    attachmentCache,
  })
  const messages = await adaptResponsesToMessagesCandidate({
    finalModel,
    finalReasoningEffort: options.finalReasoningEffort,
    signal: options.signal,
    source: structuredClone(options.adaptationSource),
    attachmentCache,
  })
  // Touch the preserved source only to assert cloneability at this boundary;
  // adapters consume the route-neutral clone, never the native-finalized body.
  structuredClone(options.preservedSource.source)
  return { native, chat, messages, ordered: [native, chat, messages] }
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
      [
        options.candidates.native,
        options.candidates.messages,
        options.candidates.chat,
      ]
    : options.candidates.ordered
  return selectEvaluatedCopilotCandidate({
    source: "responses",
    support: getModelEndpointSupport(options.selectedModel),
    candidates: ordered,
  })
}
