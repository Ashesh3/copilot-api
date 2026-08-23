# Nginx deployment templates

The files in this directory are default-deny examples. They are intentionally
not a single catch-all configuration: each hostname publishes only the route
families needed by that client.

The canonical application and Docker setup remains in the repository
`README.md`. This file covers only rendering and installing the Nginx layer.

## Template matrix

| Template                                            | Intended hostname                               | Published surface                                                             |
| --------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `sites-available/public-domain.conf.template`       | Normal public API/dashboard hostname            | Inference APIs, scoped OAuth, dashboard, Remote Control, exact health         |
| `sites-available/spoof-domains.conf.template`       | Claude API and platform compatibility hostnames | Claude API/OAuth/session compatibility allowlists                             |
| `sites-available/codex-desktop-spoof.conf.template` | Locally mapped trusted `*.openai.com` hostname  | Authenticated Codex dictation and transcript cleanup only                     |
| `sites-available/codex-statsig-spoof.conf.template` | Locally mapped `ab.chatgpt.com`                 | Exact Statsig initialize/download/check routes; all other paths denied         |

Do not combine these server blocks onto one broad hostname. Do not add a
catch-all `proxy_pass`.

The Statsig application boundary authorizes managed client IPs. If a shared
load balancer source-NATs clients, the application sees the load balancer as the
caller and cannot distinguish downstream clients. Deploying the Statsig
template in that topology explicitly accepts cross-client access and source-IP
spoofing risk for its three published endpoints. Use source preservation or
PROXY protocol when that risk is unacceptable.

## Shared prerequisites

The supplied templates do not pace requests, cap connections, or bound request
bodies. `client_max_body_size 0` is explicit so Nginx's default body limit is
disabled. Nginx cannot represent an infinite upstream-read timeout, so every
TLS server uses its maximum accepted client/read/send duration
(`2147483647s`) and its 75-second maximum connect duration. This prevents the
60-second Nginx defaults from closing quiet model streams. Install
`logrotate/copilot-api-nginx` under `/etc/logrotate.d/` if the deployment uses
the matching Nginx log paths.

## Public hostname placeholders

`public-domain.conf.template` requires:

| Placeholder                       | Example                                               |
| --------------------------------- | ----------------------------------------------------- |
| `PUBLIC_SERVER_NAME`              | `api.example.com`                                     |
| `PUBLIC_SSL_CERTIFICATE_PATH`     | `/etc/ssl/api.example.com/fullchain.pem`              |
| `PUBLIC_SSL_CERTIFICATE_KEY_PATH` | `/etc/ssl/api.example.com/privkey.pem`                |
| `CLOUDFLARE_REAL_IP_SNIPPET_PATH` | `/etc/nginx/snippets/copilot-cloudflare-real-ip.conf` |
| `UPSTREAM_URL`                    | `http://127.0.0.1:4141`                               |

The other hostname templates enumerate their placeholders in comments at the
top of each file. Render every placeholder; a value left in `{{BRACES}}` should
be treated as a deployment error.

The two top-level `map` directives must remain in the Nginx `http` context.
The Responses map is security-sensitive: normal API traffic is `POST`, while
Codex Desktop opens an authenticated WebSocket with `GET` and
`Upgrade: websocket`. A POST-only location causes an Nginx `403` before the
application can authenticate the socket. Plain GET remains denied.

Generation and WebSocket locations disable request and response buffering for
streaming and inherit the maximum-duration server settings so a quiet upstream
does not fall back to Nginx's 60-second default.

The public OpenAI-compatible transcription location publishes only
`POST /v1/audio/transcriptions` and disables request buffering so multipart
audio can stream over HTTP/1.1 to the application without Nginx first spooling
the upload.

The public template adds baseline browser headers with `always`, including to
Nginx-generated denials. It deliberately does not set Content Security Policy;
the application generates a per-response nonce and the OAuth pages add only a
validated callback origin to `form-action`.

## Cloudflare client addresses

Use `snippets/cloudflare-real-ip.conf` only when the listener is reachable
solely through Cloudflare or otherwise firewall-restricted to Cloudflare peers.
The application must separately trust the actual Nginx-to-application socket
peer through `COPILOT_TRUSTED_PROXY_CIDRS`.

Cloudflare publishes the authoritative lists at:

- `https://www.cloudflare.com/ips-v4/`
- `https://www.cloudflare.com/ips-v6/`

Compare both lists to the tracked snippet during deployment maintenance. Never
replace them with `0.0.0.0/0`, `::/0`, or a broad private-network range.
The tracked list was last compared successfully on 2026-07-12 (15 IPv4 and 7
IPv6 ranges).

## Install and validate

After rendering placeholders:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Then verify the boundary from outside the origin:

1. Exact `GET /health/health` returns `200`.
2. Unknown paths and unpublished compatibility families return `404`.
3. A plain `GET /v1/responses` is denied by Nginx.
4. A WebSocket upgrade without a credential reaches the application and returns
   `401`, not an Nginx HTML `403`.
5. The same upgrade with a valid gateway, OAuth, or inference credential returns
   `101 Switching Protocols`.
6. A normal authenticated `POST /v1/responses` still works.
7. Spoofed `X-Real-IP`, `X-Forwarded-For`, and `CF-Connecting-IP` headers from a
   non-trusted TCP peer do not authorize IP-gated routes.
8. `nginx -T` contains no `limit_req`, `limit_req_zone`, or `limit_conn`, and
   each TLS proxy server has the maximum-duration client/read/send directives.
9. The Statsig hostname proxies only `/v1/initialize`, `/v1/download`, and
   `/v1/check`; an unrelated path returns `404`.

Keep origin ports firewalled or loopback-bound. The public hostname policy does
not protect a separately reachable backend listener.

The dated files under `docs/superpowers/` are historical implementation plans,
not deployment instructions. Use the root `README.md`, `SECURITY.md`, and this
file as the current operational documentation.
