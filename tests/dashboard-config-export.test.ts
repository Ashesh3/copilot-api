import { afterAll, expect, test } from "bun:test"
import { unzipSync } from "fflate"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createConfigExportZip,
  getConfigExportFilename,
} from "../src/lib/config-export"
import { state } from "../src/lib/state"
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const textDecoder = new TextDecoder()

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
})

async function withTempDir<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-export-"))
  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function decodeEntry(entry: Uint8Array): string {
  return textDecoder.decode(entry)
}

test("config export zips only app config files that exist", async () => {
  await withTempDir(async (directory) => {
    await fs.mkdir(path.join(directory, "logs"))
    await fs.writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({ customProviders: [{ apiKey: "secret" }] }),
    )
    await fs.writeFile(path.join(directory, "model_settings.json"), "[]\n")
    await fs.writeFile(path.join(directory, "ip_allowlist.json"), "[]\n")
    await fs.writeFile(path.join(directory, "usage.json"), '{"records":[]}\n')
    await fs.writeFile(path.join(directory, "github_token"), "ghu_secret")
    await fs.writeFile(path.join(directory, "logs", "messages.log"), "skip")

    const archive = await createConfigExportZip({
      appDir: directory,
      now: new Date(2026, 4, 31, 18, 7),
    })
    const entries = unzipSync(archive.zip)

    expect(archive.filename).toBe("copilot-api-config-31-05-2026-18-07.zip")
    expect(Object.keys(entries).sort()).toEqual([
      "config.json",
      "ip_allowlist.json",
      "model_settings.json",
    ])
    expect(decodeEntry(entries["config.json"])).toContain("secret")
    expect(entries["usage.json"]).toBeUndefined()
    expect(entries["github_token"]).toBeUndefined()
    expect(entries["logs/messages.log"]).toBeUndefined()
  })
})

test("config export filename uses zero-padded local date parts", () => {
  expect(getConfigExportFilename(new Date(2026, 0, 2, 3, 4))).toBe(
    "copilot-api-config-02-01-2026-03-04.zip",
  )
})

test("dashboard config export endpoint is authenticated and returns a zip", async () => {
  state.apiKeyAuth = "dashboard-secret"

  const unauthorizedResponse = await server.request(
    "/dashboard/api/settings/export",
  )
  expect(unauthorizedResponse.status).toBe(401)

  const response = await server.request("/dashboard/api/settings/export", {
    headers: { "x-api-key": "dashboard-secret" },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/zip")
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename="copilot-api-config-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.zip"$/,
  )
  const zipBytes = new Uint8Array(await response.arrayBuffer())
  expect(() => unzipSync(zipBytes)).not.toThrow()
})

test("dashboard bundle ships the config export controls", () => {
  expect(DASHBOARD_HTML).toContain("Export Config")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/settings/export")
})
