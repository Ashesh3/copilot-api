#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ "$(git branch --show-current)" != "master" ]; then
  echo "Refusing to update outside the master branch" >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to update a checkout with tracked changes" >&2
  exit 1
fi

preserve_running_setting() {
  name="$1"
  eval "configured=\${$name-}"
  [ -n "$configured" ] && return 0
  docker inspect copilot-api >/dev/null 2>&1 || return 0
  current="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' copilot-api \
      | awk -v prefix="$name=" \
        'index($0, prefix) == 1 { print substr($0, length(prefix) + 1); exit }'
  )"
  [ -n "$current" ] && export "$name=$current"
  return 0
}

# Keep non-secret deployment policy across a generic Compose update. Secrets
# continue to come exclusively from the configured environment/secret manager.
preserve_running_setting COPILOT_ADMIN_ORIGIN
preserve_running_setting COPILOT_TRUSTED_PROXY_CIDRS

echo "Pulling latest code..."
git pull --ff-only

echo "Validating Compose configuration..."
docker compose config --quiet

echo "Rebuilding and restarting..."
docker compose up -d --build

echo "Waiting for the application healthcheck..."
container_id="$(docker compose ps -q copilot-api)"
[ -n "$container_id" ]
attempt=0
while [ "$attempt" -lt 18 ]; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  [ "$health" = "healthy" ] && break
  if [ "$health" = "unhealthy" ]; then
    echo "Container became unhealthy" >&2
    docker compose logs --tail 100 copilot-api >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 5
done

if [ "${health:-none}" != "healthy" ]; then
  echo "Timed out waiting for a healthy container" >&2
  docker compose logs --tail 100 copilot-api >&2
  exit 1
fi

echo "Cleaning old images..."
docker image prune -f

echo "Done. Current status:"
docker compose ps
