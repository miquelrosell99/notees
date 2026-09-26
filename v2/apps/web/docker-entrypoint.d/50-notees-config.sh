#!/bin/sh
# Write /config.js (window.NOTEES_CONFIG) from NOTEES_SERVER_URL before nginx
# starts. Runs via the stock nginx /docker-entrypoint.d mechanism. The URL is
# JSON-escaped minimally (backslash, double quote); leave config.js untouched
# when the variable is empty so the baked placeholder keeps its meaning.
set -eu

url="${NOTEES_SERVER_URL:-}"
if [ -n "$url" ]; then
  escaped=$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf 'window.NOTEES_CONFIG = { serverUrl: "%s" };\n' "$escaped" \
    > /usr/share/nginx/html/config.js
  echo "[notees-web] /config.js: serverUrl=$url"
else
  echo "[notees-web] NOTEES_SERVER_URL empty; leaving /config.js as shipped"
fi
