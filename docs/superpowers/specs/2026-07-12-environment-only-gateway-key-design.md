# Environment-Only Gateway Key Design

## Goal

Remove `COPILOT_API_KEY_AUTH_FILE` completely. `COPILOT_API_KEY_AUTH` will be
the sole environment-based source for the startup gateway key.

## Startup behavior

The existing `--api-key-auth` contract remains unchanged:

- `--api-key-auth <value>` uses the explicit CLI value.
- `--api-key-auth` without a value reads `COPILOT_API_KEY_AUTH`.
- Omitting `--api-key-auth` leaves startup gateway authentication disabled.
- Supplying `--api-key-auth` without an available environment value terminates
  startup with the existing explicit error.

No file path, mounted secret, or fallback file lookup will remain.

## Repository changes

- Delete `COPILOT_API_KEY_AUTH_FILE` resolution from `src/start.ts`.
- Remove the gateway-key file mount and `COPILOT_API_KEY_AUTH_FILE` assignment
  from `docker-compose.yml`.
- Remove `COPILOT_API_KEY_AUTH_FILE` from `.env.schema`.
- Update documentation to describe `COPILOT_API_KEY_AUTH` as the only
  environment source and remove key-file setup instructions.
- Update or add focused tests so environment-only resolution and missing-value
  failure remain covered.

## Production deployment

Production environment values continue to come from the existing automatic
secret-management integration. Deployment will not read, copy, print, rotate,
or modify the gateway key or `.env`.

The updated image and Compose configuration will recreate the live container
without `/run/secrets/copilot-api-key`. Verification will confirm:

- the container is healthy and bound to loopback;
- `COPILOT_API_KEY_AUTH_FILE` and its mount are absent;
- startup reports gateway authentication enabled;
- an unauthenticated protected request is rejected; and
- the OAuth authorization flow accepts the secret-manager-provided gateway key
  through a status-only check that does not print the credential.

## Failure handling

If the secret manager does not supply `COPILOT_API_KEY_AUTH`, container startup
must fail rather than starting without the gateway guard. The prior deployment
will remain available for rollback until the recreated container is healthy.

## Non-goals

- Changing OAuth token semantics or credential scopes.
- Rotating the gateway key.
- Editing production `.env`.
- Changing the secret-management provider or integration.
