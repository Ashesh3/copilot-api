import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")

async function read(relativePath: string): Promise<string> {
  return await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")
}

test("nightly smoke clients use explicit proxy and output contracts", async () => {
  const [script, geminiSettings] = await Promise.all([
    read("tests/smoke/run-smoke-tests.sh"),
    read("tests/smoke/gemini-system-settings.json"),
  ])

  expect(script).toContain(String.raw`openai_base_url=\"$SERVER_URL/v1\"`)
  expect(script).toContain("--output-last-message")
  expect(script).not.toContain('export OPENAI_BASE_URL="$SERVER_URL/v1"')

  expect(script).toContain("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
  expect(script).toContain("--skip-trust")
  expect(JSON.parse(geminiSettings)).toEqual({
    security: { auth: { selectedType: "gemini-api-key" } },
  })
})

test("nightly smoke uses a supported Gemini model for both probes", async () => {
  const script = await read("tests/smoke/run-smoke-tests.sh")

  expect(script).not.toContain("--model gemini-2.5-pro")
  expect(script.match(/--model gemini-3\.1-pro-preview/g)).toHaveLength(2)
})

test("nightly smoke generation assertions cannot pass on echoed prompts", async () => {
  const script = await read("tests/smoke/run-smoke-tests.sh")

  expect(script).not.toContain(
    'output=$(codex exec "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).not.toContain(
    'output=$(gemini --model gemini-2.5-pro -p "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).not.toContain(
    'output=$(claude -p "Reply with exactly: SMOKE_TEST_OK"',
  )
  expect(script).toContain(
    String.raw`test "$(tr -d "\r\n" < "$output_file")" = "SMOKE_TEST_OK"`,
  )
  expect(script).toContain("--output-format json")
  expect(script.match(/test "\$status" -eq 0/g)).toHaveLength(7)
})
