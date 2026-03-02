#!/bin/sh
set -e

cd "$(dirname "$0")"

echo "Pulling latest code..."
git pull

echo "Rebuilding and restarting..."
docker compose up -d --build

echo "Cleaning old images..."
docker image prune -f

echo "Done. Current status:"
docker compose ps
