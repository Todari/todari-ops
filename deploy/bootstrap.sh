#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu EC2 instance.
# Run AS the ssh user (e.g. ubuntu), NOT as root.
# After this finishes, log out & back in to pick up the docker group.

set -euo pipefail

echo "==> Updating apt + installing basics"
sudo apt-get update -y
sudo apt-get install -y curl rsync git ca-certificates gnupg

echo "==> Installing Docker (official convenience script)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "    docker installed; you must log out/in (or 'newgrp docker') for group to take effect"
else
  echo "    docker already present, skipping"
fi

echo "==> Verifying compose plugin"
docker compose version >/dev/null 2>&1 || {
  echo "!!  'docker compose' plugin missing. Install with:"
  echo "    sudo apt-get install -y docker-compose-plugin"
  exit 1
}

echo "==> Preparing app directory"
mkdir -p ~/todari-ops
echo "    ~/todari-ops ready"

echo "==> Setting up basic firewall (UFW) — only SSH inbound, all outbound"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw --force reset >/dev/null
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow ssh
  sudo ufw --force enable
  echo "    UFW: inbound SSH only, all outbound allowed (Discord gateway OK)"
else
  echo "    ufw not available; rely on AWS security group instead"
fi

echo
echo "Bootstrap complete."
echo "Next: from your laptop, run:"
echo "  EC2_HOST=ubuntu@<ip> ./deploy/secrets.sh    # one-time, pushes .env.production"
echo "  EC2_HOST=ubuntu@<ip> ./deploy/deploy.sh     # build + up"
