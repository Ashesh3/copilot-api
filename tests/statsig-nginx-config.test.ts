import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const templatePath = path.join(
  import.meta.dir,
  "..",
  "nginx",
  "sites-available",
  "codex-statsig-spoof.conf.template",
)

const proxyLimitsTemplatePath = path.join(
  import.meta.dir,
  "..",
  "nginx",
  "snippets",
  "proxy-limits.conf.template",
)

function stripComments(config: string): string {
  return config.replaceAll(/#.*$/gm, "")
}

function extractTopLevelServerBlocks(config: string): Array<string> {
  const blocks: Array<string> = []
  let blockStart: number | undefined
  let depth = 0

  for (let index = 0; index < config.length; index += 1) {
    const character = config[index]

    if (character === "{") {
      if (depth === 0) {
        let nameEnd = index
        while (nameEnd > 0 && /\s/.test(config[nameEnd - 1] ?? "")) {
          nameEnd -= 1
        }

        let nameStart = nameEnd
        while (nameStart > 0 && /[\w-]/.test(config[nameStart - 1] ?? "")) {
          nameStart -= 1
        }

        blockStart =
          config.slice(nameStart, nameEnd) === "server" ? nameStart : undefined
      }

      depth += 1
      continue
    }

    if (character !== "}") {
      continue
    }

    if (depth === 0) {
      throw new Error(`Unmatched closing brace at offset ${index}`)
    }

    depth -= 1
    if (depth === 0 && blockStart !== undefined) {
      blocks.push(config.slice(blockStart, index + 1))
      blockStart = undefined
    }
  }

  if (depth !== 0) {
    throw new Error(`Unclosed block: ${depth} unmatched opening brace(s)`)
  }

  return blocks
}

function countActiveDirective(config: string, directive: string): number {
  return config.split("\n").filter((line) => line.trim() === directive).length
}

function findServerBlock(
  blocks: Array<string>,
  listenDirective: string,
): string {
  const matches = blocks.filter(
    (block) => countActiveDirective(block, listenDirective) === 1,
  )

  expect(matches).toHaveLength(1)
  return matches[0]
}

test("Statsig spoof template preserves routing and suppresses request logs", async () => {
  const [template, proxyLimitsTemplate] = await Promise.all([
    fs.readFile(templatePath, "utf8"),
    fs.readFile(proxyLimitsTemplatePath, "utf8"),
  ])
  const activeTemplate = stripComments(template)
  const activeProxyLimitsTemplate = stripComments(proxyLimitsTemplate)
  const serverBlocks = extractTopLevelServerBlocks(activeTemplate)

  expect(activeTemplate.trimEnd().endsWith("}")).toBe(true)
  expect(serverBlocks).toHaveLength(2)

  const httpBlock = findServerBlock(serverBlocks, "listen 80;")
  const httpsBlock = findServerBlock(serverBlocks, "listen 443 ssl;")
  expect(httpBlock).not.toBe(httpsBlock)

  expect(countActiveDirective(httpBlock, "access_log off;")).toBe(1)
  expect(countActiveDirective(httpBlock, "error_log /dev/null emerg;")).toBe(1)
  expect(countActiveDirective(httpsBlock, "access_log off;")).toBe(1)
  expect(countActiveDirective(httpsBlock, "error_log /dev/null emerg;")).toBe(1)
  expect(countActiveDirective(activeTemplate, "access_log off;")).toBe(2)
  expect(
    countActiveDirective(activeTemplate, "error_log /dev/null emerg;"),
  ).toBe(2)

  expect(httpBlock).toContain(
    "server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};",
  )
  expect(httpBlock).toContain("return 301 https://$host$request_uri;")

  expect(httpsBlock).toContain(
    "server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};",
  )
  expect(httpsBlock).toContain(
    "ssl_certificate     {{CODEX_STATSIG_SPOOF_SSL_CERTIFICATE_PATH}};",
  )
  expect(httpsBlock).toContain(
    "ssl_certificate_key {{CODEX_STATSIG_SPOOF_SSL_CERTIFICATE_KEY_PATH}};",
  )
  expect(httpsBlock).toContain("proxy_set_header Host $host;")
  expect(httpsBlock).toContain("proxy_set_header X-Real-IP $remote_addr;")
  expect(httpsBlock).toContain("proxy_set_header X-Forwarded-For $remote_addr;")
  expect(httpsBlock).toContain("proxy_set_header X-Forwarded-Proto $scheme;")
  expect(httpsBlock).toContain("proxy_pass {{UPSTREAM_URL}};")
  expect(
    countActiveDirective(httpsBlock, "include {{PROXY_LIMITS_SNIPPET_PATH}};"),
  ).toBe(1)
  expect(httpsBlock).toContain(
    "limit_req zone={{RATE_LIMIT_ZONE}} burst={{RATE_LIMIT_BURST}} nodelay;",
  )

  const effectiveHttpsBlock = httpsBlock.replaceAll(
    "include {{PROXY_LIMITS_SNIPPET_PATH}};",
    activeProxyLimitsTemplate,
  )
  expect(
    countActiveDirective(effectiveHttpsBlock, "proxy_request_buffering off;"),
  ).toBe(1)
  expect(
    countActiveDirective(effectiveHttpsBlock, "proxy_buffering off;"),
  ).toBe(1)
  expect(countActiveDirective(effectiveHttpsBlock, "proxy_cache off;")).toBe(1)
})
