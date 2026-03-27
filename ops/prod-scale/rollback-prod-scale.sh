#!/usr/bin/env bash
set -euo pipefail

TS="$(date +%Y%m%d%H%M%S)"
ROOT_DIR="/var/www/minhoo-api/minhoo_api"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash /var/www/minhoo-api/minhoo_api/ops/prod-scale/rollback-prod-scale.sh"
  exit 1
fi

latest_backup() {
  local pattern="$1"
  ls -1t ${pattern} 2>/dev/null | head -n 1 || true
}

echo "[1/5] Restoring Nginx config backup..."
NGINX_BAK="$(latest_backup /etc/nginx/sites-backup/api.minhoo.xyz.bak.*)"
if [[ -n "${NGINX_BAK}" ]]; then
  cp -a "${NGINX_BAK}" /etc/nginx/sites-enabled/api.minhoo.xyz
  echo "Restored: ${NGINX_BAK}"
else
  echo "No nginx backup found. Skipping."
fi

SECURITY_BAK="$(latest_backup /etc/nginx/conf.d/zz-minhoo-security.conf.bak.*)"
if [[ -n "${SECURITY_BAK}" ]]; then
  cp -a "${SECURITY_BAK}" /etc/nginx/conf.d/zz-minhoo-security.conf
  echo "Restored: ${SECURITY_BAK}"
fi

echo "[2/5] Stopping and disabling green service..."
systemctl stop minhoo-api-green.service >/dev/null 2>&1 || true
systemctl disable minhoo-api-green.service >/dev/null 2>&1 || true

BLUE_BAK="$(latest_backup /etc/systemd/system/minhoo-api.service.bak.*)"
if [[ -n "${BLUE_BAK}" ]]; then
  cp -a "${BLUE_BAK}" /etc/systemd/system/minhoo-api.service
  echo "Restored: ${BLUE_BAK}"
else
  echo "No blue service backup found. Keeping current /etc/systemd/system/minhoo-api.service"
fi

GREEN_BAK="$(latest_backup /etc/systemd/system/minhoo-api-green.service.bak.*)"
if [[ -n "${GREEN_BAK}" ]]; then
  cp -a "${GREEN_BAK}" /etc/systemd/system/minhoo-api-green.service
  echo "Restored: ${GREEN_BAK}"
else
  rm -f /etc/systemd/system/minhoo-api-green.service
fi

echo "[3/5] Reverting MySQL tuning drop-in (if present)..."
if [[ -f /etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf ]]; then
  mv \
    /etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf \
    "/etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf.disabled.${TS}"
  echo "Disabled MySQL tuning drop-in."
fi
if [[ -f "${ROOT_DIR}/.env.green" ]]; then
  mv \
    "${ROOT_DIR}/.env.green" \
    "${ROOT_DIR}/.env.green.disabled.${TS}"
  echo "Disabled ${ROOT_DIR}/.env.green"
fi

echo "[4/5] Reloading daemons..."
systemctl daemon-reload
nginx -t
systemctl reload nginx

echo "[5/5] Rollback completed."
echo "If you need old MySQL runtime settings immediately, restart MySQL in maintenance:"
echo "  sudo systemctl restart mysql"
