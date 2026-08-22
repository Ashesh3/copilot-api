interface PendingCall {
  readonly callIndex: number
  readonly targetId: string
}

export interface ToolCallAssociations {
  readonly adaptedCallIndices: ReadonlySet<number>
  readonly callIdByIndex: ReadonlyMap<number, string>
  readonly outputCallIdByIndex: ReadonlyMap<number, string>
  readonly pairedCallIndices: ReadonlySet<number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sourceCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Associate Responses function calls and outputs by occurrence, not only by the
 * caller-supplied ID. Missing and duplicate IDs receive deterministic
 * request-local target IDs, while outputs consume matching calls FIFO exactly
 * once. Results that precede a call or exceed the matching call count remain
 * unassociated for the adapter to degrade as context.
 */
export function associateResponsesFunctionCalls(
  input: unknown,
  generatedId: (itemIndex: number) => string,
): ToolCallAssociations {
  const items = Array.isArray(input) ? input : []
  const reservedIds = new Set<string>()
  for (const raw of items) {
    if (!isRecord(raw)) continue
    const id = sourceCallId(raw.call_id)
    if (id) reservedIds.add(id)
  }

  const adaptedCallIndices = new Set<number>()
  const callIdByIndex = new Map<number, string>()
  const outputCallIdByIndex = new Map<number, string>()
  const pairedCallIndices = new Set<number>()
  const pendingBySourceId = new Map<string | undefined, Array<PendingCall>>()
  const usedTargetIds = new Set<string>()

  for (const [itemIndex, raw] of items.entries()) {
    if (!isRecord(raw)) continue
    const suppliedId = sourceCallId(raw.call_id)
    if (raw.type === "function_call") {
      let targetId = suppliedId
      if (!targetId || usedTargetIds.has(targetId)) {
        const base = generatedId(itemIndex)
        targetId = base
        let suffix = 0
        while (reservedIds.has(targetId) || usedTargetIds.has(targetId)) {
          suffix += 1
          targetId = `${base}_${suffix}`
        }
        adaptedCallIndices.add(itemIndex)
      }
      usedTargetIds.add(targetId)
      callIdByIndex.set(itemIndex, targetId)
      const queue = pendingBySourceId.get(suppliedId) ?? []
      queue.push({ callIndex: itemIndex, targetId })
      pendingBySourceId.set(suppliedId, queue)
      continue
    }
    if (raw.type !== "function_call_output") continue
    const queue = pendingBySourceId.get(suppliedId)
    const matched = queue?.shift()
    if (!matched) continue
    outputCallIdByIndex.set(itemIndex, matched.targetId)
    pairedCallIndices.add(matched.callIndex)
  }

  return {
    adaptedCallIndices,
    callIdByIndex,
    outputCallIdByIndex,
    pairedCallIndices,
  }
}
