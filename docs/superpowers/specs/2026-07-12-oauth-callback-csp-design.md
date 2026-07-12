# OAuth Callback CSP Design

## Goal

Allow Claude Code OAuth authorization form submissions to follow their `302`
redirect to the validated callback while retaining restrictive CSP defaults for
all other HTML pages.

## Root cause

The authorization page is served with `form-action 'self'`. Chromium submits
the API-key form to the same origin and receives a valid `302`, but blocks the
redirect to either `http://localhost:<port>/callback` or
`https://platform.claude.com/oauth/code/callback`.

The failure was reproduced in isolated Chromium: the POST received a `302`,
the address remained on the authorization page, and no callback request
occurred. The identical POST from a page without the restrictive `form-action`
followed the redirect and loaded the callback successfully.

## Design

`secureHtml` will accept an optional list of CSP `form-action` sources. Its
default remains exactly `'self'`.

The OAuth authorization routes will derive the callback origin from the
already validated `redirect_uri`:

- Local callbacks allow the exact requested origin, including its random port.
- Manual callbacks allow exactly `https://platform.claude.com`.

The authorization page CSP will include `'self'` and that exact callback
origin. No wildcard localhost ports, arbitrary redirect hosts, or global CSP
relaxation will be introduced.

Both the initial GET page and the invalid-key POST response will use the same
callback-aware policy so retrying the form behaves consistently.

## Security boundaries

The existing redirect validation remains authoritative and runs before a CSP
source is derived. Invalid authorization requests continue to receive the
existing bounded error response.

Dashboard, Remote Control, callback display, and every other `secureHtml`
consumer retain `form-action 'self'`.

## Testing

Focused tests will verify:

- `secureHtml` defaults to `form-action 'self'`.
- An explicit form-action origin is serialized safely alongside `'self'`.
- Local OAuth authorization pages include only their exact localhost origin
  and port.
- Manual OAuth authorization pages include only
  `https://platform.claude.com`.
- Unrelated HTML routes do not gain either OAuth callback source.

After deployment, isolated Chromium will repeat both local and manual callback
flows and confirm the browser follows the `302`. The local flow must reach
Claude Code's callback listener and trigger the token exchange.

## Non-goals

- Changing OAuth code, PKCE, state, token, scope, or expiry semantics.
- Relaxing `script-src`, `connect-src`, or any non-form CSP directive.
- Adding JavaScript submission logic.
- Changing gateway-key handling.
