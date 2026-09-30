import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ResponsesPayload } from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

// Synthetic policies and transcripts with the contracts observed in the clients.
// No captured user conversation or vendor policy text is included.
export const reviewPolicy =
  "You are a security monitor for autonomous AI coding agents.\n\n"
  + "## Classification Process\nEvaluate the final action under the user's authorization.\n\n"
  + "## Output Format\nReturn <block>yes</block> or <block>no</block>."

export function claudeReview(
  stage: 1 | 2 = 1,
  severity = false,
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-5",
    system: [
      { type: "text", text: "x-anthropic-billing-header: synthetic fixture" },
      {
        type: "text",
        text:
          severity ?
            reviewPolicy.replace(
              "Return <block>yes</block> or <block>no</block>.",
              "Return <severity>N</severity> with an integer score.",
            )
          : reviewPolicy,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "<transcript>\n" },
          {
            type: "text",
            text:
              '[{"role":"user","content":"List this directory."},'
              + '{"role":"assistant","content":"Bash: ls"}]\n',
          },
          { type: "text", text: "</transcript>\n" },
          {
            type: "text",
            text:
              stage === 1 ?
                "Stage 1 does NOT apply user intent or ALLOW exceptions. Return the classification tag."
              : "Review the classification process and follow it carefully. Return the classification tag.",
          },
        ],
      },
    ],
    metadata: { user_id: "synthetic-review" },
    max_tokens: stage === 1 ? 64 : 8192,
    temperature: 1,
    thinking: { type: "disabled" },
    ...(stage === 1 ?
      { stop_sequences: [severity ? "</severity>" : "</block>"] }
    : {}),
  }
}

export function codexReview(): ResponsesPayload & {
  client_metadata: { parent_response_id: string }
} {
  return {
    model: "codex-auto-review",
    instructions:
      "Review the proposed action against the supplied policy. Return the decision as JSON.",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "The user requested a directory listing. Proposed action: ls.",
          },
        ],
      },
    ],
    reasoning: { effort: "low", summary: "detailed" },
    client_metadata: { parent_response_id: "opaque-parent-response" },
    text: {
      format: {
        type: "json_schema",
        name: "codex_output_schema",
        strict: false,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["allow", "deny"] },
            risk_level: {
              type: "string",
              enum: ["low", "medium", "high", "critical"],
            },
            user_authorization: {
              type: "string",
              enum: ["unknown", "low", "medium", "high"],
            },
            rationale: { type: "string" },
          },
          required: ["outcome"],
        },
      },
    },
    tools: [
      {
        type: "function",
        name: "inspect_path",
        description: "Read file metadata for review.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  }
}

export function reviewModel(id: string, endpoint = "/responses"): Model {
  return {
    id,
    name: id,
    object: "model",
    version: "fixture",
    supported_endpoints: [endpoint],
    capabilities: {
      family: endpoint === "/v1/messages" ? "claude" : "gpt",
      object: "model_capabilities",
      limits: { max_output_tokens: 16000 },
      supports: {
        reasoning_effort: ["low", "medium", "high"],
        structured_outputs: true,
      },
      tokenizer: "cl100k_base",
      type: "chat",
    },
  }
}

export function reviewResponse(model: unknown, text: string, id: string) {
  return {
    id,
    object: "response",
    created_at: 1,
    model,
    output: [
      {
        id: `message_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    output_text: text,
    status: "completed",
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    error: null,
    incomplete_details: null,
  }
}
