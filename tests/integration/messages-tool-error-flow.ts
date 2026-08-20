import type { Model } from "~/services/copilot/get-models"

import {
  classifyProvider,
  isSafeCandidateRejection,
  type SafeCandidateFailure,
  safeCandidateFailure,
  selectToolCapableResponsesCandidates,
} from "./model-candidates"
import { postJSON } from "./setup"

interface AnthropicContentBlock {
  id?: string
  type: string
}

export interface AnthropicMessageResponse {
  content: Array<AnthropicContentBlock>
}

const MAX_PROVIDER_CANDIDATES = 6

export async function runMessagesToolErrorFlow(options: {
  models: ReadonlyArray<Model>
  tool: Record<string, unknown>
}): Promise<AnthropicMessageResponse | undefined> {
  const candidates = selectToolCapableResponsesCandidates(
    options.models,
    MAX_PROVIDER_CANDIDATES,
  )
  if (candidates.length === 0) return undefined

  const failures: Array<SafeCandidateFailure> = []
  for (const model of candidates) {
    const first = await postJSON("/v1/messages", {
      model: model.id,
      messages: [{ role: "user", content: "What's the weather in Sydney?" }],
      tools: [options.tool],
      tool_choice: { type: "any" },
      max_tokens: 200,
      stream: false,
    })
    if (first.status !== 200) {
      const failure = await safeCandidateFailure(model, "tool_call", first)
      failures.push(failure)
      if (!isSafeCandidateRejection(first.status))
        throwCandidateFailure(failure)
      continue
    }

    const firstBody = await readAnthropicResponse(first, "tool call")
    const toolUse = firstBody.content.find(
      (block) => block.type === "tool_use" && typeof block.id === "string",
    )
    if (!toolUse?.id) {
      failures.push({
        code: "missing_tool_use",
        phase: "tool_call",
        providerClass: classifyProvider(model),
        status: 200,
      })
      continue
    }

    const second = await postJSON("/v1/messages", {
      model: model.id,
      messages: [
        { role: "user", content: "What's the weather in Sydney?" },
        { role: "assistant", content: firstBody.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Error: Weather service is unavailable",
              is_error: true,
            },
          ],
        },
      ],
      tools: [options.tool],
      max_tokens: 200,
      stream: false,
    })
    if (second.status === 200) {
      return await readAnthropicResponse(second, "tool result")
    }

    const failure = await safeCandidateFailure(model, "tool_result", second)
    failures.push(failure)
    if (!isSafeCandidateRejection(second.status)) throwCandidateFailure(failure)
  }

  throw new Error(
    `No advertised provider accepted the Messages tool-error flow: ${JSON.stringify(failures)}`,
  )
}

async function readAnthropicResponse(
  response: Response,
  phase: string,
): Promise<AnthropicMessageResponse> {
  const body = (await response.json()) as Partial<AnthropicMessageResponse>
  if (!Array.isArray(body.content)) {
    throw new TypeError(`Messages ${phase} response omitted content`)
  }
  return { content: body.content }
}

function throwCandidateFailure(failure: SafeCandidateFailure): never {
  throw new Error(
    `Messages tool-error flow stopped on a non-capability failure: ${JSON.stringify(failure)}`,
  )
}
