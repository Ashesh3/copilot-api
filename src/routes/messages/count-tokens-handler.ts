import type { Context } from "hono"

import consola from "consola"

import { applyModelRedirect } from "~/lib/model-redirect"
import { normalizeModelName } from "~/lib/model-resolver"
import {
  normalizeReasoningEffortForModel,
  parseModelSuffix,
} from "~/lib/model-suffix"
import { setRequestContext } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import { translateToOpenAI } from "./non-stream-translation"

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
    const requestedModel = anthropicPayload.model

    const { baseModel, reasoningEffort: suffixEffort } =
      parseModelSuffix(requestedModel)
    const normalizedModel = normalizeModelName(baseModel)
    const requestedEffort = normalizeReasoningEffortForModel(
      normalizedModel,
      suffixEffort,
    )
    const redirect = await applyModelRedirect({
      model: normalizedModel,
      effort: requestedEffort,
    })
    const targetModel = normalizeModelName(redirect.model)
    const targetEffort = normalizeReasoningEffortForModel(
      targetModel,
      redirect.effort,
    )
    anthropicPayload.model = targetModel

    setRequestContext(c, {
      requestedModel,
      model: targetModel,
      provider: "TokenCount",
      reasoningEffort: targetEffort,
    })

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const selectedModel = state.models?.data.find(
      (model) => model.id === targetModel,
    )

    if (!selectedModel) {
      consola.warn("Model not found for count_tokens, returning default", {
        requestedModel,
        baseModel,
        normalizedModel,
        targetModel,
        reasoningEffort: targetEffort,
        modelsLoaded: Boolean(state.models),
        knownModelCount: state.models?.data.length ?? 0,
      })
      setRequestContext(c, { inputTokens: 1 })
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (anthropicBeta?.startsWith("claude-code")) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (targetModel.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        } else if (targetModel.startsWith("grok")) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (targetModel.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (targetModel.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    setRequestContext(c, { inputTokens: finalTokenCount })
    consola.info(`Token count: ${finalTokenCount} (${requestedModel})`)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    consola.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
