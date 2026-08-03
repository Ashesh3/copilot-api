# Usage Routing Observability

## Goal

Redesign the Usage page into a live routing-observability surface while keeping
the existing Five Hour, Seven Day, and Lifetime cards unchanged. The new
sections must show which effective models and providers receive traffic, which
Copilot accounts receive the resulting upstream calls, and whether retries or
failovers are amplifying load.

The routing detail is operational telemetry, not billing data. It exists only
in process memory, retains minute-level detail for 24 hours, and resets whenever
the server restarts. The existing usage-card storage and behavior are not
changed.

## Definitions

- **Request**: one client-facing model operation handled by the service. An HTTP
  request is counted once after the route has selected its effective model and
  produced a response. A Responses WebSocket turn is counted once when its turn
  reaches a terminal state.
- **Upstream call**: one actual network send to a model provider. Initial sends,
  HTTP retries, token-refresh resends, transport retries, and account failovers
  each count separately.
- **Amplification**: upstream calls divided by requests for the selected window.
- **Retry**: an extra send to the same destination account after an HTTP,
  authentication-refresh, or transport failure.
- **Failover**: an extra Copilot send made through a different account after the
  prior account returned a failover-eligible response.
- **Effective model**: the model identifier ultimately sent to the provider,
  after aliases, redirects, and endpoint fallbacks have been resolved.
- **Route**: the client protocol paired with the final upstream destination,
  such as `Responses -> Chat Completions`, `Messages -> Anthropic Messages`, or
  `Embeddings -> Nebius`.

These labels appear in the UI so request counts cannot be mistaken for raw
provider calls.

## Page Design

The page keeps its current `Monitor / Usage` header, manual refresh action, and
three existing cards at the top. The new content follows in this order.

### Routing Pulse

The Routing Pulse is the first new section and provides the at-a-glance health
of the selected window:

- Requests, with the average request rate.
- Upstream calls, with the amplification ratio.
- Retry sends and their percentage of calls.
- Account failovers and their percentage of requests.
- A time series comparing requests with extra upstream calls.

The user can select `15m`, `1h`, `6h`, or `24h`. The backend retains one-minute
buckets; the response aggregates them into chart intervals appropriate for the
selected range. The selected window applies to every section below the original
three cards.

The section header states that the data is in memory and retained for 24 hours.
The page footer shows when telemetry started and that a restart clears it.
Process-lifetime request, call, retry, and failover totals are returned by the
API and shown as supporting context without adding a fifth range option.

### Model Usage and Routing

The primary table has one row per effective model/provider combination. It is
sorted by upstream call count by default and can be filtered by model or
provider. Columns show:

- Effective model and provider.
- Client requests attributed to that model.
- Actual upstream calls.
- Share of all upstream calls in the selected window.
- Call amplification and retry/failover counts.
- Outcome rate derived from upstream status classes.
- A compact distribution bar showing calls per Copilot account.

Custom-provider models appear in the same table. Their account distribution is
shown as `N/A - external provider`, while their requests, upstream calls, share,
and outcomes remain part of the page totals.

### Account Balance

The Account Balance section shows each configured Copilot account, its current
health, actual initial selections, actual upstream calls, selected-window call
share, expected selection share, and the delta between actual and expected.

Expected share is eligibility-weighted per model: a request contributes
`1 / eligible account count` to each account that could serve that model at the
time of selection. This avoids treating model-availability differences as load
imbalance. Initial selections are kept separate from retries and failovers so
recovery traffic does not masquerade as a routing-selection defect.

The section explains that session affinity deliberately keeps one client
session on the same account. It also reports the split between sticky-session
selection and the stable default used when no client session identifier is
present. Balance warnings require a meaningful sample before they appear, so a
small or session-skewed window is not labeled broken.

In single-token mode, the section shows one `Default credential` destination
instead of a numbered multi-token account and does not calculate a balance
warning.

### Route Breakdown

The Route Breakdown summarizes where client protocols ultimately sent model
traffic. Each row shows the client protocol, upstream endpoint or custom
provider, requests, upstream calls, and share. Endpoint fallback paths remain
visible instead of being merged into a generic Copilot total.

### Responsive, Loading, and Empty States

The design follows the existing Astryx dashboard theme and uses the existing
table, card, banner, skeleton, and typography conventions. The routing summary
and account/route sections collapse to a single column on narrow screens; wide
tables retain the dashboard's compact, overflow-safe behavior.

The original usage cards and the routing telemetry load independently. A
routing API failure must not hide valid card data. Before any model traffic is
observed, the new area explains that it is waiting for requests while still
showing configured account health. Background refresh does not flash skeletons
or the page-level refresh spinner.

## Architecture

### In-Memory Telemetry Store

A new routing telemetry module owns all state and exposes narrow, synchronous,
non-throwing recording functions plus a snapshot function. It stores:

- A process start timestamp.
- Rolling one-minute buckets for the most recent 24 hours.
- Process-lifetime aggregate counters.
- Bounded dimension keys for model, provider, route, account, outcome, send
  reason, and session-selection mode.

Each minute bucket contains counters, not raw events. Buckets older than 24
hours are pruned on recording and snapshot reads. Model/provider cardinality is
capped; excess or invalid dimension values fold into an `Other` bucket. This
keeps memory bounded even when a caller supplies arbitrary model identifiers.

The store never retains prompts, response bodies, headers, credentials, client
session IDs, request IDs, IP addresses, or token strings. Numeric account IDs,
configured provider labels, model identifiers, endpoint names, status classes,
and aggregate counters are the only dimensions exposed.

### Request Recording

HTTP model requests are recorded at the existing request logging boundary,
after route handlers have populated structured request context with the
requested/effective model, provider, source protocol, destination, final
account, and response status. Non-model routes, rejected pre-dispatch requests,
dashboard polling, and telemetry endpoints are ignored.

Responses WebSocket turns do not correspond one-for-one with HTTP requests, so
their existing per-turn lifecycle records the same structured request event at
terminal completion. A per-request/per-turn in-memory flag prevents duplicate
request counts. Correlation state may use the existing request-scoped async
context, but correlation identifiers are never copied into telemetry buckets.

For an HTTP streaming response, the request is counted when the server has
accepted the model operation and produced the streaming response. Mid-stream
provider failures remain visible in upstream-call outcomes and do not create a
second request.

### Upstream Call Recording

Copilot calls are recorded around the actual `fetch` attempt inside the central
Copilot transport. The account router supplies structured metadata containing
the effective model, numeric account when present, destination endpoint,
selection mode, eligible accounts, and whether the outer send is initial,
token-refresh, or failover. The transport adds the internal attempt reason for
HTTP and transport retries. Each network send records exactly one terminal
outcome: HTTP status class, transport error, or abort.

Custom OpenAI-compatible providers are instrumented at their shared fetch
boundary. They record the configured provider identity, effective upstream
model, endpoint, and terminal outcome with no account ID.

Recording runs outside routing decisions and response parsing. A malformed
telemetry value or internal telemetry error is discarded and must never change
provider selection, retry budgets, response status, or stream behavior.

### Balance Accounting

When the account router makes an initial model selection, it records the chosen
account and the IDs of accounts eligible at that moment. The store increments
one actual selection for the chosen account and fractional expected-selection
credits across the eligible set. It also increments either the sticky-session
or no-session counter. Retry and failover sends affect upstream-call share but
not initial-selection balance.

No session identifier is retained or hashed into the aggregate store.

## Dashboard API

The existing authenticated `GET /dashboard/api/usage` endpoint and its payload
remain unchanged for the three current cards.

A new authenticated endpoint serves routing data:

`GET /dashboard/api/usage-routing?window=15m|1h|6h|24h`

The default window is `1h`. Unsupported window values receive a `400` response.
The response contains:

- `window`, `generatedAt`, `telemetryStartedAt`, and retention metadata.
- Selected-window and process-lifetime totals.
- Time-series points.
- Model/provider rows.
- Account health and balance rows.
- Route-breakdown rows.
- Multi-token mode and selection-mode summaries.

All lists use stable deterministic ordering after their documented primary
sort. The endpoint reads a snapshot and never mutates routing configuration.

## Refresh Behavior

The Usage screen fetches the original usage data and routing data separately.
Manual refresh reloads both. Routing telemetry silently refreshes every 10
seconds while the page is visible, using the dashboard's visibility-aware
polling helper. Changing the selected window immediately reloads only the
routing endpoint.

## Failure Handling

- Telemetry recording rejects non-finite counters and invalid dimensions
  without throwing.
- Upstream attempts that throw are counted as transport errors; aborted sends
  are classified separately.
- A routing telemetry endpoint failure renders a scoped retry banner below the
  unchanged cards.
- Empty or newly restarted stores return a valid zero-valued snapshot rather
  than `404` or `null` fields.
- Accounts that become unhealthy remain visible with their current health and
  historical selected-window counters.
- A process restart intentionally clears all new routing telemetry.

## Testing and Verification

- Store tests cover request/call separation, minute aggregation, exact window
  cutoffs, 24-hour pruning, lifetime totals, outcome classes, cardinality caps,
  deterministic ordering, and zero-data snapshots.
- Copilot transport and account-router tests prove initial calls, internal
  retries, token refresh resends, failovers, account IDs, eligible-account
  credits, and send reasons are counted exactly once without changing retry
  behavior.
- Custom-provider tests prove calls appear with the provider/model and no
  account ID for success and failure paths.
- Request logger and Responses WebSocket tests prove one client request/turn is
  recorded and non-model traffic is ignored.
- Dashboard API tests cover authentication through the existing route guard,
  all supported windows, invalid query values, empty state, and redaction of
  sensitive fields.
- UI verification covers typechecking, responsive source structure, independent
  error/empty states, polling, range selection, custom-provider `N/A`, and the
  regenerated embedded dashboard page.
- Final verification runs focused tests, `bun test`, UI typechecking and build,
  repository build, lint on changed source files, and `git diff --check`.

## Scope

This change does not persist the new routing telemetry, expose raw request
history, change account selection, alter session affinity, add billing or cost
estimation, retain client identifiers, or modify the existing three usage-card
calculations. It does not add a reset button because restarting the process is
the explicit reset boundary.
