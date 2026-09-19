import { afterEach, beforeEach, expect, jest, test } from "bun:test"

import {
  DEBUG_CAPTURE_MEMORY_MAX_BYTES,
  debugCaptureMemoryUsage,
  releaseDebugCaptureMemory,
  reserveDebugCaptureMemory,
} from "~/lib/debug-capture"
import {
  abortLlmDebugLog,
  clearLlmDebugLogs,
  finishLlmDebugLog,
  getLlmDebugCaptureSignal,
  getLlmDebugLog,
  listLlmDebugLogs,
  startLlmDebugLog,
} from "~/lib/llm-debug-log"

beforeEach(clearLlmDebugLogs)
afterEach(async () => {
  await clearLlmDebugLogs()
  jest.useRealTimers()
})

function start() {
  return startLlmDebugLog({
    method: "POST",
    path: "/responses",
    requestBody: '{"input":"retained"}',
    requestHeaders: {},
    url: "https://example.test/responses",
  })
}

function finish(id: string, status = 200, body = "{}") {
  finishLlmDebugLog(id, {
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    headers: { "content-type": "application/json" },
    body,
  })
}

function occupyRemainingMemory(): number {
  const bytes = DEBUG_CAPTURE_MEMORY_MAX_BYTES - debugCaptureMemoryUsage()
  expect(reserveDebugCaptureMemory(bytes)).toBe(true)
  return bytes
}

test("keeps an HTTP 400 capture for its full hour when memory is available", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  const failed = start()
  finish(
    failed,
    400,
    '{"error":{"message":"Encrypted function output content could not be decrypted or decoded."}}',
  )
  const original = await getLlmDebugLog(failed)
  jest.setSystemTime(now + 10 * 60_000 + 1)
  finish(start())
  expect(await getLlmDebugLog(failed)).toEqual(original)
  jest.setSystemTime(now + 60 * 60_000 - 1)
  expect(await getLlmDebugLog(failed)).toEqual(original)
  jest.setSystemTime(now + 60 * 60_000)
  expect(await getLlmDebugLog(failed)).toBeUndefined()
  expect(debugCaptureMemoryUsage()).toBe(0)
})

test("evicts a newer successful capture before an older aborted or pending capture", async () => {
  const failed = start()
  abortLlmDebugLog(failed, {
    error: new DOMException("disconnected", "AbortError"),
  })
  const pending = start()
  const pendingSignal = getLlmDebugCaptureSignal(pending)
  const success = start()
  finish(success, 200, "x".repeat(4096))
  const reserved = occupyRemainingMemory()
  try {
    const replacement = start()
    expect((await getLlmDebugLog(failed))?.status).toBe("aborted")
    expect((await getLlmDebugLog(pending))?.status).toBe("pending")
    expect(pendingSignal.aborted).toBe(false)
    expect(await getLlmDebugLog(success)).toBeUndefined()
    expect((await getLlmDebugLog(replacement))?.status).toBe("pending")
    expect(await listLlmDebugLogs()).toMatchObject({
      capacity: { droppedCaptures: 0, evictedCaptures: 1 },
    })
    expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
      DEBUG_CAPTURE_MEMORY_MAX_BYTES,
    )
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
})

test("evicts the oldest failures when no successful captures remain", async () => {
  const older = start()
  finish(older, 400, "x".repeat(2048))
  const failed = start()
  finish(failed, 400)
  const reserved = occupyRemainingMemory()
  try {
    const replacement = start()
    expect(await getLlmDebugLog(older)).toBeUndefined()
    expect((await getLlmDebugLog(failed))?.status).toBe("error")
    expect((await getLlmDebugLog(replacement))?.status).toBe("pending")
    expect(await listLlmDebugLogs()).toMatchObject({
      capacity: { droppedCaptures: 0, evictedCaptures: 1 },
    })
    expect(debugCaptureMemoryUsage()).toBeLessThanOrEqual(
      DEBUG_CAPTURE_MEMORY_MAX_BYTES,
    )
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
})

test("evicts a newly successful response before older failures", async () => {
  const failed = start()
  finish(failed, 400, "x".repeat(4096))
  const completing = start()
  const original = await getLlmDebugLog(failed)
  const reserved = occupyRemainingMemory()
  try {
    finish(completing, 200, "x".repeat(1024))
    expect(await getLlmDebugLog(failed)).toEqual(original)
    expect(await getLlmDebugLog(completing)).toBeUndefined()
    expect(await listLlmDebugLogs()).toMatchObject({
      capacity: { droppedCaptures: 0, evictedCaptures: 1 },
    })
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
})

test("entry-count pressure uses the same oldest-failure fallback", async () => {
  const retained = []
  for (let index = 0; index < 2000; index += 1) {
    const id = start()
    finish(id, 400)
    retained.push(id)
  }
  const replacement = start()
  expect(await getLlmDebugLog(retained[0])).toBeUndefined()
  expect((await getLlmDebugLog(retained[1]))?.status).toBe("error")
  expect((await getLlmDebugLog(retained.at(-1) ?? ""))?.status).toBe("error")
  expect((await getLlmDebugLog(replacement))?.status).toBe("pending")
  expect(await listLlmDebugLogs()).toMatchObject({
    capacity: { droppedCaptures: 0, evictedCaptures: 1 },
  })
})

test("clearing during terminal cancellation leaves no orphaned memory reservation", async () => {
  const id = start()
  const signal = getLlmDebugCaptureSignal(id)
  signal.addEventListener(
    "abort",
    () => {
      void clearLlmDebugLogs()
    },
    { once: true },
  )
  finish(id, 400)
  expect(await getLlmDebugLog(id)).toBeUndefined()
  expect(debugCaptureMemoryUsage()).toBe(0)
  expect(await listLlmDebugLogs()).toMatchObject({
    capacity: { droppedCaptures: 0, evictedCaptures: 0 },
  })
})

test("clearing from an evicted pending reader releases a terminal reservation", async () => {
  const pending = start()
  const growing = start()
  getLlmDebugCaptureSignal(pending).addEventListener(
    "abort",
    () => {
      void clearLlmDebugLogs()
    },
    { once: true },
  )
  const reserved =
    DEBUG_CAPTURE_MEMORY_MAX_BYTES - debugCaptureMemoryUsage() - 2000
  expect(reserveDebugCaptureMemory(reserved)).toBe(true)
  try {
    finish(growing, 400, "x".repeat(800))
    expect(await getLlmDebugLog(growing)).toBeUndefined()
    expect(debugCaptureMemoryUsage()).toBe(reserved)
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
  expect(debugCaptureMemoryUsage()).toBe(0)
})

test("clearing logs resets capacity counts while expiry does not count as eviction", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  const success = start()
  finish(success)
  jest.setSystemTime(now + 10 * 60_000)
  expect(await listLlmDebugLogs()).toMatchObject({
    capacity: { droppedCaptures: 0, evictedCaptures: 0 },
  })
  const failure = start()
  finish(failure, 400)
  const reserved = occupyRemainingMemory()
  try {
    start()
    expect(await listLlmDebugLogs()).toMatchObject({
      capacity: { droppedCaptures: 0, evictedCaptures: 1 },
    })
  } finally {
    releaseDebugCaptureMemory(reserved)
  }
  await clearLlmDebugLogs()
  expect(await listLlmDebugLogs()).toMatchObject({
    count: 0,
    capacity: { droppedCaptures: 0, evictedCaptures: 0 },
  })
})

test("HTTP 200 streamed failures use the one-hour deadline without changing raw bytes", async () => {
  jest.useFakeTimers()
  const now = Date.now()
  const id = start()
  const body =
    'event: response.failed\r\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"invalid_encrypted_content"}}}\r\n\r\n'
  finishLlmDebugLog(id, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/event-stream" },
    body,
  })
  expect((await getLlmDebugLog(id))?.status).toBe("error")
  jest.setSystemTime(now + 10 * 60_000 + 1)
  expect((await getLlmDebugLog(id))?.response?.body).toBe(body)
  jest.setSystemTime(now + 60 * 60_000)
  expect(await getLlmDebugLog(id)).toBeUndefined()
})
