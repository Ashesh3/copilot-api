import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")

type StoreOperation = { kind: "add-enterprise" } | { kind: "load" }

interface StoreRunResult {
  result: {
    accounts: unknown
    credentials: unknown
  }
  stderr: string
}

const childSource = String.raw`
const operation = JSON.parse(process.env.ACCOUNTS_STORE_OPERATION)
const store = await import("./src/lib/accounts-store.ts")

if (operation.kind === "add-enterprise") {
  await store.addAccount(
    "enterprise-token",
    "work",
    "HTTPS://MSFT.GHE.COM/",
  )
}

const result = {
  accounts: await store.loadAccounts(),
  credentials: await store.getStoredCredentials(),
}
process.stdout.write(JSON.stringify(result))
`

async function withStoreDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-api-accounts-store-"),
  )
  try {
    await fs.writeFile(path.join(directory, "github_token"), "")
    return await callback(directory)
  } finally {
    await fs.rm(directory, { force: true, recursive: true })
  }
}

async function runStore(
  directory: string,
  operation: StoreOperation = { kind: "load" },
): Promise<StoreRunResult> {
  const child = Bun.spawn([process.execPath, "-e", childSource], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ACCOUNTS_STORE_OPERATION: JSON.stringify(operation),
      DATA_DIR: directory,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Accounts-store subprocess failed:\n${stderr}`)
  }
  return {
    result: JSON.parse(stdout) as StoreRunResult["result"],
    stderr,
  }
}

test("loads pre-instance account rows as GitHub.com credentials", async () => {
  await withStoreDirectory(async (directory) => {
    await fs.writeFile(
      path.join(directory, "github_tokens.json"),
      JSON.stringify([{ token: " public-token ", label: " personal " }]),
    )

    const { result } = await runStore(directory)
    expect(result.accounts).toEqual([
      { token: "public-token", label: "personal" },
    ])
    expect(result.credentials).toEqual([
      { instanceDomain: "github.com", token: "public-token" },
    ])
  })
})

test("migrates the legacy single-token file as a GitHub.com account", async () => {
  await withStoreDirectory(async (directory) => {
    await fs.writeFile(path.join(directory, "github_token"), " legacy-token \n")

    const { result } = await runStore(directory)
    expect(result.credentials).toEqual([
      { instanceDomain: "github.com", token: "legacy-token" },
    ])
    expect(
      JSON.parse(
        (
          await fs.readFile(path.join(directory, "github_tokens.json"))
        ).toString("utf8"),
      ),
    ).toEqual([{ token: "legacy-token" }])
  })
})

test("normalizes and persists an enterprise account domain", async () => {
  await withStoreDirectory(async (directory) => {
    const { result } = await runStore(directory, { kind: "add-enterprise" })

    const expected = [
      {
        instanceDomain: "msft.ghe.com",
        label: "work",
        token: "enterprise-token",
      },
    ]
    expect(result.accounts).toEqual(expected)
    expect(
      JSON.parse(
        (
          await fs.readFile(path.join(directory, "github_tokens.json"))
        ).toString("utf8"),
      ),
    ).toEqual(expected)
  })
})

test("writes the accounts store atomically with private permissions", async () => {
  await withStoreDirectory(async (directory) => {
    const accountsPath = path.join(directory, "github_tokens.json")
    await fs.writeFile(accountsPath, "[]\n", { mode: 0o666 })

    await runStore(directory, { kind: "add-enterprise" })

    const temporaryFiles = (await fs.readdir(directory)).filter((entry) =>
      entry.startsWith("github_tokens.json."),
    )
    expect(temporaryFiles).toEqual([])
    if (process.platform !== "win32") {
      expect((await fs.stat(accountsPath)).mode & 0o777).toBe(0o600)
    }
  })
})

test("reports malformed JSON and safely falls back to legacy storage", async () => {
  await withStoreDirectory(async (directory) => {
    await fs.writeFile(path.join(directory, "github_tokens.json"), "{not-json")
    await fs.writeFile(path.join(directory, "github_token"), "legacy-fallback")

    const { result, stderr } = await runStore(directory)
    expect(result.credentials).toEqual([
      { instanceDomain: "github.com", token: "legacy-fallback" },
    ])
    expect(stderr).toContain(
      "Invalid github_tokens.json: expected valid JSON; checking legacy token storage",
    )
  })
})

test("skips malformed rows without leaking token values or crashing", async () => {
  await withStoreDirectory(async (directory) => {
    const privateMarker = "private-malformed-token-marker"
    await fs.writeFile(
      path.join(directory, "github_tokens.json"),
      JSON.stringify([
        null,
        { token: "" },
        { token: privateMarker, instanceDomain: "github.example.com" },
        { token: "valid-public-token", label: 42 },
        { token: "valid-enterprise-token", instanceDomain: "github.ghe.com" },
        { token: "valid-public-token" },
      ]),
    )

    const { result, stderr } = await runStore(directory)
    expect(result.credentials).toEqual([
      {
        instanceDomain: "github.ghe.com",
        token: "valid-enterprise-token",
      },
      { instanceDomain: "github.com", token: "valid-public-token" },
    ])
    expect(stderr).toContain("account #1")
    expect(stderr).toContain("account #4")
    expect(stderr).not.toContain(privateMarker)
  })
})

test("reports a non-array document and safely falls back to legacy storage", async () => {
  await withStoreDirectory(async (directory) => {
    await fs.writeFile(
      path.join(directory, "github_tokens.json"),
      JSON.stringify({ token: "bad" }),
    )
    await fs.writeFile(path.join(directory, "github_token"), "legacy-fallback")

    const { result, stderr } = await runStore(directory)
    expect(result.credentials).toEqual([
      { instanceDomain: "github.com", token: "legacy-fallback" },
    ])
    expect(stderr).toContain(
      "Invalid github_tokens.json: expected an array; checking legacy token storage",
    )
  })
})
