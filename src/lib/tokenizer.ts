import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

// Encoder type mapping
const ENCODING_MAP = {
  o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
  cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
  p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
  p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
  r50k_base: () => import("gpt-tokenizer/encoding/r50k_base"),
} as const

type SupportedEncoding = keyof typeof ENCODING_MAP

export interface TokenEncoder {
  encode: (text: string) => Array<number>
}

export interface TokenCountOptions {
  loadEncoder?: (encoding: string) => Promise<TokenEncoder>
}

export const TOKENIZER_EXACT_TEXT_BUDGET_BYTES = 64 * 1024
export const TOKENIZER_JSON_VALUE_BUDGET = 4_096

const IMAGE_TOKEN_ESTIMATE = 85
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3
const TOKEN_COUNT_SATURATION = Number.MAX_SAFE_INTEGER

// Cache loaded encoders to avoid repeated imports
const encodingCache = new Map<string, TokenEncoder>()

const estimateTextTokens = (codeUnits: number): number =>
  codeUnits * MAX_UTF8_BYTES_PER_CODE_UNIT

const clampTokenCount = (tokens: number): number =>
  Math.min(tokens, TOKEN_COUNT_SATURATION)

const findExactPrefixLength = (text: string, byteBudget: number): number => {
  if (byteBudget <= 0 || text.length === 0) return 0
  if (
    text.length <= byteBudget
    && Buffer.byteLength(text, "utf8") <= byteBudget
  ) {
    return text.length
  }

  let low = 0
  let high = Math.min(text.length, byteBudget)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const bytes = Buffer.byteLength(text.slice(0, middle), "utf8")
    if (bytes <= byteBudget) low = middle
    else high = middle - 1
  }

  if (
    low > 0
    && low < text.length
    && (text.codePointAt(low - 1) ?? 0) > 0xffff
  ) {
    return low - 1
  }
  return low
}

class TokenizationBudget {
  private remainingExactBytes = TOKENIZER_EXACT_TEXT_BUDGET_BYTES
  private remainingJsonValues = TOKENIZER_JSON_VALUE_BUDGET
  private readonly encoder: TokenEncoder

  constructor(encoder: TokenEncoder) {
    this.encoder = encoder
  }

  countText(text: string): number {
    if (text.length === 0) return 0

    const prefixLength = findExactPrefixLength(text, this.remainingExactBytes)
    let exactTokens = 0
    if (prefixLength > 0) {
      const prefix =
        prefixLength === text.length ? text : text.slice(0, prefixLength)
      this.remainingExactBytes -= Buffer.byteLength(prefix, "utf8")
      exactTokens = this.encoder.encode(prefix).length
    }

    return exactTokens + estimateTextTokens(text.length - prefixLength)
  }

  takeValues(length: number): { saturated: boolean; visitCount: number } {
    const visitCount = Math.min(length, this.remainingJsonValues)
    this.remainingJsonValues -= visitCount
    return {
      saturated: visitCount < length,
      visitCount,
    }
  }

  countJson(value: unknown): number {
    const serialized = this.trySerializeJson(value)
    if (serialized !== null) return this.countText(serialized)
    return this.estimateJson(value)
  }

  countJsonWithPrefix(prefix: string, value: unknown): number {
    const serialized = this.trySerializeJson(value)
    if (serialized !== null) return this.countText(`${prefix}${serialized}`)
    return this.countText(prefix) + this.estimateJson(value)
  }

  visitOwnEntries(
    value: object,
    visitor: (key: string, entry: unknown) => void,
  ): boolean {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (this.remainingJsonValues <= 0) {
        return true
      }
      this.remainingJsonValues -= 1
      visitor(key, (value as Record<string, unknown>)[key])
    }
    return false
  }

  // eslint-disable-next-line complexity -- bounded JSON eligibility rejects every unsafe shape inline
  private trySerializeJson(value: unknown): string | null {
    const stack: Array<unknown> = [value]
    const visited = new Set<object>()
    let rawStringCodeUnits = 0

    while (stack.length > 0) {
      if (this.remainingJsonValues <= 0) return null
      this.remainingJsonValues -= 1
      const current = stack.pop()
      switch (typeof current) {
        case "string": {
          rawStringCodeUnits += current.length
          if (rawStringCodeUnits > this.remainingExactBytes) return null
          break
        }
        case "number":
        case "boolean": {
          break
        }
        case "object": {
          if (current === null) break
          if (
            visited.has(current)
            || (Object.hasOwn(current, "toJSON")
              && typeof (current as { toJSON?: unknown }).toJSON === "function")
          ) {
            return null
          }
          visited.add(current)
          if (Array.isArray(current)) {
            if (current.length > this.remainingJsonValues) return null
            for (let index = current.length - 1; index >= 0; index -= 1) {
              stack.push(current[index])
            }
            break
          }
          const prototype = Object.getPrototypeOf(current) as unknown
          if (prototype !== Object.prototype && prototype !== null) return null
          const entries: Array<unknown> = []
          for (const key in current) {
            if (!Object.hasOwn(current, key)) continue
            rawStringCodeUnits += key.length
            if (
              rawStringCodeUnits > this.remainingExactBytes
              || entries.length >= this.remainingJsonValues
            ) {
              return null
            }
            entries.push((current as Record<string, unknown>)[key])
          }
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            stack.push(entries[index])
          }
          break
        }
        default: {
          return null
        }
      }
    }

    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }

  // eslint-disable-next-line complexity -- bounded structural fallback handles JSON primitives and containers inline
  private estimateJson(value: unknown): number {
    const stack: Array<unknown> = [value]
    const visited = new Set<object>()
    let tokens = 0

    while (stack.length > 0) {
      if (this.remainingJsonValues <= 0) {
        return TOKEN_COUNT_SATURATION
      }
      this.remainingJsonValues -= 1
      const current = stack.pop()
      switch (typeof current) {
        case "string": {
          tokens += this.countText(current)
          break
        }
        case "number":
        case "bigint":
        case "boolean": {
          tokens += this.countText(String(current))
          break
        }
        case "object": {
          if (current === null) {
            tokens += this.countText("null")
            break
          }
          if (visited.has(current)) {
            tokens += this.countText("[Circular]")
            break
          }
          visited.add(current)
          if (Array.isArray(current)) {
            const visitCount = Math.min(
              current.length,
              this.remainingJsonValues,
            )
            tokens += current.length * 2 + 2
            for (let index = visitCount - 1; index >= 0; index -= 1) {
              stack.push(current[index])
            }
            if (visitCount < current.length) return TOKEN_COUNT_SATURATION
            break
          }
          const entries: Array<[string, unknown]> = []
          for (const key in current) {
            if (!Object.hasOwn(current, key)) continue
            if (entries.length >= this.remainingJsonValues) {
              return TOKEN_COUNT_SATURATION
            }
            entries.push([key, (current as Record<string, unknown>)[key]])
          }
          tokens += entries.length * 3 + 2
          for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index]
            stack.push(entry[1], entry[0])
          }
          break
        }
        default: {
          break
        }
      }
    }

    return tokens
  }
}

const estimateFileTokens = (part: ContentPart): number =>
  part.type === "file" ? Math.ceil((part.file.file_data?.length ?? 0) / 4) : 0

/**
 * Calculate tokens for tool calls
 */
const calculateToolCallsTokens = (
  toolCalls: Array<ToolCall>,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let tokens = toolCalls.length * constants.funcInit + constants.funcEnd
  const { saturated, visitCount } = counter.takeValues(toolCalls.length)
  for (let index = 0; index < visitCount; index += 1) {
    tokens += counter.countJson(toolCalls[index])
  }
  return saturated ? TOKEN_COUNT_SATURATION : tokens
}

/**
 * Calculate tokens for content parts
 */
const calculateContentPartsTokens = (
  contentParts: Array<ContentPart>,
  counter: TokenizationBudget,
): number => {
  let tokens = 0
  const { saturated, visitCount } = counter.takeValues(contentParts.length)
  for (let index = 0; index < visitCount; index += 1) {
    const part = contentParts[index]
    if (part.type === "image_url") {
      tokens += IMAGE_TOKEN_ESTIMATE
    } else if (part.type === "file") {
      // Rough estimate for PDF attachments — actual cost depends on pages
      tokens += estimateFileTokens(part)
    } else if (part.text) {
      tokens += counter.countText(part.text)
    }
  }
  return saturated ? TOKEN_COUNT_SATURATION : tokens
}

/**
 * Calculate tokens for a single message
 */
const calculateMessageTokens = (
  message: Message,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  const tokensPerMessage = 3
  const tokensPerName = 1
  let tokens = tokensPerMessage + counter.countText(message.role)
  if (typeof message.content === "string") {
    tokens += counter.countText(message.content)
  } else if (Array.isArray(message.content)) {
    tokens += calculateContentPartsTokens(message.content, counter)
  }
  for (const value of [
    message.reasoning_text,
    message.reasoning_opaque,
    message.encrypted_content,
    message.name,
    message.tool_call_id,
  ]) {
    if (typeof value === "string") tokens += counter.countText(value)
  }
  if (message.name !== undefined) tokens += tokensPerName
  if (message.tool_calls) {
    tokens += calculateToolCallsTokens(message.tool_calls, counter, constants)
  }
  return tokens
}

const calculateMessageGroups = (
  messages: Array<Message>,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): { input: number; output: number } => {
  const { saturated, visitCount } = counter.takeValues(messages.length)
  let input = saturated ? TOKEN_COUNT_SATURATION : 0
  let output = saturated ? TOKEN_COUNT_SATURATION : 0
  let inputMessages = saturated ? 1 : 0
  let outputMessages = 0
  for (let index = 0; index < visitCount; index += 1) {
    const message = messages[index]
    const tokens = calculateMessageTokens(message, counter, constants)
    if (message.role === "assistant") {
      output += tokens
      outputMessages += 1
    } else {
      input += tokens
      inputMessages += 1
    }
  }
  if (inputMessages > 0) input += 3
  if (outputMessages > 0) output += 3
  return {
    input: clampTokenCount(input),
    output: clampTokenCount(output),
  }
}

/**
 * Get the corresponding encoder module based on encoding type
 */
const getEncodeChatFunction = async (
  encoding: string,
): Promise<TokenEncoder> => {
  if (encodingCache.has(encoding)) {
    const cached = encodingCache.get(encoding)
    if (cached) {
      return cached
    }
  }

  const supportedEncoding = encoding as SupportedEncoding
  if (!(supportedEncoding in ENCODING_MAP)) {
    const fallbackModule = (await ENCODING_MAP.o200k_base()) as TokenEncoder
    encodingCache.set(encoding, fallbackModule)
    return fallbackModule
  }

  const encodingModule = (await ENCODING_MAP[
    supportedEncoding
  ]()) as TokenEncoder
  encodingCache.set(encoding, encodingModule)
  return encodingModule
}

/**
 * Get tokenizer type from model information
 */
export const getTokenizerFromModel = (model: Model): string => {
  return model.capabilities.tokenizer || "o200k_base"
}

/**
 * Get model-specific constants for token calculation
 */
const getModelConstants = (model: Model) => {
  return model.id === "gpt-3.5-turbo" || model.id === "gpt-4" ?
      {
        funcInit: 10,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }
    : {
        funcInit: 7,
        propInit: 3,
        propKey: 3,
        enumInit: -3,
        enumItem: 3,
        funcEnd: 12,
      }
}

/**
 * Calculate tokens for a single parameter
 */
const calculateParameterTokens = (
  key: string,
  prop: unknown,
  context: {
    constants: ReturnType<typeof getModelConstants>
    counter: TokenizationBudget
  },
): number => {
  const { constants, counter } = context
  let tokens = constants.propKey
  if (typeof prop !== "object" || prop === null) return tokens

  const param = prop as {
    type?: string
    description?: string
    enum?: Array<unknown>
    [key: string]: unknown
  }
  let description = param.description || ""
  if (description.endsWith(".")) description = description.slice(0, -1)
  tokens += counter.countText(`${key}:${param.type || "string"}:${description}`)

  if (Array.isArray(param.enum)) {
    const items = counter.takeValues(param.enum.length)
    if (items.saturated) return TOKEN_COUNT_SATURATION
    tokens += constants.enumInit
    for (let index = 0; index < items.visitCount; index += 1) {
      tokens +=
        constants.enumItem + counter.countText(String(param.enum[index]))
    }
  }

  const saturated = counter.visitOwnEntries(
    param,
    (propertyName, propertyValue) => {
      if (["description", "enum", "type"].includes(propertyName)) return
      tokens +=
        typeof propertyValue === "string" ?
          counter.countText(`${propertyName}:${propertyValue}`)
        : counter.countJsonWithPrefix(`${propertyName}:`, propertyValue)
    },
  )
  return saturated ? TOKEN_COUNT_SATURATION : tokens
}

const calculateParametersTokens = (
  parameters: unknown,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  if (!parameters || typeof parameters !== "object") return 0
  let tokens = 0
  const saturated = counter.visitOwnEntries(parameters, (key, value) => {
    if (key === "properties" && value && typeof value === "object") {
      let propertyCount = 0
      const propertiesSaturated = counter.visitOwnEntries(
        value,
        (propertyName, propertyValue) => {
          propertyCount += 1
          tokens += calculateParameterTokens(propertyName, propertyValue, {
            constants,
            counter,
          })
        },
      )
      if (propertiesSaturated) tokens = TOKEN_COUNT_SATURATION
      if (propertyCount > 0) tokens += constants.propInit
      return
    }
    tokens +=
      typeof value === "string" ?
        counter.countText(`${key}:${value}`)
      : counter.countJsonWithPrefix(`${key}:`, value)
  })
  return saturated || tokens >= TOKEN_COUNT_SATURATION ?
      TOKEN_COUNT_SATURATION
    : tokens
}

/**
 * Calculate tokens for a single tool
 */
const calculateToolTokens = (
  tool: Tool,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let tokens = constants.funcInit
  const func = tool.function
  const fName = func.name
  let fDesc = func.description || ""
  if (fDesc.endsWith(".")) {
    fDesc = fDesc.slice(0, -1)
  }
  const line = fName + ":" + fDesc
  tokens += counter.countText(line)
  if (
    typeof func.parameters === "object" // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    && func.parameters !== null
  ) {
    tokens += calculateParametersTokens(func.parameters, counter, constants)
  }
  return tokens
}

/**
 * Calculate token count for tools based on model
 */
const calculateToolsTokens = (
  tools: Array<Tool>,
  counter: TokenizationBudget,
  constants: ReturnType<typeof getModelConstants>,
): number => {
  let funcTokenCount = 0
  const { saturated, visitCount } = counter.takeValues(tools.length)
  for (let index = 0; index < visitCount; index += 1) {
    funcTokenCount += calculateToolTokens(tools[index], counter, constants)
  }
  funcTokenCount += constants.funcEnd
  return saturated ? TOKEN_COUNT_SATURATION : funcTokenCount
}

export const numTokensForTools = (
  tools: Array<Tool>,
  encoder: TokenEncoder,
  constants: ReturnType<typeof getModelConstants>,
): number =>
  clampTokenCount(
    calculateToolsTokens(tools, new TokenizationBudget(encoder), constants),
  )

/**
 * Calculate the token count of messages, supporting multiple GPT encoders
 */
export const getTokenCount = async (
  payload: ChatCompletionsPayload,
  model: Model,
  options: TokenCountOptions = {},
): Promise<{ input: number; output: number }> => {
  // Get tokenizer string
  const tokenizer = getTokenizerFromModel(model)

  // Get corresponding encoder module
  const encoder = await (options.loadEncoder ?? getEncodeChatFunction)(
    tokenizer,
  )
  const counter = new TokenizationBudget(encoder)

  const constants = getModelConstants(model)
  const tokens = calculateMessageGroups(payload.messages, counter, constants)
  if (payload.tools && payload.tools.length > 0) {
    tokens.input = clampTokenCount(
      tokens.input + calculateToolsTokens(payload.tools, counter, constants),
    )
  }
  return tokens
}

/**
 * Estimate token count for a payload without model info (uses o200k_base encoding)
 * This is a rough estimate used when we don't have model-specific info
 */
export const estimateTokenCount = async (
  payload: ChatCompletionsPayload,
  options: TokenCountOptions = {},
): Promise<number> => {
  const encoder = await (options.loadEncoder ?? getEncodeChatFunction)(
    "o200k_base",
  )
  const counter = new TokenizationBudget(encoder)

  // Simple estimation: encode all message content
  let tokens = 0
  const { saturated, visitCount } = counter.takeValues(payload.messages.length)
  if (saturated) return TOKEN_COUNT_SATURATION
  for (let messageIndex = 0; messageIndex < visitCount; messageIndex += 1) {
    const message = payload.messages[messageIndex]
    // 3 tokens per message overhead
    tokens += 3

    if (typeof message.content === "string") {
      tokens += counter.countText(message.content)
    } else if (Array.isArray(message.content)) {
      const content = counter.takeValues(message.content.length)
      if (content.saturated) return TOKEN_COUNT_SATURATION
      for (let index = 0; index < content.visitCount; index += 1) {
        const part = message.content[index]
        if (part.type === "text" && part.text) {
          tokens += counter.countText(part.text)
        } else if (part.type === "image_url") {
          // Rough estimate for images
          tokens += IMAGE_TOKEN_ESTIMATE
        } else if (part.type === "file") {
          tokens += estimateFileTokens(part)
        }
      }
    }

    // Add role tokens
    tokens += counter.countText(message.role)

    // Tool calls in messages (assistant responses with tool use)
    if (message.tool_calls) {
      tokens += counter.countJson(message.tool_calls)
    }
  }

  // Add tool definitions if present (but don't double count - use simplified estimate)
  // Tool definitions add overhead but the full JSON stringify overcounts
  if (payload.tools && payload.tools.length > 0) {
    // Estimate ~50 tokens per tool on average for function name + description + params
    tokens += payload.tools.length * 50
  }

  // Priming tokens
  tokens += 3

  return clampTokenCount(tokens)
}
