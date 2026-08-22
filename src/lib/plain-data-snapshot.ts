import util from "node:util"

const SNAPSHOT_MAX_DEPTH = 16
const SNAPSHOT_MAX_NODES = 2048
const SNAPSHOT_MAX_ARRAY_LENGTH = SNAPSHOT_MAX_NODES
const REQUEST_SNAPSHOT_MAX_DEPTH = 64
const REQUEST_SNAPSHOT_MAX_NODES = 65_536
export const REQUEST_SNAPSHOT_MAX_ARRAY_LENGTH = REQUEST_SNAPSHOT_MAX_NODES

interface SnapshotLimits {
  readonly maxArrayLength: number
  readonly maxDepth: number
  readonly maxNodes: number
}

const GENERIC_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxArrayLength: SNAPSHOT_MAX_ARRAY_LENGTH,
  maxDepth: SNAPSHOT_MAX_DEPTH,
  maxNodes: SNAPSHOT_MAX_NODES,
}

const REQUEST_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxArrayLength: REQUEST_SNAPSHOT_MAX_ARRAY_LENGTH,
  maxDepth: REQUEST_SNAPSHOT_MAX_DEPTH,
  maxNodes: REQUEST_SNAPSHOT_MAX_NODES,
}

type DescriptorMap = Readonly<
  Record<PropertyKey, PropertyDescriptor | undefined>
>

interface SnapshotState {
  nodes: number
  readonly seen: WeakSet<object>
}

interface SnapshotContext {
  readonly depth: number
  readonly limits: SnapshotLimits
  readonly state: SnapshotState
}

interface SnapshotSuccess {
  readonly ok: true
  readonly value: unknown
}

interface SnapshotFailure {
  readonly ok: false
}

type SnapshotResult = SnapshotFailure | SnapshotSuccess

const SNAPSHOT_FAILURE: SnapshotFailure = Object.freeze({ ok: false })

function snapshotSuccess(value: unknown): SnapshotSuccess {
  return { ok: true, value }
}

export function isProxyObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  try {
    return util.types.isProxy(value)
  } catch {
    return true
  }
}

function snapshotPrimitive(value: unknown): SnapshotResult | undefined {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return snapshotSuccess(value)
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? snapshotSuccess(value) : SNAPSHOT_FAILURE
  }
  if (typeof value === "object") return undefined
  return SNAPSHOT_FAILURE
}

function readDescriptors(value: object): DescriptorMap | undefined {
  try {
    return Object.getOwnPropertyDescriptors(value) as DescriptorMap
  } catch {
    return undefined
  }
}

function readPrototype(value: object): object | null | undefined {
  try {
    return Object.getPrototypeOf(value) as object | null
  } catch {
    return undefined
  }
}

function snapshotArray(
  value: Array<unknown>,
  descriptors: DescriptorMap,
  context: SnapshotContext,
): SnapshotResult {
  const { depth, limits, state } = context
  if (readPrototype(value) !== Array.prototype) return SNAPSHOT_FAILURE
  const lengthDescriptor = descriptors.length
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return SNAPSHOT_FAILURE
  }
  const length = lengthDescriptor.value
  if (length > limits.maxArrayLength) return SNAPSHOT_FAILURE
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.some(
      (key) =>
        typeof key !== "string"
        || (key !== "length" && (!/^\d+$/u.test(key) || Number(key) >= length)),
    )
  ) {
    return SNAPSHOT_FAILURE
  }

  const clone = Array.from<unknown>({ length })
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return SNAPSHOT_FAILURE
    }
    const item = snapshotValue(descriptor.value, {
      depth: depth + 1,
      limits,
      state,
    })
    if (!item.ok) return SNAPSHOT_FAILURE
    clone[index] = item.value
  }
  return snapshotSuccess(Object.freeze(clone))
}

function snapshotRecord(
  value: object,
  descriptors: DescriptorMap,
  context: SnapshotContext,
): SnapshotResult {
  const { depth, limits, state } = context
  const prototype = readPrototype(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return SNAPSHOT_FAILURE
  }
  const clone = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return SNAPSHOT_FAILURE
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return SNAPSHOT_FAILURE
    }
    const nested = snapshotValue(descriptor.value, {
      depth: depth + 1,
      limits,
      state,
    })
    if (!nested.ok) return SNAPSHOT_FAILURE
    Object.defineProperty(clone, key, {
      configurable: false,
      enumerable: true,
      value: nested.value,
      writable: false,
    })
  }
  return snapshotSuccess(Object.freeze(clone))
}

function snapshotValue(
  value: unknown,
  context: SnapshotContext,
): SnapshotResult {
  const { depth, limits, state } = context
  const primitive = snapshotPrimitive(value)
  if (primitive) return primitive
  if (
    typeof value !== "object"
    || value === null
    || depth > limits.maxDepth
    || isProxyObject(value)
    || state.seen.has(value)
  ) {
    return SNAPSHOT_FAILURE
  }
  state.nodes += 1
  if (state.nodes > limits.maxNodes) return SNAPSHOT_FAILURE
  state.seen.add(value)
  const descriptors = readDescriptors(value)
  if (!descriptors) return SNAPSHOT_FAILURE
  let isArray: boolean
  try {
    isArray = Array.isArray(value)
  } catch {
    return SNAPSHOT_FAILURE
  }
  if (isArray) {
    return snapshotArray(value as Array<unknown>, descriptors, {
      depth,
      limits,
      state,
    })
  }
  return snapshotRecord(value, descriptors, { depth, limits, state })
}

function snapshotPlainDataRecordWithLimits(
  value: unknown,
  limits: SnapshotLimits,
): Readonly<Record<string, unknown>> | undefined {
  const snapshot = snapshotValue(value, {
    depth: 0,
    limits,
    state: { nodes: 0, seen: new WeakSet<object>() },
  })
  if (!snapshot.ok) return undefined
  const result = snapshot.value
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined
  }
  return result as Readonly<Record<string, unknown>>
}

export function snapshotPlainDataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return snapshotPlainDataRecordWithLimits(value, GENERIC_SNAPSHOT_LIMITS)
}

export function snapshotRequestPlainDataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return snapshotPlainDataRecordWithLimits(value, REQUEST_SNAPSHOT_LIMITS)
}
