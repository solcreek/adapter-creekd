#!/usr/bin/env bash
# Next.js adapter test suite - deploy script
#
# Contract:
# - cwd is an isolated test app created by the Next.js harness
# - exit non-zero on failure
# - print ONLY the deployment URL to stdout
# - write diagnostics to stderr or files
set -euo pipefail

ADAPTER_PATH="${ADAPTER_DIR}/dist/index.js"
ADAPTER_SERVER_WRAPPER="${ADAPTER_DIR}/dist/server-wrapper.js"
APP_DIR="${PWD}"
NPM_CACHE_DIR="${TMPDIR:-/tmp}/adapter-creekd-npm-cache"
PNPM_STORE_DIR="${TMPDIR:-/tmp}/adapter-creekd-pnpm-store-shared"
mkdir -p "${NPM_CACHE_DIR}" "${PNPM_STORE_DIR}"

export VERCEL_ENV="${VERCEL_ENV:-preview}"
export VERCEL="${VERCEL:-1}"
export NEXT_PRIVATE_TEST_MODE="${NEXT_PRIVATE_TEST_MODE:-e2e}"
export CREEK_NEXT_CACHE_DIR="${CREEK_NEXT_CACHE_DIR:-${APP_DIR}/.adapter-creekd-cache}"
export CREEK_NEXT_CACHE_L1_ENTRIES="${CREEK_NEXT_CACHE_L1_ENTRIES:-2048}"
export SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"

log() {
  printf '[adapter-creekd] %s %s\n' "$(date '+%H:%M:%S')" "$*" >&2
}

ensure_pnpm_build_policy() {
  node -e "
const fs = require('fs');
const file = 'pnpm-workspace.yaml';
const allowBlock = 'allowBuilds:\\n  core-js: true\\n  protobufjs: true\\n  sharp: true\\n';
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
text = text.replace(/^allowBuilds:\\n(?:[ \\t].*(?:\\n|$))*/m, '');
text = allowBlock + text.replace(/^\\n+/, '');
if (!text.endsWith('\\n')) text += '\\n';
fs.writeFileSync(file, text);
" >&2
}

log "pwd=${PWD}"
log "Installing adapter..."
if [ -n "${ADAPTER_TARBALL:-}" ] && [ -f "${ADAPTER_TARBALL}" ]; then
  log "Using tarball: ${ADAPTER_TARBALL}"
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@solcreek/adapter-creekd'] = 'file:${ADAPTER_TARBALL}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2
else
  log "ADAPTER_TARBALL missing or unreadable (=${ADAPTER_TARBALL:-<unset>}); falling back to file:${ADAPTER_DIR}"
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['@solcreek/adapter-creekd'] = 'file:${ADAPTER_DIR}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2
fi

PKG_MANAGER=$(node -e "try{const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));console.log(p.packageManager||'')}catch{console.log('')}")
log "Installing project dependencies..."
if [[ "${PKG_MANAGER}" == npm@* ]]; then
  npm install --legacy-peer-deps --cache "${NPM_CACHE_DIR}" --prefer-offline --no-audit --no-fund >&2 2>&1
else
  ensure_pnpm_build_policy
  pnpm install --store-dir "${PNPM_STORE_DIR}" --no-frozen-lockfile --prefer-offline --config.dangerouslyAllowAllBuilds=true >&2 2>&1
fi
log "package install complete"

UNSAFE_PORTS=" 1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 5060 5061 6000 6566 6665 6666 6667 6668 6669 6697 10080 "
for _ in 1 2 3 4 5 6 7 8 9 10; do
  PORT=$((3000 + RANDOM % 10000))
  case "${UNSAFE_PORTS}" in
    *" ${PORT} "*) continue ;;
    *) break ;;
  esac
done

export NEXT_ADAPTER_PATH="${ADAPTER_PATH}"
export NEXT_DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-local-${PORT}}"
log "Pre-allocated PORT=${PORT}, NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}"

log "Running next build via package script..."
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const script = pkg.scripts && pkg.scripts.build;
if (script && !script.includes('--experimental-next-config-strip-types')) {
  pkg.scripts.build = script.replace(
    /\\bnext build\\b/,
    'next build --experimental-next-config-strip-types'
  );
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
}
" >&2 2>&1

if node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));process.exit(p.scripts&&p.scripts.build?0:1);" 2>/dev/null; then
  if [[ "${PKG_MANAGER}" == npm@* ]]; then
    npm run build 2>&1 | tee .adapter-build-cli.log >&2
  else
    ensure_pnpm_build_policy
    pnpm run build 2>&1 | tee .adapter-build-cli.log >&2
  fi
else
  npx next build --experimental-next-config-strip-types 2>&1 | tee .adapter-build-cli.log >&2
fi
log "next build complete"

# The standalone output intentionally omits public/ and .next/static. Ensure
# every fixture gets the same postbuild asset layout regardless of whether its
# package.json has a postbuild lifecycle script.
node "${ADAPTER_DIR}/dist/cli.js" postbuild --project-dir "${PWD}" 2>&1 | tee -a .adapter-build-cli.log >&2

BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")
BASE_PATH=$(node -e "
  try {
    const f = require('fs').readFileSync('.next/required-server-files.json','utf8');
    console.log(JSON.parse(f).config.basePath || '');
  } catch { console.log(''); }
" 2>/dev/null || echo "")
HEALTHCHECK_PATH="${BASE_PATH}/_next/static/${BUILD_ID}/_buildManifest.js"

SERVER_FILE=$(node -e "
const fs = require('fs');
const path = require('path');
const standalone = path.join(process.cwd(), '.next', 'standalone');
const standard = path.join(standalone, 'server.js');
if (fs.existsSync(standard)) {
  console.log(standard);
  process.exit(0);
}
const matches = [];
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.isFile() && entry.name === 'server.js') matches.push(full);
  }
}
visit(standalone);
if (matches.length !== 1) {
  console.error('expected exactly one standalone server.js, found ' + matches.length);
  process.exit(1);
}
console.log(matches[0]);
")
SERVER_DIR=$(dirname "${SERVER_FILE}")

ADAPTER_HOST="${ADAPTER_HOST:-127.0.0.1}"
export HOSTNAME="${ADAPTER_HOST}"
export NODE_ENV="${NODE_ENV:-production}"
export PORT

log "Starting standalone server on port ${PORT}..."
cd "${SERVER_DIR}"
if [ -f "${ADAPTER_SERVER_WRAPPER}" ]; then
  START_CMD=(node "${ADAPTER_SERVER_WRAPPER}" "${SERVER_FILE}")
else
  START_CMD=(node "${SERVER_FILE}")
fi
if command -v setsid >/dev/null 2>&1; then
  setsid "${START_CMD[@]}" > "${APP_DIR}/.adapter-server.log" 2>&1 &
  SERVER_PID=$!
else
  "${START_CMD[@]}" > "${APP_DIR}/.adapter-server.log" 2>&1 &
  SERVER_PID=$!
fi
cd "${APP_DIR}"

echo "${SERVER_PID}" > .adapter-server.pid
{
  echo "PORT=${PORT}"
  echo "SERVER_PID=${SERVER_PID}"
  echo "APP_DIR=${APP_DIR}"
  echo "SERVER_FILE=${SERVER_FILE}"
  echo "ADAPTER_SERVER_WRAPPER=${ADAPTER_SERVER_WRAPPER}"
} > .adapter-runtime.env

for _ in $(seq 1 60); do
  if curl -fsS "http://${ADAPTER_HOST}:${PORT}${HEALTHCHECK_PATH}" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "Server process died"
    cat .adapter-server.log >&2
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "http://${ADAPTER_HOST}:${PORT}${HEALTHCHECK_PATH}" > /dev/null 2>&1; then
  log "Server failed to start within 60s"
  cat .adapter-server.log >&2
  kill "${SERVER_PID}" 2>/dev/null || true
  exit 1
fi

{
  echo "BUILD_ID: ${BUILD_ID}"
  echo "DEPLOYMENT_ID: ${NEXT_DEPLOYMENT_ID}"
  echo "IMMUTABLE_ASSET_TOKEN: undefined"
} > .adapter-build.log

log "Ready at http://${ADAPTER_HOST}:${PORT}"
echo "http://${ADAPTER_HOST}:${PORT}"
