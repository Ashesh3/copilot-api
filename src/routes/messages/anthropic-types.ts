// Anthropic API Types

export interface AnthropicMessagesPayload extends Record<string, unknown> {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens?: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: Record<string, unknown> & {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: Record<string, unknown> & {
    type: "auto" | "any" | "tool" | "none"
    name?: string
    disable_parallel_tool_use?: boolean
  }
  thinking?: Record<string, unknown> & {
    type: "enabled" | "adaptive"
    budget_tokens?: number
  }
  service_tier?: "auto" | "standard_only"
  output_config?: Record<string, unknown> & {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh"
    format?: Record<string, unknown> & {
      type: string
    }
    task_budget?: Record<string, unknown> & {
      type: "tokens"
      total: number
      remaining?: number
    }
  }
  speed?: "fast"
  cache_control?: AnthropicCacheControl
  fallback_credit_token?: string
}

export interface AnthropicCacheControl extends Record<string, unknown> {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

export interface AnthropicTextBlock extends Record<string, unknown> {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock extends Record<string, unknown> {
  type: "image"
  source:
    | (Record<string, unknown> & {
        type: "base64"
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        data: string
      })
    | (Record<string, unknown> & {
        type: "url"
        url: string
      })
  cache_control?: AnthropicCacheControl
}

/**
 * Anthropic document block — how Claude Code attaches PDFs (base64 source),
 * plain text files (text source) and remote documents (url source).
 */
export interface AnthropicDocumentBlock extends Record<string, unknown> {
  type: "document"
  source:
    | (Record<string, unknown> & {
        type: "base64"
        media_type: string
        data: string
      })
    | (Record<string, unknown> & {
        type: "text"
        media_type?: string
        data: string
      })
    | (Record<string, unknown> & { type: "url"; url: string })
    | (Record<string, unknown> & {
        type: "content"
        content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
      })
  title?: string | null
  context?: string | null
  citations?: (Record<string, unknown> & { enabled?: boolean }) | null
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolReferenceBlock extends Record<string, unknown> {
  type: "tool_reference"
  tool_name: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolResultBlock extends Record<string, unknown> {
  type: "tool_result"
  tool_use_id: string
  content:
    | string
    | Array<
        | AnthropicTextBlock
        | AnthropicImageBlock
        | AnthropicDocumentBlock
        | AnthropicToolReferenceBlock
      >
  is_error?: boolean
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolUseBlock extends Record<string, unknown> {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: AnthropicCacheControl
}

export interface AnthropicThinkingBlock extends Record<string, unknown> {
  type: "thinking"
  thinking: string
  signature?: string
  cache_control?: AnthropicCacheControl
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock

export interface AnthropicUserMessage extends Record<string, unknown> {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage extends Record<string, unknown> {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

export interface AnthropicTool extends Record<string, unknown> {
  type?: string
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
  max_uses?: number
  cache_control?: AnthropicCacheControl
}

export interface AnthropicResponse extends Record<string, unknown> {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: Record<string, unknown> & {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: "standard" | "priority" | "batch"
    cache_creation?: Record<string, unknown> & {
      ephemeral_5m_input_tokens?: number
      ephemeral_1h_input_tokens?: number
    }
    [key: string]: unknown
  }
  copilot_usage?: unknown
  recommended_auto_tier?: "eco" | "balanced"
  stop_details?: Record<string, unknown>
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent extends Record<string, unknown> {
  type: "message_start"
  message: AnthropicResponse & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent
  extends Record<string, unknown> {
  type: "content_block_start"
  index: number
  content_block:
    | AnthropicTextBlock
    | AnthropicToolUseBlock
    | AnthropicThinkingBlock
}

export interface AnthropicContentBlockDeltaEvent
  extends Record<string, unknown> {
  type: "content_block_delta"
  index: number
  delta:
    | AnthropicTextDelta
    | AnthropicInputJsonDelta
    | AnthropicThinkingDelta
    | AnthropicSignatureDelta
}

export interface AnthropicTextDelta extends Record<string, unknown> {
  type: "text_delta"
  text: string
}

export interface AnthropicInputJsonDelta extends Record<string, unknown> {
  type: "input_json_delta"
  partial_json: string
}

export interface AnthropicThinkingDelta extends Record<string, unknown> {
  type: "thinking_delta"
  thinking: string
}

export interface AnthropicSignatureDelta extends Record<string, unknown> {
  type: "signature_delta"
  signature: string
}

export interface AnthropicContentBlockStopEvent
  extends Record<string, unknown> {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent extends Record<string, unknown> {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
    [key: string]: unknown
  }
  usage?: Record<string, unknown> & {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    cache_creation?: Record<string, unknown> & {
      ephemeral_5m_input_tokens?: number
      ephemeral_1h_input_tokens?: number
    }
    [key: string]: unknown
  }
  copilot_usage?: unknown
}

export interface AnthropicMessageStopEvent extends Record<string, unknown> {
  type: "message_stop"
}

export interface AnthropicPingEvent extends Record<string, unknown> {
  type: "ping"
}

export interface AnthropicErrorEvent extends Record<string, unknown> {
  type: "error"
  error: {
    type: string
    message: string
    code?: string
    param?: string
    [key: string]: unknown
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
  toolCallIndexOffset?: 0 | 1
  // Track usage from chunks (may come separately from finish_reason)
  pendingUsage?: {
    prompt_tokens: number
    completion_tokens: number
    cached_tokens: number
  }
  pendingCopilotUsage?: unknown
  pendingRecommendedAutoTier?: "eco" | "balanced"
  // Track finish_reason to defer message_delta until we have usage
  pendingFinishReason?: "stop" | "length" | "tool_calls" | "content_filter"
  // Track if message_delta was already sent
  messageDeltaSent?: boolean
  // Track thinking/reasoning block state (for CAPI reasoning_text)
  thinkingBlockOpen?: boolean
  thinkingBlockIndex?: number
  pendingSignature?: string
}
