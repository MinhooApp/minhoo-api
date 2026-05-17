#!/usr/bin/env bash
# backup-ops-state.sh — backup diario de Grafana + Prometheus config
# Cron: 0 3 * * * root /bin/bash /var/www/minhoo-api/minhoo_api/scripts/backup-ops-state.sh
set -euo pipefail

BACKUP_DIR="/var/backups/minhoo/ops"
RETENTION_DAYS="${OPS_BACKUP_RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_PREFIX="[backup-ops]"

mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

echo "$LOG_PREFIX started ts=$TS"

# ── Grafana DB ────────────────────────────────────────────────────
GRAFANA_DB="/var/lib/grafana/grafana.db"
if [[ -f "$GRAFANA_DB" ]]; then
  OUT="$BACKUP_DIR/grafana-db-$TS.db.gz"
  # sqlite3 hot backup (safe con Grafana corriendo)
  sqlite3 "$GRAFANA_DB" ".backup /tmp/grafana-backup-$TS.db" 2>/dev/null || \
    cp "$GRAFANA_DB" "/tmp/grafana-backup-$TS.db"
  gzip -9 < "/tmp/grafana-backup-$TS.db" > "$OUT"
  rm -f "/tmp/grafana-backup-$TS.db"
  SIZE=$(du -sh "$OUT" | awk '{print $1}')
  echo "$LOG_PREFIX grafana db → $OUT ($SIZE)"
else
  echo "$LOG_PREFIX WARN grafana.db not found at $GRAFANA_DB"
fi

# ── Prometheus config + rules ─────────────────────────────────────
PROM_CONFIG_DIR="/etc/prometheus"
if [[ -d "$PROM_CONFIG_DIR" ]]; then
  OUT="$BACKUP_DIR/prometheus-config-$TS.tar.gz"
  tar czf "$OUT" \
    --exclude="*/console_libraries/*" \
    --exclude="*/consoles/*" \
    "$PROM_CONFIG_DIR" 2>/dev/null
  SIZE=$(du -sh "$OUT" | awk '{print $1}')
  echo "$LOG_PREFIX prometheus config → $OUT ($SIZE)"
fi

# ── Ops config del repo (prometheus.yml, dashboards, alertmanager) ──
OPS_DIR="/var/www/minhoo-api/minhoo_api/ops"
if [[ -d "$OPS_DIR" ]]; then
  OUT="$BACKUP_DIR/ops-configs-$TS.tar.gz"
  tar czf "$OUT" "$OPS_DIR" 2>/dev/null
  SIZE=$(du -sh "$OUT" | awk '{print $1}')
  echo "$LOG_PREFIX ops configs → $OUT ($SIZE)"
fi

# ── Retención ────────────────────────────────────────────────────
PRUNED=$(find "$BACKUP_DIR" -name "*.gz" -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
echo "$LOG_PREFIX pruned $PRUNED files older than ${RETENTION_DAYS}d"

echo "$LOG_PREFIX done"
