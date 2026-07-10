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

test("Statsig spoof template preserves routing and suppresses request logs", async () => {
  const template = await fs.readFile(templatePath, "utf8")

  expect(template).toContain("server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};")
  expect(template).toContain("access_log off;")
  expect(template).toContain("error_log /dev/null emerg;")
  expect(template).toContain("proxy_set_header Host $host;")
  expect(template).toContain("proxy_set_header X-Forwarded-For $remote_addr;")
  expect(template).toContain("proxy_pass {{UPSTREAM_URL}};")
})
