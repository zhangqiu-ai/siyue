#!/usr/bin/env bash
# Health checks for the deployed Siyue stack.
#
#   ./healthcheck.sh [--api-container siyue-api] [--public https://api.qiugeapp.com/api/siyue]
#                    [--ready-attempts 10] [--ready-interval 3] [--skip-legal]
#
# Loopback checks use host curl when it exists (the deployment host has curl) and fall back to
# node's fetch inside the API container, so this works whether or not curl is installed. The optional
# public check goes through the real nginx route and TLS and additionally proves that
#   * the bare prefix /api/siyue returns 404 (no fall-through to the qiuge service)
#   * unknown /api/siyue paths return 404
#   * legal/terms.html and legal/privacy.html are served read-only with nosniff
#   * the legal directory itself is not listable
# No secret is read or printed.
set -euo pipefail

api_container=siyue-api
public_origin=""
ready_attempts=10
ready_interval=3
check_legal=1

while [ $# -gt 0 ]; do
  case "$1" in
    --api-container) api_container=$2; shift 2 ;;
    --public) public_origin=${2%/}; shift 2 ;;
    --ready-attempts) ready_attempts=$2; shift 2 ;;
    --ready-interval) ready_interval=$2; shift 2 ;;
    --skip-legal) check_legal=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI not found" >&2; exit 1; }
failures=0
ok() { printf 'ok: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }

if command -v curl >/dev/null 2>&1; then
  probe_tool=curl
  ok "probe tool: host curl"
elif docker inspect "$api_container" >/dev/null 2>&1; then
  probe_tool=container
  ok "probe tool: node fetch inside $api_container (no host curl)"
else
  probe_tool=none
fi

if docker inspect "$api_container" >/dev/null 2>&1; then
  revision=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_container" 2>/dev/null || echo unknown)
  started=$(docker inspect -f '{{.State.StartedAt}}' "$api_container" 2>/dev/null || echo unknown)
  ok "container $api_container is up, image revision ${revision:-unknown}, started $started"
else
  fail "container $api_container not found"
fi

# Prints an HTTP status code, or 000 when the request cannot complete.
status_of() {
  case "$probe_tool" in
    curl)
      code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" 2>/dev/null) || code=""
      printf '%s\n' "${code:-000}"
      ;;
    container)
      docker exec "$api_container" node -e "fetch(process.argv[1], {redirect: 'manual'}).then(r => console.log(r.status)).catch(() => console.log(0))" "$1" 2>/dev/null || echo 000
      ;;
    *) printf '000\n' ;;
  esac
}

emit() { printf '%s\n' "$1" | tail -1; }

for endpoint in health/live health/ready; do
  url="http://127.0.0.1:8787/$endpoint"
  status=$(emit "$(status_of "$url")")
  attempt=1
  while [ "$status" != 200 ] && [ "$attempt" -lt "$ready_attempts" ]; do
    sleep "$ready_interval"
    status=$(emit "$(status_of "$url")")
    attempt=$((attempt + 1))
  done
  if [ "$status" = 200 ]; then ok "loopback /$endpoint -> 200 (attempt $attempt)"; else fail "loopback /$endpoint -> $status after $attempt attempt(s)"; fi
done

if [ -n "$public_origin" ]; then
  for endpoint in health/live health/ready; do
    status=$(emit "$(status_of "$public_origin/$endpoint")")
    if [ "$status" = 200 ]; then ok "public $public_origin/$endpoint -> 200"; else fail "public $public_origin/$endpoint -> $status"; fi
  done
  # The bare prefix must be rejected by "location = /api/siyue"; /api/cloud/* must stay qiuge's.
  bare=$(emit "$(status_of "$public_origin")")
  if [ "$bare" = 404 ]; then ok "bare prefix $public_origin -> 404"; else fail "bare prefix $public_origin -> $bare (expected 404)"; fi
  unknown=$(emit "$(status_of "$public_origin/definitely-not-a-route")")
  if [ "$unknown" = 404 ]; then ok "unknown Siyue path -> 404 (no qiuge fallback)"; else fail "unknown Siyue path -> $unknown (expected 404)"; fi
  if [ "$check_legal" = 1 ]; then
    for document in terms privacy; do
      url="$public_origin/legal/$document.html"
      status=$(emit "$(status_of "$url")")
      if [ "$status" = 200 ]; then ok "$url -> 200"; else fail "$url -> $status"; fi
    done
    listing=$(emit "$(status_of "$public_origin/legal/")")
    case "$listing" in
      403|404) ok "legal directory not listable ($listing)" ;;
      *) fail "legal directory listing returned $listing (expected 403 or 404)" ;;
    esac
    if [ "$probe_tool" = curl ]; then
      headers=$(curl -sI -m 10 "$public_origin/legal/terms.html" 2>/dev/null | tr -d '\r' || true)
      if grep -qi '^x-content-type-options:[[:space:]]*nosniff' <<< "$headers"; then
        ok "legal document sends X-Content-Type-Options: nosniff"
      else
        fail "legal document is missing X-Content-Type-Options: nosniff"
      fi
    fi
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf 'healthcheck: failed (%s finding(s))\n' "$failures"
  exit 1
fi
printf 'healthcheck: ok\n'
