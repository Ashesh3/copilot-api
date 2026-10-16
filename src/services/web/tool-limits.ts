import { webToolError } from "./tool-context"

export const MAX_MANAGED_WEB_ROUNDS = 18

export function checkWebContinuationLimit(round: number): void {
  if (round + 1 >= MAX_MANAGED_WEB_ROUNDS)
    throw webToolError(
      "web_tool_limit_exceeded",
      "Web tool continuation limit exceeded.",
    )
}
