#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="${ROOT_DIR}/ops/monitoring"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash ${ASSET_DIR}/install-chat-slo-monitor.sh"
  exit 1
fi

echo "[1/4] Installing chat SLO monitor service, alert service and timer files..."
install -m 0644 "${ASSET_DIR}/minhoo-chat-slo-monitor.service" /etc/systemd/system/minhoo-chat-slo-monitor.service
install -m 0644 "${ASSET_DIR}/minhoo-chat-slo-alert.service" /etc/systemd/system/minhoo-chat-slo-alert.service
install -m 0644 "${ASSET_DIR}/minhoo-chat-slo-monitor.timer" /etc/systemd/system/minhoo-chat-slo-monitor.timer

echo "[2/4] Reloading systemd daemon..."
systemctl daemon-reload

echo "[3/4] Enabling and starting timer..."
systemctl enable --now minhoo-chat-slo-monitor.timer

echo "[4/4] Current timer status:"
systemctl --no-pager status minhoo-chat-slo-monitor.timer -n 30
systemctl --no-pager list-timers minhoo-chat-slo-monitor.timer

echo "Done. Chat SLO monitor will run every 5 minutes."
