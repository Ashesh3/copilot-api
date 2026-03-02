#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command only (token saved to persistent volume)
  exec bun run dist/main.js auth
fi

# Build CLI args from environment variables
ARGS=""
[ -n "$COPILOT_HOST" ] && ARGS="$ARGS --host $COPILOT_HOST"
[ -n "$COPILOT_API_KEY_AUTH" ] && ARGS="$ARGS --api-key-auth $COPILOT_API_KEY_AUTH"
[ "$COPILOT_VERBOSE" = "true" ] && ARGS="$ARGS --verbose"
[ "$COPILOT_DEBUG" = "true" ] && ARGS="$ARGS --debug"

if [ -n "$GH_TOKEN" ]; then
  # Token provided via env — pass directly
  exec bun run dist/main.js start -g "$GH_TOKEN" $ARGS "$@"
else
  # No token env — use file-based auth from persistent storage
  exec bun run dist/main.js start $ARGS "$@"
fi
