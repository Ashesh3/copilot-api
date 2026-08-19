import util from "node:util"

const SNAPSHOT_MAX_DEPTH = 16
const SNAPSHOT_MAX_NODES = 2048

type DescriptorMap = Readonly<
  Record<PropertyKey, PropertyDescriptor | undefined>
>

interface SnapshotState {
  nodes: number
  readonly seen: WeakSet<object>
}

interface SnapshotContext {
  readonly depth: number
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
  const { depth, state } = context
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
    const item = snapshotValue(descriptor.value, state, depth + 1)
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
  const { depth, state } = context
  const prototype = readPrototype(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return SNAPSHOT_FAILURE
  }
  const clone: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return SNAPSHOT_FAILURE
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return SNAPSHOT_FAILURE
    }
    const nested = snapshotValue(descriptor.value, state, depth + 1)
    if (!nested.ok) return SNAPSHOT_FAILURE
    clone[key] = nested.value
  }
  return snapshotSuccess(Object.freeze(clone))
}

function snapshotValue(
  value: unknown,
  state: SnapshotState,
  depth: number,
): SnapshotResult {
  const primitive = snapshotPrimitive(value)
  if (primitive) return primitive
  if (
    typeof value !== "object"
    || value === null
    || depth > SNAPSHOT_MAX_DEPTH
    || isProxyObject(value)
    || state.seen.has(value)
  ) {
    return SNAPSHOT_FAILURE
  }
  state.nodes += 1
  if (state.nodes > SNAPSHOT_MAX_NODES) return SNAPSHOT_FAILURE
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
    return snapshotArray(value as Array<unknown>, descriptors, { depth, state })
  }
  return snapshotRecord(value, descriptors, { depth, state })
}

export function snapshotPlainDataRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const snapshot = snapshotValue(
    value,
    { nodes: 0, seen: new WeakSet<object>() },
    0,
  )
  if (!snapshot.ok) return undefined
  const result = snapshot.value
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined
  }
  return result as Readonly<Record<string, unknown>>
}
