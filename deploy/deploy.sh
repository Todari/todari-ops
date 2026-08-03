#!/usr/bin/env bash
# Build & deploy from local laptop to EC2 over SSH.
# Usage: EC2_HOST=ubuntu@<ip> ./deploy/deploy.sh

set -euo pipefail

: "${EC2_HOST:?set EC2_HOST=user@host (e.g. ubuntu@1.2.3.4)}"
EC2_PATH="${EC2_PATH:-~/todari-ops}"
SSH_KEY="${SSH_KEY:-}"

SSH_OPTS=()
RSYNC_SSH="ssh"
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=("-i" "$SSH_KEY")
  RSYNC_SSH="ssh -i $SSH_KEY"
fi

echo "==> Syncing source to $EC2_HOST:$EC2_PATH (excluding node_modules, .env, data, .git)"
rsync -avz --delete \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.git \
  --exclude=.env \
  --exclude=.env.production \
  --exclude=data \
  --exclude=audit.log \
  -e "$RSYNC_SSH" \
  ./ "$EC2_HOST:$EC2_PATH/"

echo "==> Building & restarting container on remote"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" "cd $EC2_PATH && docker compose --env-file .env.production pull --quiet 2>/dev/null || true && docker compose --env-file .env.production up -d --build"

echo "==> Tailing recent logs (last 50 lines, then Ctrl+C)"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" "cd $EC2_PATH && docker compose logs --tail=50 bot"

echo
echo "Done. To follow logs live: ssh $EC2_HOST 'cd $EC2_PATH && docker compose logs -f bot'"
