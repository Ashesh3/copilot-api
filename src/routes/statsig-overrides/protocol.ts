import { gunzipSync, strFromU8 } from "fflate"

import type { StatsigOverrides } from "./store"

type StatsigEvaluationMap = Record<string, Record<string, unknown>>

const INVALID_BODY_ERROR_MESSAGE = "Invalid Statsig initialization body"
const OBJECT_BODY_ERROR_MESSAGE =
  "Statsig initialization body must be a JSON object"
const INVALID_RESPONSE_OBJECT_ERROR_MESSAGE =
  "Statsig initialization response must be an object"
const INVALID_RESPONSE_SHAPE_ERROR_MESSAGE =
  "Statsig initialization response must be a full init-v1 response"
const INVALID_EVALUATION_MAPS_ERROR_MESSAGE =
  "Statsig initialization response must include feature_gates and dynamic_configs maps"

export class StatsigProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "StatsigProtocolError"
  }
}

export interface StatsigV1InitializeResponse extends Record<string, unknown> {
  has_updates: true
  feature_gates: Record<string, Record<string, unknown>>
  dynamic_configs: Record<string, Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function reverseString(value: string): string {
  return value.split("").reverse().join("")
}

function formatResponseFormat(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  const formattedValue = JSON.stringify(value)
  if (typeof formattedValue === "string") {
    return formattedValue
  }

  return Object.prototype.toString.call(value)
}

function validateEvaluationMap(
  map: Record<string, unknown>,
  mapName: "feature_gates" | "dynamic_configs",
): asserts map is StatsigEvaluationMap {
  for (const [name, evaluation] of Object.entries(map)) {
    if (!isRecord(evaluation)) {
      throw new StatsigProtocolError(
        `Statsig ${mapName}.${name} must be an object`,
      )
    }
  }
}

export function decodeStatsigInitializeBody(
  body: Uint8Array,
  options: { encoded: boolean; gzipped: boolean },
): Record<string, unknown> {
  try {
    const decodedBytes = options.gzipped ? gunzipSync(body) : body
    let bodyText = strFromU8(decodedBytes)

    if (options.encoded) {
      bodyText = Buffer.from(reverseString(bodyText), "base64").toString("utf8")
    }

    const parsedBody = JSON.parse(bodyText) as unknown
    if (!isRecord(parsedBody)) {
      throw new StatsigProtocolError(OBJECT_BODY_ERROR_MESSAGE)
    }

    return parsedBody
  } catch (error) {
    if (
      error instanceof StatsigProtocolError
      && error.message === OBJECT_BODY_ERROR_MESSAGE
    ) {
      throw error
    }

    throw new StatsigProtocolError(INVALID_BODY_ERROR_MESSAGE, { cause: error })
  }
}

export function createFullStatsigInitializeRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const fullRequest = structuredClone(body)

  fullRequest.sinceTime = 0
  fullRequest.partialUserMatchSinceTime = 0
  fullRequest.deltasResponseRequested = false
  fullRequest.full_checksum = null
  fullRequest.previousDerivedFields = {}

  return fullRequest
}

export function applyStatsigOverrides(
  input: unknown,
  overrides: StatsigOverrides,
): StatsigV1InitializeResponse {
  if (!isRecord(input)) {
    throw new StatsigProtocolError(INVALID_RESPONSE_OBJECT_ERROR_MESSAGE)
  }
  if (input.has_updates !== true) {
    throw new StatsigProtocolError(INVALID_RESPONSE_SHAPE_ERROR_MESSAGE)
  }
  if (input.is_delta === true) {
    throw new StatsigProtocolError(
      "Statsig delta responses cannot be overridden",
    )
  }
  if (
    "response_format" in input
    && input.response_format !== undefined
    && input.response_format !== "init-v1"
  ) {
    throw new StatsigProtocolError(
      `Unsupported Statsig response format: ${formatResponseFormat(input.response_format)}`,
    )
  }
  if (!isRecord(input.feature_gates) || !isRecord(input.dynamic_configs)) {
    throw new StatsigProtocolError(INVALID_EVALUATION_MAPS_ERROR_MESSAGE)
  }

  validateEvaluationMap(input.feature_gates, "feature_gates")
  validateEvaluationMap(input.dynamic_configs, "dynamic_configs")

  const response = structuredClone(input) as StatsigV1InitializeResponse
  const featureGates = response.feature_gates as StatsigEvaluationMap
  const dynamicConfigs = response.dynamic_configs as StatsigEvaluationMap

  for (const [name, value] of Object.entries(overrides.featureGates)) {
    if (Object.hasOwn(featureGates, name)) {
      featureGates[name].value = value
      continue
    }

    featureGates[name] = {
      name,
      value,
      rule_id: "copilot-api-override",
      exposures: [],
    }
  }
  for (const [name, value] of Object.entries(overrides.dynamicConfigs)) {
    const nextValue = structuredClone(value) as Record<string, unknown>
    if (Object.hasOwn(dynamicConfigs, name)) {
      dynamicConfigs[name].value = nextValue
      continue
    }

    dynamicConfigs[name] = {
      name,
      value: nextValue,
      rule_id: "copilot-api-override",
      exposures: [],
    }
  }

  return response
}
