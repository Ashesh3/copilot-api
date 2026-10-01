import type { Model } from "~/services/copilot/get-models"

import { classifyProvider } from "./model-candidates"

interface CacheControlProbeOptions {
  models: ReadonlyArray<Model>
  request: (model: Model, signal: AbortSignal) => Promise<Response>
  maxCandidates?: number
  candidateTimeoutMs?: number
  totalTimeoutMs?: number
}

export async function probeResponsesCacheControl(
  options: CacheControlProbeOptions,
): Promise<Response> {
  const deadline = performance.now() + (options.totalTimeoutMs ?? 50_000)
  const failures: Array<{
    providerClass: string
    status?: number
    code?: string
  }> = []
  for (const model of rotateProviders(options.models).slice(
    0,
    options.maxCandidates ?? 20,
  )) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    const result = await probeCandidate(
      options.request,
      model,
      Math.min(options.candidateTimeoutMs ?? 8000, remaining),
    )
    const providerClass = classifyProvider(model)
    if (!result) {
      failures.push({ providerClass, code: "probe_deadline" })
      if (remaining <= (options.candidateTimeoutMs ?? 8000)) break
      continue
    }
    const { response, body } = result
    if (response.status === 200) return response
    const failure = {
      providerClass,
      status: response.status,
      code: readSafeCode(body),
    }
    failures.push(failure)
    if (!isRecoverable(failure.status, failure.code)) {
      throw new Error(
        `Cache control probe stopped on an unexpected failure: ${JSON.stringify(failure)}`,
      )
    }
  }
  throw new Error(
    `No advertised Responses model accepted explicit cache controls: ${JSON.stringify(failures)}`,
  )
}

function rotateProviders(models: ReadonlyArray<Model>): Array<Model> {
  const groups = new Map<string, Array<Model>>()
  const ids = new Set<string>()
  for (const model of models) {
    if (!model.supported_endpoints?.includes("/responses") || ids.has(model.id))
      continue
    ids.add(model.id)
    const provider =
      model.vendor?.trim().toLowerCase()
      || `family:${model.capabilities.family.trim().toLowerCase()}`
    const group = groups.get(provider) ?? []
    group.push(model)
    groups.set(provider, group)
  }
  const candidates: Array<Model> = []
  for (let index = 0; candidates.length < ids.size; index++) {
    for (const group of groups.values()) {
      if (group[index]) candidates.push(group[index])
    }
  }
  return candidates
}

async function probeCandidate(
  request: CacheControlProbeOptions["request"],
  model: Model,
  timeoutMs: number,
): Promise<{ response: Response; body: string } | undefined> {
  const controller = new AbortController()
  const deadlineError = new DOMException(
    "Cache control probe deadline",
    "TimeoutError",
  )
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await request(model, controller.signal)
        if (controller.signal.aborted) {
          void response.body?.cancel(deadlineError).catch(() => {})
          throw deadlineError
        }
        reader = (
          response.body as ReadableStream<Uint8Array> | null
        )?.getReader()
        const decoder = new TextDecoder()
        let body = ""
        while (reader) {
          const chunk = await reader.read()
          controller.signal.throwIfAborted()
          if (chunk.done) break
          body += decoder.decode(chunk.value, { stream: true })
        }
        return { response, body: body + decoder.decode() }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(deadlineError)
          void reader?.cancel(deadlineError).catch(() => {})
          reject(deadlineError)
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (error === deadlineError) return undefined
    void reader?.cancel(error).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    reader?.releaseLock()
  }
}

function readSafeCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || !("error" in parsed))
      return undefined
    const error = parsed.error
    if (!error || typeof error !== "object" || !("code" in error))
      return undefined
    return typeof error.code === "string" && /^[\w.-]{1,80}$/.test(error.code) ?
        error.code
      : undefined
  } catch {
    return undefined
  }
}

function isRecoverable(status: number, code?: string): boolean {
  if ([400, 403, 404, 409, 422, 429].includes(status)) return true
  return status === 503 && code === "model_overloaded"
}
