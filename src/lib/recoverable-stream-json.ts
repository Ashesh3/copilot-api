import consola from "consola"

interface RecoverableStreamJsonOptions {
  data: string
  event?: string
  protocol: string
  terminal: boolean
}

const MAX_DIAGNOSTICS_PER_PROTOCOL = 3
const diagnosticCounts = new Map<string, number>()

export function parseRecoverableStreamJson(
  options: RecoverableStreamJsonOptions,
): unknown {
  try {
    return JSON.parse(options.data) as unknown
  } catch {
    const diagnostic = {
      bytes: new TextEncoder().encode(options.data).byteLength,
      event: options.event ?? "unnamed",
      protocol: options.protocol,
    }
    if (options.terminal) {
      throw new SyntaxError(
        `Malformed terminal ${diagnostic.protocol} stream event (${diagnostic.event}, ${diagnostic.bytes} bytes)`,
      )
    }
    const diagnosticCount = diagnosticCounts.get(options.protocol) ?? 0
    if (diagnosticCount < MAX_DIAGNOSTICS_PER_PROTOCOL) {
      diagnosticCounts.set(options.protocol, diagnosticCount + 1)
      consola.warn("Skipped malformed nonterminal stream JSON", diagnostic)
    }
    return undefined
  }
}

export function hasNonNullStreamError(
  value: unknown,
): value is { error: unknown } {
  return (
    typeof value === "object"
    && value !== null
    && Object.hasOwn(value, "error")
    && (value as { error?: unknown }).error !== null
    && (value as { error?: unknown }).error !== undefined
  )
}
