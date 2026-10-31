import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { type IncomingHttpHeaders, request } from "node:http"
import os from "node:os"
import path from "node:path"

const enabled = process.env.RUN_NGINX_TESTS === "1"
const nginxTest = test.skipIf(!enabled)
const containerName = `copilot-api-routes-${randomUUID()}`
let temporaryDirectory: string | undefined
let origin = ""

async function docker(
  args: Array<string>,
  includeStderr = false,
): Promise<string> {
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
  return includeStderr ? stdout + stderr : stdout.trim()
}

async function requestUpgrade(
  route: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(origin + route, { headers })
    outgoing.on("response", (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0, headers: response.headers })
    })
    outgoing.on("upgrade", (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? 0, headers: response.headers })
    })
    outgoing.on("error", reject)
    outgoing.setTimeout(5_000, () => {
      outgoing.destroy(new Error("Nginx upgrade request timed out"))
    })
    outgoing.end()
  })
}

async function readTemplate(name: string): Promise<string> {
  return await fs.readFile(
    path.join(
      import.meta.dir,
      `../nginx/sites-available/${name}.conf.template`,
    ),
    "utf8",
  )
}

beforeAll(async () => {
  if (!enabled) return
  temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-nginx-routes-"),
  )
  const [publicTemplate, codexTemplate, claudeTemplate] = await Promise.all([
    readTemplate("public-domain"),
    readTemplate("codex-desktop-spoof"),
    readTemplate("spoof-domains"),
  ])
  const captureHeaders = `
    add_header X-Test-Upstream reached always;
    add_header X-Test-Authorization $http_authorization always;
    add_header X-Test-Account-Id $http_chatgpt_account_id always;
    add_header X-Test-Host $http_host always;
    add_header X-Test-Forwarded-Host $http_x_forwarded_host always;
    add_header X-Test-Forwarded-Proto $http_x_forwarded_proto always;
    add_header X-Test-Real-IP $http_x_real_ip always;
    add_header X-Test-Forwarded-For $http_x_forwarded_for always;
    add_header X-Test-Upgrade $http_upgrade always;
    add_header X-Test-Connection $http_connection always;
    add_header X-Test-WebSocket-Protocol $http_sec_websocket_protocol always;
    add_header X-Test-URI $request_uri always;
    add_header X-Test-Content-Type $http_content_type always;
    add_header X-Test-HTTP-Version $server_protocol always;
  `
  const config =
    publicTemplate
      .replaceAll("{{PUBLIC_SERVER_NAME}}", "localhost")
      .replaceAll("{{UPSTREAM_URL}}", "http://127.0.0.1:8081")
      .replaceAll("{{CLOUDFLARE_REAL_IP_SNIPPET_PATH}}", "/dev/null")
      .replace("listen 443 ssl;", "listen 8080;")
      .replaceAll(/^[ \t]*ssl_certificate[^;]+;\r?\n/gm, "")
    + "\n"
    + codexTemplate
      .replaceAll("{{CODEX_DESKTOP_SPOOF_SERVER_NAMES}}", "codex.test")
      .replaceAll("{{CODEX_DESKTOP_SPOOF_PRIMARY_HOST}}", "codex.test")
      .replaceAll("{{UPSTREAM_URL}}", "http://127.0.0.1:8081")
      .replace("listen 443 ssl;", "listen 8080;")
      .replaceAll(/^[ \t]*ssl_certificate[^;]+;\r?\n/gm, "")
    + "\n"
    + claudeTemplate
      .replaceAll("{{CLAUDE_API_SERVER_NAME}}", "claude-api.test")
      .replaceAll("{{CLAUDE_PLATFORM_SERVER_NAMES}}", "claude-platform.test")
      .replaceAll("{{UPSTREAM_URL}}", "http://127.0.0.1:8081")
      .replaceAll("listen 443 ssl;", "listen 8080;")
      .replaceAll(/^[ \t]*ssl_certificate[^;]+;\r?\n/gm, "")
    + `
server {
  listen 8081;
  location ~ ^/(?:v1/)?user/dictation/stream$ {
    ${captureHeaders}
    add_header Upgrade websocket always;
    add_header Connection upgrade always;
    add_header Sec-WebSocket-Protocol claude.dictation.v1 always;
    add_header Sec-WebSocket-Accept s3pPLMBiTxaQ9kYGzzhZRbK+xOo= always;
    return 101;
  }
  location / {
    ${captureHeaders}
    return 204;
  }
}
`
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
  ["POST", "/v1/decisions"],
  ["POST", "/decisions"],
  ["POST", "/v1/images/generations"],
  ["POST", "/images/edits"],
  ["OPTIONS", "/v1/chat/completions"],
  ["OPTIONS", "/v1/responses"],
  ["OPTIONS", "/v1/messages"],
  ["POST", "/v1/messages"],
  ["POST", "/v1/messages/count_tokens"],
  // Anthropic SDK clients configured with a ".../v1" base URL.
  ["POST", "/v1/v1/messages"],
  ["OPTIONS", "/v1/v1/messages"],
  ["POST", "/v1/v1/messages/count_tokens"],
  ["OPTIONS", "/v1/audio/transcriptions"],
  ["OPTIONS", "/v1/decisions"],
  ["OPTIONS", "/v1/images/edits"],
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
  ["GET", "/v1/decisions"],
  ["GET", "/v1/images/generations"],
  ["POST", "/v1/images/variations"],
  ["GET", "/auto"],
  ["GET", "/models/session"],
  ["DELETE", "/v1/models/model-name"],
  ["POST", "/models/model-name:deleteEverything"],
  ["POST", "/v1beta/models/model-name:deleteEverything"],
  ["GET", "/v1/v1/messages"],
  ["POST", "/v1/v1/messages/"],
  ["POST", "/v1/v1/messages/batches"],
  ["POST", "/v1/v1/chat/completions"],
  ["POST", "/v1/v1/responses"],
  ["OPTIONS", "/unknown"],
] as const)("public ingress retains denial of %s %s", async (method, route) => {
  const response = await fetch(origin + route, {
    method,
    headers: { host: "localhost" },
  })
  expect([403, 404]).toContain(response.status)
  expect(response.headers.get("x-test-upstream")).toBeNull()
})

const discoveryRoutes = [
  "/api/codex/accounts/check",
  "/wham/accounts/check",
  "/backend-api/wham/accounts/check",
  "/accounts/check/v4-2023-04-27",
  "/backend-api/accounts/check/v4-2023-04-27",
]

for (const host of ["localhost", "codex.test"]) {
  for (const prefix of ["", "/backend-api"]) {
    nginxTest.each([
      ["GET", `${prefix}/settings/user`],
      [
        "PATCH",
        `${prefix}/settings/account_user_setting?feature=model_picker_reasoning_effort_visibility&value=%7B%7D`,
      ],
    ])(
      `${host} forwards authenticated reasoning preferences %s %s`,
      async (method, route) => {
        const response = await fetch(origin + route, {
          method,
          headers: {
            host,
            authorization: "Bearer routing-test",
            "chatgpt-account-id": "routing-account",
          },
        })
        expect(response.status).toBe(204)
        expect(response.headers.get("x-test-upstream")).toBe("reached")
        expect(response.headers.get("x-test-account-id")).toBe(
          "routing-account",
        )
      },
    )

    nginxTest.each([
      ["HEAD", `${prefix}/settings/user`],
      ["POST", `${prefix}/settings/user`],
      ["GET", `${prefix}/settings/account_user_setting`],
      ["POST", `${prefix}/settings/account_user_setting`],
      ["GET", `${prefix}/settings/user/extra`],
      ["PATCH", `${prefix}/settings/other`],
    ])(`${host} denies unsupported settings %s %s`, async (method, route) => {
      const response = await fetch(origin + route, {
        method,
        headers: { host, authorization: "Bearer routing-test" },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("x-test-upstream")).toBeNull()
    })

    nginxTest.each([
      ["GET", `${prefix}/settings/user`],
      ["PATCH", `${prefix}/settings/account_user_setting`],
    ])(
      `${host} denies settings without bearer %s %s`,
      async (method, route) => {
        const response = await fetch(origin + route, {
          method,
          headers: { host },
        })
        expect(response.status).toBe(404)
        expect(response.headers.get("x-test-upstream")).toBeNull()
      },
    )
  }
  nginxTest.each(discoveryRoutes)(
    `${host} forwards authenticated discovery GET %s`,
    async (route) => {
      const response = await fetch(origin + route, {
        headers: {
          host,
          authorization: "Bearer routing-test",
          "chatgpt-account-id": "routing-account",
        },
      })
      expect(response.status).toBe(204)
      expect(response.headers.get("x-test-upstream")).toBe("reached")
      expect(response.headers.get("x-test-authorization")).toBe(
        "Bearer routing-test",
      )
      expect(response.headers.get("x-test-account-id")).toBe("routing-account")
    },
  )

  nginxTest.each(discoveryRoutes)(
    `${host} denies discovery without a bearer at %s`,
    async (route) => {
      const response = await fetch(origin + route, {
        headers: { host, "chatgpt-account-id": "routing-account" },
      })
      expect(response.status).toBe(404)
      expect(response.headers.get("x-test-upstream")).toBeNull()
    },
  )

  nginxTest.each(
    discoveryRoutes.flatMap((route) =>
      ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(
        (method) => [method, route] as const,
      ),
    ),
  )(`${host} denies unsupported discovery %s %s`, async (method, route) => {
    const response = await fetch(origin + route, {
      method,
      headers: { host, authorization: "Bearer routing-test" },
    })
    expect(response.status).toBe(404)
    expect(response.headers.get("x-test-upstream")).toBeNull()
  })

  nginxTest.each([
    ...discoveryRoutes.flatMap((route) => [route + "/", route + "/extra"]),
    "/api/codex/accounts",
    "/wham/accounts",
    "/backend-api/wham/accounts",
    "/api/codex/accounts/other",
    "/wham/accounts/other",
    "/backend-api/wham/accounts/other",
    "/accounts/check",
    "/backend-api/accounts/check",
    "/accounts/check/v1",
    "/accounts/routing-account/settings",
    "/backend-api/accounts/routing-account/settings",
    "/api/codex/tasks/list",
    "/wham/tasks/list",
    "/backend-api/wham/tasks/list",
  ])(`${host} retains default denial around discovery at %s`, async (route) => {
    const response = await fetch(origin + route, {
      headers: { host, authorization: "Bearer routing-test" },
    })
    expect(response.status).toBe(404)
    expect(response.headers.get("x-test-upstream")).toBeNull()
  })
}

const desktopGatewayAuthRoutes = [
  ["GET", "/.well-known/oauth-authorization-server"],
  ["POST", "/gateway/oauth/device"],
  ["POST", "/gateway/oauth/token"],
  ["POST", "/gateway/oauth/revoke"],
  ["GET", "/gateway/oauth/verify"],
  ["POST", "/gateway/oauth/verify"],
] as const

for (const host of ["localhost", "claude-api.test"]) {
  for (const prefix of ["", "/v1"]) {
    nginxTest.each(desktopGatewayAuthRoutes)(
      `${host}${prefix} forwards native gateway %s %s without header authentication`,
      async (method, route) => {
        const response = await fetch(origin + prefix + route, {
          method,
          headers: {
            host,
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-host": "forged.example",
            "x-forwarded-proto": "https",
          },
          ...(method === "POST" ? { body: "" } : {}),
        })
        expect(response.status).toBe(204)
        expect(response.headers.get("x-test-upstream")).toBe("reached")
        expect(response.headers.get("x-test-authorization")).toBeNull()
        expect(response.headers.get("x-test-uri")).toBe(prefix + route)
        expect(response.headers.get("x-test-host")).toBe(host)
        expect(response.headers.get("x-test-forwarded-host")).toBe(host)
        expect(response.headers.get("x-test-forwarded-proto")).toBe("http")
        expect(response.headers.get("x-test-content-type")).toBe(
          "application/x-www-form-urlencoded",
        )
      },
    )

    nginxTest(
      `${host}${prefix} forwards native dictation tickets with the original bearer`,
      async () => {
        const response = await fetch(
          origin + prefix + "/user/dictation/ticket",
          {
            method: "POST",
            headers: { host, authorization: "Bearer desktop-routing-test" },
          },
        )
        expect(response.status).toBe(204)
        expect(response.headers.get("x-test-authorization")).toBe(
          "Bearer desktop-routing-test",
        )
        expect(response.headers.get("x-test-host")).toBe(host)
        expect(response.headers.get("x-test-uri")).toBe(
          prefix + "/user/dictation/ticket",
        )
      },
    )

    nginxTest(
      `${host}${prefix} denies native dictation tickets without a bearer`,
      async () => {
        const response = await fetch(
          origin + prefix + "/user/dictation/ticket",
          { method: "POST", headers: { host, "x-api-key": "routing-test" } },
        )
        expect(response.status).toBe(404)
        expect(response.headers.get("x-test-upstream")).toBeNull()
      },
    )

    nginxTest(
      `${host}${prefix} forwards the native dictation WebSocket protocol and trusted origin`,
      async () => {
        const ticket = `ticket.nginx_${randomUUID().replaceAll("-", "")}`
        const protocols = `claude.dictation.v1, ${ticket}`
        const route =
          prefix
          + "/user/dictation/stream?encoding=linear16&sample_rate=16000&channels=1&language=en-US"
        const response = await requestUpgrade(route, {
          host,
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": protocols,
          "x-real-ip": "198.51.100.99",
          "x-forwarded-for": "198.51.100.99",
          "x-forwarded-host": "forged.example",
          "x-forwarded-proto": "https",
        })
        expect(response.status).toBe(101)
        expect(response.headers["sec-websocket-protocol"]).toBe(
          "claude.dictation.v1",
        )
        expect(response.headers["sec-websocket-accept"]).toBe(
          "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )
        expect(response.headers["x-test-websocket-protocol"]).toBe(protocols)
        expect(response.headers["x-test-upgrade"]).toBe("websocket")
        expect(response.headers["x-test-connection"]).toBe("upgrade")
        expect(response.headers["x-test-http-version"]).toBe("HTTP/1.1")
        expect(response.headers["x-test-authorization"]).toBeUndefined()
        expect(response.headers["x-test-host"]).toBe(host)
        expect(response.headers["x-test-forwarded-host"]).toBe(host)
        expect(response.headers["x-test-forwarded-proto"]).toBe("http")
        expect(response.headers["x-test-real-ip"]).toBeDefined()
        expect(response.headers["x-test-real-ip"]).not.toBe("198.51.100.99")
        expect(response.headers["x-test-forwarded-for"]).toBe(
          response.headers["x-test-real-ip"],
        )
        expect(response.headers["x-test-uri"]).toBe(route)
        expect(await docker(["logs", containerName], true)).not.toContain(
          ticket,
        )
      },
    )

    nginxTest.each([
      ["HEAD", "/.well-known/oauth-authorization-server"],
      ["POST", "/.well-known/oauth-authorization-server"],
      ["OPTIONS", "/.well-known/oauth-authorization-server"],
      ["GET", "/gateway/oauth/device"],
      ["GET", "/gateway/oauth/token"],
      ["GET", "/gateway/oauth/revoke"],
      ["HEAD", "/gateway/oauth/verify"],
      ["PUT", "/gateway/oauth/verify"],
      ["OPTIONS", "/gateway/oauth/verify"],
      ["GET", "/user/dictation/ticket"],
      ["HEAD", "/user/dictation/ticket"],
      ["OPTIONS", "/user/dictation/ticket"],
      ["POST", "/user/dictation/stream"],
      ["HEAD", "/user/dictation/stream"],
      ["GET", "/user/dictation/stream"],
    ] as const)(
      `${host}${prefix} denies unsupported native gateway %s %s`,
      async (method, route) => {
        const response = await fetch(origin + prefix + route, {
          method,
          headers: { host, authorization: "Bearer routing-test" },
        })
        expect(response.status).toBe(404)
        expect(response.headers.get("x-test-upstream")).toBeNull()
      },
    )

    nginxTest.each(
      [
        "/.well-known/oauth-authorization-server/",
        "/.well-known/oauth-authorization-server/extra",
        "/xwell-known/oauth-authorization-server",
        "/.well-known/openid-configuration",
        "/gateway/oauth",
        "/gateway/oauth/device/",
        "/gateway/oauth/token/extra",
        "/gateway/oauth/unknown",
        "/user/dictation",
        "/user/dictation/ticket/",
        "/user/dictation/stream/extra",
        "/user/dictation/unknown",
        "/user/other",
        "/api/user/dictation/ticket",
        "/v2/gateway/oauth/device",
        "/v2/user/dictation/ticket",
      ].flatMap((route) =>
        ["GET", "POST"].map((method) => [method, route] as const),
      ),
    )(
      `${host}${prefix} retains default denial around native gateway routes at %s %s`,
      async (method, route) => {
        const response = await fetch(origin + prefix + route, {
          method,
          headers: { host, authorization: "Bearer routing-test" },
        })
        expect(response.status).toBe(404)
        expect(response.headers.get("x-test-upstream")).toBeNull()
      },
    )

    nginxTest.each([
      ["/user/dictation/stream", "h2c"],
      ["/user/dictation/stream/extra", "websocket"],
      ["/user/other", "websocket"],
      ["/v2/user/dictation/stream", "websocket"],
    ])(
      `${host}${prefix} denies unsupported upgrade %s %s`,
      async (route, upgrade) => {
        const response = await requestUpgrade(prefix + route, {
          host,
          upgrade,
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-protocol": "claude.dictation.v1, ticket.routing_test",
        })
        expect(response.status).toBe(404)
        expect(response.headers["x-test-upstream"]).toBeUndefined()
      },
    )
  }
}

for (const host of ["codex.test", "claude-platform.test"]) {
  for (const prefix of ["", "/v1"]) {
    nginxTest.each([
      ...desktopGatewayAuthRoutes,
      ["POST", "/user/dictation/ticket"],
    ] as const)(
      `${host}${prefix} does not expose Claude gateway %s %s`,
      async (method, route) => {
        const response = await fetch(origin + prefix + route, {
          method,
          headers: { host, authorization: "Bearer routing-test" },
        })
        expect(response.status).toBe(404)
        expect(response.headers.get("x-test-upstream")).toBeNull()
      },
    )

    nginxTest(
      `${host}${prefix} does not expose Claude gateway WebSockets`,
      async () => {
        const response = await requestUpgrade(
          prefix + "/user/dictation/stream",
          {
            host,
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-protocol":
              "claude.dictation.v1, ticket.routing_test",
          },
        )
        expect(response.status).toBe(404)
        expect(response.headers["x-test-upstream"]).toBeUndefined()
      },
    )
  }
}
