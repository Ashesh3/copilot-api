import type { FileHandle } from "node:fs/promises"

import { chmod, mkdtemp, open, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { LocalHTTPError } from "~/lib/error"

const EXPORT_TIMEOUT_MS = 30 * 60_000
const READ_CHUNK_BYTES = 64 * 1024
const DIRECTORY_PREFIX = ".database-export-"
let activeExport = false

// Keep SQLite's synchronous work in another process. Only filenames are
// supplied as arguments; none of the source path becomes executable code.
const SNAPSHOT_SCRIPT = `
import { Database } from "bun:sqlite";
const [source, target] = process.argv.slice(1);
let database;
try {
  database = new Database(source, { readonly: true, strict: true });
  database.run("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
  database.query("VACUUM main INTO ?").run(target);
} catch {
  process.exitCode = 1;
} finally {
  database?.close();
}
`

function exportError(status: 409 | 500 = 500): LocalHTTPError {
  const clientBody = {
    error: {
      code:
        status === 409 ? "database_export_active" : "database_export_failed",
      message:
        status === 409 ?
          "A database export is already in progress."
        : "Unable to export the database.",
      type: "server_error",
    },
  }
  return new LocalHTTPError(
    clientBody.error.message,
    Response.json(clientBody, { status }),
    clientBody,
  )
}

function cancelled(): DOMException {
  return new DOMException("Database export cancelled.", "AbortError")
}

function exportCancellation(signal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(cancelled())
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(
    () => controller.abort(exportError()),
    EXPORT_TIMEOUT_MS,
  )
  timeout.unref()
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    },
  }
}

async function generateSnapshot(
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      SNAPSHOT_SCRIPT,
      source,
      target,
    ],
    {
      cwd: dirname(target),
      windowsHide: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  const abort = () => {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    const exitCode = await child.exited
    signal.throwIfAborted()
    if (exitCode !== 0) throw exportError()
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

async function removeExport(directory: string, parent: string): Promise<void> {
  if (
    dirname(resolve(directory)) !== parent
    || !basename(directory).startsWith(DIRECTORY_PREFIX)
  )
    throw exportError()
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

function downloadStream(
  file: FileHandle,
  size: number,
  options: { signal: AbortSignal; cleanup: () => Promise<void> },
): ReadableStream<Uint8Array> {
  const { signal, cleanup } = options
  const state = { stopped: false, cancelled: false }
  let position = 0
  let pendingRead: Promise<unknown> | undefined
  let closing: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener("abort", abort)
      await pendingRead?.catch(() => {})
      await cleanup()
    })()
    return closing
  }
  const fail = (error: unknown) => {
    if (!state.cancelled) controller.error(error)
  }
  const abort = () => {
    if (state.stopped) return
    state.stopped = true
    void close().then(
      () => fail(signal.reason),
      () => fail(exportError()),
    )
  }
  return new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      },
      async pull() {
        if (state.stopped) return
        try {
          const bytes = new Uint8Array(
            Math.min(READ_CHUNK_BYTES, size - position),
          )
          const read = file.read(bytes, 0, bytes.byteLength, position)
          pendingRead = read
          const { bytesRead } = await read
          pendingRead = undefined
          // Abort or cancellation may have run while the file read was pending.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (state.stopped) return
          if (!bytesRead) throw exportError()
          position += bytesRead
          controller.enqueue(bytes.subarray(0, bytesRead))
          if (position === size) {
            state.stopped = true
            await close()
            if (!state.cancelled) controller.close()
          }
        } catch {
          state.stopped = true
          await close().catch(() => {})
          fail(exportError())
        }
      },
      async cancel() {
        state.stopped = true
        state.cancelled = true
        await close()
      },
    },
    { highWaterMark: 0 },
  )
}

export async function exportDatabaseResponse(
  databasePath: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw cancelled()
  if (activeExport) throw exportError(409)
  if (!databasePath || databasePath.includes("\0")) throw exportError()
  const source = resolve(databasePath)
  const parent = dirname(source)
  activeExport = true
  const cancellation = exportCancellation(signal)
  let directory: string | undefined
  let file: FileHandle | undefined
  let cleaning: Promise<void> | undefined
  const cleanup = () => {
    cleaning ??= (async () => {
      cancellation.close()
      try {
        try {
          await file?.close()
        } finally {
          if (directory) await removeExport(directory, parent)
        }
      } finally {
        activeExport = false
      }
    })().catch(() => {
      throw exportError()
    })
    return cleaning
  }
  try {
    directory = await mkdtemp(join(parent, DIRECTORY_PREFIX))
    if (process.platform !== "win32") await chmod(directory, 0o700)
    const target = join(directory, "database.sqlite")
    const empty = await open(target, "wx", 0o600)
    await empty.close()
    await generateSnapshot(source, target, cancellation.signal)
    cancellation.signal.throwIfAborted()
    file = await open(target, "r")
    const { size } = await file.stat()
    if (!Number.isSafeInteger(size) || size < 100) throw exportError()
    cancellation.signal.throwIfAborted()
    const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
    return new Response(
      downloadStream(file, size, { signal: cancellation.signal, cleanup }),
      {
        headers: {
          "Content-Type": "application/vnd.sqlite3",
          "Content-Disposition": `attachment; filename="copilot-api-database-${timestamp}.sqlite"`,
          "Content-Length": String(size),
          "Cache-Control": "no-store",
        },
      },
    )
  } catch {
    await cleanup()
    cancellation.signal.throwIfAborted()
    throw exportError()
  }
}
