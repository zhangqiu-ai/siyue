#!/usr/bin/env bash
# Builds the Siyue server deployment bundle, repeatably.
#
# Bundle layout (one directory, plus a tarball and its .sha256 beside it):
#   app/                     compiled server + workspace dependencies + migrations + resources + provision SQL
#   Dockerfile               thin runtime image: COPY app/ only
#   docker-compose.yml       siyue-api, siyue-mail-worker
#   siyue.env.example        environment variable names and placeholders (no secrets)
#   .dockerignore            keeps the env file, tarball and manifest out of the image context
#   nginx/                   incremental /api/siyue/ location snippet
#   source/                  pnpm-lock.yaml and pnpm-workspace.yaml as build inputs
#   DEPLOY.md                operator notes (copy of scripts/server-deploy/README.md)
#   DEPLOY-MANIFEST.json     source, inputs, migration checksums and per-file SHA-256
#
# The bundle never contains .env files, tests, private key material or git data; verify-artifact.sh
# proves that after the build.
#
# Usage: build-artifact.sh [--target-platform linux/amd64] [--out <dir>] [--force]
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
lib="$script_dir/lib/artifact.mjs"
target_platform=${SIYUE_ARTIFACT_TARGET_PLATFORM:-linux/amd64}
out_root=${SIYUE_ARTIFACT_DIR:-$repo_root/artifacts/server-deploy}
force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --target-platform) target_platform=$2; shift 2 ;;
    --out) out_root=$2; shift 2 ;;
    --force) force=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in node corepack git tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

cd "$repo_root"
version=$(node -p "require('./apps/server/package.json').version")
commit=$(git rev-parse --short HEAD)
dirty=""
if [ -n "$(git status --porcelain)" ]; then dirty="-dirty"; fi
release="$version-$commit$dirty"
bundle="$out_root/$release"
tarball="$out_root/$release.tar.gz"

if [ -e "$bundle" ] && [ "$force" != 1 ]; then
  echo "bundle already exists: $bundle (pass --force to rebuild it in place)" >&2
  exit 1
fi

# A failed build leaves earlier bytes at the same release path, and a dirty worktree means the git SHA
# cannot tell them apart. Say so loudly instead of letting a stale bundle look current.
on_exit() {
  status=$?
  if [ "$status" != 0 ] && [ -e "$bundle" ]; then
    echo "WARNING: build failed; $bundle and $tarball are from an EARLIER build and must not be shipped." >&2
  fi
  return 0
}
trap on_exit EXIT

echo "== build workspace packages and server (release $release)"
# Run the workspace TypeScript compiler directly, in dependency order. pnpm-workspace.yaml sets
# verifyDepsBeforeRun: error, which aborts on a settings mismatch in an already-installed tree; a
# release build must not reinstall the whole workspace to get around that, and these four builds are
# plain "tsc -p" calls. Dependency resolution for the artifact itself still comes from the lockfile
# through pnpm deploy below.
tsc_bin="$repo_root/node_modules/typescript/bin/tsc"
[ -f "$tsc_bin" ] || { echo "missing $tsc_bin; run: corepack pnpm install" >&2; exit 1; }
for project in packages/contracts packages/domain packages/ai apps/server; do
  echo "-- tsc -p $project/tsconfig.json"
  node "$tsc_bin" -p "$project/tsconfig.json"
done

echo "== pack production dependency tree (pnpm deploy --prod --legacy)"
rm -rf "$bundle"
mkdir -p "$bundle/source"
corepack pnpm --config.verify-deps-before-run=false --filter @siyue/server deploy --prod --legacy "$bundle/app"

echo "== prune sources, tests, caches and type-only files"
# app/public ships the same documents as the bundle-root legal/ directory; the API serves no static
# files, so the copy inside app/ is dropped and only legal/ (published by host nginx) stays.
rm -rf "$bundle/app/src" "$bundle/app/tests" "$bundle/app/public" "$bundle/app/.turbo" "$bundle/app/tsconfig.json" "$bundle/app/README.md"
find "$bundle/app" -type d -name '.turbo' -prune -exec rm -rf {} +
find "$bundle/app" -type d -name src -path '*@siyue*' -prune -exec rm -rf {} +
find "$bundle/app/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \) -prune -exec rm -rf {} +
# Drop type-only noise, but never third-party attribution: LICENSE/COPYING/NOTICE files are part of
# what is being redistributed, and many of them are .md.
find "$bundle/app/node_modules" -type f \( -name '*.md' -o -name '*.map' \) \
  ! -iname 'license*' ! -iname 'licence*' ! -iname 'copying*' ! -iname 'notice*' \
  ! -iname 'copyright*' ! -iname 'authors*' ! -iname 'patents*' -delete
find "$bundle/app" -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' -o -name '*.test.ts' -o -name '*.spec.js' -o -name '*.spec.mjs' \) -delete
# pnpm's legacy deploy leaves one hoisting link that climbs back out of the bundle
# (app/node_modules/.pnpm/node_modules/@siyue/server -> ../../../../../../../../apps/server). Runtime
# resolution never uses it and it would dangle after transfer, so drop every link that escapes.
node -e 'const fs=require("node:fs"),path=require("node:path");const root=path.resolve(process.argv[1]);let removed=0;const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()){const target=fs.readlinkSync(file);if(path.isAbsolute(target)||!path.resolve(path.dirname(file),target).startsWith(root+path.sep)){fs.unlinkSync(file);removed+=1;}}else if(entry.isDirectory()){walk(file);}}};walk(root);console.log("removed_escaping_symlinks="+removed);' "$bundle/app"

echo "== copy deploy files and build inputs"
# The bilingual legal documents are served by the host nginx from the release root
# (alias /opt/siyue/current/legal/), so they ship beside app/, not inside the image.
for document in terms.html privacy.html; do
  [ -f "$repo_root/apps/server/public/legal/$document" ] || { echo "missing apps/server/public/legal/$document" >&2; exit 1; }
done
mkdir -p "$bundle/legal"
cp "$repo_root/apps/server/public/legal/terms.html" "$repo_root/apps/server/public/legal/privacy.html" "$bundle/legal/"
chmod 644 "$bundle/legal/terms.html" "$bundle/legal/privacy.html"
cp "$script_dir/docker/Dockerfile" "$bundle/Dockerfile"
cp "$script_dir/docker/docker-compose.yml" "$bundle/docker-compose.yml"
cp "$script_dir/docker/.dockerignore" "$bundle/.dockerignore"
cp "$script_dir/docker/siyue.env.example" "$bundle/siyue.env.example"
mkdir -p "$bundle/nginx"
cp "$script_dir/nginx/api.qiugeapp.com.siyue-location.conf" "$bundle/nginx/api.qiugeapp.com.siyue-location.conf"
cp "$script_dir/README.md" "$bundle/DEPLOY.md"
cp "$repo_root/pnpm-lock.yaml" "$bundle/source/pnpm-lock.yaml"
cp "$repo_root/pnpm-workspace.yaml" "$bundle/source/pnpm-workspace.yaml"

echo "== write manifest"
node "$lib" manifest --bundle "$bundle" --repo-root "$repo_root" --release "$release" \
  --target-platform "$target_platform" --pnpm-version "$(corepack pnpm -v)"

echo "== verify bundle"
node "$lib" verify --bundle "$bundle"

echo "== create tarball"
rm -f "$tarball" "$tarball.sha256"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$tarball" -C "$out_root" "$release"
sha256_of "$tarball" > "$tarball.sha256"

printf 'release: %s\nbundle: %s\ntarball: %s\ntarball_sha256: %s\n' \
  "$release" "$bundle" "$tarball" "$(cat "$tarball.sha256")"
printf 'next: scripts/server-deploy/verify-artifact.sh %s\n' "$tarball"
