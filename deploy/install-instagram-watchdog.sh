#!/usr/bin/env bash
# Instagram 침묵 실패 감시와 일일 Insights 수집기를 EC2 호스트에 설치한다.
set -euo pipefail

: "${EC2_HOST:?set EC2_HOST=user@host}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_KEY="${SSH_KEY:-}"
SSH_OPTS=(-o BatchMode=yes)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

ssh "${SSH_OPTS[@]}" "$EC2_HOST" "mkdir -p /home/ubuntu/ops-watchdog"
scp "${SSH_OPTS[@]}" \
  "$ROOT/scripts/instagram-watchdog.py" \
  "$ROOT/scripts/instagram_portfolio.py" \
  "$ROOT/scripts/instagram_reliability.py" \
  "$EC2_HOST:/home/ubuntu/ops-watchdog/"
ssh "${SSH_OPTS[@]}" "$EC2_HOST" '
  chmod 700 /home/ubuntu/ops-watchdog/instagram-watchdog.py \
    /home/ubuntu/ops-watchdog/instagram_portfolio.py \
    /home/ubuntu/ops-watchdog/instagram_reliability.py
  cp /home/ubuntu/ops-watchdog/instagram-watchdog.py /home/ubuntu/ops-watchdog/watchdog.py
  chmod 700 /home/ubuntu/ops-watchdog/watchdog.py
  (crontab -l 2>/dev/null | grep -v "/home/ubuntu/ops-watchdog/instagram-watchdog.py" | grep -v "/home/ubuntu/ops-watchdog/watchdog.py" || true
   echo "7,22,37,52 * * * * /home/ubuntu/jujinmo/.venv/bin/python /home/ubuntu/ops-watchdog/watchdog.py >> /home/ubuntu/ops-watchdog/watchdog.log 2>&1") | crontab -
'

echo "Instagram watchdog + portfolio insights installed"
