import { expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

setDefaultTimeout(30_000)

const powershellExecutables = [Bun.which("pwsh"), Bun.which("powershell")]
  .filter((value): value is string => value !== null)
  .filter(
    (value, index, values) =>
      values.findIndex(
        (candidate) => candidate.toLowerCase() === value.toLowerCase(),
      ) === index,
  )
const powershellExecutable = powershellExecutables[0] ?? ""
const scriptPath = path.resolve(
  import.meta.dir,
  "../scripts/enable-codex-desktop-chatgpt-auth.ps1",
)
const powershellTest = test.skipIf(powershellExecutables.length === 0)
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
    name: string
  }
  "https://api.openai.com/auth": {
    chatgpt_user_id: string
    chatgpt_plan_type: string
    chatgpt_account_id: string
  }
}

interface WindowsDiscoveryResult {
  email: string
  fullName: string
  userName: string
}

interface ScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  digest: string
  backupPath: string
}

interface PowerShellRunOptions {
  nonInteractiveSwitch?: string
  environment?: Record<string, string | undefined>
  executable?: string
  stdin?: string
}

async function runPowerShellScript(
  arguments_: Array<string>,
  options: PowerShellRunOptions = {},
): Promise<ScriptResult> {
  const executable = options.executable ?? powershellExecutable
  const process = Bun.spawn(
    [
      executable,
      "-NoLogo",
      "-NoProfile",
      ...(options.stdin === undefined ?
        [options.nonInteractiveSwitch ?? "-NonInteractive"]
      : []),
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...arguments_,
    ],
    {
      env: options.environment,
      stdin: options.stdin === undefined ? undefined : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (options.stdin !== undefined) {
    await process.stdin.write(options.stdin)
    await process.stdin.end()
  }
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

for (const executable of powershellExecutables) {
  const engine = path.basename(executable)
  test(`creates and replaces auth safely with ${engine}`, async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const first = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-Email",
          "engine@example.invalid",
          "-FullName",
          "Engine User",
          "-SkipClipboard",
        ],
        { executable },
      )
      const original = await readAuth(codexHome)
      const second = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-Email",
          "engine@example.invalid",
          "-FullName",
          "Engine User",
          "-SkipClipboard",
        ],
        { executable },
      )
      const replacement = await readAuth(codexHome)
      const output = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`

      expect(first.exitCode).toBe(0)
      expect(second.exitCode).toBe(0)
      expect(second.digest).toBe(
        createHash("sha256")
          .update(replacement.auth.tokens.access_token, "utf8")
          .digest("hex"),
      )
      expect(await fs.readFile(second.backupPath)).toEqual(original.bytes)
      expect(await listRelativeFiles(codexHome)).toEqual([
        "auth.json",
        path.relative(codexHome, second.backupPath).replaceAll("\\", "/"),
      ])
      expect(output).not.toContain(original.auth.tokens.access_token)
      expect(output).not.toContain(original.auth.tokens.refresh_token)
      expect(output).not.toContain(replacement.auth.tokens.access_token)
      expect(output).not.toContain(replacement.auth.tokens.refresh_token)
    })
  })

  test(`never prompts in -NonInteractive mode with ${engine}`, async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-FullName",
          "Only Name",
          "-PromptForIdentity",
          "-SkipWindowsIdentityDiscovery",
          "-SkipClipboard",
        ],
        { executable },
      )
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(payload["https://api.openai.com/profile"].name).toBe("Only Name")
      expect(payload.email).toBe("only@copilot-api.local")
    })
  })

  test(`never prompts with abbreviated -noni mode using ${engine}`, async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-FullName",
          "Only Name",
          "-PromptForIdentity",
          "-SkipWindowsIdentityDiscovery",
          "-SkipClipboard",
        ],
        { executable, nonInteractiveSwitch: "-noni" },
      )
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(payload["https://api.openai.com/profile"].name).toBe("Only Name")
      expect(payload.email).toBe("only@copilot-api.local")
    })
  })
}

async function runScript(codexHome: string): Promise<ScriptResult> {
  return await runPowerShellScript([
    "-CodexHome",
    codexHome,
    "-Email",
    "device@example.invalid",
    "-FullName",
    "copilot-api",
    "-SkipClipboard",
  ])
}

async function runScriptWithDefaultEmail(
  codexHome: string,
  fullName: string,
): Promise<ScriptResult> {
  return await runPowerShellScript(
    [
      "-CodexHome",
      codexHome,
      "-FullName",
      fullName,
      "-SkipWindowsIdentityDiscovery",
      "-SkipClipboard",
    ],
    {
      environment: {
        ...globalThis.process.env,
        CODEX_AUTH_EMAIL: "",
      },
    },
  )
}

async function getExpectedWindowsDiscovery(
  executable = powershellExecutable,
): Promise<WindowsDiscoveryResult> {
  const script = String.raw`
$identity = [ordered]@{
  FullName = $null
  Email = $null
  UserName = [string][Environment]::UserName
}
try {
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
  $principal = [System.DirectoryServices.AccountManagement.UserPrincipal]::Current
  if ($null -ne $principal) {
    if (-not [string]::IsNullOrWhiteSpace($principal.DisplayName)) { $identity.FullName = $principal.DisplayName.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($principal.EmailAddress)) { $identity.Email = $principal.EmailAddress.Trim() }
    elseif (-not [string]::IsNullOrWhiteSpace($principal.UserPrincipalName)) { $identity.Email = $principal.UserPrincipalName.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($principal.SamAccountName)) { $identity.UserName = $principal.SamAccountName.Trim() }
  }
} catch {}
if ([string]::IsNullOrWhiteSpace($identity.FullName)) {
  try {
    if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
      $localUser = Get-LocalUser -Name $identity.UserName -ErrorAction Stop
      if (-not [string]::IsNullOrWhiteSpace($localUser.FullName)) { $identity.FullName = $localUser.FullName.Trim() }
    }
  } catch {}
}
if ([string]::IsNullOrWhiteSpace($identity.FullName) -and -not [string]::IsNullOrWhiteSpace($identity.UserName)) {
  try {
    $escaped = $identity.UserName.Replace("'", "''")
    $account = Get-CimInstance Win32_UserAccount -Filter "Name='$escaped'" -ErrorAction Stop | Where-Object { $_.LocalAccount } | Select-Object -First 1
    if ($null -ne $account -and -not [string]::IsNullOrWhiteSpace($account.FullName)) { $identity.FullName = $account.FullName.Trim() }
  } catch {}
}
$identity | ConvertTo-Json -Compress
`
  const process = Bun.spawn(
    [
      executable,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout) as {
    Email?: string | null
    FullName?: string | null
    UserName?: string | null
  }
  return {
    email: parsed.Email ?? "",
    fullName: parsed.FullName ?? "",
    userName: parsed.UserName ?? "",
  }
}

async function withTemporaryCodexHome(
  callback: (codexHome: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-script-")),
  )
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

function getJwtFromRefreshToken(refreshToken: string): string {
  const encodedJwt = refreshToken.replace(/^local_codex_v1\./, "")
  return Buffer.from(encodedJwt, "base64url").toString("utf8")
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
    expect(auth.tokens.refresh_token).toMatch(/^local_codex_v1\.[\w-]+$/)
    expect(getJwtFromRefreshToken(auth.tokens.refresh_token)).toBe(
      auth.tokens.access_token,
    )
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
      name: "copilot-api",
    })
    expect(userId).toBe("device")
    expect(accountId).toBe("device")
    expect(payload.sub).toBe("device")
    expect(auth.tokens.account_id).toBe("device")
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

powershellTest(
  "generates independent credentials with a stable identity derived from email",
  async () => {
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
      expect(secondPayload["https://api.openai.com/auth"].chatgpt_user_id).toBe(
        firstPayload["https://api.openai.com/auth"].chatgpt_user_id,
      )
      expect(
        secondPayload["https://api.openai.com/auth"].chatgpt_account_id,
      ).toBe(firstPayload["https://api.openai.com/auth"].chatgpt_account_id)
      expect(secondPayload.sub).toBe("device")
      expect(secondPayload["https://api.openai.com/auth"].chatgpt_user_id).toBe(
        "device",
      )
      expect(
        secondPayload["https://api.openai.com/auth"].chatgpt_account_id,
      ).toBe("device")
      expect(secondResult.digest).not.toBe(firstResult.digest)
    })
  },
)

powershellTest(
  "uses explicit full name and email and derives a normalized user id",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript([
        "-CodexHome",
        codexHome,
        "-FullName",
        "  Ashesh Kumar  ",
        "-Email",
        "  Ashesh.Kumar+Codex@Example.COM  ",
        "-SkipClipboard",
      ])
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(payload.email).toBe("Ashesh.Kumar+Codex@Example.COM")
      expect(payload["https://api.openai.com/profile"]).toEqual({
        email: "Ashesh.Kumar+Codex@Example.COM",
        name: "Ashesh Kumar",
      })
      expect(payload.sub).toBe("ashesh.kumar-codex")
      expect(payload["https://api.openai.com/auth"].chatgpt_user_id).toBe(
        "ashesh.kumar-codex",
      )
      expect(auth.tokens.account_id).toBe("ashesh.kumar-codex")
    })
  },
)

powershellTest(
  "uses configured identity overrides when parameters are absent",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript(
        ["-CodexHome", codexHome, "-SkipClipboard"],
        {
          environment: {
            ...globalThis.process.env,
            CODEX_AUTH_FULL_NAME: "Friendly Windows User",
            CODEX_AUTH_EMAIL: "friendly.windows@example.com",
          },
        },
      )
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(payload.email).toBe("friendly.windows@example.com")
      expect(payload["https://api.openai.com/profile"].name).toBe(
        "Friendly Windows User",
      )
      expect(payload.sub).toBe("friendly.windows")
    })
  },
)

powershellTest(
  "discovers the available Windows account name without prompting",
  async () => {
    const expected = await getExpectedWindowsDiscovery()
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript([
        "-CodexHome",
        codexHome,
        "-SkipClipboard",
      ])
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      if (expected.fullName) {
        expect(payload["https://api.openai.com/profile"].name).toBe(
          expected.fullName,
        )
      } else {
        expect(payload["https://api.openai.com/profile"].name).not.toBe("")
      }
      if (expected.email) expect(payload.email).toBe(expected.email)
      expect(payload.sub).not.toBe("")
    })
  },
)

powershellTest(
  "prompts for missing identity values and uses entered answers",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-PromptForIdentity",
          "-SkipWindowsIdentityDiscovery",
          "-SkipClipboard",
        ],
        {
          environment: {
            ...globalThis.process.env,
            USERNAME: "",
            COMPUTERNAME: "Prompt PC",
          },
          executable: powershellExecutable,
          stdin: "Prompt Person\nPrompt.Person@example.com\n",
        },
      )
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(payload["https://api.openai.com/profile"].name).toBe(
        "Prompt Person",
      )
      expect(payload.email).toBe("Prompt.Person@example.com")
      expect(payload.sub).toBe("prompt.person")
    })

    await withTemporaryCodexHome(async (codexHome) => {
      const result = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-PromptForIdentity",
          "-SkipWindowsIdentityDiscovery",
          "-SkipClipboard",
        ],
        {
          environment: {
            ...globalThis.process.env,
            USERNAME: "",
            COMPUTERNAME: "Fallback PC",
          },
          executable: powershellExecutable,
          stdin: "\n\n",
        },
      )
      const { auth } = await readAuth(codexHome)
      const payload = getJwtPayload(auth.tokens.access_token)

      expect(result.exitCode).toBe(0)
      expect(payload["https://api.openai.com/profile"].name).toBe("copilot-api")
      expect(payload.email).toBe("copilot-api@copilot-api.local")
      expect(payload.sub).toBe("copilot-api")
      expect(auth.tokens.account_id).toBe("copilot-api")
    })
  },
)

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
  "ignores process environment paths and writes nothing outside Codex home",
  async () => {
    await withTemporaryCodexHome(async (codexHome, root) => {
      const firstResult = await runScript(codexHome)
      const outsidePath = path.join(root, "outside-write.txt")
      const secondResult = await runPowerShellScript(
        [
          "-CodexHome",
          codexHome,
          "-Email",
          "device@example.invalid",
          "-FullName",
          "copilot-api",
          "-SkipClipboard",
        ],
        {
          environment: {
            ...globalThis.process.env,
            CODEX_AUTH_TEST_REPLACEMENT_OBSERVER_PATH: outsidePath,
          },
        },
      )

      expect(firstResult.exitCode).toBe(0)
      expect(secondResult.exitCode).toBe(0)
      expect(
        await fs.stat(outsidePath).then(
          () => true,
          () => false,
        ),
      ).toBeFalse()
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
      expect(result.stdout).toContain("your gateway's /dashboard#settings page")
      expect(result.stdout).toContain("quit and reopen Codex Desktop")
    })
  },
)

powershellTest(
  "derives the default email from a sanitized first name with a safe fallback",
  async () => {
    await withTemporaryCodexHome(async (codexHome) => {
      const sanitizedResult = await runScriptWithDefaultEmail(
        codexHome,
        "  Ashesh!!! Kumar  ",
      )
      const { auth: sanitizedAuth } = await readAuth(codexHome)
      const sanitizedPayload = getJwtPayload(sanitizedAuth.tokens.access_token)

      expect(sanitizedResult.exitCode).toBe(0)
      expect(sanitizedPayload.email).toBe("ashesh@copilot-api.local")

      const fallbackResult = await runScriptWithDefaultEmail(codexHome, "___")
      const { auth: fallbackAuth } = await readAuth(codexHome)
      const fallbackPayload = getJwtPayload(fallbackAuth.tokens.access_token)

      expect(fallbackResult.exitCode).toBe(0)
      expect(fallbackPayload.email).toBe("copilot-api@copilot-api.local")
    })
  },
)
