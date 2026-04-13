#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash /var/www/minhoo-api/minhoo_api/scripts/restart-blue-green-safe.sh"
  exit 1
fi

wait_http_200() {
  local url="$1"
  local label="$2"
  local timeout_s="${3:-45}"
  local start_ts
  start_ts="$(date +%s)"
  while true; do
    if curl -fsS --max-time 2 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    if (( "$(date +%s)" - start_ts >= timeout_s )); then
      echo "Timeout waiting for ${label}: ${url}"
      return 1
    fi
    sleep 1
  done
}

warmup_instance() {
  local api_base="$1"
  local label="$2"
  local -a warmup_paths=(
    "/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5"
    "/post?summary=1&page=0&size=20"
    "/post/suggested?summary=1&page=0&size=20"
    "/reel?summary=1&page=0&size=20"
    "/reel/suggested?summary=1&page=0&size=20"
  )

  echo "Warming ${label} feed caches..."
  local path
  for path in "${warmup_paths[@]}"; do
    if ! curl -fsS --max-time 4 "${api_base}${path}" >/dev/null 2>&1; then
      echo "  warning: warm-up failed for ${label}: ${path}"
    fi
  done
}

restart_with_health() {
  local service="$1"
  local ping_url="$2"
  local ready_url="$3"
  local api_base="$4"
  echo "Restarting ${service}..."
  systemctl restart "${service}"
  systemctl is-active --quiet "${service}"
  wait_http_200 "${ping_url}" "${service} ping"
  wait_http_200 "${ready_url}" "${service} ready"
  warmup_instance "${api_base}" "${service}"
  echo "${service} is healthy."
}

echo "Starting blue/green rolling restart..."
restart_with_health \
  "minhoo-api.service" \
  "http://127.0.0.1:3000/api/v1/ping" \
  "http://127.0.0.1:3000/api/v1/ready" \
  "http://127.0.0.1:3000/api/v1"
restart_with_health \
  "minhoo-api-green.service" \
  "http://127.0.0.1:3001/api/v1/ping" \
  "http://127.0.0.1:3001/api/v1/ready" \
  "http://127.0.0.1:3001/api/v1"
echo "Rolling restart completed successfully."
