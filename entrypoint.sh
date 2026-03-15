#!/bin/sh
if [ "$1" = "--auth" ]; then
  exec bun run dist/main.js auth
fi

# Build CLI args from environment variables
# (these come from .env file or docker env directly)
ARGS=""
[ -n "$COPILOT_HOST" ] && ARGS="$ARGS --host $COPILOT_HOST"
[ -n "$COPILOT_API_KEY_AUTH" ] && ARGS="$ARGS --api-key-auth $COPILOT_API_KEY_AUTH"
[ "$COPILOT_VERBOSE" = "true" ] && ARGS="$ARGS --verbose"
[ "$COPILOT_DEBUG" = "true" ] && ARGS="$ARGS --debug"

# Determine the start command
if [ -n "$GH_TOKEN" ]; then
  CMD="bun run dist/main.js start -g $GH_TOKEN $ARGS $*"
else
  CMD="bun run dist/main.js start $ARGS $*"
fi

# Run with varlock (resolves 1Password secrets) or directly
if [ -n "$OP_TOKEN" ] && [ -f ".env.schema" ]; then
  echo "Resolving secrets from 1Password via varlock..."
  exec bunx varlock run -- $CMD
else
  exec $CMD
fi
