#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "Building Docker image..."
docker compose -f docker-compose.yaml build

echo "Recreating container with its SQLite volume preserved..."
docker compose -f docker-compose.yaml up -d --force-recreate --wait

echo "Done. External port: 8766"
docker compose -f docker-compose.yaml ps
