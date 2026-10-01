#!/usr/bin/env bash
# Single entry point: select the runtime from the server's persisted configuration.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
compose=(docker compose --env-file .env.production)
if [[ -f .env.content ]]; then compose+=(--env-file .env.content); fi
compose+=(-f docker-compose.yml)
# Let Compose parse dotenv syntax and precedence; never source or print credentials.
enabled=$("${compose[@]}" config --environment | awk -F= '$1 == "CONTENT_ENABLED" {print substr($0, index($0, "=") + 1)}')
case "$enabled" in
  true|1) compose+=(-f docker-compose.content.yml) ;;
  false|0|'') ;;
  *) echo 'CONTENT_ENABLED must be true, false, 1 or 0' >&2; exit 1 ;;
esac
if [[ "${1:-}" == deploy ]]; then
  shift
  "${compose[@]}" build bot
  if [[ "$enabled" == true || "$enabled" == 1 ]]; then
    "${compose[@]}" run --rm --no-deps bot /opt/content-venv/bin/python3 /app/deploy/content_preflight.py
  fi
  "${compose[@]}" up -d --wait --wait-timeout 180 "$@"
else
  "${compose[@]}" "$@"
fi
