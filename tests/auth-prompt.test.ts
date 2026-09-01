import { expect, test } from "bun:test"
import path from "node:path"
import { Readable, Writable } from "node:stream"

import {
  createAuthTextPrompt,
  selectAuthMethod,
  selectInstanceDomain,
} from "../src/auth"

const repositoryRoot = path.join(import.meta.dir, "..")

function captureOutput(chunks: Array<string>): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
}

test("uses plain numbered input and retries invalid choices", async () => {
  const output: Array<string> = []
  const prompt = createAuthTextPrompt({
    input: Readable.from(["3\n2\nMSFT.GHE.COM\n1\n"]),
    output: captureOutput(output),
  })

  try {
    const instanceDomain = await selectInstanceDomain(undefined, prompt)
    const method = await selectAuthMethod(
      {
        deviceCode: false,
        verbose: false,
        webFlow: false,
      },
      prompt,
      false,
    )

    expect(instanceDomain).toBe("msft.ghe.com")
    expect(method).toBe("device")
  } finally {
    prompt.close()
  }

  const text = output.join("")
  expect(text).toContain("1. GitHub.com")
  expect(text).toContain("2. GitHub Enterprise Cloud (*.ghe.com)")
  expect(text).toContain("Please enter a number from 1 to 2.")
  expect(text).toContain("1. Sign in with a device code (recommended)")
  expect(text).not.toContain("\u001B")
})

test("treats closed input as authentication cancellation", async () => {
  const prompt = createAuthTextPrompt({
    input: Readable.from([]),
    output: captureOutput([]),
  })

  try {
    let error: unknown
    try {
      await selectInstanceDomain(undefined, prompt)
    } catch (caughtError) {
      error = caughtError
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Authentication cancelled")
  } finally {
    prompt.close()
  }
})

test("recommends browser flow for a local interactive terminal", async () => {
  const output: Array<string> = []
  const prompt = createAuthTextPrompt({
    input: Readable.from(["1\n"]),
    output: captureOutput(output),
  })

  try {
    const method = await selectAuthMethod(
      {
        deviceCode: false,
        verbose: false,
        webFlow: false,
      },
      prompt,
      true,
    )
    expect(method).toBe("web")
  } finally {
    prompt.close()
  }

  expect(output.join("")).toContain(
    "1. Sign in with your browser (recommended)\n  2. Sign in with a device code",
  )
})

test("explicit auth flags do not require an interactive prompt", async () => {
  expect(await selectInstanceDomain("MSFT.GHE.COM")).toBe("msft.ghe.com")
  expect(
    await selectAuthMethod({
      deviceCode: true,
      verbose: false,
      webFlow: false,
    }),
  ).toBe("device")
})

test("the CLI accepts piped numbered input without EPIPE", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(repositoryRoot, "src", "main.ts"),
      "auth",
    ],
    {
      cwd: repositoryRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  await child.stdin.write("3\n1\n")
  await child.stdin.end()

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(exitCode).not.toBe(0)
  expect(stdout).toBe("")
  expect(stderr).toContain("1. GitHub.com")
  expect(stderr).toContain("Please enter a number from 1 to 2.")
  expect(stderr).toContain("How do you want to sign in?")
  expect(stderr).toContain("Authentication cancelled")
  expect(stderr).not.toContain("EPIPE")
  expect(stderr).not.toContain("\u001B")
})
