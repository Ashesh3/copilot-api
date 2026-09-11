import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { resolveStorageConfig } from "~/lib/storage/config"

test.each([{}, { DATA_DIR: "  " }])(
  "storage defaults to the local application database",
  (env) => {
    expect(resolveStorageConfig(env)).toEqual({
      kind: "sqlite",
      path: join(
        homedir(),
        ".local",
        "share",
        "copilot-api",
        "copilot-api.sqlite",
      ),
    })
  },
)

test("DATA_DIR resolves a local directory with the fixed database filename", () => {
  expect(resolveStorageConfig({ DATA_DIR: " ./fixture " })).toEqual({
    kind: "sqlite",
    path: join(process.cwd(), "fixture", "copilot-api.sqlite"),
  })
})

test.each([
  String.raw`\\?\C:\storage`,
  String.raw`\\.\D:\storage`,
  String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\storage`,
  String.raw`\\.\Volume{12345678-1234-1234-1234-123456789abc}\storage`,
])("local Windows namespaces keep their database location: %s", (DATA_DIR) => {
  if (process.platform !== "win32") {
    expect(() => resolveStorageConfig({ DATA_DIR })).toThrow("local directory")
    return
  }
  expect(resolveStorageConfig({ DATA_DIR })).toEqual({
    kind: "sqlite",
    path: `${DATA_DIR}\\copilot-api.sqlite`,
  })
})

test.each([
  "https://database.example/store",
  "file://server/share",
  "//server/share",
  String.raw`\\server\share`,
  String.raw`\\?\UNC\server\share`,
  String.raw`\\.\UNC\server\share`,
  String.raw`\\?\C:storage`,
  String.raw`\\?\Volume{not-a-guid}\storage`,
])(
  "rejects a remote DATA_DIR instead of creating a misleading local path: %s",
  (DATA_DIR) => {
    expect(() => resolveStorageConfig({ DATA_DIR })).toThrow("local directory")
  },
)

test("DATA_DIR rejects NUL bytes before constructing a database path", () => {
  expect(() =>
    resolveStorageConfig({ DATA_DIR: "fixture\u0000other-directory" }),
  ).toThrow("local directory")
})
