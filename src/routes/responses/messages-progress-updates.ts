import type {
  AnthropicMessagesPayload,
  AnthropicRedactedThinkingBlock,
  AnthropicThinkingBlock,
} from "~/routes/messages/anthropic-types"
import type { NativeMessagesRequestOptions } from "~/routes/messages/native-handler"

import { inspectHttpError, isHTTPError } from "~/lib/error"
import { canonicalizeAnthropicBeta } from "~/services/copilot/anthropic-request-headers"

/** Beta that returns Claude progress updates as readable thinking text. */
export const THINKING_DISPLAY_UPDATES_BETA =
  "thinking-display-updates-2026-08-18"

/**
 * Text Anthropic puts in the last progress update of an interrupted response.
 * It describes the transport rather than the task, so it is never shown.
 */
export const INTERRUPTED_PROGRESS_UPDATE_TEXT =
  "This part of the response was interrupted before it finished."

/** Separates a progress update from neighbouring visible text. */
export const PROGRESS_UPDATE_SEPARATOR = "\n\n"

/**
 * Under adaptive thinking these models narrate between tool calls in thinking
 * blocks instead of text blocks. The default display returns that narration
 * empty, so clients that render only text show nothing while the model works.
 */
const PROGRESS_UPDATE_MODELS = new Set([
  "claude-opus-5.5",
  "claude-opus-5-5",
  "claude-sonnet-5.5",
  "claude-sonnet-5-5",
])
const REJECTION_RETENTION_MS = 60 * 60 * 1000
const MAX_REMEMBERED_REJECTIONS = 64
const rejectedProgressUpdates = new Map<string, number>()
const DISPLAY_FIELD_ERROR = /\bthinking\.(?:adaptive|enabled)\.display\b/u

type ReasoningBlock = AnthropicThinkingBlock | AnthropicRedactedThinkingBlock

export interface ProgressUpdateRequest {
  readonly nativeOptions: NativeMessagesRequestOptions
  readonly payload: AnthropicMessagesPayload
}

/** Whether the model narrates in thinking blocks under display updates. */
export function isProgressUpdateModel(model: string): boolean {
  return PROGRESS_UPDATE_MODELS.has(model)
}

/** A non-empty thinking text is a progress update unless it is the cut-off notice. */
export function isVisibleProgressUpdate(text: string): boolean {
  return text.trim().length > 0 && text !== INTERRUPTED_PROGRESS_UPDATE_TEXT
}

function progressUpdatesRejected(model: string): boolean {
  const expiresAt = rejectedProgressUpdates.get(model)
  if (expiresAt === undefined) return false
  if (expiresAt > Date.now()) return true
  rejectedProgressUpdates.delete(model)
  return false
}

/** Skip display updates for this model for a while after Copilot rejects them. */
export function rememberProgressUpdatesRejection(model: string): void {
  rejectedProgressUpdates.delete(model)
  if (rejectedProgressUpdates.size >= MAX_REMEMBERED_REJECTIONS) {
    const oldest = rejectedProgressUpdates.keys().next()
    if (!oldest.done) rejectedProgressUpdates.delete(oldest.value)
  }
  rejectedProgressUpdates.set(model, Date.now() + REJECTION_RETENTION_MS)
}

export function resetProgressUpdatesRejectionsForTest(): void {
  rejectedProgressUpdates.clear()
}

function forcesToolUse(payload: AnthropicMessagesPayload): boolean {
  return (
    payload.tool_choice?.type === "any" || payload.tool_choice?.type === "tool"
  )
}

function withProgressUpdates(
  thinking: AnthropicMessagesPayload["thinking"],
): AnthropicMessagesPayload["thinking"] | undefined {
  if (thinking === undefined) {
    return { type: "adaptive", display: "updates" }
  }
  if (thinking.type !== "adaptive" && thinking.type !== "enabled") {
    return undefined
  }
  if (thinking.display !== undefined && thinking.display !== "summarized") {
    return undefined
  }
  return { ...thinking, display: "updates" }
}

/**
 * Ask a Claude 5.5 model to return its narration as readable progress
 * updates. Reasoning stays hidden: under this display the reasoning blocks
 * come back empty and only the narration blocks carry text. Compaction
 * summaries do not ask for updates, so their output stays plain text.
 */
export function requestProgressUpdates(options: {
  readonly compaction?: boolean
  readonly nativeOptions: NativeMessagesRequestOptions
  readonly payload: AnthropicMessagesPayload
}): ProgressUpdateRequest | undefined {
  const { nativeOptions, payload } = options
  if (
    options.compaction
    || !isProgressUpdateModel(payload.model)
    || progressUpdatesRejected(payload.model)
  ) {
    return undefined
  }
  // Thinking cannot accompany forced tool use; never introduce it here.
  if (payload.thinking === undefined && forcesToolUse(payload)) return undefined
  const thinking = withProgressUpdates(payload.thinking)
  if (!thinking) return undefined
  return {
    payload: { ...payload, thinking },
    nativeOptions: {
      ...nativeOptions,
      anthropicBeta: canonicalizeAnthropicBeta(
        [nativeOptions.anthropicBeta, THINKING_DISPLAY_UPDATES_BETA]
          .filter(Boolean)
          .join(","),
      ),
    },
  }
}

/** Copilot rejected the display value or its beta; the request is otherwise fine. */
export async function isProgressUpdatesRejection(
  error: unknown,
): Promise<boolean> {
  if (!isHTTPError(error)) return false
  const inspection = await inspectHttpError(error)
  if (inspection.status !== 400 && inspection.status !== 422) return false
  if (inspection.kind !== "upstream" || inspection.bodyText === undefined) {
    return false
  }
  return (
    inspection.bodyText.includes(THINKING_DISPLAY_UPDATES_BETA)
    || DISPLAY_FIELD_ERROR.test(inspection.bodyText)
  )
}

/**
 * The progress update a replayed reasoning item ends with, if any. Only an
 * envelope written under display updates holds narration the client was
 * shown; other thinking text is reasoning, never repeated as a message.
 */
export function replayedProgressUpdate(envelope: {
  readonly blocks: ReadonlyArray<ReasoningBlock>
  readonly progressUpdates: boolean
}): string | undefined {
  if (!envelope.progressUpdates) return undefined
  const last = envelope.blocks.at(-1)
  if (last?.type !== "thinking") return undefined
  return isVisibleProgressUpdate(last.thinking) ? last.thinking : undefined
}

/** Assembles visible text the way the progress-update stream renders it. */
export class VisibleTextBuilder {
  private text = ""
  private lastWasUpdate: boolean | undefined

  push(segment: string, update: boolean): void {
    if (!segment) return
    if (this.lastWasUpdate !== undefined && (this.lastWasUpdate || update)) {
      this.text += PROGRESS_UPDATE_SEPARATOR
    }
    this.text += segment
    this.lastWasUpdate = update
  }

  toString(): string {
    return this.text
  }
}
