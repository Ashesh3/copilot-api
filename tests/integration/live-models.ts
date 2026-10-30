import { test as bunTest, type TestOptions } from "bun:test"
import { relative } from "node:path"

import { normalizeModelName } from "~/lib/model-resolver"
import { state } from "~/lib/state"

/**
 * Live tests name models, and Copilot retires models over time. A test that
 * fails after every model it asked for turned out to be unavailable is
 * skipped with a warning instead: the model is not on this account, or
 * Copilot rejects it as not supported. The warning names the tests to move
 * to a current model or remove.
 */

const NOT_SUPPORTED =
  /\bmodel_not_supported\b|\bthe requested model is not supported\b/iu
const MODEL_IN_PATH = /\/models\/([^/:]+):/u

/** Per model the running test used: why it was unavailable, or undefined. */
let testModels: Map<string, string | undefined> | undefined
const skipped = new Map<string, Set<string>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether this account lists the model, as the gateway resolves its name. */
export function isListedModel(model: string): boolean {
  const listed = new Set(state.models?.data.map((entry) => entry.id))
  return listed.has(model) || listed.has(normalizeModelName(model))
}

function requestedModel(path: string, body: unknown): string | undefined {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown
      if (isRecord(parsed) && typeof parsed.model === "string") {
        return parsed.model
      }
    } catch {
      // Not JSON; the model may still be in the path.
    }
  }
  const match = MODEL_IN_PATH.exec(path)
  return match ? decodeURIComponent(match[1]) : undefined
}

async function unavailableReason(
  model: string,
  response: Response,
): Promise<string | undefined> {
  if (response.status < 400) return undefined
  if (!isListedModel(model)) return "is not available on this account"
  const body = await response
    .clone()
    .text()
    .catch(() => "")
  return NOT_SUPPORTED.test(body) ?
      "is listed, but Copilot rejects it as not supported"
    : undefined
}

/** Note which model a live request used and whether it was available. */
export async function recordLiveModelResponse(
  path: string,
  body: unknown,
  response: Response,
): Promise<void> {
  if (!testModels) return
  const model = requestedModel(path, body)
  if (!model) return
  const reason = await unavailableReason(model, response)
  // One request the model served shows the test reached a usable model.
  if (reason === undefined) testModels.set(model, undefined)
  else if (!testModels.has(model)) testModels.set(model, reason)
}

/** Skip a test with a warning because its model is unavailable. */
export function skipForUnavailableModel(
  label: string,
  model: string,
  reason: string,
): void {
  const key = `${model} ${reason}`
  const labels = skipped.get(key) ?? new Set<string>()
  labels.add(label)
  skipped.set(key, labels)
  console.warn(`Skipped live test "${label}": ${key}.`)
}

/**
 * Skip up front when the account does not list a model, sparing the request.
 * Returns true when the caller should return.
 */
export function skipUnlessListed(label: string, model: string): boolean {
  if (isListedModel(model)) return false
  skipForUnavailableModel(label, model, "is not available on this account")
  return true
}

/**
 * Run a live test body. When it fails and every model it sent a request to
 * was unavailable, the failure becomes a skip with a warning. A failure
 * after any model served a request still fails.
 */
export async function runLiveTest(
  label: string,
  fn: () => unknown,
): Promise<void> {
  const models = new Map<string, string | undefined>()
  testModels = models
  try {
    await fn()
  } catch (error) {
    const reasons = [...models]
    if (
      reasons.length === 0
      || reasons.some(([, reason]) => reason === undefined)
    ) {
      throw error
    }
    for (const [model, reason] of reasons) {
      if (reason) skipForUnavailableModel(label, model, reason)
    }
  } finally {
    if (testModels === models) testModels = undefined
  }
}

/** `test` for live suites; see `runLiveTest`. */
export function test(
  label: string,
  fn: () => unknown,
  options?: number | TestOptions,
): void {
  bunTest(label, () => runLiveTest(label, fn), options)
}

function escapeAnnotation(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
}

/**
 * Report this file's skipped tests once: on the console, and as a GitHub
 * Actions warning annotation in CI so the run summary shows what to update.
 */
export function reportSkippedLiveTests(): void {
  if (skipped.size === 0) return
  const file = relative(process.cwd(), Bun.main).replaceAll("\\", "/")
  const lines = [...skipped].map(
    ([key, labels]) => `- ${key}: ${[...labels].join("; ")}`,
  )
  skipped.clear()
  const message = [
    `Skipped live tests in ${file} because their models are unavailable. Move them to a current model or remove them.`,
    ...lines,
  ].join("\n")
  console.warn(message)
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(
      `::warning file=${file},title=Live tests skipped for unavailable models::${escapeAnnotation(message)}\n`,
    )
  }
}
