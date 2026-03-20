#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="${ROOT_DIR}/ops/monitoring"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash ${ASSET_DIR}/install-risk-monitor.sh"
  exit 1
fi

echo "[1/4] Installing systemd service and timer files..."
install -m 0644 "${ASSET_DIR}/minhoo-risk-monitor.service" /etc/systemd/system/minhoo-risk-monitor.service
install -m 0644 "${ASSET_DIR}/minhoo-risk-monitor.timer" /etc/systemd/system/minhoo-risk-monitor.timer

echo "[2/4] Reloading systemd daemon..."
systemctl daemon-reload

echo "[3/4] Enabling and starting timer..."
systemctl enable --now minhoo-risk-monitor.timer

echo "[4/4] Current timer status:"
systemctl --no-pager status minhoo-risk-monitor.timer -n 30
systemctl --no-pager list-timers minhoo-risk-monitor.timer

echo "Done. Risk monitor will run every minute."

