# Codex Statsig Feature Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add separately managed ChatGPT/Codex Statsig overrides to the dashboard and apply them to allowlisted `ab.chatgpt.com` traffic without replacing unrelated upstream flags.

**Architecture:** A dedicated Statsig override store persists feature gates and dynamic configs independently from Claude Code's GrowthBook flags. A pre-auth, host-aware middleware proxies real Statsig traffic; initialization requests are normalized into full evaluations, overlaid with local values, and returned to Codex Desktop. The existing dashboard gains an application selector and type-aware editors while retaining all current Claude Code behavior.

**Tech Stack:** TypeScript, Bun, Hono, React 19, Astryx UI, `fflate`, Bun test runner, Vite.

---

## Execution Prerequisite

Implement this plan in a dedicated git worktree. Do not alter the existing untracked files in the primary checkout:

```text
.claude/settings.json
UI_design
copilot-session-cd403420-4904-4e69-bfed-4cb1528d8247.md
scripts/content_filter_probe.py
```

## File Map

**Create**

- `src\routes\statsig-overrides\store.ts` - validated persistent storage for Statsig gates and dynamic configs.
- `src\routes\statsig-overrides\protocol.ts` - request decoding, full-evaluation normalization, and V1 response overlay logic.
- `src\routes\statsig-overrides\proxy.ts` - allowlisted `ab.chatgpt.com` middleware and upstream proxying.
- `src\lib\proxy-http.ts` - shared host/header normalization used by Anthropic and Statsig proxy paths.
- `tests\statsig-overrides-store.test.ts` - storage validation and persistence tests.
- `tests\statsig-protocol.test.ts` - encoding and overlay unit tests.
- `tests\statsig-proxy.test.ts` - host, allowlist, forwarding, and failure-path tests.
- `tests\dashboard-statsig-overrides.test.ts` - authenticated dashboard API and generated UI assertions.
- `nginx\sites-available\codex-statsig-spoof.conf.template` - TLS vhost that preserves the Statsig host while disabling query-string access logs.
- `tests\statsig-nginx-config.test.ts` - deployment-template regression checks.

**Modify**

- `src\lib\paths.ts` - add `STATSIG_OVERRIDES_PATH`.
- `src\lib\config-export.ts` - include `statsig_overrides.json` in configuration exports.
- `tests\dashboard-config-export.test.ts` - verify the new file is exported.
- `src\lib\transparent-proxy.ts` - consume shared proxy helpers without changing Anthropic behavior.
- `src\server.ts` - register Statsig middleware before API-key authentication.
- `src\lib\sentry.ts` - redact Statsig client keys from events, transactions, spans, and logs.
- `tests\sentry.test.ts` - verify Statsig URL redaction.
- `src\routes\dashboard\api.ts` - add Statsig handlers and include overrides in the overview count.
- `src\routes\dashboard\route.ts` - register Statsig dashboard endpoints.
- `ui\src\lib\types.ts` - add Statsig dashboard payload types.
- `ui\src\screens\Flags.tsx` - add application switching, setup banners, gate controls, and JSON config editing.
- `src\routes\dashboard\page-generated.ts` - regenerate from the UI build; never edit manually.
- `FEATURES.md` - document hosts/TLS requirements and the known GPT-5.6 override IDs.

## Task 1: Persistent Statsig Override Store

**Files:**

- Create: `src\routes\statsig-overrides\store.ts`
- Create: `tests\statsig-overrides-store.test.ts`
- Modify: `src\lib\paths.ts`
- Modify: `src\lib\config-export.ts`
- Modify: `tests\dashboard-config-export.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `tests\statsig-overrides-store.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createStatsigOverrideStore,
  StatsigOverrideValidationError,
} from "../src/routes/statsig-overrides/store"

const tempDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function createTempStore() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "copilot-statsig-overrides-"),
  )
  tempDirectories.push(directory)
  return createStatsigOverrideStore(
    path.join(directory, "statsig_overrides.json"),
  )
}

test("stores feature gates and dynamic configs independently", async () => {
  const store = await createTempStore()

  store.set("featureGate", "824038554", true)
  store.set("dynamicConfig", "107580212", {
    available_models: ["gpt-5.6-sol"],
    use_hidden_models: true,
  })

  expect(store.get()).toEqual({
    featureGates: { "824038554": true },
    dynamicConfigs: {
      "107580212": {
        available_models: ["gpt-5.6-sol"],
        use_hidden_models: true,
      },
    },
  })
  expect(store.count()).toBe(2)
})

test("persists overrides for a new store instance", async () => {
  const store = await createTempStore()
  const filePath = store.filePath

  store.set("featureGate", "824038554", true)

  expect(createStatsigOverrideStore(filePath).get()).toEqual({
    featureGates: { "824038554": true },
    dynamicConfigs: {},
  })
})

test("validates override names and values", async () => {
  const store = await createTempStore()

  expect(() => store.set("featureGate", "824038554", "true")).toThrow(
    StatsigOverrideValidationError,
  )
  expect(() => store.set("dynamicConfig", "107580212", [])).toThrow(
    StatsigOverrideValidationError,
  )
  expect(() => store.set("featureGate", "__proto__", true)).toThrow(
    StatsigOverrideValidationError,
  )
  expect(() => store.set("featureGate", "   ", true)).toThrow(
    StatsigOverrideValidationError,
  )
})

test("removes only the requested override kind", async () => {
  const store = await createTempStore()
  store.set("featureGate", "same-name", true)
  store.set("dynamicConfig", "same-name", { enabled: true })

  expect(store.remove("featureGate", "same-name")).toBe(true)
  expect(store.remove("featureGate", "same-name")).toBe(false)
  expect(store.get()).toEqual({
    featureGates: {},
    dynamicConfigs: { "same-name": { enabled: true } },
  })
})
```

- [ ] **Step 2: Extend the config-export test before implementing storage**

In `tests\dashboard-config-export.test.ts`, write `statsig_overrides.json` in the temporary directory and add it to the expected ZIP entries:

```ts
await fs.writeFile(
  path.join(directory, "statsig_overrides.json"),
  '{"featureGates":{"824038554":true},"dynamicConfigs":{}}\n',
)
```

Expected names:

```ts
expect(Object.keys(entries).sort()).toEqual([
  "config.json",
  "ip_allowlist.json",
  "model_settings.json",
  "statsig_overrides.json",
])
```

- [ ] **Step 3: Run the tests and verify they fail**

Run:

```powershell
bun test "tests\statsig-overrides-store.test.ts" "tests\dashboard-config-export.test.ts"
```

Expected: FAIL because `src\routes\statsig-overrides\store.ts` and `STATSIG_OVERRIDES_PATH` do not exist and the export list omits the new file.

- [ ] **Step 4: Add the storage path and export filename**

Add to `src\lib\paths.ts`:

```ts
const STATSIG_OVERRIDES_PATH = path.join(APP_DIR, "statsig_overrides.json")
```

Add `STATSIG_OVERRIDES_PATH` to `PATHS`.

Add `"statsig_overrides.json"` immediately after `"feature_flags.json"` in `CONFIG_EXPORT_FILENAMES` in `src\lib\config-export.ts`.

- [ ] **Step 5: Implement the store**

Create `src\routes\statsig-overrides\store.ts` with this public contract:

```ts
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/paths"

export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigDynamicConfig = Record<string, unknown>

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}

export interface StatsigOverrideStore {
  readonly filePath: string
  get(): StatsigOverrides
  set(
    kind: StatsigOverrideKind,
    name: string,
    value: unknown,
  ): StatsigOverrides
  remove(kind: StatsigOverrideKind, name: string): boolean
  count(): number
  replaceForTest(overrides: StatsigOverrides): void
}

export class StatsigOverrideValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StatsigOverrideValidationError"
  }
}
```

Implement these exact validation rules:

```ts
const UNSAFE_NAMES = new Set(["__proto__", "prototype", "constructor"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new StatsigOverrideValidationError("name is required")
  }
  if (UNSAFE_NAMES.has(normalized)) {
    throw new StatsigOverrideValidationError("name is not allowed")
  }
  return normalized
}

function validateValue(
  kind: StatsigOverrideKind,
  value: unknown,
): boolean | StatsigDynamicConfig {
  if (kind === "featureGate") {
    if (typeof value !== "boolean") {
      throw new StatsigOverrideValidationError(
        "feature gate value must be boolean",
      )
    }
    return value
  }

  if (!isRecord(value)) {
    throw new StatsigOverrideValidationError(
      "dynamic config value must be a JSON object",
    )
  }
  return structuredClone(value)
}
```

`createStatsigOverrideStore(filePath = PATHS.STATSIG_OVERRIDES_PATH)` must:

1. Treat only `ENOENT` as an empty store.
2. Parse and validate both maps when a file exists.
3. Cache the parsed value.
4. Return structured clones from `get()`.
5. Persist formatted JSON with a trailing newline after `set()` and successful `remove()`.
6. Use `path.dirname(filePath)` when creating directories so tests remain isolated.
7. Make `replaceForTest()` replace the cache and disable persistence for that store instance.

Export the production singleton:

```ts
export const statsigOverrideStore = createStatsigOverrideStore()
```

- [ ] **Step 6: Run the targeted tests**

Run:

```powershell
bun test "tests\statsig-overrides-store.test.ts" "tests\dashboard-config-export.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 7: Commit the storage layer**

```powershell
git add -- "src\lib\paths.ts" "src\lib\config-export.ts" "src\routes\statsig-overrides\store.ts" "tests\statsig-overrides-store.test.ts" "tests\dashboard-config-export.test.ts"
git commit -m "feat: add Statsig override storage" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 2: Statsig Protocol Normalization and Overlay

**Files:**

- Create: `src\routes\statsig-overrides\protocol.ts`
- Create: `tests\statsig-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Create `tests\statsig-protocol.test.ts`:

```ts
import { expect, test } from "bun:test"
import { gzipSync, strToU8 } from "fflate"

import {
  applyStatsigOverrides,
  createFullStatsigInitializeRequest,
  decodeStatsigInitializeBody,
  StatsigProtocolError,
} from "../src/routes/statsig-overrides/protocol"

const initializeRequest = {
  user: {
    userID: "ua-test",
    customIDs: { stableID: "stable-test" },
  },
  sinceTime: 123,
  partialUserMatchSinceTime: 123,
  deltasResponseRequested: true,
  full_checksum: "checksum",
  previousDerivedFields: { plan: "logged_out" },
}

function reverseBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").split("").reverse().join("")
}

test("decodes plain Statsig initialization JSON", () => {
  const decoded = decodeStatsigInitializeBody(
    strToU8(JSON.stringify(initializeRequest)),
    { encoded: false, gzipped: false },
  )

  expect(decoded).toEqual(initializeRequest)
})

test("decodes reversed-base64 and gzip in Statsig wire order", () => {
  const encoded = reverseBase64(JSON.stringify(initializeRequest))
  const decoded = decodeStatsigInitializeBody(gzipSync(strToU8(encoded)), {
    encoded: true,
    gzipped: true,
  })

  expect(decoded).toEqual(initializeRequest)
})

test("decodes gzip without reversed-base64 encoding", () => {
  const decoded = decodeStatsigInitializeBody(
    gzipSync(strToU8(JSON.stringify(initializeRequest))),
    { encoded: false, gzipped: true },
  )

  expect(decoded).toEqual(initializeRequest)
})

test("forces a full upstream evaluation without dropping user metadata", () => {
  expect(createFullStatsigInitializeRequest(initializeRequest)).toEqual({
    ...initializeRequest,
    sinceTime: 0,
    partialUserMatchSinceTime: 0,
    deltasResponseRequested: false,
    full_checksum: null,
    previousDerivedFields: {},
  })
})

test("overlays gates and configs while preserving unrelated upstream values", () => {
  const result = applyStatsigOverrides(
    {
      has_updates: true,
      time: 1234,
      feature_gates: {
        unrelated: {
          name: "unrelated",
          rule_id: "upstream",
          secondary_exposures: [],
          value: true,
        },
        "824038554": {
          name: "824038554",
          rule_id: "default",
          secondary_exposures: [{ gate: "dependency", gateValue: "false" }],
          value: false,
          version: 9,
        },
      },
      dynamic_configs: {
        "107580212": {
          name: "107580212",
          rule_id: "default",
          secondary_exposures: [],
          value: { available_models: ["gpt-5.5"] },
          version: 22,
        },
      },
      layer_configs: {},
    },
    {
      featureGates: {
        "824038554": true,
        new_gate: false,
      },
      dynamicConfigs: {
        "107580212": {
          available_models: ["gpt-5.6-sol"],
          use_hidden_models: true,
        },
        new_config: { enabled: true },
      },
    },
  )

  expect(result.feature_gates.unrelated.value).toBe(true)
  expect(result.feature_gates["824038554"]).toMatchObject({
    name: "824038554",
    rule_id: "default",
    secondary_exposures: [{ gate: "dependency", gateValue: "false" }],
    value: true,
    version: 9,
  })
  expect(result.feature_gates.new_gate).toMatchObject({
    name: "new_gate",
    rule_id: "copilot-api-override",
    secondary_exposures: [],
    value: false,
  })
  expect(result.dynamic_configs["107580212"]).toMatchObject({
    name: "107580212",
    rule_id: "default",
    secondary_exposures: [],
    value: {
      available_models: ["gpt-5.6-sol"],
      use_hidden_models: true,
    },
    version: 22,
  })
  expect(result.dynamic_configs.new_config.value).toEqual({ enabled: true })
})

test("rejects malformed, delta, and init-v2 responses", () => {
  expect(() => applyStatsigOverrides({}, {
    featureGates: { gate: true },
    dynamicConfigs: {},
  })).toThrow(StatsigProtocolError)

  expect(() => applyStatsigOverrides({
    has_updates: true,
    is_delta: true,
    feature_gates: {},
    dynamic_configs: {},
  }, {
    featureGates: { gate: true },
    dynamicConfigs: {},
  })).toThrow(StatsigProtocolError)

  expect(() => applyStatsigOverrides({
    has_updates: true,
    response_format: "init-v2",
    feature_gates: {},
    dynamic_configs: {},
  }, {
    featureGates: { gate: true },
    dynamicConfigs: {},
  })).toThrow(StatsigProtocolError)
})
```

- [ ] **Step 2: Run the protocol tests and verify they fail**

Run:

```powershell
bun test "tests\statsig-protocol.test.ts"
```

Expected: FAIL because the protocol module does not exist.

- [ ] **Step 3: Implement request decoding**

Create `src\routes\statsig-overrides\protocol.ts` and export:

```ts
import { gunzipSync, strFromU8 } from "fflate"

import type { StatsigOverrides } from "./store"

export class StatsigProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StatsigProtocolError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function decodeStatsigInitializeBody(
  body: Uint8Array,
  options: { encoded: boolean; gzipped: boolean },
): Record<string, unknown> {
  try {
    const decompressed = options.gzipped ? gunzipSync(body) : body
    const wireText = strFromU8(decompressed)
    const jsonText =
      options.encoded ?
        Buffer.from(wireText.split("").reverse().join(""), "base64").toString(
          "utf8",
        )
      : wireText
    const parsed: unknown = JSON.parse(jsonText)
    if (!isRecord(parsed)) {
      throw new StatsigProtocolError(
        "Statsig initialization body must be a JSON object",
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof StatsigProtocolError) throw error
    throw new StatsigProtocolError("Invalid Statsig initialization body")
  }
}

export function createFullStatsigInitializeRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    sinceTime: 0,
    partialUserMatchSinceTime: 0,
    deltasResponseRequested: false,
    full_checksum: null,
    previousDerivedFields: {},
  }
}
```

- [ ] **Step 4: Implement V1 overlay behavior**

Add a typed return shape and `applyStatsigOverrides()`:

```ts
export interface StatsigV1InitializeResponse extends Record<string, unknown> {
  has_updates: true
  feature_gates: Record<string, Record<string, unknown>>
  dynamic_configs: Record<string, Record<string, unknown>>
}

function requireEvaluationMap(
  response: Record<string, unknown>,
  key: "feature_gates" | "dynamic_configs",
): Record<string, Record<string, unknown>> {
  const value = response[key]
  if (!isRecord(value)) {
    throw new StatsigProtocolError(`Statsig response is missing ${key}`)
  }
  return value as Record<string, Record<string, unknown>>
}

export function applyStatsigOverrides(
  input: unknown,
  overrides: StatsigOverrides,
): StatsigV1InitializeResponse {
  if (!isRecord(input) || input.has_updates !== true) {
    throw new StatsigProtocolError(
      "Statsig response is not a full initialization payload",
    )
  }
  if (
    input.is_delta === true
    || (typeof input.response_format === "string"
      && input.response_format !== "init-v1")
  ) {
    throw new StatsigProtocolError(
      "Statsig response format does not support local overrides",
    )
  }

  const response = structuredClone(input)
  const featureGates = requireEvaluationMap(response, "feature_gates")
  const dynamicConfigs = requireEvaluationMap(response, "dynamic_configs")

  for (const [name, value] of Object.entries(overrides.featureGates)) {
    const existing = featureGates[name]
    featureGates[name] =
      isRecord(existing) ?
        { ...existing, value }
      : {
          name,
          rule_id: "copilot-api-override",
          secondary_exposures: [],
          value,
        }
  }

  for (const [name, value] of Object.entries(overrides.dynamicConfigs)) {
    const existing = dynamicConfigs[name]
    dynamicConfigs[name] =
      isRecord(existing) ?
        { ...existing, value: structuredClone(value) }
      : {
          name,
          rule_id: "copilot-api-override",
          secondary_exposures: [],
          value: structuredClone(value),
        }
  }

  return response as StatsigV1InitializeResponse
}
```

- [ ] **Step 5: Run the protocol tests**

Run:

```powershell
bun test "tests\statsig-protocol.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the protocol layer**

```powershell
git add -- "src\routes\statsig-overrides\protocol.ts" "tests\statsig-protocol.test.ts"
git commit -m "feat: normalize Statsig initialization payloads" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 3: Shared HTTP Proxy Helpers

**Files:**

- Create: `src\lib\proxy-http.ts`
- Modify: `src\lib\transparent-proxy.ts`
- Test: `tests\transparent-proxy.test.ts`

- [ ] **Step 1: Establish the proxy regression baseline**

Run:

```powershell
bun test "tests\transparent-proxy.test.ts"
```

Expected: all existing transparent-proxy tests PASS.

- [ ] **Step 2: Extract shared host and header helpers**

Create `src\lib\proxy-http.ts` by moving the existing hop-by-hop and decoded-body header logic out of `transparent-proxy.ts`. Export:

```ts
export function normalizeProxyHost(
  host: string | undefined,
): string | null

export function createProxyRequestHeaders(request: Request): Headers

export function createProxyResponseHeaders(headers: Headers): Headers
```

The implementations must preserve current behavior:

```ts
export function normalizeProxyHost(
  host: string | undefined,
): string | null {
  if (!host) return null
  const trimmed = host.trim().toLowerCase()
  if (!trimmed) return null
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  return trimmed.split(":")[0] ?? null
}
```

`createProxyRequestHeaders()` must remove hop-by-hop headers, `content-length`, and `host`, then set `accept-encoding: identity`.

`createProxyResponseHeaders()` must remove hop-by-hop headers and remove `content-encoding`, `content-length`, and `content-md5` whenever the upstream response carried `content-encoding`.

- [ ] **Step 3: Update the Anthropic transparent proxy**

Replace its private normalization/header helpers with imports from `~/lib/proxy-http`. Do not add `ab.chatgpt.com` to `TRANSPARENT_PROXY_HOSTS`; Statsig traffic has a separate pre-auth middleware.

- [ ] **Step 4: Run the regression test**

Run:

```powershell
bun test "tests\transparent-proxy.test.ts"
```

Expected: all tests PASS with no changed assertions.

- [ ] **Step 5: Commit the refactor**

```powershell
git add -- "src\lib\proxy-http.ts" "src\lib\transparent-proxy.ts"
git commit -m "refactor: share HTTP proxy header handling" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 4: Allowlisted Statsig Proxy Middleware

**Files:**

- Create: `src\routes\statsig-overrides\proxy.ts`
- Create: `tests\statsig-proxy.test.ts`
- Modify: `src\server.ts`
- Modify: `src\lib\sentry.ts`
- Modify: `tests\sentry.test.ts`

- [ ] **Step 1: Write failing middleware tests**

Create `tests\statsig-proxy.test.ts` with a local Hono app and injected dependencies:

```ts
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"

import { setIpAllowlistForTest } from "../src/lib/ip-allowlist"
import { state } from "../src/lib/state"
import {
  createStatsigProxyMiddleware,
} from "../src/routes/statsig-overrides/proxy"
import type { StatsigOverrides } from "../src/routes/statsig-overrides/store"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth
const originalDebug = state.debug
const clientIp = "198.51.100.70"

beforeEach(() => {
  state.apiKeyAuth = "dashboard-secret"
  setIpAllowlistForTest([
    {
      ip: clientIp,
      enabled: true,
      source: "manual",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
  ])
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
  state.debug = originalDebug
})

function createApp(
  fetchImpl: typeof fetch,
  overrides: StatsigOverrides = {
    featureGates: {},
    dynamicConfigs: {},
  },
) {
  const app = new Hono()
  app.use(
    "*",
    createStatsigProxyMiddleware({
      fetchImpl,
      getOverrides: () => structuredClone(overrides),
    }),
  )
  app.all("*", (c) => c.text("next"))
  return app
}

test("ignores requests for other hosts", async () => {
  const fetchMock = mock(() => Promise.resolve(new Response("unexpected")))
  const response = await createApp(fetchMock as unknown as typeof fetch).request(
    "/v1/initialize",
    { headers: { host: "localhost" } },
  )

  expect(response.status).toBe(200)
  expect(await response.text()).toBe("next")
  expect(fetchMock).not.toHaveBeenCalled()
})

test("hides Statsig endpoints from non-allowlisted clients", async () => {
  setIpAllowlistForTest([])
  const fetchMock = mock(() => Promise.resolve(new Response("unexpected")))
  const response = await createApp(fetchMock as unknown as typeof fetch).request(
    "/v1/initialize",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "x-forwarded-for": clientIp,
      },
      body: "{}",
    },
  )

  expect(response.status).toBe(404)
  expect(fetchMock).not.toHaveBeenCalled()
})

test("normalizes Statsig host case and port", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(new Response("proxied", { status: 202 })),
  )
  const response = await createApp(
    fetchMock as unknown as typeof fetch,
  ).request("/v1/rgstr?k=client-test", {
    method: "POST",
    headers: {
      host: "AB.CHATGPT.COM:443",
      "x-forwarded-for": clientIp,
    },
    body: '{"events":[]}',
  })

  expect(response.status).toBe(202)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test("protocol-relative paths cannot replace the Statsig upstream origin", async () => {
  const fetchMock = mock((url: string | URL | Request) =>
    Promise.resolve(new Response(String(url), { status: 202 })),
  )
  const response = await createApp(
    fetchMock as unknown as typeof fetch,
  ).request("https://gateway.test//evil.example/v1/rgstr?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: '{"events":[]}',
  })

  expect(response.status).toBe(202)
  const upstreamUrl = new URL(await response.text())
  expect(upstreamUrl.hostname).toBe("ab.chatgpt.com")
  expect(upstreamUrl.pathname).toBe("//evil.example/v1/rgstr")
})

test("proxies non-initialization Statsig requests unchanged", async () => {
  const fetchMock = mock((url: string | URL | Request) =>
    Promise.resolve(
      new Response(String(url), {
        status: 202,
        headers: { "x-upstream": "statsig" },
      }),
    ),
  )
  const response = await createApp(fetchMock as unknown as typeof fetch).request(
    "/v1/rgstr?k=client-test",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "x-forwarded-for": clientIp,
      },
      body: '{"events":[]}',
    },
  )

  expect(response.status).toBe(202)
  expect(response.headers.get("x-upstream")).toBe("statsig")
  expect(await response.text()).toBe(
    "https://ab.chatgpt.com/v1/rgstr?k=client-test",
  )
})

test("forces a full initialization and overlays configured values", async () => {
  const fetchMock = mock(
    (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(request).toMatchObject({
        sinceTime: 0,
        partialUserMatchSinceTime: 0,
        deltasResponseRequested: false,
        full_checksum: null,
        previousDerivedFields: {},
      })
      return Promise.resolve(
        Response.json({
          has_updates: true,
          time: 1234,
          feature_gates: {
            unrelated: {
              name: "unrelated",
              rule_id: "upstream",
              secondary_exposures: [],
              value: true,
            },
          },
          dynamic_configs: {},
          layer_configs: {},
        }),
      )
    },
  )

  const response = await createApp(
    fetchMock as unknown as typeof fetch,
    {
      featureGates: { "824038554": true },
      dynamicConfigs: {
        "107580212": {
          available_models: ["gpt-5.6-sol"],
          use_hidden_models: true,
        },
      },
    },
  ).request("/v1/initialize?k=client-test&se=1", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: Buffer.from(
      JSON.stringify({
        user: { userID: "ua-test" },
        sinceTime: 100,
        deltasResponseRequested: true,
      }),
    )
      .toString("base64")
      .split("")
      .reverse()
      .join(""),
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    feature_gates: Record<string, { value: boolean }>
    dynamic_configs: Record<string, { value: Record<string, unknown> }>
  }
  expect(body.feature_gates.unrelated.value).toBe(true)
  expect(body.feature_gates["824038554"].value).toBe(true)
  expect(body.dynamic_configs["107580212"].value).toEqual({
    available_models: ["gpt-5.6-sol"],
    use_hidden_models: true,
  })

  const upstreamUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
  expect(upstreamUrl.searchParams.get("k")).toBe("client-test")
  expect(upstreamUrl.searchParams.has("se")).toBe(false)
  expect(upstreamUrl.searchParams.has("gz")).toBe(false)
})

test("returns explicit errors for invalid bodies and failed upstream fetches", async () => {
  const neverFetch = mock(() => Promise.resolve(new Response("unexpected")))
  const invalidResponse = await createApp(
    neverFetch as unknown as typeof fetch,
  ).request("/v1/initialize?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: "not-json",
  })
  expect(invalidResponse.status).toBe(400)
  expect(neverFetch).not.toHaveBeenCalled()

  const failingFetch = mock(() => Promise.reject(new Error("offline")))
  const upstreamResponse = await createApp(
    failingFetch as unknown as typeof fetch,
  ).request("/v1/rgstr?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: "{}",
  })
  expect(upstreamResponse.status).toBe(502)
})

test("Statsig handling runs before the API-key silent-drop guard", async () => {
  setIpAllowlistForTest([])
  const response = await server.request("/v1/initialize?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: "{}",
  })

  expect(response.status).toBe(404)
})

test("Statsig traffic never enters the request logger", async () => {
  setIpAllowlistForTest([])
  state.debug = true
  const consoleSpy = spyOn(console, "log").mockImplementation(() => {})

  try {
    const response = await server.request(
      "/v1/initialize?k=client-logger-test",
      {
        method: "POST",
        headers: {
          host: "ab.chatgpt.com",
          "x-forwarded-for": clientIp,
        },
        body: '{"user":{"private_marker":"must-not-be-logged"}}',
      },
    )

    expect(response.status).toBe(404)
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      "client-logger-test",
    )
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      "must-not-be-logged",
    )
  } finally {
    consoleSpy.mockRestore()
    state.debug = originalDebug
  }
})
```

Also add focused tests for:

```ts
test("passes upstream 401 responses through unchanged", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(Response.json({ message: "unauthorized" }, { status: 401 })),
  )
  const response = await createApp(fetchMock as unknown as typeof fetch).request(
    "/v1/initialize?k=invalid",
    {
      method: "POST",
      headers: {
        host: "ab.chatgpt.com",
        "x-forwarded-for": clientIp,
      },
      body: JSON.stringify({ user: { userID: "ua-test" } }),
    },
  )
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ message: "unauthorized" })
})

test("returns 502 for malformed successful initialization responses", async () => {
  const fetchMock = mock(() =>
    Promise.resolve(Response.json({ has_updates: false })),
  )
  const response = await createApp(
    fetchMock as unknown as typeof fetch,
  ).request("/v1/initialize?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify({ user: { userID: "ua-test" } }),
  })
  expect(response.status).toBe(502)
})

test("returns a successful upstream payload byte-for-byte when no overrides exist", async () => {
  const upstreamBody = JSON.stringify({
    has_updates: true,
    feature_gates: {},
    dynamic_configs: {},
    layer_configs: {},
    time: 1234,
  })
  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(upstreamBody, {
        headers: { "content-type": "application/json" },
      }),
    ),
  )
  const response = await createApp(
    fetchMock as unknown as typeof fetch,
  ).request("/v1/initialize?k=client-test", {
    method: "POST",
    headers: {
      host: "ab.chatgpt.com",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify({ user: { userID: "ua-test" } }),
  })

  expect(response.status).toBe(200)
  expect(await response.text()).toBe(upstreamBody)
})
```

- [ ] **Step 2: Run the proxy tests and verify they fail**

Run:

```powershell
bun test "tests\statsig-proxy.test.ts"
```

Expected: FAIL because the middleware does not exist and `src\server.ts` has no pre-auth Statsig registration.

- [ ] **Step 3: Implement the middleware**

Create `src\routes\statsig-overrides\proxy.ts` with:

```ts
import type { MiddlewareHandler } from "hono"

import consola from "consola"

import { extractClientIp, isIpAllowedForWhitelistedRoute } from "~/lib/ip-blocker"
import {
  createProxyRequestHeaders,
  createProxyResponseHeaders,
  normalizeProxyHost,
} from "~/lib/proxy-http"

import {
  applyStatsigOverrides,
  createFullStatsigInitializeRequest,
  decodeStatsigInitializeBody,
  StatsigProtocolError,
} from "./protocol"
import { statsigOverrideStore, type StatsigOverrides } from "./store"

const STATSIG_HOST = "ab.chatgpt.com"
const STATSIG_ORIGIN = `https://${STATSIG_HOST}`

export interface StatsigProxyDependencies {
  fetchImpl?: typeof fetch
  getOverrides?: () => StatsigOverrides
}

export function createStatsigProxyMiddleware(
  dependencies: StatsigProxyDependencies = {},
): MiddlewareHandler

export const statsigProxyMiddleware = createStatsigProxyMiddleware()
```

The middleware must follow this exact order:

1. If `normalizeProxyHost(c.req.header("host")) !== STATSIG_HOST`, call `next()`.
2. Resolve the client IP with `extractClientIp`.
3. Return `c.notFound()` unless `isIpAllowedForWhitelistedRoute(ip)` succeeds.
4. For `POST /v1/initialize`, call the initialization handler.
5. For every other method/path, proxy the raw request to `STATSIG_ORIGIN`.

For initialization:

```ts
const sourceUrl = new URL(c.req.url)
const upstreamUrl = new URL(STATSIG_ORIGIN)
upstreamUrl.pathname = sourceUrl.pathname
upstreamUrl.search = sourceUrl.search
const encoded = upstreamUrl.searchParams.get("se") === "1"
const gzipped = upstreamUrl.searchParams.get("gz") === "1"
const decoded = decodeStatsigInitializeBody(
  new Uint8Array(await c.req.arrayBuffer()),
  { encoded, gzipped },
)
const upstreamBody = createFullStatsigInitializeRequest(decoded)
upstreamUrl.searchParams.delete("se")
upstreamUrl.searchParams.delete("gz")
```

Use the same fixed-origin construction for non-initialization requests. Never pass a path string to the `URL` constructor with `STATSIG_ORIGIN` as a base, because a path beginning with `//` would replace the hostname.

Send normalized JSON using `createProxyRequestHeaders`, deleting `content-encoding` and setting `content-type: application/json`.

If upstream status is outside 200-299, return the upstream body/status/headers unchanged. If no overrides are configured, return the successful upstream body unchanged. Otherwise parse JSON, call `applyStatsigOverrides`, and return the modified JSON. Before returning modified JSON, remove `content-length`, `content-encoding`, and `content-md5` from the copied upstream response headers and set `content-type: application/json`.

Always parse and validate a successful initialization response with `applyStatsigOverrides()`, even when both override maps are empty. When they are empty, discard the validated clone and return the original upstream text so valid no-override responses remain byte-for-byte unchanged. This ensures malformed, delta, and unsupported response formats still return 502 instead of silently passing through.

Every upstream `fetch()` call must set `redirect: "manual"` so 3xx responses can be passed through unchanged.

Catch `StatsigProtocolError` from request decoding as status 400. Treat overlay/parsing errors after a successful upstream response as 502. Treat fetch failures as 502. Never log the raw fetch error because Bun error objects may contain the full upstream URL and `k` query parameter. Log a fixed message plus sanitized fields only:

```ts
function getSafeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError"
}

consola.error("[statsig-proxy] upstream request failed", {
  method,
  path: sourceUrl.pathname,
  errorName: getSafeErrorName(error),
})
```

Do not log the client key, query string, request body, raw error message, stack, cause, or error object.

- [ ] **Step 4: Register middleware before authentication**

In `src\server.ts`, import `statsigProxyMiddleware` and register it before every logging or authentication middleware:

```ts
server.use("*", statsigProxyMiddleware)
server.use(requestLogger)
server.use(cors())
```

Move the existing `requestLogger` and `cors` registrations below the Statsig registration. Statsig requests must return from the proxy without entering `requestLogger`, because debug logging captures request bodies and normal logging includes query strings containing the public client key. Non-Statsig hosts call `next()` and retain the current logger/CORS behavior.

- [ ] **Step 5: Add Sentry redaction tests**

In `tests\sentry.test.ts`, import `scrubStatsigClientKeyData` and add:

```ts
test("scrubs Statsig client keys from Sentry payload shapes", () => {
  const payload = {
    request: {
      url: "https://ab.chatgpt.com/v1/initialize?k=client-secret&st=js",
    },
    spans: [
      {
        description:
          "POST https://ab.chatgpt.com/v1/initialize?k=client-secret",
        data: {
          "url.full":
            "https://ab.chatgpt.com/v1/initialize?k=client-secret&st=js",
          "server.address": "ab.chatgpt.com",
          "url.query": "k=client-secret&st=js",
        },
      },
    ],
    breadcrumbs: [
      {
        data: {
          url: "https://ab.chatgpt.com/v1/rgstr?k=client-secret",
        },
      },
    ],
    message:
      "request https://example.com/path?k=unrelated-client-value failed",
  }

  scrubStatsigClientKeyData(payload)

  const serialized = JSON.stringify(payload)
  expect(serialized).not.toContain("client-secret")
  expect(serialized).toContain("k=[Filtered]")
  expect(serialized).toContain("k=unrelated-client-value")
})
```

- [ ] **Step 6: Implement Sentry payload redaction**

In `src\lib\sentry.ts`, add a recursive, in-place scrubber:

```ts
const STATSIG_HOST = "ab.chatgpt.com"
const STATSIG_CLIENT_KEY_PATTERN =
  /((?:^|[?&])k=)[^&#\s"'<>]+/gi

function redactStatsigClientKey(
  value: string,
  statsigContext: boolean,
): string {
  if (
    !statsigContext
    && !value.toLowerCase().includes(STATSIG_HOST)
  ) {
    return value
  }
  return value.replace(STATSIG_CLIENT_KEY_PATTERN, "$1[Filtered]")
}

export function scrubStatsigClientKeyData(
  value: unknown,
  seen = new WeakSet<object>(),
  inheritedStatsigContext = false,
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index]
      if (typeof item === "string") {
        value[index] = redactStatsigClientKey(
          item,
          inheritedStatsigContext,
        )
      } else {
        scrubStatsigClientKeyData(item, seen, inheritedStatsigContext)
      }
    }
    return
  }

  const entries = Object.entries(value)
  const statsigContext =
    inheritedStatsigContext
    || entries.some(
      ([, item]) =>
        typeof item === "string"
        && item.toLowerCase().includes(STATSIG_HOST),
    )

  for (const [key, item] of entries) {
    if (typeof item === "string") {
      ;(value as Record<string, unknown>)[key] =
        redactStatsigClientKey(item, statsigContext)
    } else {
      scrubStatsigClientKeyData(item, seen, statsigContext)
    }
  }
}
```

Call `scrubStatsigClientKeyData(event)` inside the existing `scrubSensitiveData()`.

Add all four Sentry hooks:

```ts
beforeSend(event) {
  return scrubSensitiveData(event)
},
beforeSendTransaction(event) {
  return scrubSensitiveData(event)
},
beforeSendSpan(span) {
  scrubStatsigClientKeyData(span)
  return span
},
beforeSendLog(log) {
  scrubStatsigClientKeyData(log)
  return log
},
```

This covers inbound request events, transaction payloads, streamed outbound fetch spans, breadcrumbs, and Sentry logs. Sentry may split a URL into sibling fields such as `server.address: "ab.chatgpt.com"` and `url.query: "k=..."`; the local object context must therefore trigger redaction in sibling and nested strings. Do not propagate that context across unrelated sibling objects, so unrelated `k` query parameters elsewhere in the event remain unchanged.

- [ ] **Step 7: Run proxy, Sentry, and Anthropic regression tests**

Run:

```powershell
bun test "tests\statsig-proxy.test.ts" "tests\statsig-protocol.test.ts" "tests\transparent-proxy.test.ts" "tests\sentry.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 8: Commit the proxy and telemetry redaction**

```powershell
git add -- "src\routes\statsig-overrides\proxy.ts" "src\server.ts" "src\lib\sentry.ts" "tests\statsig-proxy.test.ts" "tests\sentry.test.ts"
git commit -m "feat: proxy and overlay Codex Statsig flags" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 5: Dashboard Statsig Override API

**Files:**

- Create: `tests\dashboard-statsig-overrides.test.ts`
- Modify: `src\routes\dashboard\api.ts`
- Modify: `src\routes\dashboard\route.ts`

- [ ] **Step 1: Write failing dashboard API tests**

Create `tests\dashboard-statsig-overrides.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { getFeatureFlags } from "../src/routes/feature-flags/store"
import { statsigOverrideStore } from "../src/routes/statsig-overrides/store"
import { server } from "../src/server"

const originalApiKeyAuth = state.apiKeyAuth

beforeEach(() => {
  state.apiKeyAuth = "dashboard-secret"
  statsigOverrideStore.replaceForTest({
    featureGates: {},
    dynamicConfigs: {},
  })
})

afterAll(() => {
  state.apiKeyAuth = originalApiKeyAuth
})

const authHeaders = {
  "content-type": "application/json",
  "x-api-key": "dashboard-secret",
}

test("Statsig override API is authenticated", async () => {
  const response = await server.request(
    "/dashboard/api/statsig-overrides",
  )
  expect(response.status).toBe(401)
})

test("dashboard can add, list, and remove both override kinds", async () => {
  const gateResponse = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        kind: "featureGate",
        name: "824038554",
        value: true,
      }),
    },
  )
  expect(gateResponse.status).toBe(200)

  const configResponse = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        kind: "dynamicConfig",
        name: "107580212",
        value: {
          available_models: ["gpt-5.6-sol"],
          use_hidden_models: true,
        },
      }),
    },
  )
  expect(configResponse.status).toBe(200)

  const listResponse = await server.request(
    "/dashboard/api/statsig-overrides",
    { headers: { "x-api-key": "dashboard-secret" } },
  )
  expect(await listResponse.json()).toEqual({
    featureGates: { "824038554": true },
    dynamicConfigs: {
      "107580212": {
        available_models: ["gpt-5.6-sol"],
        use_hidden_models: true,
      },
    },
  })

  const deleteResponse = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({
        kind: "featureGate",
        name: "824038554",
      }),
    },
  )
  expect(deleteResponse.status).toBe(200)
  expect(statsigOverrideStore.get().featureGates).toEqual({})
})

test("dashboard rejects invalid kinds and values", async () => {
  const invalidKind = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        kind: "experiment",
        name: "gate",
        value: true,
      }),
    },
  )
  expect(invalidKind.status).toBe(400)

  const invalidValue = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        kind: "dynamicConfig",
        name: "107580212",
        value: "not-an-object",
      }),
    },
  )
  expect(invalidValue.status).toBe(400)
})

test("overview counts Claude and Statsig flags", async () => {
  statsigOverrideStore.replaceForTest({
    featureGates: { gate: true },
    dynamicConfigs: { config: { enabled: true } },
  })

  const response = await server.request("/dashboard/api/overview", {
    headers: { "x-api-key": "dashboard-secret" },
  })
  const body = (await response.json()) as { flagsCount: number }

  expect(body.flagsCount).toBe(Object.keys(getFeatureFlags()).length + 2)
})

test("existing Claude Code flag endpoint remains unchanged", async () => {
  const response = await server.request("/dashboard/api/flags", {
    headers: { "x-api-key": "dashboard-secret" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(getFeatureFlags())
})
```

Add a missing-delete assertion:

```ts
test("deleting an unknown Statsig override returns 404", async () => {
  const response = await server.request(
    "/dashboard/api/statsig-overrides",
    {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({ kind: "featureGate", name: "missing" }),
    },
  )
  expect(response.status).toBe(404)
})
```

- [ ] **Step 2: Run the dashboard tests and verify they fail**

Run:

```powershell
bun test "tests\dashboard-statsig-overrides.test.ts"
```

Expected: FAIL with 404 responses because the endpoint is not registered.

- [ ] **Step 3: Add dashboard handlers**

In `src\routes\dashboard\api.ts`, import:

```ts
import {
  StatsigOverrideValidationError,
  statsigOverrideStore,
  type StatsigOverrideKind,
} from "~/routes/statsig-overrides/store"
```

Add:

```ts
function isStatsigOverrideKind(
  value: unknown,
): value is StatsigOverrideKind {
  return value === "featureGate" || value === "dynamicConfig"
}

export function handleListStatsigOverrides(c: Context) {
  return c.json(statsigOverrideStore.get())
}

export async function handleSetStatsigOverride(c: Context) {
  const body = await c.req.json<{
    kind?: unknown
    name?: unknown
    value?: unknown
  }>()
  if (!isStatsigOverrideKind(body.kind)) {
    return c.json({ error: "kind must be featureGate or dynamicConfig" }, 400)
  }
  if (typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  try {
    statsigOverrideStore.set(body.kind, body.name, body.value)
    return c.json({ success: true })
  } catch (error) {
    if (error instanceof StatsigOverrideValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}

export async function handleDeleteStatsigOverride(c: Context) {
  const body = await c.req.json<{ kind?: unknown; name?: unknown }>()
  if (!isStatsigOverrideKind(body.kind)) {
    return c.json({ error: "kind must be featureGate or dynamicConfig" }, 400)
  }
  if (typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400)
  }

  try {
    if (!statsigOverrideStore.remove(body.kind, body.name)) {
      return c.json({ error: "Override not found" }, 404)
    }
    return c.json({ success: true })
  } catch (error) {
    if (error instanceof StatsigOverrideValidationError) {
      return c.json({ error: error.message }, 400)
    }
    throw error
  }
}
```

Update `handleOverview()`:

```ts
const statsigOverrides = statsigOverrideStore.get()
const statsigFlagCount =
  Object.keys(statsigOverrides.featureGates).length
  + Object.keys(statsigOverrides.dynamicConfigs).length
```

Return:

```ts
flagsCount: Object.keys(flags).length + statsigFlagCount,
```

- [ ] **Step 4: Register dashboard routes**

Import the three new handlers in `src\routes\dashboard\route.ts`, then add immediately after the existing `/api/flags` routes:

```ts
dashboardRoutes.get(
  "/api/statsig-overrides",
  handleListStatsigOverrides,
)
dashboardRoutes.post(
  "/api/statsig-overrides",
  handleSetStatsigOverride,
)
dashboardRoutes.delete(
  "/api/statsig-overrides",
  handleDeleteStatsigOverride,
)
```

- [ ] **Step 5: Run dashboard and store tests**

Run:

```powershell
bun test "tests\dashboard-statsig-overrides.test.ts" "tests\statsig-overrides-store.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the dashboard API**

```powershell
git add -- "src\routes\dashboard\api.ts" "src\routes\dashboard\route.ts" "tests\dashboard-statsig-overrides.test.ts"
git commit -m "feat: manage Statsig overrides from dashboard API" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 6: Feature Flags Dashboard Application Switcher

**Files:**

- Modify: `ui\src\lib\types.ts`
- Modify: `ui\src\screens\Flags.tsx`
- Modify (generated): `src\routes\dashboard\page-generated.ts`
- Modify: `tests\dashboard-statsig-overrides.test.ts`

- [ ] **Step 1: Add failing generated-bundle assertions**

Append to `tests\dashboard-statsig-overrides.test.ts`:

```ts
import { DASHBOARD_HTML } from "../src/routes/dashboard/page-generated"

test("dashboard bundle exposes ChatGPT Statsig controls and setup guidance", () => {
  expect(DASHBOARD_HTML).toContain("ChatGPT / Codex")
  expect(DASHBOARD_HTML).toContain("/dashboard/api/statsig-overrides")
  expect(DASHBOARD_HTML).toContain("ab.chatgpt.com")
  expect(DASHBOARD_HTML).toContain("api.anthropic.com")
})
```

- [ ] **Step 2: Run the bundle assertion and verify it fails**

Run:

```powershell
bun test "tests\dashboard-statsig-overrides.test.ts"
```

Expected: the API tests pass, but the generated-bundle assertion FAILS because the UI has no ChatGPT controls.

- [ ] **Step 3: Add dashboard payload types**

In `ui\src\lib\types.ts`, add:

```ts
export type FlagApplication = "claudeCode" | "chatgptCodex"
export type StatsigOverrideKind = "featureGate" | "dynamicConfig"
export type StatsigDynamicConfig = Record<string, unknown>

export interface StatsigOverrides {
  featureGates: Record<string, boolean>
  dynamicConfigs: Record<string, StatsigDynamicConfig>
}
```

- [ ] **Step 4: Refactor the Flags screen data model**

In `ui\src\screens\Flags.tsx`:

1. Import `CodeBlock`, `Heading`, and `TextArea`.
2. Import the new types.
3. Add application state:

```ts
const [application, setApplication] =
  useState<FlagApplication>("claudeCode")
```

4. Replace the fixed loader with:

```ts
type FlagScreenData =
  | { application: "claudeCode"; flags: FlagsMap }
  | { application: "chatgptCodex"; overrides: StatsigOverrides }

async function loadFlagData(
  application: FlagApplication,
): Promise<FlagScreenData> {
  if (application === "claudeCode") {
    return {
      application,
      flags: await get<FlagsMap>("/dashboard/api/flags"),
    }
  }
  return {
    application,
    overrides: await get<StatsigOverrides>(
      "/dashboard/api/statsig-overrides",
    ),
  }
}
```

Call `useAsyncData(() => loadFlagData(application), [application])`.

5. Extend each row with a stable kind:

```ts
interface FlagRow extends Record<string, unknown> {
  id: string
  kind: "claudeFlag" | StatsigOverrideKind
  name: string
  value: FlagValue
}
```

Build Claude rows from `data.flags`. Build Statsig gate rows from `featureGates` and config rows from `dynamicConfigs`. Use `${kind}:${name}` as `id`.

- [ ] **Step 5: Add the application selector and setup banner**

Place a labeled `Selector` in `Page.actions` before the Add button:

```tsx
<Selector
  label="Application"
  size="sm"
  value={application}
  options={[
    { value: "claudeCode", label: "Claude Code" },
    { value: "chatgptCodex", label: "ChatGPT / Codex" },
  ]}
  onChange={(value) => setApplication(value as FlagApplication)}
/>
```

Add a setup banner as the first page child. Use a separate dismissal key per application:

```ts
const setupStorageKey = `feature-flags-setup-dismissed:${application}`
const [showSetup, setShowSetup] = useState(
  () => localStorage.getItem(setupStorageKey) !== "1",
)

useEffect(() => {
  setShowSetup(localStorage.getItem(setupStorageKey) !== "1")
}, [setupStorageKey])
```

Render:

```tsx
{showSetup ?
  <Banner
    status="info"
    title={
      application === "claudeCode" ?
        "Redirect Claude Code feature traffic"
      : "Redirect Codex Statsig traffic"
    }
    description="Add these entries on the client machine and use a TLS certificate trusted by that client."
    isDismissable
    onDismiss={() => {
      localStorage.setItem(setupStorageKey, "1")
      setShowSetup(false)
    }}
    defaultIsExpanded
  >
    <CodeBlock
      language="plaintext"
      code={
        application === "claudeCode" ?
          [
            "<server-ip> api.anthropic.com",
            "<server-ip> claude.ai",
            "<server-ip> platform.claude.com",
          ].join("\n")
        : "<server-ip> ab.chatgpt.com"
      }
    />
  </Banner>
: null}
```

For ChatGPT / Codex, append this sentence to the description:

```text
Nginx must serve ab.chatgpt.com and preserve Host: ab.chatgpt.com. The certificate SAN must include ab.chatgpt.com, and the copilot-api server itself must resolve that hostname to the real upstream service.
```

- [ ] **Step 6: Make the dialog type-aware**

Extend the dialog state with:

```ts
kind: "claudeFlag" | StatsigOverrideKind
```

For Claude Code, preserve the existing boolean/string/number selector and behavior.

For ChatGPT / Codex:

1. Show a `Selector` with `Feature gate` and `Dynamic config` when adding.
2. Disable kind changes while editing.
3. Render a `Switch` for feature gates.
4. Render a `TextArea` with `rows={12}` and `hasSpellCheck={false}` for dynamic configs.
5. Pretty-print initial JSON with `JSON.stringify(value, null, 2)`.
6. Validate that parsed JSON is a non-null, non-array object:

```ts
function parseDynamicConfig(
  text: string,
): { value?: Record<string, unknown>; error?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      return { error: "Dynamic config must be a JSON object" }
    }
    return { value: parsed as Record<string, unknown> }
  } catch {
    return { error: "Enter valid JSON" }
  }
}
```

Pass the error through `TextArea.status` and disable Save until valid.

- [ ] **Step 7: Route actions to the correct endpoint**

Use these request shapes:

```ts
await post("/dashboard/api/statsig-overrides", {
  kind,
  name,
  value,
})
```

```ts
await del("/dashboard/api/statsig-overrides", {
  kind,
  name,
})
```

Keep `/dashboard/api/flags` unchanged for Claude Code. Toggle controls appear for Claude boolean flags and Statsig feature gates. Dynamic configs retain Edit and Delete actions.

Render ChatGPT feature gates and dynamic configs under separate `Heading level={3}` labels with independent empty states. Keep the existing table/card pattern and use row `id` as `idKey`.

- [ ] **Step 8: Build and typecheck the dashboard**

Run:

```powershell
npm --prefix "ui" run typecheck
npm --prefix "ui" run build
```

Expected: both commands succeed, and the build regenerates `src\routes\dashboard\page-generated.ts`.

- [ ] **Step 9: Run the dashboard bundle test**

Run:

```powershell
bun test "tests\dashboard-statsig-overrides.test.ts"
```

Expected: all API and generated-bundle tests PASS.

- [ ] **Step 10: Commit the UI**

```powershell
git add -- "ui\src\lib\types.ts" "ui\src\screens\Flags.tsx" "src\routes\dashboard\page-generated.ts" "tests\dashboard-statsig-overrides.test.ts"
git commit -m "feat: add ChatGPT feature flag controls" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

## Task 7: Documentation and End-to-End Verification

**Files:**

- Modify: `FEATURES.md`
- Create: `nginx\sites-available\codex-statsig-spoof.conf.template`
- Create: `tests\statsig-nginx-config.test.ts`
- Verify: all files changed in Tasks 1-6

- [ ] **Step 1: Write the failing Nginx template test**

Create `tests\statsig-nginx-config.test.ts`:

```ts
import { expect, test } from "bun:test"
import fs from "node:fs/promises"

const templatePath =
  new URL(
    "../nginx/sites-available/codex-statsig-spoof.conf.template",
    import.meta.url,
  )

test("Statsig spoof vhost preserves Host and disables query-string logs", async () => {
  const template = await fs.readFile(templatePath, "utf8")

  expect(template).toContain(
    "server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};",
  )
  expect(template).toContain("access_log off;")
  expect(template).toContain("error_log /dev/null emerg;")
  expect(template).toContain("proxy_set_header Host $host;")
  expect(template).toContain(
    "proxy_set_header X-Forwarded-For $remote_addr;",
  )
  expect(template).toContain("proxy_pass {{UPSTREAM_URL}};")
})
```

- [ ] **Step 2: Run the Nginx test and verify it fails**

Run:

```powershell
bun test "tests\statsig-nginx-config.test.ts"
```

Expected: FAIL with `ENOENT` because the dedicated template does not exist.

- [ ] **Step 3: Add the dedicated Statsig Nginx template**

Create `nginx\sites-available\codex-statsig-spoof.conf.template`:

```nginx
# Codex Desktop Statsig domain spoofing.
#
# Point ab.chatgpt.com to this gateway on the Codex client only. The server
# running copilot-api must retain normal public DNS resolution for
# ab.chatgpt.com so the application can proxy to the real Statsig service.
#
# The TLS certificate must include the spoofed hostname in its SAN and be
# signed by a CA trusted by the Codex client.
#
# Access logging is disabled because the Statsig public client key is sent in
# the `k` query parameter. Application/Sentry logging is independently
# scrubbed, but nginx must not persist the raw request URI either. Error
# logging is also suppressed because upstream/rate-limit errors can include
# the complete request line.

server {
  listen 80;
  server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};
  access_log off;
  error_log /dev/null emerg;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name {{CODEX_STATSIG_SPOOF_SERVER_NAME}};

  ssl_certificate     {{CODEX_STATSIG_SPOOF_SSL_CERTIFICATE_PATH}};
  ssl_certificate_key {{CODEX_STATSIG_SPOOF_SSL_CERTIFICATE_KEY_PATH}};

  access_log off;
  error_log /dev/null emerg;
  limit_req zone={{RATE_LIMIT_ZONE}} burst={{RATE_LIMIT_BURST}} nodelay;

  location / {
    proxy_pass {{UPSTREAM_URL}};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    include {{PROXY_LIMITS_SNIPPET_PATH}};
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
  }
}
```

- [ ] **Step 4: Run the Nginx test**

Run:

```powershell
bun test "tests\statsig-nginx-config.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Document deployment and known flags**

Add a `Codex Desktop Statsig feature flags` section near the existing HTTPS spoofing documentation in `FEATURES.md`. Include:

```text
<server-ip> ab.chatgpt.com
```

State all of the following explicitly:

1. Nginx must serve a certificate whose SAN contains `ab.chatgpt.com`.
2. The issuing CA must be trusted by the Windows/Codex client.
3. The hosts entry belongs on the client only.
4. The server must resolve `ab.chatgpt.com` normally to avoid a proxy loop.
5. Redirected clients must be present in the dashboard IP allowlist.
6. The public Statsig client key is forwarded automatically; no OpenAI API key or ChatGPT token is needed.

Direct users to `nginx\sites-available\codex-statsig-spoof.conf.template` and include this equivalent Nginx shape:

```nginx
server {
  listen 443 ssl;
  server_name ab.chatgpt.com;

  ssl_certificate     /path/to/ab-chatgpt-com.crt;
  ssl_certificate_key /path/to/ab-chatgpt-com.key;

  access_log off;
  error_log /dev/null emerg;

  location / {
    proxy_pass http://localhost:4141;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
  }
}
```

Prefer directing users to the new `nginx\sites-available\codex-statsig-spoof.conf.template`. Explain that `access_log off` is intentional because nginx's default `$request` logging includes the `k` query parameter, and `error_log /dev/null emerg` prevents upstream or rate-limit errors from persisting the full request line.

Document the initial entries:

```json
{
  "featureGates": {
    "824038554": true
  },
  "dynamicConfigs": {
    "107580212": {
      "default_model": "gpt-5.6-sol",
      "available_models": [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4"
      ],
      "use_hidden_models": true
    }
  }
}
```

- [ ] **Step 6: Run all targeted tests together**

Run:

```powershell
bun test "tests\statsig-overrides-store.test.ts" "tests\statsig-protocol.test.ts" "tests\statsig-proxy.test.ts" "tests\dashboard-statsig-overrides.test.ts" "tests\dashboard-config-export.test.ts" "tests\statsig-nginx-config.test.ts" "tests\transparent-proxy.test.ts" "tests\wham-route.test.ts" "tests\sentry.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 7: Run project validation**

Run:

```powershell
bun run typecheck
bun run lint:all
bun run build
npm --prefix "ui" run typecheck
npm --prefix "ui" run build
git --no-pager diff --check
```

Expected: every command succeeds and the second UI build produces no uncommitted generated-dashboard difference.

- [ ] **Step 8: Review the complete change set**

Run:

```powershell
git status --short
$base = git merge-base HEAD master
git --no-pager diff "$base..HEAD" --stat
git --no-pager diff "$base..HEAD"
```

Confirm:

- No pre-existing untracked file is staged.
- Claude Code `/api/eval` and `/dashboard/api/flags` behavior remains unchanged.
- `ab.chatgpt.com` handling is registered before `apiKeyGuard`.
- The Statsig client key is never logged or persisted.
- Sentry payloads redact the Statsig `k` value, and the dedicated Nginx vhost suppresses both access and error logs.
- Only configured gate/config names replace upstream values.
- `statsig_overrides.json` is included in config export.
- The generated dashboard contains both setup host lists.

- [ ] **Step 9: Commit deployment support and documentation**

```powershell
git add -- "FEATURES.md" "nginx\sites-available\codex-statsig-spoof.conf.template" "tests\statsig-nginx-config.test.ts"
git commit -m "docs: explain Codex Statsig overrides" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: e85863fc-9bee-4ec6-939d-315f98f8cb9e"
```

If review produced code fixes, stage only the files changed for those fixes and create a separate `fix:` commit with the required trailers before declaring completion.
