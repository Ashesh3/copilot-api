import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")
const exampleSpoofHost = "codex-gateway.openai.com"

async function readRepositoryFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")
}

test("documents the required Codex hosted-service spoof hostname", async () => {
  const [guide, readme] = await Promise.all([
    readRepositoryFile("docs/codex-desktop-managed-auth.md"),
    readRepositoryFile("README.md"),
  ])

  for (const document of [guide, readme]) {
    expect(document).toContain(
      `chatgpt_base_url = "https://${exampleSpoofHost}"`,
    )
    expect(document).toContain(`cli_auth_credentials_store = "file"`)
  }

  expect(guide).toContain(`<GATEWAY_IP> ${exampleSpoofHost}`)
  expect(guide).toMatch(/rapid, repeated successful refresh requests/i)
})

test("documents matching TLS and default-deny Nginx routing", async () => {
  const [guide, nginxReadme, template] = await Promise.all([
    readRepositoryFile("docs/codex-desktop-managed-auth.md"),
    readRepositoryFile("nginx/README.md"),
    readRepositoryFile(
      "nginx/sites-available/codex-desktop-spoof.conf.template",
    ),
  ])

  for (const document of [guide, nginxReadme, template]) {
    expect(document).toContain(exampleSpoofHost)
    expect(document).toContain("location / { return 404; }")
  }

  expect(guide).toContain("Subject Alternative Name")
  expect(guide).toContain(
    "x-codex-browser-use-security-mode: disabled-for-local-testing",
  )
  expect(guide).toMatch(
    /remove the exact\s+`\/backend-api\/aura\/site_status` location/,
  )
  expect(nginxReadme).toContain(`server_name ${exampleSpoofHost};`)
  expect(nginxReadme).toContain(
    "x-codex-browser-use-security-mode: disabled-for-local-testing",
  )
  expect(template).toContain(`chatgpt_base_url = "https://${exampleSpoofHost}"`)
})
