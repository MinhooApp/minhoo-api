#!/usr/bin/env bash
# =============================================================
#  install-health-monitor.sh
#  Instala minhoo-health-monitor.service como daemon systemd.
#
#  Uso:
#    sudo bash /var/www/minhoo-api/minhoo_api/scripts/install-health-monitor.sh
# =============================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] && die "Run as root: sudo bash $0"

SERVICE_NAME="minhoo-health-monitor"
SCRIPT_PATH="/var/www/minhoo-api/minhoo_api/scripts/health-monitor-daemon.js"
ENV_FILE="/var/www/minhoo-api/minhoo_api/.env"
NODE_BIN=$(which node 2>/dev/null || echo "/usr/bin/node")

[[ -f "${SCRIPT_PATH}" ]] || die "Script not found: ${SCRIPT_PATH}"
[[ -f "${NODE_BIN}" ]]    || die "Node.js not found at ${NODE_BIN}"

info "Installing ${SERVICE_NAME}.service ..."

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Minhoo API Health Monitor
Documentation=https://github.com/minhoo-app/minhoo-api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=appuser
Group=appuser
WorkingDirectory=/var/www/minhoo-api/minhoo_api
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${SCRIPT_PATH}
Restart=always
RestartSec=10

# Output goes to journald (view with: journalctl -u ${SERVICE_NAME} -f)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Limits
LimitNOFILE=4096
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

info "Reloading systemd ..."
systemctl daemon-reload

info "Enabling and starting ${SERVICE_NAME}.service ..."
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"

sleep 3
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  info "✓ ${SERVICE_NAME}.service is running."
  echo ""
  info "Useful commands:"
  echo "  journalctl -u ${SERVICE_NAME} -f          # live logs"
  echo "  systemctl status ${SERVICE_NAME}           # status"
  echo "  systemctl stop ${SERVICE_NAME}             # detener"
  echo "  systemctl restart ${SERVICE_NAME}          # reiniciar"
else
  warn "Service may not be active. Check logs:"
  echo "  journalctl -u ${SERVICE_NAME} -n 30 --no-pager"
  exit 1
fi
