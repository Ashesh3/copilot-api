// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- UI has a separate JSX TS project.
// @ts-nocheck -- Runtime coverage imports the separately configured UI project.
import { expect, mock, test } from "bun:test"

// UI dependencies and their declarations live outside the root TS project.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { renderToStaticMarkup } from "../ui/node_modules/react-dom/server.bun.js"
import { createElement } from "../ui/node_modules/react/index.js"

const settingsBundle = {
  credentials: [],
  groq: false,
  settings: {
    version: "2.0.10",
    port: "4141",
    host: "127.0.0.1",
    authEnabled: true,
    multiToken: false,
    sentryEnabled: false,
    groqEnabled: false,
    dataDir: "F:/copilot-api-data",
    debug: false,
    verbose: false,
    passwordManagedExternally: true,
    codexCleanupModel: null,
    codexCleanupModelDefault: undefined,
    permissionReviewModel: "gpt-6-luna",
    permissionReviewAllowAll: false,
    availableModels: [],
  },
  allowlist: [
    {
      ip: "192.0.2.10",
      enabled: true,
      source: "dashboard",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  currentIp: "198.51.100.24",
  trustedJwtDigests: [
    {
      id: "6f9619ff-8b86-4be5-9c13-11c0c978a11",
      label: "Gaming PC",
      digest: "a".repeat(64),
      enabled: true,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
}

await mock.module("../ui/src/lib/usePolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useAsyncData: () => ({
    data: settingsBundle,
    error: undefined,
    loading: false,
    reload: () => {},
    reloadSilently: () => {},
  }),
}))

await mock.module("../ui/src/lib/toast", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix
  useToast: () => ({
    success: () => {},
    error: () => {},
  }),
}))

const { default: SettingsScreen } = await import("../ui/src/screens/Settings")
const { PermissionReviewSettings } = await import(
  "../ui/src/components/PermissionReviewSettings"
)

function renderSettings(): string {
  return renderToStaticMarkup(createElement(SettingsScreen))
}

test("permission review has a free-text model and an unchecked danger option", () => {
  const markup = renderSettings()
  const review = markup.slice(markup.indexOf("Permission review"))
  expect(markup).toContain("Permission review")
  expect(review).toContain("Reviewer model")
  expect(review).toContain('value="gpt-6-luna"')
  expect(review).toContain('type="checkbox"')
  const checkbox = review.match(/<input[^>]+type="checkbox"[^>]*>/)?.[0]
  expect(checkbox).not.toContain('checked=""')
  expect(review).toContain("Danger: allow all permission requests")
  expect(review).toContain("sensitive or destructive")
  expect(review).toContain("Save permission review")
})

test("permission review displays a saved custom model and enabled bypass warning", () => {
  const markup: string = renderToStaticMarkup(
    createElement(PermissionReviewSettings, {
      settings: {
        permissionReviewModel: "provider/custom-reviewer",
        permissionReviewAllowAll: true,
      },
      onSaved: () => {},
    }),
  )
  expect(markup).toContain('value="provider/custom-reviewer"')
  expect(markup.match(/<input[^>]+type="checkbox"[^>]*>/)?.[0]).toContain(
    'checked=""',
  )
  expect(markup).toContain('role="alert"')
  expect(markup).toContain("reviewer model is bypassed")
  expect(markup).not.toContain('role="combobox"')
})

test("settings groups credentials, access controls and administration after a compact server summary", () => {
  const markup = renderSettings()
  const serverIndex = markup.indexOf("Server Configuration")
  const credentialsIndex = markup.indexOf(
    'aria-labelledby="settings-credentials-heading"',
  )
  const accessIndex = markup.indexOf(
    'aria-labelledby="settings-access-heading"',
  )
  const administrationIndex = markup.indexOf(
    'aria-labelledby="settings-administration-heading"',
  )

  expect(serverIndex).toBeGreaterThan(-1)
  expect(credentialsIndex).toBeGreaterThan(serverIndex)
  expect(accessIndex).toBeGreaterThan(credentialsIndex)
  expect(administrationIndex).toBeGreaterThan(accessIndex)
  const credentials = markup.slice(credentialsIndex, accessIndex)
  expect(credentials).toContain("Gateway credentials")
  expect(credentials).toContain("Speech transcription")
  expect(credentials).toContain("Codex Dictation Cleanup")
  const access = markup.slice(accessIndex, administrationIndex)
  expect(access).toContain("IP Allowlist")
  expect(access).toContain("Trusted JWT Digests")
  expect(access).toContain(
    'role="region" aria-labelledby="settings-ip-list-label" tabindex="0"',
  )
  expect(access).toContain(
    'role="region" aria-labelledby="settings-jwt-list-label" tabindex="0"',
  )
  expect(access).toContain("1 IP address · 1 enabled")
  expect(access).toContain("1 trusted digest · 1 enabled")
  expect(access).toContain('aria-label="IP allowlist"')
  expect(access).toContain('aria-label="Trusted JWT digests"')
  const administration = markup.slice(administrationIndex)
  expect(administration).toContain("Administrator password")
  expect(administration).toContain("Export database")
  expect(markup).not.toContain('role="tablist"')
})

test("settings provides one complete SQLite export with current password and sensitive-file copy", () => {
  const markup = renderSettings()
  const backupMarkup = markup.slice(markup.indexOf("Export database"))

  expect(backupMarkup).toContain("Current administrator password")
  expect(backupMarkup).toContain("Download database")
  expect(backupMarkup).toContain("not encrypted")
  expect(backupMarkup).toContain("credentials")
  expect(backupMarkup).not.toContain("Backup password")
  expect(backupMarkup).not.toContain("Export sanitized config")
  expect(backupMarkup).not.toContain("Encrypted database backup")
  expect(markup).not.toContain("Administrator Security")
  expect(markup).not.toContain("Password managed by the environment")
  expect(markup).not.toContain("COPILOT_ADMIN_PASSWORD_HASH")
})

test("individual IP removal has no confirmation dialog", () => {
  const markup = renderSettings()

  expect(markup).toContain('aria-label="Remove 192.0.2.10"')
  expect(markup).toContain("Clear IP allowlist")
  expect(markup).toContain("Delete trusted JWT digest")
  expect(markup.match(/role="alertdialog"/g)).toHaveLength(2)
})
