import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const powershell = Bun.which("pwsh") ?? Bun.which("powershell")
const powershellExecutable = powershell ?? ""
const scriptPath = path.resolve(
  import.meta.dir,
  "../scripts/enable-codex-desktop-chatgpt-auth.ps1",
)
const powershellTest = test.skipIf(powershell === null)
const replacementObserverEnvironmentVariable =
  "CODEX_AUTH_TEST_REPLACEMENT_OBSERVER_PATH"
const environmentExclusions = [
  "config.toml",
  "hosts",
  "certificate",
  "environment",
  "proxy",
  "dns",
  "firewall",
]

interface AuthFile {
  auth_mode: string
  OPENAI_API_KEY: string | null
  tokens: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id: string
  }
  last_refresh: string
}

interface JwtPayload {
  iss: string
  aud: string
  sub: string
  iat: number
  email: string
  "https://api.openai.com/profile": {
    email: string
  }
  "https://api.openai.com/auth": {
    chatgpt_user_id: string
    chatgpt_plan_type: string
    chatgpt_account_id: string
  }
}

interface ScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  digest: string
  backupPath: string
}

async function runPowerShellScript(
  arguments_: Array<string>,
  environment?: Record<string, string | undefined>,
): Promise<ScriptResult> {
  const process = Bun.spawn(
    [
      powershellExecutable,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      scriptPath,
      ...arguments_,
    ],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  const digestMatch =
    /TRUSTED_JWT_SHA256_BEGIN\s+([a-f\d]{64})\s+TRUSTED_JWT_SHA256_END/.exec(
      stdout,
    )
  const backupLine = stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("Backup path: "))
  return {
    exitCode,
    stdout,
    stderr,
    digest: digestMatch?.[1] ?? "",
    backupPath: backupLine?.slice("Backup path: ".length).trim() ?? "",
  }
}

async function runScript(codexHome: string): Promise<ScriptResult> {
  return await runPowerShellScript([
    "-CodexHome",
    codexHome,
    "-Email",
    "device@example.invalid",
    "-SkipClipboard",
  ])
}

async function runScriptWithDefaultEmail(
  codexHome: string,
  machineName: string,
): Promise<ScriptResult> {
  return await runPowerShellScript(
    ["-CodexHome", codexHome, "-SkipClipboard"],
    { ...globalThis.process.env, COMPUTERNAME: machineName },
  )
}

async function withTemporaryCodexHome(
  callback: (codexHome: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-script-"))
  const codexHome = path.join(root, ".codex")
  try {
    await callback(codexHome, root)
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

async function readAuth(codexHome: string): Promise<{
  auth: AuthFile
  bytes: Buffer
}> {
  const bytes = await fs.readFile(path.join(codexHome, "auth.json"))
  return {
    auth: JSON.parse(bytes.toString("utf8")) as AuthFile,
    bytes,
  }
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown
}

function getJwtPayload(jwt: string): JwtPayload {
  return decodeJwtPart(jwt.split(".")[1] ?? "") as JwtPayload
}

async function listRelativeFiles(root: string): Promise<Array<string>> {
  const results: Array<string> = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else {
        results.push(path.relative(root, entryPath).replaceAll("\\", "/"))
      }
    }
  }

  await visit(root)
  return results.sort()
}

powershellTest("writes the exact ChatGPT auth file shape", async () => {
  await withTemporaryCodexHome(async (codexHome) => {
    const result = await runScript(codexHome)
    const { auth } = await readAuth(codexHome)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(auth.auth_mode).toBe("chatgpt")
    expect(auth.OPENAI_API_KEY).toBeNull()
    expect(auth.tokens.id_token).toBe(auth.tokens.access_token)
    expect(auth.tokens.refresh_token).toMatch(/^local_[\w-]+$/)
    expect(auth.tokens.account_id).toBe(
      getJwtPayload(auth.tokens.access_token)["https://api.openai.com/auth"]
        .chatgpt_account_id,
    )
    expect(auth.last_refresh).toBe("2099-01-01T00:00:00Z")
  })
})

powershellTest("writes the required local ChatGPT JWT claims", async () => {
  await withTemporaryCodexHome(async (codexHome) => {
    const before = Math.floor(Date.now() / 1000)
    const result = await runScript(codexHome)
    const after = Math.floor(Date.now() / 1000)
    const { auth } = await readAuth(codexHome)
    const [headerPart, payloadPart] = auth.tokens.access_token.split(".")
    const header = decodeJwtPart(headerPart) as Record<string, string>
    const payload = decodeJwtPart(payloadPart) as JwtPayload
    const userId = payload["https://api.openai.com/auth"].chatgpt_user_id
    const accountId = payload["https://api.openai.com/auth"].chatgpt_account_id

    expect(result.exitCode).toBe(0)
    expect(header).toEqual({ alg: "none", typ: "JWT" })
    expect(payload.iss).toBe("https://auth.openai.com")
    expect(payload.aud).toBe("https://api.openai.com/v1")
    expect(payload.email).toBe("device@example.invalid")
    expect(payload["https://api.openai.com/profile"]).toEqual({
      email: "device@example.invalid",
    })
    expect(userId).toMatch(/^local-dictation-[a-f0-9]{32}$/)
    expect(accountId).toMatch(/^local-dictation-[a-f0-9]{32}$/)
    expect(userId).not.toBe(accountId)
    expect(payload.sub).toBe(userId)
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    expect(payload["https://api.openai.com/auth"].chatgpt_plan_type).toBe(
      "plus",
    )
  })
})

powershellTest("uses three non-empty base64url JWT segments", async () => {
  await withTemporaryCodexHome(async (codexHome) => {
    const result = await runScript(codexHome)
    const { auth } = await readAuth(codexHome)
    const segments = auth.tokens.access_token.split(".")

    expect(result.exitCode).toBe(0)
    expect(segments).toHaveLength(3)
    for (const segment of segments) {
      expect(segment).toMatch(/^[\w-]+$/)
    }
  })
})

powershellTest(
  "prints the SHA-256 digest of the exact access token",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runScript(codexHome)
      const { auth } = await readAuth(codexHome)
      const expectedDigest = createHash("sha256")
        .update(auth.tokens.access_token, "utf8")
        .digest("hex")

      expect(result.exitCode).toBe(0)
      expect(result.digest).toBe(expectedDigest)
      expect(result.stdout.match(/TRUSTED_JWT_SHA256_BEGIN/g)).toHaveLength(1)
      expect(result.stdout.match(/TRUSTED_JWT_SHA256_END/g)).toHaveLength(1)
    })
  },
)

powershellTest(
  "does not expose excluded system-configuration parameters or operations",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      for (const excludedParameter of environmentExclusions) {
        const result = await runPowerShellScript([
          "-CodexHome",
          codexHome,
          `-${excludedParameter}`,
          "sentinel",
        ])

        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toBe("")
        expect(
          await fs.stat(codexHome).then(
            () => true,
            () => false,
          ),
        ).toBeFalse()
      }
    })
  },
)

powershellTest("never prints the JWT or refresh token", async () => {
  await withTemporaryCodexHome(async (codexHome) => {
    const result = await runScript(codexHome)
    const { auth } = await readAuth(codexHome)
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.exitCode).toBe(0)
    expect(output).not.toContain(auth.tokens.access_token)
    expect(output).not.toContain(auth.tokens.refresh_token)
  })
})

powershellTest("generates independent credentials on every run", async () => {
  await withTemporaryCodexHome(async (codexHome) => {
    const firstResult = await runScript(codexHome)
    const { auth: firstAuth } = await readAuth(codexHome)
    const secondResult = await runScript(codexHome)
    const { auth: secondAuth } = await readAuth(codexHome)
    const firstPayload = getJwtPayload(firstAuth.tokens.access_token)
    const secondPayload = getJwtPayload(secondAuth.tokens.access_token)

    expect(firstResult.exitCode).toBe(0)
    expect(secondResult.exitCode).toBe(0)
    expect(secondAuth.tokens.access_token).not.toBe(
      firstAuth.tokens.access_token,
    )
    expect(secondAuth.tokens.refresh_token).not.toBe(
      firstAuth.tokens.refresh_token,
    )
    expect(
      secondPayload["https://api.openai.com/auth"].chatgpt_user_id,
    ).not.toBe(firstPayload["https://api.openai.com/auth"].chatgpt_user_id)
    expect(
      secondPayload["https://api.openai.com/auth"].chatgpt_account_id,
    ).not.toBe(firstPayload["https://api.openai.com/auth"].chatgpt_account_id)
    expect(secondResult.digest).not.toBe(firstResult.digest)
  })
})

powershellTest(
  "backs up an existing auth file byte-for-byte before replacing it",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const firstResult = await runScript(codexHome)
      const { bytes: original } = await readAuth(codexHome)

      const result = await runScript(codexHome)
      const backup = await fs.readFile(result.backupPath)
      const backupDirectory = path.basename(path.dirname(result.backupPath))

      expect(firstResult.exitCode).toBe(0)
      expect(result.exitCode).toBe(0)
      expect(result.backupPath).not.toBe("")
      expect(backup).toEqual(original)
      expect(path.basename(result.backupPath)).toBe("auth.json")
      expect(backupDirectory).toMatch(
        /^codex-chatgpt-auth-\d{8}T\d{6}Z-[a-f0-9]{8}$/,
      )
      expect(
        path
          .relative(path.join(codexHome, "backups"), result.backupPath)
          .startsWith(".."),
      ).toBeFalse()
    })
  },
)

powershellTest(
  "uses the permanent backup as the atomic replacement backup destination",
  async () => {
    await withTemporaryCodexHome(async (codexHome, root) => {
      const firstResult = await runScript(codexHome)
      const observerPath = path.join(root, "replacement-observer.txt")
      const secondResult = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-Email",
          "device@example.invalid",
          "-SkipClipboard",
        ],
        {
          ...globalThis.process.env,
          [replacementObserverEnvironmentVariable]: observerPath,
        },
      )
      const observedReplacementBackupPath = (
        await fs.readFile(observerPath, "utf8")
      ).trim()

      expect(firstResult.exitCode).toBe(0)
      expect(secondResult.exitCode).toBe(0)
      expect(observedReplacementBackupPath).toBe(secondResult.backupPath)
      expect(await listRelativeFiles(codexHome)).toEqual([
        "auth.json",
        path.relative(codexHome, secondResult.backupPath).replaceAll("\\", "/"),
      ])
    })
  },
)

powershellTest(
  "preserves every unrelated file and leaves no temporary output",
  async () => {
    await withTemporaryCodexHome(async (codexHome, root) => {
      await fs.mkdir(codexHome, { recursive: true })
      const configContents = 'model = "sentinel"\r\n'
      const notesContents = Buffer.from([1, 2, 3, 4, 5])
      const outsidePath = path.join(root, "outside-sentinel.txt")
      await fs.writeFile(path.join(codexHome, "config.toml"), configContents)
      await fs.writeFile(path.join(codexHome, "notes.bin"), notesContents)
      await fs.writeFile(outsidePath, "outside")

      const result = await runScript(codexHome)
      const files = await listRelativeFiles(codexHome)

      expect(result.exitCode).toBe(0)
      expect(
        await fs.readFile(path.join(codexHome, "config.toml"), "utf8"),
      ).toBe(configContents)
      expect(await fs.readFile(path.join(codexHome, "notes.bin"))).toEqual(
        notesContents,
      )
      expect(await fs.readFile(outsidePath, "utf8")).toBe("outside")
      expect(files).toEqual(["auth.json", "config.toml", "notes.bin"])
      expect(await fs.readdir(root).then((entries) => entries.sort())).toEqual([
        ".codex",
        "outside-sentinel.txt",
      ])
    })
  },
)

powershellTest(
  "skip-clipboard mode prints manual dashboard registration instructions",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runScript(codexHome)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Clipboard skipped")
      expect(result.stdout).toContain("Copy the digest from the marker block")
      expect(result.stdout).toContain(
        "https://ai.ashesh.dev/dashboard#settings",
      )
      expect(result.stdout).toContain("quit and reopen Codex Desktop")
    })
  },
)

powershellTest(
  "derives the default email from a sanitized machine name with a fallback",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const sanitizedResult = await runScriptWithDefaultEmail(
        codexHome,
        "  My___WINDOWS PC!!  ",
      )
      const { auth: sanitizedAuth } = await readAuth(codexHome)
      const sanitizedPayload = getJwtPayload(sanitizedAuth.tokens.access_token)

      expect(sanitizedResult.exitCode).toBe(0)
      expect(sanitizedPayload.email).toBe("codex-my-windows-pc@local.invalid")

      const fallbackResult = await runScriptWithDefaultEmail(codexHome, "___")
      const { auth: fallbackAuth } = await readAuth(codexHome)
      const fallbackPayload = getJwtPayload(fallbackAuth.tokens.access_token)

      expect(fallbackResult.exitCode).toBe(0)
      expect(fallbackPayload.email).toBe("codex-windows-pc@local.invalid")
    })
  },
)
