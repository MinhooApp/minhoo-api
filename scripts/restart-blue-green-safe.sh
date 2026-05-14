#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash /var/www/minhoo-api/minhoo_api/scripts/restart-blue-green-safe.sh"
  exit 1
fi

unit_exists() {
  local service="$1"
  systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | \
    awk -v svc="${service}" '$1 == svc { found=1 } END { exit(found ? 0 : 1) }'
}

unit_state() {
  local service="$1"
  systemctl is-active "${service}" 2>/dev/null || true
}

unit_fragment() {
  local service="$1"
  systemctl show "${service}" -p FragmentPath --value 2>/dev/null || true
}

stop_conflicting_service() {
  local service="$1"
  local target_service="${2:-}"
  if ! unit_exists "${service}"; then
    return 0
  fi

  if [[ -n "${target_service}" ]] && unit_exists "${target_service}"; then
    local source_fragment target_fragment
    source_fragment="$(unit_fragment "${service}")"
    target_fragment="$(unit_fragment "${target_service}")"
    if [[ -n "${source_fragment}" && "${source_fragment}" == "${target_fragment}" ]]; then
      echo "Skipping conflict stop for ${service}; it aliases ${target_service}."
      return 0
    fi
  fi

  local state
  state="$(unit_state "${service}")"
  if [[ "${state}" == "active" || "${state}" == "activating" || "${state}" == "reloading" ]]; then
    echo "Stopping conflicting service ${service} (state=${state}) to avoid port collision on :3002..."
    systemctl stop "${service}" || true
  fi
}

resolve_third_node_service() {
  if unit_exists "minhoo-api-3.service"; then
    echo "minhoo-api-3.service"
    return 0
  fi
  # Legacy fallback for older hosts that still use the historical service name.
  if unit_exists "minhoo-api-yello.service"; then
    echo "warning: using legacy third-node unit minhoo-api-yello.service; migrate to minhoo-api-3.service" >&2
    echo "minhoo-api-yello.service"
    return 0
  fi
  echo "Unable to locate third-node service (expected minhoo-api-3.service)." >&2
  return 1
}

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

THIRD_SERVICE="$(resolve_third_node_service)"
if [[ "${THIRD_SERVICE}" == "minhoo-api-3.service" ]]; then
  stop_conflicting_service "minhoo-api-yello.service" "${THIRD_SERVICE}"
else
  stop_conflicting_service "minhoo-api-3.service" "${THIRD_SERVICE}"
fi

restart_with_health \
  "${THIRD_SERVICE}" \
  "http://127.0.0.1:3002/api/v1/ping" \
  "http://127.0.0.1:3002/api/v1/ready" \
  "http://127.0.0.1:3002/api/v1"
echo "Rolling restart completed successfully."
