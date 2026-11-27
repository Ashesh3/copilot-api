import consola from "consola"

import {
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import { shouldRedactDebugHeader } from "~/lib/request-logger"

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

/**
 * Read a copy of the body so an unheld or unchanged response can be returned
 * as the original object, bytes intact. Returns undefined when the body cannot
 * be held: capture memory is exhausted, the read fails, or it is not UTF-8 text.
 * On success the caller owns `reservedBytes` of capture memory.
 */
export async function readResponseCopy(
  response: Response,
  path: string,
): Promise<{ text: string; reservedBytes: number } | undefined> {
  const body = response.clone().body
  if (!body) return { text: "", reservedBytes: 0 }
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Array<Uint8Array> = []
  let reservedBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const needed = value.byteLength * HELD_BODY_COPIES
      if (!reserveDebugCaptureMemory(needed)) {
        releaseDebugCaptureMemory(reservedBytes)
        await reader.cancel().catch(() => undefined)
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
  }
}
