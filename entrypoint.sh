#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command only (token saved to persistent volume)
  exec bun run dist/main.js auth
elif [ -n "$GH_TOKEN" ]; then
  # Token provided via env — pass directly
  exec bun run dist/main.js start -g "$GH_TOKEN" "$@"
else
  # No token env — use file-based auth from persistent storage
  # Mount /root/.local/share/copilot-api to persist across containers
  exec bun run dist/main.js start "$@"
fi
