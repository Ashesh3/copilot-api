import type {
  ObservedRequestUsage,
  RequestUsageObserver,
} from "~/lib/request-usage"

import {
  addUsageTokenCount,
  normalizeUsageTokenCount,
} from "~/lib/storage/usage-counters"

import { isRecord, type WebProtocol } from "./tool-context"

type UsageComponents = Record<string, number | null | undefined>

function updateUsage(
  value: unknown,
  protocol: WebProtocol,
  components: UsageComponents,
): ObservedRequestUsage | undefined {
  const incoming = isRecord(value) ? value : {}
  const inputFields =
    protocol === "messages" ?
      ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    : [protocol === "chat" ? "prompt_tokens" : "input_tokens"]
  const outputField =
    protocol === "chat" ? "completion_tokens" : "output_tokens"
  const fields = [...inputFields, outputField]
  let invalid = false
  for (const key of fields) {
    if (incoming[key] === undefined) continue
    const count = normalizeUsageTokenCount(incoming[key])
    if (count === null) {
      invalid = true
      components[key] ??= null
    } else components[key] = count
  }
  if (fields.every((key) => components[key] === undefined)) return undefined
  const input = sumCounts(inputFields.map((key) => components[key]))
  const output = sumCounts([components[outputField]])
  return {
    inputTokens: input.total,
    outputTokens: output.total,
    unknownTokenCount: invalid || input.unknown || output.unknown,
  }
}

function sumCounts(values: ReadonlyArray<unknown>): {
  total: number
  unknown: boolean
} {
  let total = 0
  let unknown = false
  for (const value of values) {
    if (value === undefined) continue
    const count = normalizeUsageTokenCount(value)
    if (count === null) {
      unknown = true
      continue
    }
    const added = addUsageTokenCount(total, count)
    total = added.total
    unknown ||= added.overflow
  }
  return { total, unknown }
}

function combinedUsage(
  completed: ObservedRequestUsage | undefined,
  current: ObservedRequestUsage | undefined,
): ObservedRequestUsage | undefined {
  if (!current) return completed
  if (!completed) return current
  const input = sumCounts([completed.inputTokens, current.inputTokens])
  const output = sumCounts([completed.outputTokens, current.outputTokens])
  return {
    inputTokens: input.total,
    outputTokens: output.total,
    unknownTokenCount:
      completed.unknownTokenCount
      || current.unknownTokenCount
      || input.unknown
      || output.unknown,
  }
}

/** Replace snapshots within a round; add only distinct upstream rounds. */
export class ManagedWebUsage {
  private completed?: ObservedRequestUsage
  private current?: ObservedRequestUsage
  private components: UsageComponents = {}
  private active = false
  private readonly protocol: WebProtocol
  private readonly publish: RequestUsageObserver | undefined

  constructor(
    protocol: WebProtocol,
    publish: RequestUsageObserver | undefined,
  ) {
    this.protocol = protocol
    this.publish = publish
  }

  observe(usage: unknown, intercepted: boolean): void {
    this.active ||= intercepted
    const current = updateUsage(usage, this.protocol, this.components)
    if (current)
      current.unknownTokenCount ||= this.current?.unknownTokenCount === true
    this.current = current
    const total = combinedUsage(this.completed, this.current)
    if (this.active)
      this.publish?.(
        total ?? { inputTokens: undefined, outputTokens: undefined },
      )
  }

  nextRound(): void {
    this.completed = combinedUsage(this.completed, this.current)
    this.current = undefined
    this.components = {}
  }
}
