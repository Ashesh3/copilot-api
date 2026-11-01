# Claude Desktop local gateway setup

Configure a personal Claude Desktop installation on Windows to use an existing
Copilot API gateway, sign in through that gateway, and enable the native dictation
microphone. These steps were verified with Claude Desktop **4.4212.0**.

This guide covers the Desktop application. For the standalone Claude Code CLI,
see [Claude Code setup](../README.md#claude-code).

## 1. Check the client and connection

Have the following ready:

- A Claude Desktop build with third-party gateway configuration and Dictation
  support. Update an older client from the [official download page](https://claude.com/download)
  if these options are missing.
- The working gateway base, such as `https://gateway.example.com`. Use HTTPS for a
  remote gateway; supported loopback HTTP can be used for a local gateway.
- An existing Copilot API **gateway or inference key** for browser approval.

Keep the gateway root URL without adding `/v1`. If inference already works, retain
its working base. This setup uses Desktop's editable third-party profile and does
not require new hosts-file redirects, a client-side proxy, or registry policies.
For an organization-managed client, have the administrator update its existing
configuration instead of overriding policy locally.

If an update is needed, finish active Desktop/Cowork tasks and fully quit the app
first. Back up the effective user-data directory described below, including
`configLibrary` and `Local State`, before an in-place update. Keep this backup
private: it contains client settings and credential state. Use the existing
Windows user and preserve the package family and data.

## 2. Find the selected local profile

Prefer Desktop's editable third-party configuration screen when it exposes the
required settings. For a manual edit, use the profile belonging to the Windows
user who actually runs Desktop.

The normal profile library is:

```text
%LOCALAPPDATA%\Claude-3p\configLibrary
```

MSIX installations, including Windows 10 setups, can store the effective library
in the package's virtualized data directory:

```text
%LOCALAPPDATA%\Packages\<package-family>\LocalCache\Local\Claude-3p\configLibrary
```

Find the installed package family and version in **Windows PowerShell**:

```powershell
Get-AppxPackage -Name Claude |
  Select-Object Name, Version, PackageFamilyName
```

Replace `<package-family>` with the returned value. If `CLAUDE_USER_DATA_DIR` is
already configured, use that custom user-data root. If both normal and virtualized
locations exist, identify the one used by the running client before editing.

Within the active library:

1. Read `_meta.json` and find `appliedId`.
2. Select the corresponding `<appliedId>.json` file. Do not select a profile by
   modification time or edit `_meta.json` to guess the active profile.
3. If an active `hybridPointer` is present, select the intended local profile
   through Desktop first, then resolve `appliedId` again.
4. Fully quit Desktop, including its tray process, and back up the selected file.
   For an app update, back up the entire effective `Claude-3p` data root as well.

Preserve sealed credentials and the surrounding client data. Copying one profile
JSON to another Windows account is not a credential-migration procedure.

## 3. Enable gateway sign-in and Dictation

In the selected profile, merge these four top-level values, replacing the example
hostname with your working gateway base:

```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "https://gateway.example.com",
  "inferenceCredentialKind": "interactive",
  "dictationEnabled": true
}
```

Merge the values into the existing object; do not replace the entire file with
this small example. Preserve all other values and sealed credentials, and keep
the JSON valid.

For an existing static-key profile, the practical changes are switching
`inferenceCredentialKind` from `static` to `interactive` and enabling
`dictationEnabled`. Static credentials still support ordinary inference, but the
native microphone in the verified build requires interactive sign-in.

Use the gateway's own sign-in flow. External OIDC issuer/token settings, including
`inferenceGatewayOidc` or `inferenceIdpOidc`, are a different configuration and
prevent this native gateway dictation path. Keep them absent for this setup. If
the current profile intentionally uses external OIDC, select a separate local
gateway profile instead of silently removing its identity settings.

Save the selected profile and reopen Desktop.

## 4. Complete sign-in in Desktop

1. Start **Sign in** from Desktop's gateway connection.
2. Check that the device code in the browser matches the one shown by Desktop.
3. Approve with the existing **Copilot API gateway or inference key**. The form
   does not take a Groq provider key, GitHub token, or Anthropic account password.
4. Return to Desktop and let its sign-in finish. Restart sign-in if the displayed
   code expires.

Use the native Desktop action so the approved session belongs to that client.
There is no need to copy access or refresh tokens into the profile. Keep codes,
credentials, and tickets out of screenshots, logs, and support reports.

## 5. Try the native microphone

Open a new conversation and confirm ordinary inference works with an available
model. Then:

1. Click the native microphone.
2. Speak a short sentence.
3. Press **Stop**.
4. Confirm the transcript appears in the editable input without automatically
   submitting it.

The adapter transcribes after Stop. The verified Desktop build waits roughly two
seconds for final text, so provider/network latency affects whether text arrives
in time. Ordinary click-to-record mode can also stop after about a minute without
partial text; start with a short recording.

A healthy server or successful discovery request does not establish microphone
success. Verify the actual editable transcript. If Windows requests microphone
access, review that request for the intended app and input device.

## Troubleshooting

| Symptom                                               | Check                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No microphone                                         | Confirm the client supports Dictation, the selected profile has `dictationEnabled: true`, credentials are `interactive`, sign-in completed, and external OIDC is absent.             |
| Changes have no effect                                | Recheck the GUI user's effective data root, `_meta.json` selection, custom user-data location, and whether a managed policy overrides local settings. Fully quit and reopen Desktop. |
| Windows PowerShell app-package command is unavailable | If the Appx module fails to load in PowerShell 7, run the package query in Windows PowerShell.                                                                                       |
| Sign-in loops or approval fails                       | Verify the gateway root, public discovery URLs, code expiry, and that the approving gateway/inference key remains active. Check the Nginx routes below.                              |
| Recording starts but no text appears                  | Check microphone input, the existing transcription-provider configuration, the stream upgrade, and response latency after Stop.                                                      |
| Official downloads or updates return gateway errors   | Existing redirects for vendor hostnames can also redirect their download/updater URLs. Review those existing mappings; this setup requires no new vendor-host redirects.             |

If a Windows MSIX update reports `0x80073D02` even after closing the window, an
existing background Cowork service may still hold the package. After finishing
active tasks, fully quitting Desktop, and backing up its data, update the MSIX
downloaded from the [official Windows deployment instructions](https://support.claude.com/en/articles/12622703-deploy-claude-desktop-for-windows):

```powershell
Add-AppxPackage -Path '.\Claude.msix' -ForceApplicationShutdown
```

Replace the example filename with the downloaded package. Run in the intended
Windows user's context and follow any administrator-approval requirements. The
flag closes running components of the package during its update. Recheck the
selected profile after updating rather than creating a new empty data directory.

### Verify Nginx only when connection checks fail

Have the gateway operator compare the **active** vhost with the tracked
[public-domain template](../nginx/sites-available/public-domain.conf.template).
The root `update.sh` updates the application; host Nginx needs its own configuration
installation and reload. The operator can validate and inspect it with:

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo nginx -T
```

The following exact routes must reach the gateway. The same paths are also
available under `/v1`, but do not append `/v1` to an already working Desktop base.

| Method                 | Root path                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| GET                    | `/.well-known/oauth-authorization-server`                                |
| POST                   | `/gateway/oauth/device`, `/gateway/oauth/token`, `/gateway/oauth/revoke` |
| GET, POST              | `/gateway/oauth/verify`                                                  |
| POST, authenticated    | `/user/dictation/ticket`                                                 |
| GET, WebSocket Upgrade | `/user/dictation/stream`                                                 |

Device initiation and token polling must accept their native form requests
without an Authorization header or client ID. A blanket proxy authentication gate
on these paths prevents sign-in. Ticket issuance authenticates the gateway
credential; stream authorization uses a single-use ticket.

These credential-free Windows checks print public discovery and the device
endpoint's HTTP status. The second command discards its response body so it does
not print the generated device code:

```powershell
$gateway = 'https://gateway.example.com'
curl.exe --fail --silent --show-error --user-agent 'copilot-api-desktop-check/1.0' `
  "$gateway/.well-known/oauth-authorization-server"

curl.exe --silent --show-error --request POST `
  --user-agent 'copilot-api-desktop-check/1.0' `
  --header 'Content-Type: application/x-www-form-urlencoded' `
  --header 'Content-Length: 0' `
  --output NUL --write-out "%{http_code}\n" `
  "$gateway/gateway/oauth/device"
```

Expect discovery JSON and device-initiation HTTP `200`. The issuer, device, token,
and revocation URLs must use the configured public HTTPS origin and base. If they
do not, have the operator inspect `COPILOT_TRUSTED_PROXY_CIDRS` for the actual proxy
peer and any `COPILOT_PUBLIC_BASE_URL` override. Preserve the deployment's intended
base instead of adding extra `/v1` prefixes.

Inside the stream location, verify the complete header block from the template:

```nginx
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection upgrade;
proxy_set_header Sec-WebSocket-Protocol $http_sec_websocket_protocol;
```

Location-level `proxy_set_header` directives replace inherited header settings;
forwarding only Upgrade and Connection loses the public-origin headers. The proxy
must overwrite caller-supplied forwarding values, preserve the request URI and
audio query, and retain the template's disabled buffering/cache and access logging
on sensitive paths. Use the exact allowlisted locations rather than a catch-all
proxy.

During a real native recording, the WebSocket request offers `claude.dictation.v1`
and `ticket.<ticket>`. Expect HTTP `101` and a selected subprotocol of only
`claude.dictation.v1`. Keep the ticket out of URLs and diagnostics. If a deployment
already uses a Claude API spoof hostname, its API vhost needs the corresponding
[spoof-template routes](../nginx/sites-available/spoof-domains.conf.template);
keep platform-login and Codex spoof vhosts separate.

See [Nginx operator notes](../nginx/README.md) and the existing
[dictation protocol reference](claude-desktop-dictation.md) for more detail.

## Return to the previous client setup

Sign out, fully quit Desktop, and restore the backed-up selected profile. An
existing static-key configuration can also return to `inferenceCredentialKind:
"static"` while retaining its saved credential. Reopen Desktop and verify ordinary
inference. Client-profile rollback does not require changing the gateway database.
