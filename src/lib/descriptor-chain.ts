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

function shouldSkipBaseErrorDescriptor(current: object, key: string): boolean {
  return (
    (current === Error.prototype || current === TypeError.prototype)
    && (key === "message" || key === "name")
  )
}

function collectAllowlistedDescriptors(
  options: {
    readonly current: object
    readonly keys: ReadonlySet<string>
    readonly ownDescriptors: Record<string, PropertyDescriptor>
  },
  collected: Map<string, PropertyDescriptor>,
  blocked: Set<string>,
): void {
  const { current, keys, ownDescriptors } = options
  for (const key of keys) {
    if (collected.has(key) || !Object.hasOwn(ownDescriptors, key)) continue
    if (shouldSkipBaseErrorDescriptor(current, key)) continue
    const descriptor = ownDescriptors[key]
    if ("value" in descriptor) collected.set(key, descriptor)
    else blocked.add(key)
  }
}

interface DescriptorChainWalk {
  readonly blockedDescriptors: Set<string>
  readonly descriptors: Map<string, PropertyDescriptor>
  readonly domExceptionPrototypeSeen: boolean
  readonly errorPrototypeSeen: boolean
  readonly rootDescriptors: Record<string, PropertyDescriptor>
}

function walkDescriptorChain(
  value: object,
  options: SnapshotDescriptorChainOptions,
): DescriptorChainWalk | undefined {
  const blockedDescriptors = new Set<string>()
  const descriptors = new Map<string, PropertyDescriptor>()
  let domExceptionPrototypeSeen = false
  let errorPrototypeSeen = false
  let rootDescriptors: Record<string, PropertyDescriptor> | undefined
  let current: object | null = value

  for (let depth = 0; depth < options.maxDepth && current !== null; depth++) {
    if (depth > 0 && safeIsProxy(current)) return undefined
    let ownDescriptors: Record<string, PropertyDescriptor>
    try {
      ownDescriptors = Object.getOwnPropertyDescriptors(current)
    } catch {
      return undefined
    }
    rootDescriptors ??= ownDescriptors
    if (current === DOMException.prototype) domExceptionPrototypeSeen = true
    if (current === Error.prototype) errorPrototypeSeen = true
    collectAllowlistedDescriptors(
      { current, keys: options.keys, ownDescriptors },
      descriptors,
      blockedDescriptors,
    )
    try {
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      return undefined
    }
  }

  if (current !== null || !rootDescriptors) return undefined
  return {
    blockedDescriptors,
    descriptors,
    domExceptionPrototypeSeen,
    errorPrototypeSeen,
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
  const error =
    errorKind && chain.errorPrototypeSeen ?
      { message: Error.prototype.message }
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

export function readNativeDomExceptionField(
  snapshot: DescriptorChainSnapshot | undefined,
  key: "code" | "message" | "name",
): unknown {
  const descriptorValue = readDescriptorSnapshotValue(snapshot, key)
  if (descriptorValue !== undefined) return descriptorValue
  if (snapshot?.prototypeKind !== "DOMException") return undefined
  return snapshot.domException?.[key]
}

export function readNativeErrorMessage(
  snapshot: DescriptorChainSnapshot | undefined,
): unknown {
  const descriptorValue = readDescriptorSnapshotValue(snapshot, "message")
  if (descriptorValue !== undefined) return descriptorValue
  if (snapshot?.blockedDescriptors.has("message")) return undefined
  return snapshot?.error?.message
}
