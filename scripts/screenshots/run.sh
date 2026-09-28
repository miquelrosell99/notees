#!/usr/bin/env bash
# One-shot screenshot capture for Notees v2: boots throwaway notees-sync +
# notees-web containers on 127.0.0.1:8477/8480, seeds a synthetic knowledge
# workspace through the object API, and captures UI screenshots into
# docs/img/screenshots/. Uses the LOCAL m1 images only — never pushes/pulls
# and never touches the live notees-sync/notees-web stack or compose files.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../.." && pwd)"
SYNC_PORT="${SYNC_PORT:-8477}"
WEB_PORT="${WEB_PORT:-8480}"
SYNC_IMAGE="${NOTEES_SYNC_IMAGE:-ghcr.io/miquelrosell99/notees-sync:2.0.0-m1}"
WEB_IMAGE="${NOTEES_WEB_IMAGE:-ghcr.io/miquelrosell99/notees-web:2.0.0-m1}"
SYNC_CONTAINER="notees-screenshots-sync"
WEB_CONTAINER="notees-screenshots-web"
RUNTIME="$DIR/.runtime"
DATA="$RUNTIME/data"
OUT="$REPO_ROOT/docs/img/screenshots"

# Guard rails: never collide with the production stack or a busy port.
for name in "$SYNC_CONTAINER" "$WEB_CONTAINER"; do
  if [ "$name" = "notees-sync" ] || [ "$name" = "notees-web" ]; then
    echo "refusing to use live container name: $name" >&2
    exit 1
  fi
done
for port in "$SYNC_PORT" "$WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port 127.0.0.1:$port is already in use" >&2
    exit 1
  fi
done

rm -rf "$RUNTIME"
mkdir -p "$DATA" "$OUT"
# The sync image runs as uid 1000 (USER node) with /data as a bind mount —
# host-side ownership must let the container write the generated API key.
chown 1000:1000 "$DATA" 2>/dev/null || true

cd "$DIR"
if [ ! -d node_modules ]; then
  echo ">> installing playwright package (browser already in ~/.cache/ms-playwright)..."
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
fi

cleanup() {
  docker rm -f "$SYNC_CONTAINER" "$WEB_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo ">> starting throwaway sync server on 127.0.0.1:$SYNC_PORT ($SYNC_IMAGE)"
docker run -d --name "$SYNC_CONTAINER" --rm \
  -p "127.0.0.1:${SYNC_PORT}:8377" \
  -v "$DATA:/data" \
  -e "NOTEES_CORS_ORIGIN=http://127.0.0.1:${WEB_PORT}" \
  "$SYNC_IMAGE" >/dev/null

echo ">> waiting for sync /healthz..."
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${SYNC_PORT}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:${SYNC_PORT}/healthz" >/dev/null

# The server generates /data/api_key.txt on first boot (single-user key).
API_KEY=""
for _ in $(seq 1 30); do
  if [ -f "$DATA/api_key.txt" ]; then
    API_KEY="$(tr -d '[:space:]' < "$DATA/api_key.txt")"
    [ -n "$API_KEY" ] && break
  fi
  sleep 1
done
if [ -z "$API_KEY" ]; then
  API_KEY="$(docker exec "$SYNC_CONTAINER" cat /data/api_key.txt | tr -d '[:space:]')"
fi
echo ">> api key acquired"

echo ">> starting throwaway web client on 127.0.0.1:$WEB_PORT ($WEB_IMAGE)"
docker run -d --name "$WEB_CONTAINER" --rm \
  -p "127.0.0.1:${WEB_PORT}:80" \
  -e "NOTEES_SERVER_URL=http://127.0.0.1:${SYNC_PORT}" \
  "$WEB_IMAGE" >/dev/null

echo ">> waiting for web /config.js..."
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${WEB_PORT}/config.js" 2>/dev/null | grep -q "$SYNC_PORT"; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:${WEB_PORT}/config.js" | grep -q "$SYNC_PORT"

API_URL="http://127.0.0.1:${SYNC_PORT}" API_KEY="$API_KEY" node seed.mjs
BASE_URL="http://127.0.0.1:${WEB_PORT}" API_URL="http://127.0.0.1:${SYNC_PORT}" \
  API_KEY="$API_KEY" OUT_DIR="$OUT" node capture.mjs
echo ">> screenshots in $OUT"
