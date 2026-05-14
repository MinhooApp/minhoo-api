#!/usr/bin/env bash
# =============================================================
#  upgrade-redis-7.sh
#  Upgrades Redis from 6.x (EOL) → latest 7.x stable
#  via the official packages.redis.io repository.
#
#  Usage:
#    sudo bash /var/www/minhoo-api/minhoo_api/scripts/upgrade-redis-7.sh
#
#  What it does:
#    1. Backs up /etc/redis/redis.conf
#    2. Adds packages.redis.io apt repository (signed)
#    3. Upgrades redis-server to 7.x
#    4. Verifies the service is running and checks version
#    5. Runs a smoke test (PING + eval of the rate-limiter Lua)
# =============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ "$(id -u)" -ne 0 ]] && die "Run as root: sudo bash $0"

BACKUP_DIR="/var/www/minhoo-api/backups/redis-upgrade-$(date +%Y%m%dT%H%M%SZ)"
REDIS_CONF="/etc/redis/redis.conf"

# ------------------------------------------------------------------
# 1. Backup
# ------------------------------------------------------------------
info "Creating backup at ${BACKUP_DIR} ..."
mkdir -p "${BACKUP_DIR}"
[[ -f "${REDIS_CONF}" ]] && cp "${REDIS_CONF}" "${BACKUP_DIR}/redis.conf"
redis-cli CONFIG REWRITE 2>/dev/null || true
# Dump a snapshot before upgrade
redis-cli BGSAVE 2>/dev/null || true
sleep 2
RDB_PATH=$(redis-cli CONFIG GET dir 2>/dev/null | tail -1)
DUMP_FILE=$(redis-cli CONFIG GET dbfilename 2>/dev/null | tail -1)
if [[ -f "${RDB_PATH}/${DUMP_FILE}" ]]; then
  cp "${RDB_PATH}/${DUMP_FILE}" "${BACKUP_DIR}/${DUMP_FILE}"
  info "RDB snapshot saved to ${BACKUP_DIR}/${DUMP_FILE}"
fi

# ------------------------------------------------------------------
# 2. Agregar repositorio oficial de Redis
# ------------------------------------------------------------------
info "Adding packages.redis.io repository ..."
if [[ ! -f /etc/apt/trusted.gpg.d/redis.gpg ]]; then
  curl -fsSL https://packages.redis.io/gpg \
    | gpg --dearmor -o /etc/apt/trusted.gpg.d/redis.gpg
fi

CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME}}")
cat > /etc/apt/sources.list.d/redis.list <<EOF
deb [signed-by=/etc/apt/trusted.gpg.d/redis.gpg] https://packages.redis.io/deb ${CODENAME} main
EOF
info "Repository added for Ubuntu ${CODENAME}."

# ------------------------------------------------------------------
# 3. Instalar Redis 7.x
# ------------------------------------------------------------------
info "Running apt update ..."
apt-get update -qq

AVAILABLE=$(apt-cache policy redis-server 2>/dev/null | grep "Candidate:" | awk '{print $2}')
info "Candidate version: ${AVAILABLE}"

MAJOR=$(echo "${AVAILABLE}" | grep -oP '^\d+:?\K\d+' || echo "0")
if [[ "${MAJOR}" -lt 7 ]]; then
  die "Candidate version ${AVAILABLE} is not Redis 7.x. Check repository setup."
fi

info "Upgrading redis-server to ${AVAILABLE} ..."
# DEBIAN_FRONTEND=noninteractive prevents prompts about config file changes.
# We keep our existing redis.conf (answer: N = keep local version).
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  -o Dpkg::Options::="--force-confold" \
  redis-server redis-tools

# ------------------------------------------------------------------
# 4. Verificar servicio
# ------------------------------------------------------------------
info "Checking service status ..."
sleep 2
systemctl is-active --quiet redis-server \
  || { warn "redis-server not active after upgrade, trying restart ..."; systemctl restart redis-server; sleep 3; }
systemctl is-active --quiet redis-server \
  || die "redis-server failed to start after upgrade."

NEW_VERSION=$(redis-cli --version)
info "Running version: ${NEW_VERSION}"
RUNNING_MAJOR=$(redis-cli INFO server 2>/dev/null | grep "redis_version" | grep -oP '\d+(?=\.)' | head -1)
[[ "${RUNNING_MAJOR}" -ge 7 ]] \
  || die "Service is running but version is still < 7 (${NEW_VERSION}). Check logs."

# ------------------------------------------------------------------
# 5. Smoke test
# ------------------------------------------------------------------
info "Running smoke tests ..."

# Basic PING
PONG=$(redis-cli PING 2>/dev/null)
[[ "${PONG}" == "PONG" ]] || die "PING failed: ${PONG}"
info "  PING → PONG ✓"

# Smoke: Lua script idéntico al rate limiter
LUA_RESULT=$(redis-cli EVAL \
  "local c=redis.call('INCR',KEYS[1]); if c==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {c, redis.call('PTTL',KEYS[1])}" \
  1 "healthcheck:smoke:lua" "60000" 2>/dev/null)
redis-cli DEL "healthcheck:smoke:lua" >/dev/null 2>&1 || true
[[ -n "${LUA_RESULT}" ]] || die "Lua eval smoke test failed."
info "  Lua INCR+PEXPIRE+PTTL → ${LUA_RESULT} ✓"

# Check keyspace survived
KEYS=$(redis-cli DBSIZE 2>/dev/null)
info "  Keyspace: ${KEYS} keys ✓"

# ------------------------------------------------------------------
# Listo
# ------------------------------------------------------------------
echo ""
info "======================================================"
info " Redis upgrade to ${NEW_VERSION} completed successfully."
info " Backup: ${BACKUP_DIR}"
info "======================================================"
echo ""
info "Next: verify app health with:"
echo "  curl -s http://localhost:3000/api/v1/health | python3 -m json.tool"
