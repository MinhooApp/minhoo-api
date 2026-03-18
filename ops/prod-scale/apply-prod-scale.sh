#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/var/www/minhoo-api/minhoo_api"
ASSET_DIR="${ROOT_DIR}/ops/prod-scale"
TS="$(date +%Y%m%d%H%M%S)"
NGINX_BACKUP_DIR="/etc/nginx/sites-backup"
RESTART_MYSQL=false

if [[ "${1:-}" == "--restart-mysql" ]]; then
  RESTART_MYSQL=true
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash ${ASSET_DIR}/apply-prod-scale.sh [--restart-mysql]"
  exit 1
fi

require_file() {
  local f="$1"
  if [[ ! -f "${f}" ]]; then
    echo "Missing required file: ${f}"
    exit 1
  fi
}

require_file "${ASSET_DIR}/minhoo-api-green.service"
require_file "${ASSET_DIR}/api.minhoo.xyz"
require_file "${ASSET_DIR}/z-minhoo-tuning.cnf"

echo "[1/8] Creating backups..."
mkdir -p "${NGINX_BACKUP_DIR}"
cp -a /etc/systemd/system/minhoo-api.service "/etc/systemd/system/minhoo-api.service.bak.${TS}"
if [[ -f /etc/systemd/system/minhoo-api-green.service ]]; then
  cp -a \
    /etc/systemd/system/minhoo-api-green.service \
    "/etc/systemd/system/minhoo-api-green.service.bak.${TS}"
fi
cp -a \
  /etc/nginx/sites-enabled/api.minhoo.xyz \
  "${NGINX_BACKUP_DIR}/api.minhoo.xyz.bak.${TS}"
cp -a /etc/mysql/mysql.conf.d/mysqld.cnf "/etc/mysql/mysql.conf.d/mysqld.cnf.bak.${TS}"
if [[ -f /etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf ]]; then
  cp -a \
    /etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf \
    "/etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf.bak.${TS}"
fi
if [[ -f "${ROOT_DIR}/.env.green" ]]; then
  cp -a "${ROOT_DIR}/.env.green" "${ROOT_DIR}/.env.green.bak.${TS}"
fi

echo "[2/8] Preparing green environment..."
cp -a "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.green"
if grep -q '^PORT=' "${ROOT_DIR}/.env.green"; then
  sed -i 's/^PORT=.*/PORT=3001/' "${ROOT_DIR}/.env.green"
else
  echo "PORT=3001" >> "${ROOT_DIR}/.env.green"
fi
chmod 640 "${ROOT_DIR}/.env.green"
chmod 755 "${ROOT_DIR}/src/_data" "${ROOT_DIR}/src/_data/catalog" 2>/dev/null || true

echo "[3/8] Installing systemd green service..."
install -m 0644 "${ASSET_DIR}/minhoo-api-green.service" /etc/systemd/system/minhoo-api-green.service

echo "[4/8] Installing Nginx blue/green upstream config..."
install -m 0644 "${ASSET_DIR}/api.minhoo.xyz" /etc/nginx/sites-enabled/api.minhoo.xyz

echo "[5/8] Installing MySQL tuning drop-in..."
install -m 0644 "${ASSET_DIR}/z-minhoo-tuning.cnf" /etc/mysql/mysql.conf.d/z-minhoo-tuning.cnf

echo "[6/8] Reloading systemd and starting green..."
systemctl daemon-reload
systemctl enable minhoo-api-green.service >/dev/null 2>&1 || true
systemctl restart minhoo-api-green.service
sleep 1
systemctl --no-pager --full status minhoo-api-green.service | sed -n '1,25p'

echo "[7/8] Validating and reloading Nginx..."
nginx -t
systemctl reload nginx

echo "[8/8] Basic health checks (blue + green)..."
curl -fsS http://127.0.0.1:3000/api/v1/ping >/dev/null
curl -fsS http://127.0.0.1:3001/api/v1/ping >/dev/null
echo "Blue and green are responding."

echo "[9/9] MySQL tuning activation..."
if [[ "${RESTART_MYSQL}" == "true" ]]; then
  echo "Restarting MySQL now (brief maintenance expected)..."
  systemctl restart mysql
  systemctl --no-pager --full status mysql | sed -n '1,20p'
else
  echo "MySQL was NOT restarted to avoid interruption."
  echo "Run later in maintenance window:"
  echo "  sudo systemctl restart mysql"
fi

echo
echo "Done. Backup timestamp: ${TS}"
echo "Next recommended checks:"
echo "  SMOKE_BASE_URL=http://127.0.0.1:3000 INTERNAL_DEBUG_TOKEN=\"\$(awk -F= '/^INTERNAL_DEBUG_TOKEN=/{print \$2}' ${ROOT_DIR}/.env)\" npm run ops:smoke:release"
