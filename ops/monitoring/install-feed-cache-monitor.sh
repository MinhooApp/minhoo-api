#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="${ROOT_DIR}/ops/monitoring"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash ${ASSET_DIR}/install-feed-cache-monitor.sh"
  exit 1
fi

echo "[1/4] Installing systemd service, alert service and timer files..."
install -m 0644 "${ASSET_DIR}/minhoo-feed-cache-monitor.service" /etc/systemd/system/minhoo-feed-cache-monitor.service
install -m 0644 "${ASSET_DIR}/minhoo-feed-cache-alert.service" /etc/systemd/system/minhoo-feed-cache-alert.service
install -m 0644 "${ASSET_DIR}/minhoo-feed-cache-monitor.timer" /etc/systemd/system/minhoo-feed-cache-monitor.timer

echo "[2/4] Reloading systemd daemon..."
systemctl daemon-reload

echo "[3/4] Enabling and starting timer..."
systemctl enable --now minhoo-feed-cache-monitor.timer

echo "[4/4] Current timer status:"
systemctl --no-pager status minhoo-feed-cache-monitor.timer -n 30
systemctl --no-pager list-timers minhoo-feed-cache-monitor.timer

echo "Done. Feed cache monitor will run every 5 minutes."
