import { afterEach, beforeEach, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { getConfig, setConfigForTest } from "~/lib/config"
import { state } from "~/lib/state"
import {
  closeStorageRuntime,
  getStorageRuntime,
  initializeStorageRuntime,
} from "~/lib/storage/runtime"
import { server } from "~/server"

import {
  adminHeaders,
  createTestAdminSession,
  resetTestAdminSession,
  type TestAdminSession,
} from "./helpers/admin-session"

const settingsPath = "/dashboard/api/settings"
const routingPath = `${settingsPath}/image-routing`
const IMAGE_ENDPOINTS = ["/v1/images/generations", "/v1/images/edits"]
let adminSession: TestAdminSession
const originalModels = state.models

function catalogModel(
  id: string,
  type: string,
  supportedEndpoints: Array<string>,
): Model {
  return {
    capabilities: {
      family: id,
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type,
    },
    id,
    name: `${id} display name`,
    object: "model",
    supported_endpoints: supportedEndpoints,
    version: id,
  }
}

beforeEach(async () => {
  setConfigForTest(null)
  adminSession = await createTestAdminSession()
  state.models = {
    object: "list",
    data: [
      catalogModel("gpt-6-luna", "chat", ["/responses"]),
      catalogModel("gpt-image-2.5-flare", "image", IMAGE_ENDPOINTS),
      catalogModel("gpt-image-2.5-sunburst", "image", IMAGE_ENDPOINTS),
    ],
  }
})

afterEach(async () => {
  state.models = originalModels
  await resetTestAdminSession()
})

async function save(body: unknown): Promise<Response> {
  return server.request(routingPath, {
    method: "POST",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(body),
  })
}

async function readSettings(): Promise<unknown> {
  const response = await server.request(settingsPath, {
    headers: adminHeaders(adminSession, false),
  })
  expect(response.status).toBe(200)
  return response.json()
}

test("settings report automatic image routing and the live image models", async () => {
  expect(await readSettings()).toMatchObject({
    imageModels: [
      {
        endpoints: IMAGE_ENDPOINTS,
        id: "gpt-image-2.5-flare",
        name: "gpt-image-2.5-flare display name",
      },
      {
        endpoints: IMAGE_ENDPOINTS,
        id: "gpt-image-2.5-sunburst",
        name: "gpt-image-2.5-sunburst display name",
      },
    ],
    imageRoutingAutomaticModel: "gpt-image-2.5-flare",
    imageRoutingModel: null,
  })
})

test("a saved image model persists across a storage restart", async () => {
  const response = await save({ model: "  gpt-image-2.5-sunburst  " })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    imageRoutingAutomaticModel: "gpt-image-2.5-flare",
    imageRoutingModel: "gpt-image-2.5-sunburst",
  })

  const storageConfig = getStorageRuntime().config
  await closeStorageRuntime()
  await initializeStorageRuntime({ config: storageConfig })
  expect(getConfig()).toMatchObject({
    imageRoutingModel: "gpt-image-2.5-sunburst",
  })
  expect(await readSettings()).toMatchObject({
    imageRoutingModel: "gpt-image-2.5-sunburst",
  })
})

test.each([null, "", "   "])(
  "saving %p restores automatic routing",
  async (model) => {
    expect((await save({ model: "gpt-image-2.5-sunburst" })).status).toBe(200)

    const response = await save({ model })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ imageRoutingModel: null })
    expect(Object.hasOwn(getConfig(), "imageRoutingModel")).toBe(false)
  },
)

test.each(["gpt-6-luna", "gpt-image-9-unknown"])(
  "rejects %p because it is not a live image model",
  async (model) => {
    const before = getConfig()

    const response = await save({ model })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: `${model} is not a live image model`,
    })
    expect(getConfig()).toEqual(before)
  },
)

test.each([
  null,
  [],
  "gpt-image-2.5-flare",
  {},
  { model: 7 },
  { model: "gpt-image-2.5-flare\n" },
  { model: "x".repeat(257) },
])("invalid image routing body %p changes nothing", async (body) => {
  const before = getConfig()

  const response = await save(body)

  expect(response.status).toBe(400)
  expect(getConfig()).toEqual(before)
})

test("image routing writes require an administrator and CSRF token", async () => {
  const body = JSON.stringify({ model: "gpt-image-2.5-sunburst" })
  const unauthenticated = await server.request(routingPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  expect(unauthenticated.status).toBe(401)
  const missingCsrf = await server.request(routingPath, {
    method: "POST",
    headers: {
      ...adminHeaders(adminSession, false),
      "content-type": "application/json",
    },
    body,
  })
  expect(missingCsrf.status).toBe(401)
  expect(getConfig()).not.toHaveProperty("imageRoutingModel")
})
