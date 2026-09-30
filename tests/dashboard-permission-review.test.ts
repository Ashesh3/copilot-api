import { afterEach, beforeEach, expect, test } from "bun:test"

import { getConfig, setConfigForTest, writeConfig } from "~/lib/config"
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
const reviewPath = `${settingsPath}/permission-review`
let adminSession: TestAdminSession
const originalModels = state.models

beforeEach(async () => {
  setConfigForTest(null)
  adminSession = await createTestAdminSession()
})

afterEach(async () => {
  state.models = originalModels
  await resetTestAdminSession()
})

async function save(body: unknown): Promise<Response> {
  return server.request(reviewPath, {
    method: "POST",
    headers: adminHeaders(adminSession),
    body: JSON.stringify(body),
  })
}

test("settings default permission review to Luna with allow-all disabled", async () => {
  const response = await server.request(settingsPath, {
    headers: adminHeaders(adminSession, false),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    permissionReviewModel: "gpt-6-luna",
    permissionReviewAllowAll: false,
  })
})

test("permission review saves custom models absent from the catalog and persists both fields", async () => {
  state.models = {
    object: "list",
    data: [
      {
        id: "advertised-model",
        name: "Advertised model",
        object: "model",
        version: "1",
        capabilities: {
          family: "test",
          object: "model_capabilities",
          supports: {},
          tokenizer: "cl100k_base",
          type: "chat",
        },
      },
    ],
  }
  await writeConfig({ ...getConfig(), smallModel: "keep-small-model" })
  const response = await save({
    model: "  custom/reviewer:v2  ",
    allowAll: true,
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    permissionReviewModel: "custom/reviewer:v2",
    permissionReviewAllowAll: true,
  })
  const storageConfig = getStorageRuntime().config
  await closeStorageRuntime()
  await initializeStorageRuntime({ config: storageConfig })
  expect(getConfig()).toMatchObject({
    smallModel: "keep-small-model",
    permissionReviewModel: "custom/reviewer:v2",
    permissionReviewAllowAll: true,
  })
})

test.each([null, "", "   "])(
  "resetting model %p restores Luna and disables allow-all in the same save",
  async (model) => {
    expect(
      (await save({ model: "custom-reviewer", allowAll: true })).status,
    ).toBe(200)
    const response = await save({ model, allowAll: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      permissionReviewModel: "gpt-6-luna",
      permissionReviewAllowAll: false,
    })
    expect(Object.hasOwn(getConfig(), "permissionReviewModel")).toBe(false)
    expect(getConfig()).toMatchObject({ permissionReviewAllowAll: false })
  },
)

test.each([
  null,
  [],
  true,
  "reviewer",
  {},
  { model: "custom-reviewer" },
  { allowAll: true },
  { model: 7, allowAll: true },
  { model: "reviewer", allowAll: "true" },
  { model: "reviewer", allowAll: 1 },
  { model: "reviewer", allowAll: null },
  { model: "reviewer\n", allowAll: true },
  { model: "reviewer\u0000", allowAll: true },
  { model: "reviewer\u007f", allowAll: true },
  { model: "reviewer\u0085", allowAll: true },
  { model: "x".repeat(257), allowAll: true },
])("invalid permission review body %p changes neither field", async (body) => {
  const before = getConfig()
  const response = await save(body)
  expect(response.status).toBe(400)
  expect(getConfig()).toEqual(before)
})

test("malformed permission review JSON returns a client error", async () => {
  const response = await server.request(reviewPath, {
    method: "POST",
    headers: adminHeaders(adminSession),
    body: "{",
  })
  expect(response.status).toBe(400)
})

test("permission review writes require an administrator and CSRF token", async () => {
  const body = JSON.stringify({ model: "custom-reviewer", allowAll: true })
  const unauthenticated = await server.request(reviewPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  expect(unauthenticated.status).toBe(401)
  const missingCsrf = await server.request(reviewPath, {
    method: "POST",
    headers: {
      ...adminHeaders(adminSession, false),
      "content-type": "application/json",
    },
    body,
  })
  expect(missingCsrf.status).toBe(401)
  expect(getConfig()).not.toHaveProperty("permissionReviewAllowAll", true)
})
