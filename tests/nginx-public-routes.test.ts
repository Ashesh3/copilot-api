import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const enabled = process.env.RUN_NGINX_TESTS === "1"
const nginxTest = test.skipIf(!enabled)
const containerName = `copilot-api-routes-${randomUUID()}`
let temporaryDirectory: string | undefined
let origin = ""

async function docker(args: Array<string>): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Docker failed: ${stderr}`)
  return stdout.trim()
}

beforeAll(async () => {
  if (!enabled) return
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-nginx-routes-"),
  )
  const template = await fs.readFile(
    path.join(
      import.meta.dir,
      "../nginx/sites-available/public-domain.conf.template",
    ),
    "utf8",
  )
  const config =
    template
      .replaceAll("{{PUBLIC_SERVER_NAME}}", "localhost")
      .replaceAll("{{UPSTREAM_URL}}", "http://127.0.0.1:8081")
      .replaceAll("{{CLOUDFLARE_REAL_IP_SNIPPET_PATH}}", "/dev/null")
      .replace("listen 443 ssl;", "listen 8080;")
      .replaceAll(/^[ \t]*ssl_certificate[^;]+;\r?\n/gm, "")
    + "\nserver { listen 8081; add_header X-Test-Upstream reached always; return 204; }\n"
  const configPath = path.join(temporaryDirectory, "default.conf")
  await fs.writeFile(configPath, config)
  await docker([
    "create",
    "--name",
    containerName,
    "-p",
    "127.0.0.1::8080",
    "nginx:1.29-alpine",
  ])
  await docker([
    "cp",
    configPath,
    `${containerName}:/etc/nginx/conf.d/default.conf`,
  ])
  await docker(["start", containerName])
  const port = await docker(["port", containerName, "8080/tcp"])
  origin = `http://${port}`
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${origin}/health/health`, { headers: { host: "localhost" } })
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error("Nginx did not become ready")
}, 30_000)

afterAll(async () => {
  if (!enabled) return
  await docker(["rm", "-f", containerName]).catch(() => undefined)
  if (temporaryDirectory)
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

nginxTest.each([
  ["GET", "/v1beta/models"],
  ["GET", "/v1beta/models/vendor%2Fmodel-name"],
  ["POST", "/v1beta/models/vendor%2Fmodel-name:generateContent"],
  ["GET", "/v1/models/model-name"],
  ["POST", "/v1beta/models/model-name:generateContent"],
  ["POST", "/v1/models/model-name:streamGenerateContent"],
  ["POST", "/models/model-name:countTokens"],
  ["POST", "/models/session"],
  ["POST", "/models/session/intent"],
  ["POST", "/auto"],
  ["POST", "/models/model-name/policy"],
  ["OPTIONS", "/v1/chat/completions"],
  ["OPTIONS", "/v1/responses"],
  ["OPTIONS", "/v1/messages"],
  ["OPTIONS", "/v1/audio/transcriptions"],
  ["OPTIONS", "/v1beta/models"],
] as const)(
  "public ingress forwards supported %s %s",
  async (method, route) => {
    const response = await fetch(origin + route, {
      method,
      headers: { host: "localhost" },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("x-test-upstream")).toBe("reached")
  },
)

nginxTest.each([
  ["GET", "/v1/responses"],
  ["GET", "/auto"],
  ["GET", "/models/session"],
  ["DELETE", "/v1/models/model-name"],
  ["POST", "/models/model-name:deleteEverything"],
  ["POST", "/v1beta/models/model-name:deleteEverything"],
  ["OPTIONS", "/unknown"],
] as const)("public ingress retains denial of %s %s", async (method, route) => {
  const response = await fetch(origin + route, {
    method,
    headers: { host: "localhost" },
  })
  expect([403, 404]).toContain(response.status)
  expect(response.headers.get("x-test-upstream")).toBeNull()
})
