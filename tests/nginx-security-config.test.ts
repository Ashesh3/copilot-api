import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const nginxRoot = path.join(import.meta.dir, "..", "nginx")

async function read(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(nginxRoot, relativePath), "utf8")
}

test("all nginx hostname templates end with default denial", async () => {
  const templates = await Promise.all([
    read("sites-available/public-domain.conf.template"),
    read("sites-available/spoof-domains.conf.template"),
    read("sites-available/codex-statsig-spoof.conf.template"),
    read("sites-available/codex-desktop-spoof.conf.template"),
  ])

  for (const template of templates) {
    expect(template).toContain("location / { return 404; }")
    expect(template).not.toMatch(/location\s+\/\s*\{\s*proxy_pass/)
    expect(template).not.toContain("$proxy_add_x_forwarded_for")
    expect(template).toContain("proxy_set_header X-Real-IP $remote_addr;")
    expect(template).toContain("proxy_set_header X-Forwarded-For $remote_addr;")
  }
})

test("public nginx template denies known pre-auth compatibility surfaces", async () => {
  const template = await read("sites-available/public-domain.conf.template")
  for (const route of [
    "/sessions",
    "/ws/direct",
    "/health/api",
    "/feature-flags",
  ]) {
    expect(template).not.toContain(`location = ${route}`)
  }
  expect(template).toContain("location = /health/health")
  expect(template).toContain("location = /v1/oauth/token")
  expect(template).toContain("location = /v1/oauth/revoke")
})

test("Claude spoof template exposes only authenticated compatibility families", async () => {
  const template = await read("sites-available/spoof-domains.conf.template")
  expect(template).toContain("^/v1/code/sessions")
  expect(template).toContain("^/v1/code/triggers")
  expect(template).toContain("location = /v1/code/github/import-token")
  expect(template).toContain("location = /v1/environment_providers")
  expect(template).toContain(
    "location = /v1/environment_providers/cloud/create",
  )
  expect(template).toContain("location = /v1/mcp_servers")
  expect(template).toContain("^/v1/session_ingress/session/[^/]+")
  expect(template).toContain("location = /v1/ultrareview/quota")
  expect(template).toContain("^/v1/(?:sessions|environments)")
  expect(template).toContain("^/api/(?:oauth|claude_code")
  expect(template).toContain("location = /v1/oauth/revoke")
  expect(template).not.toContain("/sessions/api/sessions")
  expect(template).not.toContain("/ws/direct")
})

test("Claude subscriber compatibility routes have exact methods and write caps", async () => {
  const template = await read("sites-available/spoof-domains.conf.template")

  expect(template).toMatch(
    /location ~ \^\/v1\/code\/triggers[\s\S]*?limit_except GET POST \{ deny all; \}[\s\S]*?client_max_body_size 64k;/,
  )
  expect(template).toMatch(
    /location = \/v1\/code\/github\/import-token \{[\s\S]*?limit_except POST \{ deny all; \}[\s\S]*?client_max_body_size 64k;/,
  )
  expect(template).toMatch(
    /location = \/v1\/environment_providers \{[\s\S]*?limit_except GET \{ deny all; \}/,
  )
  expect(template).toMatch(
    /location = \/v1\/environment_providers\/cloud\/create \{[\s\S]*?limit_except POST \{ deny all; \}[\s\S]*?client_max_body_size 64k;/,
  )
  for (const getOnlyPath of ["/v1/mcp_servers", "/v1/ultrareview/quota"]) {
    expect(template).toMatch(
      new RegExp(
        `location = ${getOnlyPath.replaceAll("/", String.raw`\/`)} \\{[\\s\\S]*?limit_except GET \\{ deny all; \\}`,
      ),
    )
  }
  expect(template).toContain(
    "location ~ ^/v1/session_ingress/session/[^/]+/?$ {",
  )
  expect(template).toMatch(
    /location ~ \^\/v1\/session_ingress\/session\/[\s\S]*?limit_except GET \{ deny all; \}/,
  )
})

test("proxy limits are finite and bodies are bounded", async () => {
  const [
    snippet,
    publicTemplate,
    spoofTemplate,
    codexTemplate,
    statsigTemplate,
  ] = await Promise.all([
    read("snippets/proxy-limits.conf.template"),
    read("sites-available/public-domain.conf.template"),
    read("sites-available/spoof-domains.conf.template"),
    read("sites-available/codex-desktop-spoof.conf.template"),
    read("sites-available/codex-statsig-spoof.conf.template"),
  ])
  for (const template of [
    publicTemplate,
    spoofTemplate,
    codexTemplate,
    statsigTemplate,
  ]) {
    expect(template).toContain("client_header_timeout 10s;")
    expect(template).toContain("client_body_timeout 30s;")
    expect(template).not.toContain("client_max_body_size 0")
  }
  expect(publicTemplate).toContain("client_max_body_size 32m;")
  expect(codexTemplate).toContain("client_max_body_size 4m;")
  expect(statsigTemplate).toContain("client_max_body_size 1m;")
  expect(snippet).not.toContain("client_header_timeout")
  expect(snippet).not.toContain("client_max_body_size")
  expect(snippet).not.toContain("1d")
})

test("WebSocket locations have exact methods and dedicated finite lifetimes", async () => {
  const [publicTemplate, spoofTemplate] = await Promise.all([
    read("sites-available/public-domain.conf.template"),
    read("sites-available/spoof-domains.conf.template"),
  ])
  expect(publicTemplate).toMatch(
    /location ~ \^\/ws\/remote\/ \{[\s\S]*?limit_except GET \{ deny all; \}[\s\S]*?proxy_read_timeout 1h;/,
  )
  expect(spoofTemplate).toMatch(
    /location ~ \^\/api\/ws\/speech_to_text\/voice_stream\/\??[\s\S]*?limit_except GET \{ deny all; \}[\s\S]*?proxy_read_timeout 3m;/,
  )
})

test("Cloudflare real-IP policy trusts exact published ranges only", async () => {
  const [template, publicTemplate] = await Promise.all([
    read("snippets/cloudflare-real-ip.conf"),
    read("sites-available/public-domain.conf.template"),
  ])
  expect(template).toContain("real_ip_header CF-Connecting-IP;")
  expect(template).toContain("set_real_ip_from 173.245.48.0/20;")
  expect(template).not.toContain("set_real_ip_from 10.0.0.0/8")
  expect(template).not.toContain("set_real_ip_from 0.0.0.0/0")
  expect(publicTemplate).toContain(
    "include {{CLOUDFLARE_REAL_IP_SNIPPET_PATH}};",
  )
})
