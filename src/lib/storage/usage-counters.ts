/** Tokenizer saturation is an unknown count, never measured usage. */
export function normalizeUsageTokenCount(value: unknown): number | null {
  return (
      typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        && value < Number.MAX_SAFE_INTEGER
    ) ?
      value
    : null
}

/** Retain the known subtotal when another count cannot be added exactly. */
export function addUsageTokenCount(
  subtotal: number,
  increment: number,
): { total: number; overflow: boolean } {
  const overflow = increment > Number.MAX_SAFE_INTEGER - 1 - subtotal
  return { total: overflow ? subtotal : subtotal + increment, overflow }
}
