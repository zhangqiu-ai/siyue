#!/usr/bin/env bash
# Verifies a Siyue deployment bundle (directory or .tar.gz) before it is shipped or started.
#
#   ./verify-artifact.sh <bundle-dir|bundle.tar.gz> [--no-probe] [--expect-target linux/amd64]
#
# Checks: tarball digest, per-file SHA-256 from DEPLOY-MANIFEST.json, no unexpected or forbidden files
# (.env, keys, tests, git data), relative-only symlinks, workspace dependencies present in
# node_modules, migration checksums, native prebuilds for the target platform.
#
# With probes enabled it also runs the real entrypoints with an emptied environment, so a check can
# never connect to a database: the API and mail worker must fail fast on missing configuration, and
# argon2/fastify/pg plus the migrations directory must load from the bundle itself.
# No secret value is read or printed.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lib="$script_dir/lib/artifact.mjs"
probe=1
probe_host=0
expect_target=""
input=""

while [ $# -gt 0 ]; do
  case "$1" in
    --no-probe) probe=0; shift ;;
    --probe-host-platform) probe_host=1; shift ;;
    --expect-target) expect_target=$2; shift 2 ;;
    --*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) input=$1; shift ;;
  esac
done

[ -n "$input" ] || { echo "usage: verify-artifact.sh <bundle-dir|bundle.tar.gz> [--no-probe] [--expect-target linux/amd64]" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "missing tool: node" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

workdir=""
bundle=""
cleanup() { if [ -n "$workdir" ]; then rm -rf "$workdir"; fi; return 0; }
trap cleanup EXIT

if [ -d "$input" ]; then
  bundle=$(cd "$input" && pwd)
elif [ -f "$input" ]; then
  if [ -f "$input.sha256" ]; then
    expected_sha=$(cat "$input.sha256")
    actual_sha=$(sha256_of "$input")
    if [ "$expected_sha" != "$actual_sha" ]; then
      echo "FAIL: tarball_sha256_mismatch: $input" >&2
      exit 1
    fi
    echo "ok: tarball sha256 matches $input.sha256"
  else
    echo "note: no $input.sha256 beside the tarball; tarball digest not checked"
  fi
  workdir=$(mktemp -d)
  tar -xzf "$input" -C "$workdir"
  first=""
  for entry in "$workdir"/*; do first=$(basename "$entry"); break; done
  [ -n "$first" ] || { echo "FAIL: tarball does not contain a bundle directory" >&2; exit 1; }
  bundle="$workdir/$first"
else
  echo "FAIL: no such bundle: $input" >&2
  exit 1
fi

echo "== manifest and file integrity"
node "$lib" verify --bundle "$bundle"

manifest_target=$(node -p "require('$bundle/DEPLOY-MANIFEST.json').build.targetPlatform")
if [ -n "$expect_target" ] && [ "$expect_target" != "$manifest_target" ]; then
  echo "FAIL: target platform mismatch: manifest $manifest_target, expected $expect_target" >&2
  exit 1
fi

if [ "$probe" = 1 ]; then
  echo "== entrypoint probes (empty environment, target $manifest_target)"
  app="$bundle/app"
  host_platform="$(node -p 'process.platform')/$(node -p 'process.arch')"
  case "$host_platform" in
    darwin/arm64) host_target="darwin/arm64" ;;
    darwin/x64) host_target="darwin/amd64" ;;
    linux/x64) host_target="linux/amd64" ;;
    linux/arm64) host_target="linux/arm64" ;;
    *) host_target="unknown" ;;
  esac
  probe_runner=""
  if [ "$host_target" = "$manifest_target" ]; then
    probe_runner=host
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    probe_runner=docker
  fi
  if [ "$probe_host" = 1 ] && command -v node >/dev/null 2>&1; then
    probe_runner=host
    if [ "$host_target" != "$manifest_target" ]; then
      echo "note: probes run on the host platform ($host_target) although the bundle targets $manifest_target;"
      echo "note: JavaScript, workspace resolution, migrations and the dependency graph are covered, and the"
      echo "note: native argon2 binding resolved against the host prebuild. The target prebuild presence is"
      echo "note: asserted separately above (nativeModules / targetPrebuilds)."
    fi
  fi

  probe() {
    if [ "$probe_runner" = host ]; then
      ( cd "$app" && env -i PATH="$PATH" HOME="${HOME:-/tmp}" SIYUE_ENVIRONMENT=production NODE_ENV=production node "$@" )
    else
      docker run --rm --platform "$manifest_target" -v "$app":/app:ro -w /app \
        -e SIYUE_ENVIRONMENT=production -e NODE_ENV=production \
        node:22-bookworm-slim node "$@"
    fi
  }

  expect_fail_fast() {
    label=$1
    shift
    set +e
    output=$(probe "$@" 2>&1)
    status=$?
    set -e
    if [ "$status" -eq 1 ] && [ -n "$output" ]; then
      echo "ok: $label fails fast without configuration (exit 1)"
    else
      echo "FAIL: $label unexpectedly exited $status" >&2
      echo "$output" >&2
      exit 1
    fi
  }

  if [ -z "$probe_runner" ]; then
    echo "note: probe_skipped: host is $host_platform, bundle target is $manifest_target, no usable docker CLI"
    echo "note: run this script on the target platform or where docker is available to execute the probes"
  else
    expect_fail_fast "api entrypoint" dist/index.js
    expect_fail_fast "mail worker entrypoint" dist/mail-worker.js
    set +e
    output=$(probe --input-type=module -e "await import('argon2'); await import('fastify'); await import('pg'); await import('nodemailer'); await import('jose'); await import('zod'); console.log('dependencies loaded')" 2>&1)
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      echo "ok: runtime dependencies load from the bundle (argon2 native, fastify, pg, nodemailer, jose, zod)"
    else
      echo "FAIL: runtime dependency probe exited $status" >&2
      echo "$output" >&2
      exit 1
    fi
    set +e
    output=$(probe --input-type=module -e "const {readMigrations} = await import('./dist/adapters/postgres/migrate.js'); const migrations = await readMigrations(); console.log('migrations ' + migrations.length)" 2>&1)
    status=$?
    set -e
    manifest_migrations=$(node -p "require('$bundle/DEPLOY-MANIFEST.json').migrations.length")
    if [ "$status" -eq 0 ] && [ "$output" = "migrations $manifest_migrations" ]; then
      echo "ok: migrations resolve inside the bundle ($manifest_migrations files)"
    else
      echo "FAIL: migration read probe exited $status with '$output' (manifest says $manifest_migrations)" >&2
      exit 1
    fi
  fi
fi

echo "verify-artifact: ok ($bundle)"
