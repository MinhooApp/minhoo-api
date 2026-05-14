#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/minhoo-api/minhoo_api"
ENV_FILE="$APP_DIR/.env"
SECRETS_DIR="$APP_DIR/.secrets"
BACKUP_BASE_DIR="/var/backups/minhoo/db"
KEY_DIR="/etc/minhoo/backup"
KEY_FILE="$KEY_DIR/db_backup_key"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-45}"

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
  echo "[backup-db][ERROR] DB password is empty."
  exit 1
fi

mkdir -p "$BACKUP_BASE_DIR" "$KEY_DIR"
chmod 700 /var/backups/minhoo "$BACKUP_BASE_DIR" "$KEY_DIR" 2>/dev/null || true

if [[ ! -f "$KEY_FILE" ]]; then
  umask 077
  openssl rand -hex 64 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="minhoo-db-$TS"
TMP_SQL_GZ="/tmp/$BASENAME.sql.gz"
ENC_FILE="$BACKUP_BASE_DIR/$BASENAME.sql.gz.enc"
SHA_FILE="$ENC_FILE.sha256"
MANIFEST_FILE="$BACKUP_BASE_DIR/$BASENAME.manifest.json"

cleanup() {
  rm -f "$TMP_SQL_GZ"
}
trap cleanup EXIT

MYSQL_PWD="$DB_PASS" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --triggers \
  --no-tablespaces \
  --set-gtid-purged=OFF \
  "$DB_NAME" | gzip -9 > "$TMP_SQL_GZ"

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$TMP_SQL_GZ" \
  -out "$ENC_FILE" \
  -pass "file:$KEY_FILE"

sha256sum "$ENC_FILE" > "$SHA_FILE"

cat > "$MANIFEST_FILE" <<JSON
{
  "created_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "db_name": "$DB_NAME",
  "db_host": "$DB_HOST",
  "db_port": $DB_PORT,
  "file": "$(basename "$ENC_FILE")",
  "sha256_file": "$(basename "$SHA_FILE")",
  "retention_days": $RETENTION_DAYS
}
JSON

chmod 600 "$ENC_FILE" "$SHA_FILE" "$MANIFEST_FILE"

find "$BACKUP_BASE_DIR" -type f -name 'minhoo-db-*.sql.gz.enc' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_BASE_DIR" -type f -name 'minhoo-db-*.sql.gz.enc.sha256' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_BASE_DIR" -type f -name 'minhoo-db-*.manifest.json' -mtime +"$RETENTION_DAYS" -delete

echo "[backup-db] ok file=$ENC_FILE"
