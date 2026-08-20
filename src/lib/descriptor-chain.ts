import util from "node:util"

export interface DescriptorChainSnapshot {
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>
  readonly domException?: {
    readonly code: number
    readonly message: string
    readonly name: string
  }
  readonly error?: {
    readonly message: string
  }
  readonly blockedDescriptors: ReadonlySet<string>
  readonly errorKind?: "Error" | "TypeError"
  readonly prototypeKind?: "DOMException"
}

export interface SnapshotDescriptorChainOptions {
  readonly keys: ReadonlySet<string>
  readonly maxDepth: number
}

function safeIsProxy(value: object): boolean {
  try {
    return util.types.isProxy(value)
  } catch {
    return true
  }
}

function safeErrorKind(value: object): "Error" | "TypeError" | undefined {
  try {
    if (!Error.isError(value)) return undefined
  } catch {
    return undefined
  }

  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value) as object | null
  } catch {
    return undefined
  }
  if (prototype === TypeError.prototype) return "TypeError"
  return "Error"
}

function isDataOnlyCloneCandidate(
  rootDescriptors: Record<string, PropertyDescriptor>,
): boolean {
  for (const descriptor of Object.values(rootDescriptors)) {
    if (!descriptor.enumerable) continue
    if (!("value" in descriptor)) return false
    const fieldValue: unknown = descriptor.value
    if (
      fieldValue !== null
      && fieldValue !== undefined
      && typeof fieldValue === "object"
    ) {
      return false
    }
    if (typeof fieldValue === "function") return false
  }
  return true
}

function cloneDomException(value: object): object | undefined {
  let clone: object
  try {
    clone = structuredClone(value)
  } catch {
    return undefined
  }
  return clone
}

function readDomExceptionClone(
  clone: object,
): DescriptorChainSnapshot["domException"] | undefined {
  if (Object.getPrototypeOf(clone) !== DOMException.prototype) {
    return undefined
  }

  const prototypeDescriptors = Object.getOwnPropertyDescriptors(
    DOMException.prototype,
  )
  // DOMException.code is deprecated but remains part of the raw admin record.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const codeGetter = prototypeDescriptors["code"].get
  const messageGetter = prototypeDescriptors["message"].get
  const nameGetter = prototypeDescriptors["name"].get
  if (!codeGetter || !messageGetter || !nameGetter) return undefined

  const code = Reflect.apply(codeGetter, clone, []) as unknown
  const message = Reflect.apply(messageGetter, clone, []) as unknown
  const name = Reflect.apply(nameGetter, clone, []) as unknown
  if (
    typeof code !== "number"
    || typeof message !== "string"
    || typeof name !== "string"
  ) {
    return undefined
  }
  return { code, message, name }
}

function snapshotDomException(
  value: object,
  rootDescriptors: Record<string, PropertyDescriptor>,
): DescriptorChainSnapshot["domException"] | undefined {
  if (!isDataOnlyCloneCandidate(rootDescriptors)) return undefined
  const clone = cloneDomException(value)
  if (!clone) return undefined
  try {
    return readDomExceptionClone(clone)
  } catch {
    return undefined
  }
}

function shouldSkipNativePrototypeDescriptor(
  current: object,
  key: string,
): boolean {
  return (
    ((current === Error.prototype || current === TypeError.prototype)
      && (key === "message" || key === "name"))
    || (current === DOMException.prototype
      && (key === "code" || key === "message" || key === "name"))
  )
}

function isNativePrototypeDescriptor(
  current: object,
  key: string,
  descriptor: PropertyDescriptor,
): boolean {
  const isErrorPrototype =
    current === Error.prototype || current === TypeError.prototype
  return (
    shouldSkipNativePrototypeDescriptor(current, key)
    && (isErrorPrototype ?
      "value" in descriptor
    : !Object.hasOwn(descriptor, "value"))
  )
}

interface DescriptorResolutionState {
  readonly blockedDescriptors: Set<string>
  readonly descriptors: Map<string, PropertyDescriptor>
  readonly nativeDescriptors: Map<string, PropertyDescriptor | undefined>
}

function collectAllowlistedDescriptors(
  options: {
    readonly current: object
    readonly keys: ReadonlySet<string>
    readonly ownDescriptors: Record<string, PropertyDescriptor>
  },
  state: DescriptorResolutionState,
): void {
  const { current, keys, ownDescriptors } = options
  const { blockedDescriptors, descriptors, nativeDescriptors } = state
  for (const key of keys) {
    if (
      descriptors.has(key)
      || blockedDescriptors.has(key)
      || nativeDescriptors.has(key)
      || !Object.hasOwn(ownDescriptors, key)
    ) {
      continue
    }
    const descriptor = ownDescriptors[key]
    if (isNativePrototypeDescriptor(current, key, descriptor)) {
      nativeDescriptors.set(key, descriptor)
      continue
    }
    if ("value" in descriptor) descriptors.set(key, descriptor)
    else blockedDescriptors.add(key)
  }
}

interface DescriptorChainWalk {
  readonly blockedDescriptors: Set<string>
  readonly descriptors: Map<string, PropertyDescriptor>
  readonly domExceptionPrototypeSeen: boolean
  readonly nativeDescriptors: Map<string, PropertyDescriptor | undefined>
  readonly rootDescriptors: Record<string, PropertyDescriptor>
}

function areAllKeysResolved(
  keys: ReadonlySet<string>,
  state: DescriptorResolutionState,
): boolean {
  for (const key of keys) {
    if (!isKeyResolved(key, state)) return false
  }
  return true
}

function isKeyResolved(key: string, state: DescriptorResolutionState): boolean {
  return (
    state.descriptors.has(key)
    || state.blockedDescriptors.has(key)
    || state.nativeDescriptors.has(key)
  )
}

function resolveAbsentNativeDomExceptionStack(
  current: object,
  keys: ReadonlySet<string>,
  state: DescriptorResolutionState,
): void {
  if (
    current === DOMException.prototype
    && keys.has("stack")
    && !isKeyResolved("stack", state)
  ) {
    state.nativeDescriptors.set("stack", undefined)
    state.blockedDescriptors.add("stack")
  }
}

function canKeepPartialNativeSnapshot(
  nativeDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined>,
): boolean {
  return nativeDescriptors.size > 0
}

function readOwnDescriptors(
  current: object,
): Record<string, PropertyDescriptor> | undefined {
  try {
    return Object.getOwnPropertyDescriptors(current)
  } catch {
    return undefined
  }
}

function shouldStopBeforeCurrent(
  current: object,
  depth: number,
  nativeDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined>,
): boolean | undefined {
  if (depth === 0 || !safeIsProxy(current)) return false
  if (canKeepPartialNativeSnapshot(nativeDescriptors)) return true
  return undefined
}

function nextPrototype(
  current: object,
  nativeDescriptors: ReadonlyMap<string, PropertyDescriptor | undefined>,
): { current: object | null; partial: boolean } | undefined {
  try {
    return {
      current: Object.getPrototypeOf(current) as object | null,
      partial: false,
    }
  } catch {
    if (canKeepPartialNativeSnapshot(nativeDescriptors)) {
      return { current: null, partial: true }
    }
    return undefined
  }
}

function walkDescriptorChain(
  value: object,
  options: SnapshotDescriptorChainOptions,
): DescriptorChainWalk | undefined {
  const state: DescriptorResolutionState = {
    blockedDescriptors: new Set<string>(),
    descriptors: new Map<string, PropertyDescriptor>(),
    nativeDescriptors: new Map<string, PropertyDescriptor>(),
  }
  const { blockedDescriptors, descriptors, nativeDescriptors } = state
  let domExceptionPrototypeSeen = false
  let partialNativeSnapshotAllowed = false
  let rootDescriptors: Record<string, PropertyDescriptor> | undefined
  let current: object | null = value

  for (let depth = 0; depth < options.maxDepth && current !== null; depth++) {
    const stopBeforeCurrent = shouldStopBeforeCurrent(
      current,
      depth,
      nativeDescriptors,
    )
    if (stopBeforeCurrent === undefined) return undefined
    if (stopBeforeCurrent) {
      partialNativeSnapshotAllowed = true
      break
    }
    const ownDescriptors = readOwnDescriptors(current)
    if (!ownDescriptors) {
      if (canKeepPartialNativeSnapshot(nativeDescriptors)) {
        partialNativeSnapshotAllowed = true
        break
      }
      return undefined
    }
    rootDescriptors ??= ownDescriptors
    if (current === DOMException.prototype) domExceptionPrototypeSeen = true
    collectAllowlistedDescriptors(
      { current, keys: options.keys, ownDescriptors },
      state,
    )
    resolveAbsentNativeDomExceptionStack(current, options.keys, state)
    if (
      canKeepPartialNativeSnapshot(nativeDescriptors)
      && areAllKeysResolved(options.keys, state)
    ) {
      current = null
      break
    }
    const next = nextPrototype(current, nativeDescriptors)
    if (next === undefined) return undefined
    current = next.current
    partialNativeSnapshotAllowed ||= next.partial
  }

  if ((current !== null && !partialNativeSnapshotAllowed) || !rootDescriptors) {
    return undefined
  }
  return {
    blockedDescriptors,
    descriptors,
    domExceptionPrototypeSeen,
    nativeDescriptors,
    rootDescriptors,
  }
}

export function snapshotDescriptorChain(
  value: unknown,
  options: SnapshotDescriptorChainOptions,
): DescriptorChainSnapshot | undefined {
  if (typeof value !== "object" || value === null || safeIsProxy(value)) {
    return undefined
  }

  const chain = walkDescriptorChain(value, options)
  if (!chain) return undefined
  const errorKind = safeErrorKind(value)
  const domException =
    chain.domExceptionPrototypeSeen ?
      snapshotDomException(value, chain.rootDescriptors)
    : undefined
  if (chain.domExceptionPrototypeSeen && !domException) {
    for (const key of ["code", "message", "name"] as const) {
      if (chain.nativeDescriptors.has(key)) {
        chain.blockedDescriptors.add(key)
      }
    }
  }
  const errorMessageDescriptor = chain.nativeDescriptors.get("message")
  const error =
    (
      errorKind
      && errorMessageDescriptor
      && "value" in errorMessageDescriptor
      && typeof errorMessageDescriptor.value === "string"
    ) ?
      { message: errorMessageDescriptor.value }
    : undefined
  return {
    blockedDescriptors: chain.blockedDescriptors,
    descriptors: chain.descriptors,
    domException,
    error,
    errorKind,
    ...(domException ? { prototypeKind: "DOMException" as const } : {}),
  }
}

export function readDescriptorSnapshotValue(
  snapshot: DescriptorChainSnapshot | undefined,
  key: string,
): unknown {
  const descriptor = snapshot?.descriptors.get(key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function hasDescriptorSnapshotValue(
  snapshot: DescriptorChainSnapshot | undefined,
  key: string,
): boolean {
  return snapshot?.descriptors.has(key) === true
}

export function readNativeDomExceptionField(
  snapshot: DescriptorChainSnapshot | undefined,
  key: "code" | "message" | "name",
): unknown {
  const descriptorValue = readDescriptorSnapshotValue(snapshot, key)
  if (hasDescriptorSnapshotValue(snapshot, key)) return descriptorValue
  if (snapshot?.blockedDescriptors.has(key)) return undefined
  if (snapshot?.prototypeKind !== "DOMException") return undefined
  return snapshot.domException?.[key]
}

export function readNativeErrorMessage(
  snapshot: DescriptorChainSnapshot | undefined,
): unknown {
  const descriptorValue = readDescriptorSnapshotValue(snapshot, "message")
  if (hasDescriptorSnapshotValue(snapshot, "message")) return descriptorValue
  if (snapshot?.blockedDescriptors.has("message")) return undefined
  return snapshot?.error?.message
}
