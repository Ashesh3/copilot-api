import consola from "consola"

import type { State } from "./state"

import { HTTPError } from "./error"
import { sleep } from "./utils"

const RATE_LIMIT_BURST_WINDOW_SECONDS = 10

function getRateLimitBucketCapacity(rateLimitSeconds: number): number {
  return Math.max(
    1,
    Math.ceil(RATE_LIMIT_BURST_WINDOW_SECONDS / rateLimitSeconds),
  )
}

function getRefilledBucketTokens(
  state: State,
  now: number,
): {
  tokens: number
  refillRatePerSecond: number
} {
  const rateLimitSeconds = state.rateLimitSeconds
  if (rateLimitSeconds === undefined || rateLimitSeconds <= 0) {
    return { tokens: Infinity, refillRatePerSecond: Infinity }
  }

  const capacity = getRateLimitBucketCapacity(rateLimitSeconds)
  const refillRatePerSecond = 1 / rateLimitSeconds
  const previousTokens = state.rateLimitBucketTokens ?? capacity
  const previousUpdatedAt = state.rateLimitBucketUpdatedAt ?? now
  const elapsedSeconds = Math.max(0, (now - previousUpdatedAt) / 1000)

  return {
    tokens: Math.min(
      capacity,
      previousTokens + elapsedSeconds * refillRatePerSecond,
    ),
    refillRatePerSecond,
  }
}

export async function checkRateLimit(state: State, signal?: AbortSignal) {
  if (state.rateLimitSeconds === undefined || state.rateLimitSeconds <= 0)
    return

  const now = Date.now()
  const { tokens, refillRatePerSecond } = getRefilledBucketTokens(state, now)

  if (tokens >= 1) {
    state.rateLimitBucketTokens = tokens - 1
    state.rateLimitBucketUpdatedAt = now
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil((1 - tokens) / refillRatePerSecond)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      "Rate limit exceeded",
      Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
    )
  }

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  if (signal) {
    let rejectAbort: (() => void) | undefined
    try {
      await Promise.race([
        sleep(waitTimeMs),
        new Promise<never>((_resolve, reject) => {
          rejectAbort = () => {
            const reason: unknown = signal.reason
            if (reason instanceof Error) {
              reject(reason)
              return
            }
            const error = new Error("Rate-limit wait aborted")
            error.name = "AbortError"
            reject(error)
          }
          if (signal.aborted) {
            rejectAbort()
            return
          }
          signal.addEventListener("abort", rejectAbort, { once: true })
        }),
      ])
    } finally {
      if (rejectAbort) signal.removeEventListener("abort", rejectAbort)
    }
  } else {
    await sleep(waitTimeMs)
  }

  const readyAt = Date.now()
  const nextBucket = getRefilledBucketTokens(state, readyAt)
  state.rateLimitBucketTokens = Math.max(0, nextBucket.tokens - 1)
  state.rateLimitBucketUpdatedAt = readyAt
  state.lastRequestTimestamp = readyAt
  consola.info("Rate limit wait completed, proceeding with request")
  return
}
