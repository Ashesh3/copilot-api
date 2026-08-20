import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.join(import.meta.dir, "..")

test("keeps tracked environment typings synchronized with Varlock generation", async () => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(repositoryRoot, ".varlock-typegen-"),
  )

  try {
    const schema = await fs.readFile(
      path.join(repositoryRoot, ".env.schema"),
      "utf8",
    )
    const typeGenerationSchema = schema
      .split(/\r?\n/u)
      .filter(
        (line) =>
          !line.startsWith("# @plugin(")
          && !line.startsWith("# @initOp(")
          && !line.startsWith("# @setValuesBulk("),
      )
      .join("\n")
    await fs.writeFile(
      path.join(temporaryDirectory, ".env.schema"),
      typeGenerationSchema,
      "utf8",
    )

    const varlock = Bun.spawn(
      [
        process.execPath,
        path.join(repositoryRoot, "node_modules", "varlock", "bin", "cli.js"),
        "typegen",
        "--path",
        ".env.schema",
      ],
      {
        cwd: temporaryDirectory,
        stderr: "pipe",
        stdout: "pipe",
      },
    )
    const [exitCode, stderr, stdout] = await Promise.all([
      varlock.exited,
      new Response(varlock.stderr).text(),
      new Response(varlock.stdout).text(),
    ])

    expect(stderr).toBe("")
    if (exitCode !== 0) {
      throw new Error(`Varlock type generation failed:\n${stdout}`)
    }
    expect(exitCode).toBe(0)

    const [generated, tracked] = await Promise.all([
      fs.readFile(path.join(temporaryDirectory, "env.d.ts"), "utf8"),
      fs.readFile(path.join(repositoryRoot, "env.d.ts"), "utf8"),
    ])
    const generatedDeclaration = generated.match(
      /^ {2}COPILOT_INTEGRATION_ID\??: string;$/mu,
    )?.[0]
    const trackedDeclaration = tracked.match(
      /^ {2}COPILOT_INTEGRATION_ID\??: string;$/mu,
    )?.[0]
    expect(generatedDeclaration).toBe("  COPILOT_INTEGRATION_ID?: string;")
    expect(trackedDeclaration).toBe(generatedDeclaration)
  } finally {
    await fs.rm(temporaryDirectory, { force: true, recursive: true })
  }
})
