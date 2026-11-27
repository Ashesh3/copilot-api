import consola from "consola"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { shouldRedactDebugHeader } from "~/lib/request-logger"

import type { InterceptPendingItem } from "./types"

/** A held item keeps its original body, the current body, and parsed views. */
export const HELD_BODY_COPIES = 3

export function warnCaptureBudget(path: string): void {
  consola.warn(
    `[Intercept] Debug capture memory is full; passing ${path} through without holding it`,
  )
}

/** Held items are shown to operators; credentials never leave the transport. */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      shouldRedactDebugHeader(name) ? "[REDACTED]" : value,
    ]),
  )
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/**
 * Capture memory an item holds: its original body, the current body and the
 * view parsed from it, the request context of a response with its view, and
 * a suggestion's preview body with its view. Parsed views are counted at the
 * size of the text they came from.
 */
export function retainedBytes(
  item: Pick<
    InterceptPendingItem,
    "originalBody" | "currentBody" | "requestContext" | "assistantSuggestion"
  >,
): number {
  const preview = item.assistantSuggestion?.previewBody
  return (
    textBytes(item.originalBody)
    + 2 * textBytes(item.currentBody)
    + (item.requestContext ? 2 * textBytes(item.requestContext.body) : 0)
    + (preview ? 2 * textBytes(preview) : 0)
  )
}

/**
 * Read a copy of the body so an unheld or unchanged response can be returned
 * as the original object, bytes intact. Returns undefined when the body cannot
 * be held: capture memory is exhausted, the read fails, the body is not UTF-8
 * text, or `signal` aborts first (Intercept turned off, client gone, or the
 * hold deadline passed). On success the caller owns `reservedBytes`.
 */
export async function readResponseCopy(
  response: Response,
  path: string,
  signal: AbortSignal,
): Promise<{ text: string; reservedBytes: number } | undefined> {
  const body = response.clone().body
  if (!body) return { text: "", reservedBytes: 0 }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  // Cancelling a branch of a cloned body never blocks the other branch; do
  // not wait for it, or a stalled upstream would stall the caller too.
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Array<Uint8Array> = []
  let reservedBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) {
        releaseDebugCaptureMemory(reservedBytes)
        return undefined
      }
      if (done) break
      const needed = value.byteLength * HELD_BODY_COPIES
      if (!reserveDebugCaptureMemory(needed)) {
        releaseDebugCaptureMemory(reservedBytes)
        cancel()
        warnCaptureBudget(path)
        return undefined
      }
      reservedBytes += needed
      chunks.push(value)
    }
    return {
      text: new TextDecoder(undefined, { fatal: true }).decode(
        Buffer.concat(chunks),
      ),
      reservedBytes,
    }
  } catch {
    // A read failure surfaces to the caller through the original body.
    releaseDebugCaptureMemory(reservedBytes)
    return undefined
  } finally {
    signal.removeEventListener("abort", cancel)
  }
}
