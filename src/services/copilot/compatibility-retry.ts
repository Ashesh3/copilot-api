export type CompatibilityRetryEndpoint =
  | "/chat/completions"
  | "/responses"
  | "/v1/messages"

export type CompatibilityRetryKind =
  | "encrypted_compaction_verification"
  | "tool_choice_without_tools"
  | "unsupported_temperature"
  | "unsupported_top_p"
  | "invalid_thinking_signature"

export type CompatibilityRetryDecision =
  | { kind: "none" }
  | {
      kind: CompatibilityRetryKind
      normalize: (body: Record<string, unknown>) => boolean
    }

const TOOL_CHOICE_WITHOUT_TOOLS_MESSAGE =
  "Invalid request content: A tool_choice was set on the request but no tools were specified."
const UNSUPPORTED_TEMPERATURE_MESSAGE =
  "Unsupported parameter: 'temperature' is not supported with this model."
const UNSUPPORTED_TOP_P_MESSAGE =
  "Unsupported parameter: 'top_p' is not supported with this model."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function hasEncryptedCompaction(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.input)
    && body.input.some(
      (item) =>
        isRecord(item)
        && item.type === "compaction"
        && typeof item.encrypted_content === "string"
        && item.encrypted_content.length > 0,
    )
  )
}

function matchesEncryptedCompactionError(
  code: unknown,
  message: unknown,
): boolean {
  if (code !== "invalid_encrypted_content" && code !== "invalid_request_body") {
    return false
  }
  if (typeof message !== "string") return false
  const normalized = message.toLowerCase().replaceAll(/\s+/gu, " ")
  return /\bencrypted content(?: \S+)? could not be (?:verified|decrypted|parsed)/u.test(
    normalized,
  )
}

function removeTemperature(body: Record<string, unknown>): boolean {
  if (!hasOwn(body, "temperature")) return false
  delete body.temperature
  return true
}

function removeTopP(body: Record<string, unknown>): boolean {
  if (!hasOwn(body, "top_p")) return false
  delete body.top_p
  return true
}

function removeToolChoiceWithoutTools(body: Record<string, unknown>): boolean {
  const toolsAreAbsentOrEmpty =
    !hasOwn(body, "tools")
    || (Array.isArray(body.tools) && body.tools.length === 0)
  if (!hasOwn(body, "tool_choice") || !toolsAreAbsentOrEmpty) return false
  delete body.tool_choice
  delete body.parallel_tool_calls
  return true
}

export function stripAssistantThinkingBlocks(
  body: Record<string, unknown>,
): boolean {
  if (!Array.isArray(body.messages)) return false
  let removed = false
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "assistant") continue
    if (!Array.isArray(message.content)) continue
    const retained = message.content.filter(
      (block) => !isRecord(block) || block.type !== "thinking",
    )
    if (retained.length === message.content.length) continue
    message.content = retained
    removed = true
  }
  return removed
}

function hasAssistantThinkingBlock(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some(
    (message) =>
      isRecord(message)
      && message.role === "assistant"
      && Array.isArray(message.content)
      && message.content.some(
        (block) => isRecord(block) && block.type === "thinking",
      ),
  )
}

function isNativeThinkingSignatureError(
  parsed: Record<string, unknown>,
  error: Record<string, unknown>,
): boolean {
  return (
    (parsed.type === "error"
      && error.type === "invalid_request_error"
      && error.message === "Invalid signature in thinking block")
    || (error.code === "invalid_request_body"
      && error.message === "Invalid `signature` in thinking block")
  )
}

// Closed decision tables naturally branch once per permitted retry class.
// eslint-disable-next-line complexity
function classifyParsedCompatibilityRetry(options: {
  body: Record<string, unknown>
  endpoint: CompatibilityRetryEndpoint
  parsed: Record<string, unknown>
}): CompatibilityRetryDecision {
  if (!isRecord(options.parsed.error)) return { kind: "none" }
  const error = options.parsed.error
  if (
    options.endpoint === "/responses"
    && hasEncryptedCompaction(options.body)
    && matchesEncryptedCompactionError(error.code, error.message)
  ) {
    return {
      kind: "encrypted_compaction_verification",
      normalize: hasEncryptedCompaction,
    }
  }

  if (
    options.endpoint === "/v1/messages"
    && hasAssistantThinkingBlock(options.body)
    && isNativeThinkingSignatureError(options.parsed, error)
  ) {
    return {
      kind: "invalid_thinking_signature",
      normalize: stripAssistantThinkingBlocks,
    }
  }

  if (
    options.endpoint !== "/chat/completions"
    && options.endpoint !== "/responses"
  ) {
    return { kind: "none" }
  }
  if (error.code !== "invalid_request_body") return { kind: "none" }

  if (error.message === TOOL_CHOICE_WITHOUT_TOOLS_MESSAGE) {
    if (
      !hasOwn(options.body, "tool_choice")
      || (hasOwn(options.body, "tools")
        && (!Array.isArray(options.body.tools)
          || options.body.tools.length > 0))
    ) {
      return { kind: "none" }
    }
    return {
      kind: "tool_choice_without_tools",
      normalize: removeToolChoiceWithoutTools,
    }
  }

  if (
    error.message === UNSUPPORTED_TEMPERATURE_MESSAGE
    && hasOwn(options.body, "temperature")
  ) {
    return {
      kind: "unsupported_temperature",
      normalize: removeTemperature,
    }
  }

  if (
    error.message === UNSUPPORTED_TOP_P_MESSAGE
    && hasOwn(options.body, "top_p")
  ) {
    return {
      kind: "unsupported_top_p",
      normalize: removeTopP,
    }
  }

  return { kind: "none" }
}

export async function classifyCompatibilityRetry(options: {
  body: Record<string, unknown>
  endpoint: CompatibilityRetryEndpoint
  response: Response
}): Promise<CompatibilityRetryDecision> {
  if (options.response.status !== 400) return { kind: "none" }
  try {
    const parsed: unknown = JSON.parse(await options.response.clone().text())
    if (!isRecord(parsed)) return { kind: "none" }
    return classifyParsedCompatibilityRetry({
      body: options.body,
      endpoint: options.endpoint,
      parsed,
    })
  } catch {
    return { kind: "none" }
  }
}
