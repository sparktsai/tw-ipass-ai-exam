#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8765}"

echo "Starting iPAS AI exam at http://${HOST}:${PORT}/"
exec node server.js
