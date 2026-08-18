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

const ERROR_KEYS = new Set(["code", "message", "name", "stack"])

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

type LowerPrototypeKind = "accessor" | "data"

interface NativeErrorShadowCase {
  readonly create: () => Error
  readonly expectedName: "Error" | "TypeError"
  readonly label: string
  readonly lowerKind: LowerPrototypeKind
  readonly nativePrototype: object
}

function lowerDescriptors(
  kind: LowerPrototypeKind,
  getterCalls: { count: number },
): PropertyDescriptorMap {
  if (kind === "data") {
    return {
      code: { configurable: true, value: "LOWER_PRIVATE_CODE" },
      message: { configurable: true, value: "lower private message" },
      name: { configurable: true, value: "AbortError" },
      stack: { configurable: true, value: "lower private stack" },
    }
  }

  return Object.fromEntries(
    ["code", "message", "name", "stack"].map((key) => [
      key,
      {
        configurable: true,
        get() {
          getterCalls.count += 1
          throw new Error(`unreadable lower ${key}`)
        },
      },
    ]),
  )
}

function withLowerPrototype<T>(
  nativePrototype: object,
  descriptors: PropertyDescriptorMap,
  callback: () => T,
): T {
  const originalPrototype = Object.getPrototypeOf(nativePrototype) as
    | object
    | null
  const lowerPrototype = objectWithDescriptors(originalPrototype, descriptors)
  Object.setPrototypeOf(nativePrototype, lowerPrototype)
  try {
    return callback()
  } finally {
    Object.setPrototypeOf(nativePrototype, originalPrototype)
  }
}

function withRevokedLowerPrototype<T>(
  nativePrototype: object,
  callback: () => T,
): T {
  const originalPrototype = Object.getPrototypeOf(nativePrototype) as
    | object
    | null
  const { proxy, revoke } = Proxy.revocable(
    Object.create(originalPrototype) as object,
    {},
  )
  revoke()
  Object.setPrototypeOf(nativePrototype, proxy)
  try {
    return callback()
  } finally {
    Object.setPrototypeOf(nativePrototype, originalPrototype)
  }
}

const NATIVE_ERROR_SHADOW_CASES: Array<NativeErrorShadowCase> = [
  ...(["data", "accessor"] as const).map((lowerKind) => ({
    create: () => new Error(),
    expectedName: "Error" as const,
    label: `Error over lower ${lowerKind}`,
    lowerKind,
    nativePrototype: Error.prototype,
  })),
  ...(["data", "accessor"] as const).map((lowerKind) => ({
    create: () => new TypeError(),
    expectedName: "TypeError" as const,
    label: `TypeError over lower ${lowerKind}`,
    lowerKind,
    nativePrototype: TypeError.prototype,
  })),
]

test.each(NATIVE_ERROR_SHADOW_CASES.map((testCase) => [testCase] as const))(
  "preserves native $label fields",
  ({ create, expectedName, lowerKind, nativePrototype }) => {
    const getterCalls = { count: 0 }
    withLowerPrototype(
      nativePrototype,
      lowerDescriptors(lowerKind, getterCalls),
      () => {
        const error = create()
        Object.defineProperty(error, "code", {
          configurable: true,
          value: "ECONNRESET",
        })
        const expectedStack = error.stack
        const result = snapshot(error)

        expect(result).toBeDefined()
        expect(readDescriptorSnapshotValue(result, "message")).toBeUndefined()
        expect(readNativeErrorMessage(result)).toBe("")
        expect(getErrorCode(error)).toBe("ECONNRESET")
        expect(isConnectionError(error)).toBe(true)
        expect(
          sanitizeHandlerLogArguments(["Prepared request", error]),
        ).toEqual(["Prepared request", { name: expectedName }])
        expect(toLlmDebugLogError(error)).toMatchObject({
          code: "ECONNRESET",
          message: "",
          name: expectedName,
          stack: expectedStack,
        })
      },
    )
    expect(getterCalls.count).toBe(0)
  },
)

test.each(["data", "accessor"] as const)(
  "preserves native DOMException fields over a lower %s descriptor",
  (lowerKind) => {
    const getterCalls = { count: 0 }
    withLowerPrototype(
      DOMException.prototype,
      lowerDescriptors(lowerKind, getterCalls),
      () => {
        const error = new DOMException("", "AbortError")
        const result = snapshot(error)

        expect(result).toBeDefined()
        expect(readDescriptorSnapshotValue(result, "code")).toBeUndefined()
        expect(readDescriptorSnapshotValue(result, "message")).toBeUndefined()
        expect(readDescriptorSnapshotValue(result, "name")).toBeUndefined()
        expect(readDescriptorSnapshotValue(result, "stack")).toBeUndefined()
        expect(result?.blockedDescriptors.has("stack")).toBe(true)
        expect(readNativeDomExceptionField(result, "code")).toBe(20)
        expect(readNativeDomExceptionField(result, "message")).toBe("")
        expect(readNativeDomExceptionField(result, "name")).toBe("AbortError")
        expect(isAbortLikeError(error)).toBe(true)
        expect(isAbortError(error)).toBe(true)
        expect(isConnectionError(error)).toBe(false)
        expect(toLlmDebugLogError(error)).toEqual({
          code: 20,
          message: "",
          name: "AbortError",
        })
      },
    )
    expect(getterCalls.count).toBe(0)
  },
)

test("uses blocked fallback when native DOMException reconstruction is unreadable", () => {
  const privateMarker = "lower-dom-private-marker"
  withLowerPrototype(
    DOMException.prototype,
    {
      code: { configurable: true, value: privateMarker },
      message: { configurable: true, value: privateMarker },
      name: { configurable: true, value: "AbortError" },
    },
    () => {
      const error = new DOMException("native message", "AbortError")
      Object.defineProperty(error, "details", {
        enumerable: true,
        value: { privateMarker },
      })
      const result = snapshot(error)

      expect(result).toBeDefined()
      expect(readNativeDomExceptionField(result, "code")).toBeUndefined()
      expect(readNativeDomExceptionField(result, "message")).toBeUndefined()
      expect(readNativeDomExceptionField(result, "name")).toBeUndefined()
      expect(result?.blockedDescriptors.has("code")).toBe(true)
      expect(result?.blockedDescriptors.has("message")).toBe(true)
      expect(result?.blockedDescriptors.has("name")).toBe(true)
      expect(isAbortLikeError(error)).toBe(false)
      expect(isAbortError(error)).toBe(false)
      expect(toLlmDebugLogError(error)).toEqual({
        message: "Unknown thrown value",
        name: "Error",
      })
      expect(JSON.stringify(toLlmDebugLogError(error))).not.toContain(
        privateMarker,
      )
    },
  )
})

test("keeps native Error fields when a lower prototype is revoked", () => {
  withRevokedLowerPrototype(Error.prototype, () => {
    const error = new Error()
    Object.defineProperty(error, "code", { value: "ECONNRESET" })
    const expectedStack = error.stack
    const result = snapshot(error)

    expect(result).toBeDefined()
    expect(readNativeErrorMessage(result)).toBe("")
    expect(getErrorCode(error)).toBe("ECONNRESET")
    expect(isConnectionError(error)).toBe(true)
    expect(sanitizeHandlerLogArguments(["Prepared request", error])).toEqual([
      "Prepared request",
      { name: "Error" },
    ])
    expect(toLlmDebugLogError(error)).toMatchObject({
      code: "ECONNRESET",
      message: "",
      name: "Error",
      stack: expectedStack,
    })
  })
})

test("keeps native TypeError fields when a lower prototype is revoked", () => {
  withRevokedLowerPrototype(TypeError.prototype, () => {
    const error = new TypeError()
    Object.defineProperty(error, "code", { value: "ECONNRESET" })
    const expectedStack = error.stack
    const result = snapshot(error)

    expect(result).toBeDefined()
    expect(readNativeErrorMessage(result)).toBe("")
    expect(getErrorCode(error)).toBe("ECONNRESET")
    expect(isConnectionError(error)).toBe(true)
    expect(sanitizeHandlerLogArguments(["Prepared request", error])).toEqual([
      "Prepared request",
      { name: "TypeError" },
    ])
    expect(toLlmDebugLogError(error)).toMatchObject({
      code: "ECONNRESET",
      message: "",
      name: "TypeError",
      stack: expectedStack,
    })
  })
})

test("keeps native DOMException fields when a lower prototype is revoked", () => {
  withRevokedLowerPrototype(DOMException.prototype, () => {
    const error = new DOMException("", "AbortError")
    const result = snapshot(error)

    expect(result).toBeDefined()
    expect(readNativeDomExceptionField(result, "code")).toBe(20)
    expect(readNativeDomExceptionField(result, "message")).toBe("")
    expect(readNativeDomExceptionField(result, "name")).toBe("AbortError")
    expect(isAbortLikeError(error)).toBe(true)
    expect(isAbortError(error)).toBe(true)
    expect(isConnectionError(error)).toBe(false)
    expect(toLlmDebugLogError(error)).toMatchObject({
      code: 20,
      message: "",
      name: "AbortError",
    })
  })
})

test("keeps a native-absent DOMException stack over a revoked prototype", () => {
  withRevokedLowerPrototype(DOMException.prototype, () => {
    const result = snapshotDescriptorChain(new DOMException("", "AbortError"), {
      keys: new Set(["stack"]),
      maxDepth: 6,
    })

    expect(result).toBeDefined()
    expect(readDescriptorSnapshotValue(result, "stack")).toBeUndefined()
    expect(result?.blockedDescriptors.has("stack")).toBe(true)
  })
})

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
