#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/minhoo-api/minhoo_api"
ENV_FILE="$APP_DIR/.env"
SECRETS_DIR="$APP_DIR/.secrets"
BACKUP_BASE_DIR="/var/backups/minhoo/db"
KEY_FILE="/etc/minhoo/backup/db_backup_key"
STRICT_MODE="${RESTORE_VERIFY_STRICT:-0}"

MYSQL_BIN="${MYSQL_BIN:-/usr/bin/mysql}"
MYSQLADMIN_BIN="${MYSQLADMIN_BIN:-/usr/bin/mysqladmin}"
MYSQLD_BIN="${MYSQLD_BIN:-/usr/sbin/mysqld}"

TEMP_MYSQL_BASE=""
TEMP_MYSQL_SOCKET=""
ROW_SAMPLE="-1"
STRICT_RESTORE_DONE=0
RESTORE_METHOD="non_destructive"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB:-mnh_db}"
DB_USER="${USER_DB:-minhoo_app}"
DB_PASS="${DB_PASSWORD:-}"
DB_PASS_FILE="${DB_PASSWORD_FILE:-$SECRETS_DIR/db_password}"

if [[ -z "$DB_PASS" || "$DB_PASS" =~ ^__USE_.*_FILE__$ ]]; then
  if [[ -f "$DB_PASS_FILE" ]]; then
    DB_PASS="$(tr -d '\r' < "$DB_PASS_FILE")"
  fi
fi

if [[ -z "$DB_PASS" ]]; then
  echo "[restore-verify][ERROR] DB password is empty."
  exit 1
fi

LATEST_ENC="$(ls -1t "$BACKUP_BASE_DIR"/minhoo-db-*.sql.gz.enc 2>/dev/null | head -n1 || true)"
if [[ -z "$LATEST_ENC" ]]; then
  echo "[restore-verify][ERROR] no backup file found in $BACKUP_BASE_DIR"
  exit 1
fi

LATEST_SHA="$LATEST_ENC.sha256"
if [[ ! -f "$LATEST_SHA" ]]; then
  echo "[restore-verify][ERROR] checksum file missing: $LATEST_SHA"
  exit 1
fi

( cd "$BACKUP_BASE_DIR" && sha256sum -c "$(basename "$LATEST_SHA")" )

TMP_SQL_GZ="/tmp/restore-verify-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
TMP_SQL="/tmp/restore-verify-$(date -u +%Y%m%dT%H%M%SZ).sql"
TMP_DB="mnh_restore_verify_$(date -u +%Y%m%d_%H%M%S)"
TMP_SANITIZED_SQL=""

cleanup() {
  rm -f "$TMP_SQL_GZ"
  rm -f "$TMP_SQL"
  [[ -n "$TMP_SANITIZED_SQL" ]] && rm -f "$TMP_SANITIZED_SQL" || true
  MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "DROP DATABASE IF EXISTS $TMP_DB" >/dev/null 2>&1 || true
  if [[ -n "$TEMP_MYSQL_SOCKET" ]]; then
    "$MYSQLADMIN_BIN" --protocol=socket --socket="$TEMP_MYSQL_SOCKET" -u root shutdown >/dev/null 2>&1 || true
  fi
  if [[ -n "$TEMP_MYSQL_BASE" && -d "$TEMP_MYSQL_BASE" ]]; then
    rm -rf "$TEMP_MYSQL_BASE" || true
  fi
}
trap cleanup EXIT

sanitize_dump_for_restore() {
  local input_file="$1"
  local output_file="$2"
  # Remove explicit DEFINER statements to avoid requiring users that do not
  # exist in a temporary verification instance.
  sed -E \
    -e 's/DEFINER=`[^`]+`@`[^`]+`//g' \
    -e 's/SQL SECURITY DEFINER/SQL SECURITY INVOKER/g' \
    "$input_file" > "$output_file"
}

strict_restore_with_temp_mysql() {
  if [[ ! -x "$MYSQLD_BIN" || ! -x "$MYSQL_BIN" || ! -x "$MYSQLADMIN_BIN" ]]; then
    echo "[restore-verify][WARN] strict temp mysql restore skipped: mysql binaries missing"
    return 1
  fi

  TEMP_MYSQL_BASE="$(mktemp -d /tmp/minhoo-restore-verify-mysql.XXXXXX)"
  local datadir="$TEMP_MYSQL_BASE/data"
  local socket_file="$TEMP_MYSQL_BASE/mysql.sock"
  local pid_file="$TEMP_MYSQL_BASE/mysql.pid"
  local err_file="$TEMP_MYSQL_BASE/mysql.err"
  local temp_dir="$TEMP_MYSQL_BASE/tmp"
  TMP_SANITIZED_SQL="$TEMP_MYSQL_BASE/restore-sanitized.sql"
  TEMP_MYSQL_SOCKET="$socket_file"

  rm -rf "$datadir" >/dev/null 2>&1 || true
  mkdir -p "$temp_dir"

  "$MYSQLD_BIN" --no-defaults --initialize-insecure --user=root --datadir="$datadir" >/dev/null 2>"$err_file" || {
    echo "[restore-verify][WARN] strict temp mysql init failed"
    sed -n '1,80p' "$err_file" || true
    return 1
  }

  sanitize_dump_for_restore "$TMP_SQL" "$TMP_SANITIZED_SQL"

  "$MYSQLD_BIN" \
    --no-defaults \
    --user=root \
    --datadir="$datadir" \
    --socket="$socket_file" \
    --pid-file="$pid_file" \
    --log-error="$err_file" \
    --skip-log-bin \
    --skip-networking \
    --skip-name-resolve \
    --tmpdir="$temp_dir" >/dev/null 2>&1 &

  local ready=0
  for _ in $(seq 1 60); do
    if "$MYSQLADMIN_BIN" --protocol=socket --socket="$socket_file" -u root ping >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    echo "[restore-verify][WARN] strict temp mysql did not become ready"
    sed -n '1,120p' "$err_file" || true
    return 1
  fi

  "$MYSQL_BIN" --protocol=socket --socket="$socket_file" -u root -Nse "CREATE DATABASE restore_verify" >/dev/null
  "$MYSQL_BIN" --protocol=socket --socket="$socket_file" -u root restore_verify < "$TMP_SANITIZED_SQL"

  local table_count
  table_count="$("$MYSQL_BIN" --protocol=socket --socket="$socket_file" -u root -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='restore_verify'")"
  if [[ "${table_count:-0}" -le 0 ]]; then
    echo "[restore-verify][WARN] strict temp mysql restore produced 0 tables"
    return 1
  fi

  ROW_SAMPLE="$("$MYSQL_BIN" --protocol=socket --socket="$socket_file" -u root -Nse "SELECT COUNT(*) FROM restore_verify.services" 2>/dev/null || echo -1)"
  STRICT_RESTORE_DONE=1
  RESTORE_METHOD="temp_mysql_instance"
  return 0
}

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$LATEST_ENC" \
  -out "$TMP_SQL_GZ" \
  -pass "file:$KEY_FILE"

gzip -t "$TMP_SQL_GZ"
gunzip -c "$TMP_SQL_GZ" > "$TMP_SQL"

if ! grep -q 'CREATE TABLE `users`' "$TMP_SQL"; then
  echo "[restore-verify][ERROR] users table definition missing in dump"
  exit 1
fi
if ! grep -q 'CREATE TABLE `services`' "$TMP_SQL"; then
  echo "[restore-verify][ERROR] services table definition missing in dump"
  exit 1
fi
if ! grep -q 'CREATE TABLE `offers`' "$TMP_SQL"; then
  echo "[restore-verify][ERROR] offers table definition missing in dump"
  exit 1
fi

# Strict mode path 1: restore into temporary DB using app DB user (when grants allow).
if MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "CREATE DATABASE $TMP_DB" >/dev/null 2>&1; then
  if MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$TMP_DB" < "$TMP_SQL"; then
    TABLE_COUNT="$(MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TMP_DB'")"
    if [[ "${TABLE_COUNT:-0}" -le 0 ]]; then
      echo "[restore-verify][ERROR] strict restore validation failed (no tables in $TMP_DB)"
      exit 1
    fi
    STRICT_RESTORE_DONE=1
    RESTORE_METHOD="app_user_temp_db"
    ROW_SAMPLE="$(MYSQL_PWD="$DB_PASS" "$MYSQL_BIN" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -Nse "SELECT COUNT(*) FROM $TMP_DB.services" 2>/dev/null || echo -1)"
  elif [[ "$STRICT_MODE" == "1" ]]; then
    echo "[restore-verify][ERROR] strict restore import failed using app DB user"
    exit 1
  else
    echo "[restore-verify][WARN] strict restore import failed with app DB user; keeping non-destructive validation only"
  fi
elif strict_restore_with_temp_mysql; then
  :
else
  if [[ "$STRICT_MODE" == "1" ]]; then
    echo "[restore-verify][ERROR] strict mode enabled but no strict restore path succeeded"
    exit 1
  fi
  echo "[restore-verify][WARN] strict restore unavailable; ran non-destructive validation only"
fi

echo "[restore-verify] ok backup=$(basename "$LATEST_ENC") strict_restore=$STRICT_RESTORE_DONE method=$RESTORE_METHOD services_rows=$ROW_SAMPLE"
