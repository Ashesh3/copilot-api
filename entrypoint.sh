#!/bin/sh
if [ "$1" = "--auth" ]; then
  exec bun run dist/main.js auth
fi

# Build base CLI args
ARGS=""
[ -n "$COPILOT_HOST" ] && ARGS="$ARGS --host $COPILOT_HOST"
[ "$COPILOT_VERBOSE" = "true" ] && ARGS="$ARGS --verbose"
[ "$COPILOT_DEBUG" = "true" ] && ARGS="$ARGS --debug"
[ -n "$GH_TOKEN" ] && ARGS="$ARGS -g $GH_TOKEN"

# --api-key-auth with no value tells the app to read COPILOT_API_KEY_AUTH from env
# This works whether the env var comes from .env, docker env, or varlock
ARGS="$ARGS --api-key-auth"

CMD="bun run dist/main.js start $ARGS $*"

# Run with varlock (resolves 1Password secrets into env) or directly
if [ -n "$OP_TOKEN" ] && [ -f ".env.schema" ]; then
  echo "Resolving secrets from 1Password via varlock..."
  exec bunx varlock run -- $CMD
else
  exec $CMD
fi
