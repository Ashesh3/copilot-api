import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
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
  expect(template).toContain("^/(?:v1/)?alpha/search/?$")
})

test("public nginx template exposes only the exact transcription upload routes", async () => {
  const template = await read("sites-available/public-domain.conf.template")
  for (const route of ["/v1/audio/transcriptions", "/transcribe"]) {
    const routePattern = route.replaceAll("/", String.raw`\/`)
    const location = template.match(
      new RegExp(`location = ${routePattern} {([\\s\\S]*?)\\n {2}}`),
    )?.[1]

    expect(location).toBeDefined()
    expect(location).toContain("limit_except POST { deny all; }")
    expect(location).toContain("proxy_pass {{UPSTREAM_URL}};")
    expect(location).toContain("proxy_http_version 1.1;")
    expect(location).toContain("proxy_request_buffering off;")
  }
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
  expect(template).not.toMatch(/location\s+~\s+\^\/api\/eval/)
})

test("public templates keep IP-only compatibility routes narrowly scoped", async () => {
  const [claudeTemplate, statsigTemplate] = await Promise.all([
    read("sites-available/spoof-domains.conf.template"),
    read("sites-available/codex-statsig-spoof.conf.template"),
  ])

  expect(claudeTemplate).not.toMatch(/location\s+~\s+\^\/api\/eval/)
  expect(statsigTemplate).toContain(
    "location ~ ^/v1/(?:initialize|download|check)/?$ {",
  )
  expect(
    statsigTemplate.match(/proxy_pass \{\{UPSTREAM_URL\}\};/g),
  ).toHaveLength(1)
  expect(statsigTemplate).toContain("location / { return 404; }")
})

test("Codex dictation streams multipart uploads while cleanup requires a bearer", async () => {
  const template = await read(
    "sites-available/codex-desktop-spoof.conf.template",
  )

  const transcribeLocation = template.match(
    /location = \/transcribe \{([\s\S]*?)\n {2}\}/,
  )?.[1]
  expect(transcribeLocation).toBeDefined()
  expect(transcribeLocation).toContain("limit_except POST { deny all; }")
  expect(transcribeLocation).toContain("proxy_pass {{UPSTREAM_URL}};")
  expect(transcribeLocation).toContain("proxy_http_version 1.1;")
  expect(transcribeLocation).toContain("proxy_request_buffering off;")
  expect(transcribeLocation).not.toContain("$http_authorization")

  expect(template).toMatch(
    /location = \/codex\/responses \{[\s\S]*?if \(\$http_authorization = ""\) \{ return 404; \}/,
  )
})

test("Codex Computer Use policy is an exact GET-only spoof route", async () => {
  const template = await read(
    "sites-available/codex-desktop-spoof.conf.template",
  )

  expect(template).toMatch(
    /location = \/backend-api\/aura\/site_status \{[\s\S]*?limit_except GET \{ deny all; \}[\s\S]*?proxy_pass \{\{UPSTREAM_URL\}\};/,
  )
})

test("Claude subscriber compatibility routes keep exact methods", async () => {
  const template = await read("sites-available/spoof-domains.conf.template")

  expect(template).toMatch(
    /location ~ \^\/redirect\/claudeai\\\.v1\\\.\[0-9a-f-\]\+\/oauth\/authorize\/\?\$ \{[\s\S]*?limit_except GET \{ deny all; \}[\s\S]*?rewrite \^ \/oauth\/authorize last;/,
  )
  expect(template).toMatch(
    /location ~ \^\/v1\/code\/triggers[\s\S]*?limit_except GET POST \{ deny all; \}/,
  )
  expect(template).toMatch(
    /location = \/v1\/code\/github\/import-token \{[\s\S]*?limit_except POST \{ deny all; \}/,
  )
  expect(template).toMatch(
    /location = \/v1\/environment_providers \{[\s\S]*?limit_except GET \{ deny all; \}/,
  )
  expect(template).toMatch(
    /location = \/v1\/environment_providers\/cloud\/create \{[\s\S]*?limit_except POST \{ deny all; \}/,
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

test("nginx templates disable body limits and maximize inherited proxy timeouts", async () => {
  const [publicTemplate, spoofTemplate, codexTemplate, statsigTemplate] =
    await Promise.all([
      read("sites-available/public-domain.conf.template"),
      read("sites-available/spoof-domains.conf.template"),
      read("sites-available/codex-desktop-spoof.conf.template"),
      read("sites-available/codex-statsig-spoof.conf.template"),
    ])
  expect(
    existsSync(path.join(nginxRoot, "snippets/proxy-limits.conf.template")),
  ).toBe(false)
  for (const template of [
    publicTemplate,
    spoofTemplate,
    codexTemplate,
    statsigTemplate,
  ]) {
    expect(template).toContain("client_max_body_size 0;")
    expect(template).toContain("client_header_timeout 2147483647s;")
    expect(template).toContain("client_body_timeout 2147483647s;")
    expect(template).toContain("proxy_connect_timeout 75s;")
    expect(template).toContain("proxy_send_timeout 2147483647s;")
    expect(template).toContain("proxy_read_timeout 2147483647s;")
    expect(template).toContain("send_timeout 2147483647s;")
    expect(template).not.toContain("limit_req")
    expect(template).not.toContain("limit_conn")
    expect(template).not.toContain("PROXY_LIMITS_SNIPPET_PATH")
  }
})

test("WebSocket locations keep exact methods without local lifetimes", async () => {
  const [publicTemplate, spoofTemplate] = await Promise.all([
    read("sites-available/public-domain.conf.template"),
    read("sites-available/spoof-domains.conf.template"),
  ])
  expect(publicTemplate).toMatch(
    /location ~ \^\/ws\/remote\/ \{[\s\S]*?limit_except GET \{ deny all; \}/,
  )
  expect(publicTemplate).toContain(
    'map "$request_method:$http_upgrade" $responses_route_allowed {',
  )
  expect(publicTemplate).toContain("~*^GET:websocket$ 1;")
  expect(publicTemplate).toMatch(
    /location ~ \^\/\(\?:v1\/\)\?responses\/\?\$ \{[\s\S]*?limit_except GET POST \{ deny all; \}[\s\S]*?if \(\$responses_route_allowed = 0\) \{ return 404; \}/,
  )
  expect(publicTemplate).toMatch(
    /location ~ \^\/\(\?:v1\/\)\?\(\?:embeddings\|responses\/compact\)\/\?\$ \{[\s\S]*?limit_except POST \{ deny all; \}/,
  )
  expect(publicTemplate).toMatch(
    /location ~ \^\/\(\?:v1\/\)\?alpha\/search\/\?\$ \{[\s\S]*?limit_except POST \{ deny all; \}/,
  )
  expect(spoofTemplate).toMatch(
    /location ~ \^\/api\/ws\/speech_to_text\/voice_stream\/\??[\s\S]*?limit_except GET \{ deny all; \}/,
  )
})

test("authenticated generation streams disable buffering without timeouts", async () => {
  const [publicTemplate, spoofTemplate] = await Promise.all([
    read("sites-available/public-domain.conf.template"),
    read("sites-available/spoof-domains.conf.template"),
  ])

  expect(publicTemplate).toMatch(
    /location ~ \^\/\(\?:v1\/\)\?\(\?:chat\/completions\|messages\)\/\?\$ \{[\s\S]*?limit_except POST \{ deny all; \}[\s\S]*?proxy_http_version 1\.1;[\s\S]*?proxy_buffering off;/,
  )
  expect(spoofTemplate).toMatch(
    /location ~ \^\/v1\/messages\/\?\$ \{[\s\S]*?limit_except POST \{ deny all; \}[\s\S]*?proxy_http_version 1\.1;[\s\S]*?proxy_buffering off;/,
  )
  const messagesLocation = spoofTemplate.match(
    /location ~ \^\/v1\/messages\/\?\$ \{([\s\S]*?)\n {2}\}/,
  )?.[1]
  expect(messagesLocation).toBeDefined()
  expect(messagesLocation).not.toContain("_timeout")
})

test("codex desktop /codex/responses location disables proxy buffering", async () => {
  const template = await read(
    "sites-available/codex-desktop-spoof.conf.template",
  )

  // /codex/responses is an SSE route. Without these, nginx buffers the whole
  // response and swallows the keep-alive frames that keep Cloudflare's origin
  // inactivity timer from firing.
  const location = template.match(
    /location = \/codex\/responses \{([\s\S]*?)\n {2}\}/,
  )?.[1]

  expect(location).toBeDefined()
  expect(location).toContain("proxy_request_buffering off;")
  expect(location).toContain("proxy_buffering off;")
  expect(location).toContain("proxy_cache off;")
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

test("public nginx denials retain browser hardening headers", async () => {
  const template = await read("sites-available/public-domain.conf.template")

  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
  ]) {
    expect(template).toMatch(new RegExp(`add_header ${header} .* always;`))
  }
  expect(template).not.toMatch(/add_header Content-Security-Policy/)
})
