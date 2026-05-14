#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSET_DIR="${ROOT_DIR}/ops/monitoring"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash ${ASSET_DIR}/install-feed-slo-monitoring.sh"
  exit 1
fi

echo "[1/4] Installing SLO sampler/report service and timer files..."
install -m 0644 "${ASSET_DIR}/minhoo-feed-slo-sampler.service" /etc/systemd/system/minhoo-feed-slo-sampler.service
install -m 0644 "${ASSET_DIR}/minhoo-feed-slo-sampler.timer" /etc/systemd/system/minhoo-feed-slo-sampler.timer
install -m 0644 "${ASSET_DIR}/minhoo-feed-slo-report.service" /etc/systemd/system/minhoo-feed-slo-report.service
install -m 0644 "${ASSET_DIR}/minhoo-feed-slo-report.timer" /etc/systemd/system/minhoo-feed-slo-report.timer

echo "[2/4] Reloading systemd daemon..."
systemctl daemon-reload

echo "[3/4] Ensuring writable sample file for appuser..."
SAMPLES_FILE="$(
  grep -E '^FEED_SLO_24H_SAMPLES_FILE=' "${ROOT_DIR}/.env" 2>/dev/null | tail -n 1 | cut -d'=' -f2- || true
)"
SAMPLES_FILE="${SAMPLES_FILE:-/tmp/minhoo-feed-slo-samples.jsonl}"
mkdir -p "$(dirname "${SAMPLES_FILE}")"
touch "${SAMPLES_FILE}"
chown appuser:appuser "${SAMPLES_FILE}" || true
chmod 0664 "${SAMPLES_FILE}" || true

echo "[4/5] Enabling and starting timers..."
systemctl enable --now minhoo-feed-slo-sampler.timer
systemctl enable --now minhoo-feed-slo-report.timer

echo "[5/5] Current timer status:"
systemctl --no-pager status minhoo-feed-slo-sampler.timer -n 20
systemctl --no-pager status minhoo-feed-slo-report.timer -n 20
systemctl --no-pager list-timers minhoo-feed-slo-sampler.timer minhoo-feed-slo-report.timer

echo "Done. SLO sampler runs every 5 minutes and report runs daily."
