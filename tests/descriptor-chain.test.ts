import { expect, test } from "bun:test"

import {
  readDescriptorSnapshotValue,
  readNativeDomExceptionField,
  readNativeErrorMessage,
  snapshotDescriptorChain,
} from "../src/lib/descriptor-chain"
import { isAbortError } from "../src/lib/error"
import { toLlmDebugLogError } from "../src/lib/llm-debug-log"
import { sanitizeHandlerLogArguments } from "../src/lib/logger"
import {
  getErrorCode,
  isAbortLikeError,
  isConnectionError,
} from "../src/services/copilot/transport-retry"

const ERROR_KEYS = new Set(["code", "message", "name"])

function objectWithDescriptors(
  prototype: object | null,
  descriptors: PropertyDescriptorMap,
): object {
  return Object.create(prototype, descriptors) as object
}

function errorWithPrototype(prototype: object): Error {
  const error = new Error()
  Object.setPrototypeOf(error, prototype)
  return error
}

interface EmptyDescriptorCase {
  readonly label: string
  readonly value: object
}

function snapshot(value: unknown) {
  return snapshotDescriptorChain(value, { keys: ERROR_KEYS, maxDepth: 6 })
}

function defineUnreadable(
  value: object,
  key: "code" | "message" | "name",
  getterCalls: { count: number },
): void {
  Object.defineProperty(value, key, {
    configurable: true,
    get() {
      getterCalls.count += 1
      throw new Error(`unreadable ${key}`)
    },
  })
}

test("the nearest Error accessor blocks lower data and native fallback", () => {
  const getterCalls = { count: 0 }
  const lowerData = Object.create(Error.prototype, {
    message: { configurable: true, value: "lower private message" },
  }) as object
  const nearer = Object.create(lowerData) as object
  const error = new Error()
  defineUnreadable(nearer, "message", getterCalls)
  Object.setPrototypeOf(error, nearer)

  const result = snapshot(error)

  expect(readDescriptorSnapshotValue(result, "message")).toBeUndefined()
  expect(readNativeErrorMessage(result)).toBeUndefined()
  expect(result?.blockedDescriptors.has("message")).toBe(true)
  expect(toLlmDebugLogError(error)).toMatchObject({
    message: "Unknown thrown value",
    name: "Error",
  })
  expect(getterCalls.count).toBe(0)
})

test("an own DOMException accessor blocks lower data and native fallback", () => {
  const getterCalls = { count: 0 }
  const error = new DOMException("lower private message", "AbortError")
  const lowerData = Object.create(DOMException.prototype, {
    name: { configurable: true, value: "AbortError" },
  }) as object
  Object.setPrototypeOf(error, lowerData)
  defineUnreadable(error, "name", getterCalls)

  const result = snapshot(error)

  expect(readDescriptorSnapshotValue(result, "name")).toBeUndefined()
  expect(readNativeDomExceptionField(result, "name")).toBeUndefined()
  expect(result?.blockedDescriptors.has("name")).toBe(true)
  expect(isAbortLikeError(error)).toBe(false)
  expect(isAbortError(error)).toBe(false)
  expect(toLlmDebugLogError(error)).toMatchObject({
    code: 20,
    message: "lower private message",
    name: "Error",
  })
  expect(getterCalls.count).toBe(0)
})

test("a lower accessor still shadows still-lower data", () => {
  const getterCalls = { count: 0 }
  const lowerData = Object.create(null, {
    code: { configurable: true, value: "ECONNRESET" },
  }) as object
  const lowerAccessor = Object.create(lowerData) as object
  defineUnreadable(lowerAccessor, "code", getterCalls)
  const error = Object.create(lowerAccessor) as object

  const result = snapshot(error)

  expect(readDescriptorSnapshotValue(result, "code")).toBeUndefined()
  expect(result?.blockedDescriptors.has("code")).toBe(true)
  expect(getErrorCode(error)).toBeUndefined()
  expect(isConnectionError(error)).toBe(false)
  expect(getterCalls.count).toBe(0)
})

test.each<EmptyDescriptorCase>([
  {
    label: "own",
    value: new Error(""),
  },
  {
    label: "inherited",
    value: errorWithPrototype(
      objectWithDescriptors(Error.prototype, {
        message: { configurable: true, value: "" },
      }),
    ),
  },
])("preserves an exact $label empty data descriptor", ({ value }) => {
  const result = snapshot(value)

  expect(result?.descriptors.has("message")).toBe(true)
  expect(readDescriptorSnapshotValue(result, "message")).toBe("")
  expect(toLlmDebugLogError(value).message).toBe("")
})

test("a present undefined data descriptor blocks native fallback", () => {
  const ordinary = new Error()
  Object.defineProperty(ordinary, "message", { value: undefined })
  const domException = new DOMException("private message", "AbortError")
  Object.defineProperty(domException, "name", { value: undefined })

  expect(readNativeErrorMessage(snapshot(ordinary))).toBeUndefined()
  expect(
    readNativeDomExceptionField(snapshot(domException), "name"),
  ).toBeUndefined()
  expect(toLlmDebugLogError(ordinary).message).toBe("Unknown thrown value")
  expect(toLlmDebugLogError(domException).name).toBe("Error")
})

test("ordinary logging does not use a blocked lower Error name", () => {
  const getterCalls = { count: 0 }
  const lowerData = Object.create(Error.prototype, {
    name: { configurable: true, value: "AbortError" },
  }) as object
  const nearer = Object.create(lowerData) as object
  const error = new Error("private message")
  defineUnreadable(nearer, "name", getterCalls)
  Object.setPrototypeOf(error, nearer)

  expect(sanitizeHandlerLogArguments(["Prepared request", error])).toEqual([
    "Prepared request",
    { name: "Error" },
  ])
  expect(getterCalls.count).toBe(0)
})

test("a proxy in the descriptor chain fails closed without traps", () => {
  let prototypeTrapCalls = 0
  const proxyTarget = objectWithDescriptors(null, {
    code: { value: "ECONNRESET" },
  })
  const hostilePrototype = new Proxy(proxyTarget, {
    getPrototypeOf() {
      prototypeTrapCalls += 1
      throw new Error("private proxy marker")
    },
  })
  const error = Object.create(hostilePrototype) as object

  expect(snapshot(error)).toBeUndefined()
  expect(getErrorCode(error)).toBeUndefined()
  expect(isConnectionError(error)).toBe(false)
  expect(prototypeTrapCalls).toBe(0)
})
