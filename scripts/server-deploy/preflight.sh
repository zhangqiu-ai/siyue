#!/usr/bin/env bash
# Read-only preflight for a Siyue deployment on the target host.
#
#   ./preflight.sh --bundle <bundle-dir|bundle.tar.gz> [options]
#
# Options (each also reads the matching environment variable):
#   --env-file <path>         SIYUE_ENV_FILE         default /etc/siyue/siyue.env
#   --secrets-dir <path>      SIYUE_SECRETS_DIR      default /etc/siyue/secrets
#   --version <tag>           SIYUE_VERSION          image tag compose builds/runs
#   --pg-network <name>       SIYUE_PG_NETWORK       default qiuge-private
#   --pg-host <name>          SIYUE_PG_HOST          default qiuge-postgres
#   --pg-port <port>          SIYUE_PG_PORT          default 5432
#   --nginx-sites-file <path> SIYUE_NGINX_SITES_FILE default /etc/nginx/sites-enabled/api.qiugeapp.com
#   --node-image <image>      SIYUE_NODE_IMAGE       default docker.m.daocloud.io/library/node:22-bookworm-slim
#   --container-uid <uid>     SIYUE_CONTAINER_UID    default 1000 (node image user)
#   --allow-no-ledger         accept a deployment where account deletion stays closed
#   --skip-network-probe      skip the throwaway container that proves PG reachability
#
# What it never does: no writes, no restarts, no migrations, no database login beyond a TCP connect,
# no remote change. Secret files are measured (mode, owner, size) and never read or printed.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bundle=""
env_file=${SIYUE_ENV_FILE:-/etc/siyue/siyue.env}
secrets_dir=${SIYUE_SECRETS_DIR:-/etc/siyue/secrets}
version=${SIYUE_VERSION:-}
pg_network=${SIYUE_PG_NETWORK:-qiuge-private}
pg_host=${SIYUE_PG_HOST:-qiuge-postgres}
pg_port=${SIYUE_PG_PORT:-5432}
nginx_sites_file=${SIYUE_NGINX_SITES_FILE:-/etc/nginx/sites-enabled/api.qiugeapp.com}
node_image=${SIYUE_NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm-slim}
container_uid=${SIYUE_CONTAINER_UID:-1000}
network_probe=1
require_ledger=1

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle=$2; shift 2 ;;
    --env-file) env_file=$2; shift 2 ;;
    --secrets-dir) secrets_dir=$2; shift 2 ;;
    --version) version=$2; shift 2 ;;
    --pg-network) pg_network=$2; shift 2 ;;
    --pg-host) pg_host=$2; shift 2 ;;
    --pg-port) pg_port=$2; shift 2 ;;
    --nginx-sites-file) nginx_sites_file=$2; shift 2 ;;
    --node-image) node_image=$2; shift 2 ;;
    --container-uid) container_uid=$2; shift 2 ;;
    --allow-no-ledger) require_ledger=0; shift ;;
    --skip-network-probe) network_probe=0; shift ;;
    --*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) bundle=$1; shift ;;
  esac
done

failures=0
warnings=0
ok() { printf 'ok: %s\n' "$1"; }
warn() { printf 'warn: %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo '?'; }
file_uid() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1" 2>/dev/null || echo '?'; }
env_value() { grep -E "^$1=" "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

echo "== tooling"
if command -v docker >/dev/null 2>&1; then
  ok "docker CLI present"
  if docker compose version >/dev/null 2>&1; then ok "docker compose plugin present"; else fail "docker compose plugin missing"; fi
  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; else fail "docker daemon not reachable"; fi
  if docker image inspect "$node_image" >/dev/null 2>&1; then
    ok "base image $node_image is cached locally (image build needs no registry pull)"
  else
    warn "base image $node_image not cached; the image build would have to pull it or fall back to docker save/load"
  fi
  if sudo -n true 2>/dev/null; then ok "passwordless sudo available for nginx checks and reload"; else warn "sudo -n not usable; nginx -t and reload must be run another way"; fi
else
  fail "docker CLI missing"
fi

echo "== release bundle"
if [ -z "$bundle" ]; then
  fail "--bundle is required (pass the release bundle directory or .tar.gz)"
elif [ ! -e "$bundle" ]; then
  fail "bundle not found: $bundle"
else
  verify_status=1
  if command -v node >/dev/null 2>&1; then
    if "$script_dir/verify-artifact.sh" "$bundle" --no-probe >/dev/null 2>&1; then verify_status=0; fi
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker image inspect "$node_image" >/dev/null 2>&1; then
    bundle_parent=$(cd "$(dirname "$bundle")" && pwd)
    bundle_name=$(basename "$bundle")
    if docker run --rm --network none \
      -v "$script_dir:/verify:ro" -v "$bundle_parent:/input:ro" \
      "$node_image" bash /verify/verify-artifact.sh "/input/$bundle_name" --no-probe >/dev/null 2>&1; then
      verify_status=0
    fi
  fi
  if [ "$verify_status" -eq 0 ]; then
    ok "bundle passes manifest verification (entrypoint probes: run verify-artifact.sh separately)"
  else
    fail "bundle failed verification; run verify-artifact.sh on a Node host or in the cached Node image"
  fi
fi

echo "== capacity (host has 1.6 GB total and qiuge keeps running)"
mem_available_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo '')
if [ -n "$mem_available_mb" ]; then
  if [ "$mem_available_mb" -ge 512 ]; then ok "MemAvailable ${mem_available_mb} MB (siyue containers are capped at 448m + 256m)"; else warn "MemAvailable ${mem_available_mb} MB; siyue container limits total 704 MB"; fi
else
  warn "could not read MemAvailable from /proc/meminfo"
fi
for path in /var/lib/docker /srv/qiuge/data/postgres; do
  if [ -d "$path" ]; then
    free_gb=$(df -Pk "$path" | awk 'NR==2{print int($4/1048576)}')
    if [ "${free_gb:-0}" -ge 3 ]; then ok "$path free ${free_gb} GB"; else warn "$path free ${free_gb} GB; new databases and images need headroom"; fi
  fi
done

echo "== ports"
if command -v ss >/dev/null 2>&1; then
  listeners=$(ss -ltnH 2>/dev/null | awk '{print $4}' || true)
  if grep -Eq '[:.]8787$' <<< "$listeners"; then
    if docker inspect siyue-api >/dev/null 2>&1; then
      warn "127.0.0.1:8787 already bound (siyue-api exists: probably the current deployment)"
    else
      fail "127.0.0.1:8787 already bound by another process"
    fi
  else
    ok "127.0.0.1:8787 free"
  fi
else
  warn "ss not available; port 8787 not checked"
fi

echo "== environment file ($env_file)"
present=""
if [ ! -f "$env_file" ]; then
  fail "env file missing: copy docker/siyue.env.example there, fill it in and chmod 600"
else
  mode=$(file_mode "$env_file")
  if [ "$mode" = 600 ]; then ok "env file mode 600"; else fail "env file mode $mode; expected 600"; fi
  if grep -qE '^SIYUE_MIGRATION_DATABASE_URL=' "$env_file"; then
    fail "env file must not contain SIYUE_MIGRATION_DATABASE_URL: the API refuses to start with migration credentials. Keep it in a separate migration env file"
  else
    ok "no migration credentials in the API env file"
  fi

  required='SIYUE_ENVIRONMENT SIYUE_DATABASE_NAME SIYUE_DATABASE_URL SIYUE_JWT_ISSUER SIYUE_JWT_AUDIENCE SIYUE_JWT_KEY_ID SIYUE_JWT_PRIVATE_KEY_FILE SIYUE_JWT_VERIFY_KEYS_FILE SIYUE_SECRET_ENCRYPTION_KEY_FILE SIYUE_CHALLENGE_PEPPER_FILE SIYUE_TRUSTED_PROXY_CIDRS SIYUE_REGISTRATION_POLICY_FILE'
  known="$required SIYUE_SERVER_HOST SIYUE_SERVER_PORT SIYUE_POSTGRES_MAX_CONNECTIONS SIYUE_EMAIL_ENABLED SIYUE_MAIL_CONFIG_FILE SIYUE_APPLE_ENABLED SIYUE_APPLE_CONFIG_FILE SIYUE_MOCK_AUTH_ENABLED SIYUE_WECHAT_ENABLED SIYUE_DELETION_LEDGER_URL SIYUE_DELETION_LEDGER_DATABASE SIYUE_DELETION_LEDGER_ENVIRONMENT SIYUE_MIGRATION_DATABASE_URL"
  present=$(grep -oE '^[A-Z0-9_]+=' "$env_file" | tr -d '=' | sort -u)
  for name in $required; do
    # A here-string, not "printf | grep -q": with pipefail, grep -q exiting on its first match can
    # return the pipeline as failed and report a present key as missing.
    if grep -qxF "$name" <<< "$present"; then ok "$name set"; else fail "$name missing"; fi
  done
  for name in $present; do
    case " $known " in
      *" $name "*) ;;
      *) warn "unrecognised environment key: $name" ;;
    esac
  done
  for name in SIYUE_MOCK_AUTH_ENABLED SIYUE_WECHAT_ENABLED; do
    value=$(env_value "$name")
    if [ -n "$value" ] && [ "$value" != false ]; then fail "$name must stay false (found a different value)"; fi
  done
  if [ "$(env_value SIYUE_ENVIRONMENT)" != production ]; then fail "SIYUE_ENVIRONMENT must be production"; else ok "SIYUE_ENVIRONMENT=production"; fi
  if [ "$(env_value SIYUE_DATABASE_NAME)" != siyue ]; then fail "SIYUE_DATABASE_NAME must be siyue"; else ok "SIYUE_DATABASE_NAME=siyue"; fi
  if [ "$(env_value SIYUE_JWT_ISSUER)" != 'https://api.qiugeapp.com/api/siyue' ]; then fail "SIYUE_JWT_ISSUER must be the fixed production issuer"; else ok "SIYUE_JWT_ISSUER is the fixed production issuer"; fi
  if [ "$(env_value SIYUE_JWT_AUDIENCE)" != siyue-api ]; then fail "SIYUE_JWT_AUDIENCE must be siyue-api"; else ok "SIYUE_JWT_AUDIENCE=siyue-api"; fi

  db_url=$(env_value SIYUE_DATABASE_URL)
  if [ -z "$db_url" ]; then
    fail "SIYUE_DATABASE_URL empty"
  else
    scheme=${db_url%%://*}
    rest=${db_url#*://}
    credentials=${rest%%@*}
    host_part=${rest##*@}
    db_user=${credentials%%:*}
    db_password=${credentials#*:}
    host_path=${host_part%%\?*}
    db_name=${host_path##*/}
    db_host=${host_path%%/*}
    if [ "$scheme" != postgresql ] && [ "$scheme" != postgres ]; then fail "SIYUE_DATABASE_URL scheme not accepted"; else ok "database url scheme $scheme"; fi
    if [ "$db_user" != siyue_app ]; then fail "database url user must be siyue_app (values are never printed here)"; else ok "database url user siyue_app"; fi
    if [ "$db_name" != "$(env_value SIYUE_DATABASE_NAME)" ]; then fail "database url database does not match SIYUE_DATABASE_NAME"; else ok "database url database $db_name"; fi
    if [ "$db_host" = "$pg_host:$pg_port" ]; then ok "database url host $db_host"; else warn "database url host is not $pg_host:$pg_port; it must be the existing cluster, never a container-local address"; fi
    if [ -z "$db_password" ]; then fail "database url has no password"; fi
  fi

  email_enabled=$(env_value SIYUE_EMAIL_ENABLED)
  case "$email_enabled" in
    true) ok "SIYUE_EMAIL_ENABLED=true (public registration and password reset enabled)" ;;
    false) fail "SIYUE_EMAIL_ENABLED=false: this round needs real external email registration" ;;
    '') fail "SIYUE_EMAIL_ENABLED missing: this round needs real external email registration" ;;
    *) fail "SIYUE_EMAIL_ENABLED must be true or false" ;;
  esac
  if [ "$email_enabled" = true ] && [ -z "$(env_value SIYUE_MAIL_CONFIG_FILE)" ]; then fail "SIYUE_MAIL_CONFIG_FILE missing while email is enabled"; fi
  if [ "$(env_value SIYUE_APPLE_ENABLED)" = true ]; then warn "SIYUE_APPLE_ENABLED=true: without a real Apple config file startup is refused"; fi

  ledger_count=0
  ledger_missing=''
  for name in SIYUE_DELETION_LEDGER_URL SIYUE_DELETION_LEDGER_DATABASE SIYUE_DELETION_LEDGER_ENVIRONMENT; do
    if [ -n "$(env_value "$name")" ]; then ledger_count=$((ledger_count + 1)); else ledger_missing="$ledger_missing $name"; fi
  done
  if [ "$ledger_count" = 3 ]; then
    ok "deletion ledger configured (same PostgreSQL cluster: logical separation, not an independent failure domain)"
    if [ "$(env_value SIYUE_DELETION_LEDGER_DATABASE)" != siyue_deletion_ledger ]; then fail "SIYUE_DELETION_LEDGER_DATABASE must be siyue_deletion_ledger"; fi
    if [ "$(env_value SIYUE_DELETION_LEDGER_ENVIRONMENT)" != production ]; then fail "SIYUE_DELETION_LEDGER_ENVIRONMENT must be production"; fi
  elif [ "$require_ledger" = 1 ]; then
    fail "deletion ledger not configured (missing:$ledger_missing). Account deletion needs it; pass --allow-no-ledger only to deploy with DELETE /v1/me/account closed"
  else
    warn "deletion ledger not configured: DELETE /v1/me/account stays unregistered (--allow-no-ledger)"
  fi
fi

echo "== secret files (mode and owner only, never contents)"
if [ -f "$env_file" ]; then
  if [ ! -d "$secrets_dir" ]; then
    fail "secrets directory missing: $secrets_dir"
  else
    dir_mode=$(file_mode "$secrets_dir")
    dir_uid=$(file_uid "$secrets_dir")
    if [ "$dir_mode" = 700 ]; then ok "secrets directory mode 700"; else fail "secrets directory mode $dir_mode; expected 700"; fi
    if [ "$dir_uid" = "$container_uid" ]; then ok "secrets directory owner uid $dir_uid"; else fail "secrets directory owner uid $dir_uid; the container runs as uid $container_uid and cannot read a 700 directory owned by another uid"; fi
  fi
  for name in SIYUE_JWT_PRIVATE_KEY_FILE SIYUE_JWT_VERIFY_KEYS_FILE SIYUE_SECRET_ENCRYPTION_KEY_FILE SIYUE_CHALLENGE_PEPPER_FILE SIYUE_MAIL_CONFIG_FILE SIYUE_REGISTRATION_POLICY_FILE; do
    path=$(env_value "$name")
    [ -n "$path" ] || continue
    case "$path" in
      /run/siyue-secrets/*) ;;
      *) fail "$name must live under /run/siyue-secrets/ so the container can read it"; continue ;;
    esac
    host_file="$secrets_dir/${path#/run/siyue-secrets/}"
    if [ ! -f "$host_file" ]; then fail "$name: host file $host_file not found"; continue; fi
    mode=$(file_mode "$host_file")
    uid=$(file_uid "$host_file")
    size=$(wc -c < "$host_file" | tr -d ' ')
    if [ "$mode" = 600 ]; then ok "$name mode 600"; else fail "$name mode $mode; the API requires mode 600 for secret files"; fi
    if [ "$uid" = "$container_uid" ]; then ok "$name owner uid $uid"; else fail "$name owner uid $uid but the container runs as uid $container_uid"; fi
    if [ "$size" -gt 0 ]; then ok "$name present ($size bytes)"; else fail "$name is empty"; fi
  done

  policy_path=$(env_value SIYUE_REGISTRATION_POLICY_FILE)
  policy_host=""
  case "$policy_path" in
    /run/siyue-secrets/*) policy_host="$secrets_dir/${policy_path#/run/siyue-secrets/}" ;;
  esac
  if [ -n "$policy_host" ] && [ -f "$policy_host" ]; then
    if command -v python3 >/dev/null 2>&1; then
      if python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["enabled"] is True;assert d["terms"]["url"].startswith("https://api.qiugeapp.com/api/siyue/legal/terms.html");assert d["privacy"]["url"].startswith("https://api.qiugeapp.com/api/siyue/legal/privacy.html")' "$policy_host" >/dev/null 2>&1; then
        ok "registration policy is JSON with enabled=true and both served legal URLs"
      else
        fail "registration policy JSON must set enabled=true and the served /api/siyue/legal/terms.html and /api/siyue/legal/privacy.html URLs"
      fi
    elif grep -q '"enabled"[[:space:]]*:[[:space:]]*true' "$policy_host" && grep -q 'api.qiugeapp.com/api/siyue/legal/terms.html' "$policy_host" && grep -q 'api.qiugeapp.com/api/siyue/legal/privacy.html' "$policy_host"; then
      ok "registration policy contains enabled=true and both legal URLs (text check; python3 unavailable)"
    else
      fail "registration policy must contain enabled=true and the served legal URLs"
    fi
  fi
  if [ -n "$bundle" ] && [ -d "$bundle/legal" ]; then
    ok "release ships legal/ for the nginx alias /opt/siyue/current/legal/"
  elif [ -n "$bundle" ]; then
    fail "release is missing legal/; the nginx legal alias would return 404"
  fi
fi

echo "== docker networks and PostgreSQL reachability"
if ! command -v docker >/dev/null 2>&1; then
  warn "docker unavailable; network checks skipped"
elif ! docker network inspect "$pg_network" >/dev/null 2>&1; then
  fail "network $pg_network not found; the siyue containers could not reach $pg_host"
else
  pg_subnet=$(docker network inspect "$pg_network" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)
  pg_gateway=$(docker network inspect "$pg_network" --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null || true)
  ok "network $pg_network exists (subnet ${pg_subnet:-unknown}, gateway ${pg_gateway:-unknown})"
  if [ "$network_probe" = 1 ]; then
    probe_log=$(mktemp)
    if docker run --rm --network "$pg_network" node:22-bookworm-slim node -e "const net=require('node:net');const dns=require('node:dns');const [host,port]=process.argv.slice(1);dns.lookup(host,(error,address)=>{if(error){console.log('dns_failed');process.exit(2);}const socket=net.connect({host:address,port:Number(port)});socket.setTimeout(5000);socket.on('connect',()=>{socket.end();console.log('reachable');});socket.on('error',()=>{console.log('connect_failed');process.exit(3);});socket.on('timeout',()=>{socket.destroy();console.log('connect_timeout');process.exit(4);});});" "$pg_host" "$pg_port" >"$probe_log" 2>&1; then
      ok "$pg_host:$pg_port reachable from $pg_network (TCP connect only, no database login)"
    else
      warn "could not reach $pg_host:$pg_port from $pg_network ($(tail -1 "$probe_log" 2>/dev/null)); pull node:22-bookworm-slim or re-run when docker networking is healthy"
    fi
    rm -f "$probe_log"
  fi
fi

echo "== first-hop proxy trust"
trusted=$(env_value SIYUE_TRUSTED_PROXY_CIDRS)
if [ -z "$trusted" ]; then
  fail "SIYUE_TRUSTED_PROXY_CIDRS is empty: nginx forwarding would be ignored and every client would share the docker gateway bucket"
else
  siyue_subnet=""
  if command -v docker >/dev/null 2>&1 && docker network inspect siyue-internal >/dev/null 2>&1; then
    siyue_subnet=$(docker network inspect siyue-internal --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)
  fi
  case "$trusted" in
    *0.0.0.0/0*|*::/0*) fail "SIYUE_TRUSTED_PROXY_CIDRS must not trust the whole internet" ;;
    *) ok "SIYUE_TRUSTED_PROXY_CIDRS is an explicit list" ;;
  esac
  case "$trusted" in
    *127.0.0.1/32*|*"${siyue_subnet:-siyue-internal}"*) ok "trusted list covers the host nginx hop (docker bridge peer and/or loopback)" ;;
    *) warn "trusted list covers neither the siyue-internal subnet (${siyue_subnet:-not created yet}) nor 127.0.0.1/32; nginx forwarding would be ignored and clients would share one bucket" ;;
  esac
fi

echo "== compose configuration"
compose_file=""
if [ -n "$bundle" ] && [ -f "$bundle/docker-compose.yml" ]; then compose_file="$bundle/docker-compose.yml"; fi
if [ -z "$compose_file" ] && [ -n "$bundle" ] && [ -f "$bundle" ]; then
  tmp_extract=$(mktemp -d)
  tar -xzf "$bundle" -C "$tmp_extract" 2>/dev/null || true
  found=$(find "$tmp_extract" -maxdepth 2 -name docker-compose.yml | head -1)
  if [ -n "$found" ]; then mkdir -p "$tmp_extract/keep" && cp "$found" "$tmp_extract/keep/docker-compose.yml" && compose_file="$tmp_extract/keep/docker-compose.yml"; fi
fi
if [ -n "$compose_file" ] && [ -n "$version" ] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if SIYUE_VERSION="$version" SIYUE_PG_NETWORK="$pg_network" SIYUE_ENV_FILE="$env_file" SIYUE_SECRETS_DIR="$secrets_dir" \
     docker compose -f "$compose_file" config -q >/dev/null 2>&1; then
    ok "docker compose config -q accepts the compose file and required variables"
  else
    fail "docker compose config -q rejected the configuration (never run it without -q: it prints resolved secrets)"
  fi
else
  warn "compose validation skipped; needs --bundle, --version and a working compose plugin"
fi

echo "== host nginx (/usr/sbin/nginx, site $nginx_sites_file)"
if [ ! -f "$nginx_sites_file" ]; then
  fail "nginx site file not found: $nginx_sites_file"
else
  if grep -q '^ *location \^~ /api/siyue/' "$nginx_sites_file"; then
    ok "/api/siyue/ location present in $nginx_sites_file"
  else
    warn "/api/siyue/ not present yet in $nginx_sites_file (expected before the first snippet insert)"
  fi
  if grep -q '/api/cloud/' "$nginx_sites_file"; then ok "qiuge /api/cloud locations still present in the same file"; fi
  if grep -Eq '^ *location +/api/siyue( |\{)' "$nginx_sites_file"; then
    warn "a bare /api/siyue location without the trailing slash exists; it must not fall through to the qiuge upstream"
  fi
  if sudo -n /usr/sbin/nginx -t >/dev/null 2>&1; then
    ok "sudo -n /usr/sbin/nginx -t passes"
  elif nginx -t >/dev/null 2>&1; then
    ok "nginx -t passes"
  else
    warn "nginx -t could not be run here; run it before reload and never reload a config that fails it"
  fi
fi

printf '\npreflight: %s failure(s), %s warning(s)\n' "$failures" "$warnings"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
printf 'preflight: ready for the main agent to deploy (this script changed nothing)\n'
