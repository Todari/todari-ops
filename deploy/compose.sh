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
  target=${1:-all}
  [[ $# -le 1 ]] && [[ "$target" == all || "$target" == bot || "$target" == content-worker ]] || {
    echo 'Usage: compose.sh deploy [bot|content-worker]' >&2; exit 2;
  }
  if [[ "$enabled" != true && "$enabled" != 1 ]]; then
    [[ "$target" != content-worker ]] || { echo 'Content worker is disabled' >&2; exit 1; }
    "${compose[@]}" -f docker-compose.content.yml stop content-worker
  fi
  if [[ "$target" != content-worker ]]; then
    "${compose[@]}" build bot
    "${compose[@]}" up -d --no-deps --wait --wait-timeout 180 bot
    echo "Discord bot is ready"
  fi
  if [[ "$target" != bot && ( "$enabled" == true || "$enabled" == 1 ) ]]; then
    [[ -f .env.content ]] || { echo ".env.content is required for the content worker" >&2; exit 1; }
    "${compose[@]}" build content-worker
    "${compose[@]}" run --rm --no-deps content-worker /opt/content-venv/bin/python3 /app/deploy/content_preflight.py
    "${compose[@]}" up -d --no-deps --wait --wait-timeout 180 content-worker
  fi
else
  "${compose[@]}" "$@"
fi
