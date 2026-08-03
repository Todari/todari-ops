#!/usr/bin/env bash
# One-time push of .env.production from laptop to EC2.
# Usage:
#   1. Locally: cp .env .env.production  (then edit so values match prod)
#   2. EC2_HOST=ubuntu@<ip> ./deploy/secrets.sh

set -euo pipefail

: "${EC2_HOST:?set EC2_HOST=user@host}"
EC2_PATH="${EC2_PATH:-~/todari-ops}"
SSH_KEY="${SSH_KEY:-}"

SSH_OPTS=()
SCP_SSH="scp"
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=("-i" "$SSH_KEY")
  SCP_SSH="scp -i $SSH_KEY"
fi

if [[ ! -f .env.production ]]; then
  echo "!! .env.production not found. Create it (see .env.production.example)."
  echo "   Tip: cp .env .env.production && \$EDITOR .env.production"
  exit 1
fi

echo "==> Ensuring remote dir exists"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" "mkdir -p $EC2_PATH"

echo "==> Uploading .env.production (chmod 600 on remote)"
$SCP_SSH .env.production "$EC2_HOST:$EC2_PATH/.env.production"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" "chmod 600 $EC2_PATH/.env.production"

echo
echo "Secrets installed on $EC2_HOST:$EC2_PATH/.env.production"
echo "Next: ./deploy/deploy.sh"
