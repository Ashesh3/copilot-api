// Google Generative AI API types
// Based on @ai-sdk/google request/response format

// ─── Request Types ───

export interface GoogleAIRequest {
  contents: Array<GoogleContent>
  systemInstruction?: GoogleSystemInstruction
  generationConfig?: GoogleGenerationConfig
  tools?: Array<GoogleTool>
  toolConfig?: GoogleToolConfig
  safetySettings?: Array<GoogleSafetySetting>
  cachedContent?: string
  labels?: Record<string, string>
}

export interface GoogleContent {
  role: "user" | "model"
  parts: Array<GooglePart>
}

export type GooglePart =
  | GoogleTextPart
  | GoogleInlineDataPart
  | GoogleFileDataPart
  | GoogleFunctionCallPart
  | GoogleFunctionResponsePart

export interface GoogleTextPart {
  text: string
  thought?: boolean
  thoughtSignature?: string
}

export interface GoogleInlineDataPart {
  inlineData: {
    mimeType: string
    data: string
  }
}

export interface GoogleFileDataPart {
  fileData: {
    mimeType: string
    fileUri: string
  }
}

export interface GoogleFunctionCallPart {
  functionCall: {
    name: string
    args: Record<string, unknown>
  }
  thoughtSignature?: string
}

export interface GoogleFunctionResponsePart {
  functionResponse: {
    name: string
    response: Record<string, unknown>
  }
}

export interface GoogleSystemInstruction {
  parts: Array<{ text: string }>
}

export interface GoogleGenerationConfig {
  maxOutputTokens?: number
  temperature?: number
  topK?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stopSequences?: Array<string>
  seed?: number
  responseMimeType?: string
  responseSchema?: Record<string, unknown>
  responseModalities?: Array<string>
  thinkingConfig?: Record<string, unknown>
  audioTimestamp?: boolean
  mediaResolution?: string
  candidateCount?: number
}

export interface GoogleTool {
  functionDeclarations?: Array<GoogleFunctionDeclaration>
  googleSearch?: Record<string, unknown>
  codeExecution?: Record<string, unknown>
}

export interface GoogleFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface GoogleToolConfig {
  functionCallingConfig?: {
    mode: "AUTO" | "NONE" | "ANY"
    allowedFunctionNames?: Array<string>
  }
}

export interface GoogleSafetySetting {
  category: string
  threshold: string
}

// ─── Response Types ───

export interface GoogleAIResponse {
  candidates: Array<GoogleCandidate>
  usageMetadata?: GoogleUsageMetadata
  modelVersion?: string
  promptFeedback?: Record<string, unknown>
}

export interface GoogleCandidate {
  content: GoogleContent
  finishReason:
    | "STOP"
    | "MAX_TOKENS"
    | "SAFETY"
    | "RECITATION"
    | "OTHER"
    | "BLOCKLIST"
    | "PROHIBITED_CONTENT"
    | "SPII"
    | "MALFORMED_FUNCTION_CALL"
    | null
  safetyRatings?: Array<Record<string, unknown>>
  groundingMetadata?: Record<string, unknown>
  index?: number
}

export interface GoogleUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  promptTokensDetails?: Array<{ modality: string; tokenCount: number }>
  cacheTokensDetails?: Array<{ modality: string; tokenCount: number }>
}

// ─── Streaming Types ───

export interface GoogleStreamFailure {
  error: {
    code: number
    message: string
    status: "INTERNAL"
    body_bytes?: Array<number>
    content_type?: string
    upstream_status?: number
  }
}

/** Each streamGenerateContent item is a response chunk or terminal failure. */
export type GoogleStreamChunk = GoogleAIResponse | GoogleStreamFailure
