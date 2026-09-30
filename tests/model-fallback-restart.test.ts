import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

const fixture = resolve(import.meta.dir, "fixtures/fallback-restart.ts")
const fixtureRoot = resolve(
  import.meta.dir,
  "../.superpowers/test-data/restart",
)

async function requestInProcess(database: string, phase: string) {
  const child = Bun.spawn([process.execPath, fixture, database, phase], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`Restart fixture failed: ${errors}`)
  return JSON.parse(output) as Array<{
    model: string
    input: Array<Record<string, unknown>>
  }>
}

test("a new process resumes the SQLite conversation model and preserves its new thinking", async () => {
  await mkdir(fixtureRoot, { recursive: true })
  const directory = await mkdtemp(join(fixtureRoot, "conversation-"))
  const checked = resolve(directory)
  if (!checked.startsWith(`${fixtureRoot}${sep}`))
    throw new Error("Unsafe restart fixture cleanup path")
  try {
    const database = join(directory, "routing.sqlite")
    const first = await requestInProcess(database, "seed")
    expect(first.map((payload) => payload.model)).toEqual(["source", "target"])
    const resumed = await requestInProcess(database, "read")
    expect(resumed.map((payload) => payload.model)).toEqual(["target"])
    expect(resumed[0]?.input).toEqual([
      { type: "reasoning", encrypted_content: "new-target-signature" },
      { role: "user", content: "Continue" },
    ])
  } finally {
    await rm(checked, { recursive: true, force: true })
  }
}, 20000)
