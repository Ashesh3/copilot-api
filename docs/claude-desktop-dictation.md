# Claude Desktop dictation through Copilot API

This integration supplies the native microphone in Claude Desktop's third-party
gateway mode. Speak, stop recording, and the transcript is inserted into the
editable prompt. Inference continues through Copilot API. It does not enable
conversational voice or change computer-use feature availability.

The protocol was verified against Claude Desktop 4.4212.0. The existing Claude
Code CLI voice socket and Codex Desktop transcription routes remain separate.

## Deploy the gateway first

Deploy the updated application and the corresponding public-domain Nginx
configuration. The application adds storage migration 012 for Desktop device
grants, authentication sessions, and access-token digests. Follow the normal
database-backup procedure before upgrading. Existing CLI OAuth clients retain
their existing token and refresh behavior.

Configure the stored Groq credential in the dashboard's credential settings;
preserve the existing credential if transcription already works. `groqModel`
continues to select the transcription model. Normal startup does not import
`GROQ_API_KEY` from the environment. Never enter a Groq key into the Desktop
sign-in page: that page takes a Copilot API gateway or inference key.

The new paths are available under the root and `/v1` prefixes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | Native gateway discovery |
| POST | `/gateway/oauth/device` | Start Desktop sign-in |
| GET, POST | `/gateway/oauth/verify` | Display and approve the device code |
| POST | `/gateway/oauth/token` | Exchange a device code or refresh a session |
| POST | `/gateway/oauth/revoke` | Sign out |
| POST | `/user/dictation/ticket` | Obtain a single-use stream credential |
| GET, Upgrade | `/user/dictation/stream` | Native audio/transcript WebSocket |

Device codes expire after five minutes and use OAuth's advertised polling
interval. Device-flow operation receipts are retained for one day, with
unresolved commit receipts protected until reconciliation. The integration does
not add application request-rate or body-size caps.

Use the gateway root as Desktop's normal base, for example
`https://gateway.example.com`, as in the main Desktop setup instructions. The
additional `/v1` auth/dictation routes preserve compatibility with clients or
proxy configurations that already use that prefix. Do not append another `/v1`
to an otherwise working Desktop inference configuration.

If a reverse proxy changes the external origin or adds a path prefix, configure
the existing trusted-proxy settings or `COPILOT_PUBLIC_BASE_URL` so discovery
advertises the same public origin and base that Desktop uses. Nginx must forward
the WebSocket Upgrade and `Sec-WebSocket-Protocol` headers.

## Enable the microphone in Desktop

1. Keep **gateway** as the inference provider and retain the working base URL.
2. Select **interactive** credentials using the gateway's own sign-in. Do not
   configure an external OIDC issuer or token URL for this dictation path.
3. Enable **Dictation** (`dictationEnabled`).
4. Start sign-in, check the displayed device code, and approve it in the browser
   using a stored Copilot API gateway or inference key.

For an editable Windows installation, Desktop 4.4212.0 stores its selected profile
under `%LOCALAPPDATA%\Claude-3p\configLibrary`. `_meta.json` identifies the selected
file through `appliedId`. If the option is not exposed by the UI, fully quit
Desktop, back up that selected JSON file, and merge these fields into it:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "https://gateway.example.com",
  "inferenceCredentialKind": "interactive",
  "dictationEnabled": true
}
```

Preserve all other configuration and sealed credentials. Reopen Desktop and
complete sign-in. If `_meta.json` contains an active `hybridPointer`, select the
intended local profile through Desktop before editing. A custom
`CLAUDE_USER_DATA_DIR` changes the profile location.

Avoid adding Windows registry policy values for a personal setup: managed
inference settings take precedence and can make the setup editor read-only.
Organization-managed installations should update their existing policy instead.

## Verification

Check discovery on the exact configured public base. Its device and token URLs
must be on that same origin. Then sign in, click the native microphone, record a
short sentence, and stop. The complete transcript should appear in the prompt
without automatically submitting it.

The renderer uses 16 kHz mono PCM16 and offers the `claude.dictation.v1` WebSocket
subprotocol plus a one-time ticket. The server negotiates `claude.dictation.v1`.
Tickets expire after 60 seconds and cannot be reused or moved to another base.
Desktop access is inference-only and expires after one hour; refresh tokens
rotate and last thirty days. Disabling, replacing, or revoking the approving key
also invalidates its Desktop sessions.

Desktop waits approximately two seconds for final text after Stop. The gateway
currently sends the recording to Groq when recording stops, so provider and
network latency must fit that native drain window. Validate this with the actual
deployment; protocol tests alone cannot establish production transcription
latency. Closing the socket aborts provider work and releases the audio buffer.

The server does not add recording-duration, frame, connection, or timeout caps.
The optional `max_seconds` ticket field is omitted; the inspected client applies
its own ten-minute maximum by default. In ordinary click-to-record mode, the
client can also stop after about one minute without receiving transcript text.
This batch adapter returns text after Stop, so shorter recordings are appropriate;
push-to-talk has different native silence behavior. Upstream transcription limits
still apply. Regional Desktop locales such as `en-US` are normalized to the
provider's base language code, such as `en`.

## Troubleshooting and rollback

- **No microphone:** check `dictationEnabled`, interactive credentials, an HTTPS
  gateway base (or supported loopback HTTP), and absence of external OIDC
  configuration. A static key is insufficient for this native path.
- **Sign-in fails:** check the public discovery URL, origin/prefix consistency,
  device-code expiry, and whether the approving key is active. The native gateway
  flow is different from the existing CLI `/v1/oauth/token` flow.
- **Recording opens but text is absent:** check ticket/Upgrade forwarding, the
  Groq configuration, and response latency against the native Stop drain window.
  Verification codes, credentials, tickets, audio, and transcript content are
  excluded from the new integration's ordinary diagnostics.
- **Return to static inference:** sign out, restore the selected profile backup,
  or switch `inferenceCredentialKind` back to `static`. Restoring Desktop's
  profile does not require reverting the server's database migration.
