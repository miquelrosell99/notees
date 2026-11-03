#!/bin/sh
# Write /config.js (window.NOTEES_CONFIG) from NOTEES_SERVER_URL and
# NOTEES_E2EE before nginx starts. Runs via the stock nginx
# /docker-entrypoint.d mechanism. The URL is JSON-escaped minimally
# (backslash, double quote); leave config.js untouched when BOTH variables
# are empty so the baked placeholder keeps its meaning. NOTEES_E2EE is the
# E2EE kill switch: only the exact value "on" turns workspace keying on.
set -eu

url="${NOTEES_SERVER_URL:-}"
e2ee="${NOTEES_E2EE:-}"
if [ -n "$url" ] || [ -n "$e2ee" ]; then
  escaped=$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')
  if [ -n "$e2ee" ]; then
    printf 'window.NOTEES_CONFIG = { serverUrl: "%s", e2ee: "%s" };\n' "$escaped" "$e2ee" \
      > /usr/share/nginx/html/config.js
  else
    printf 'window.NOTEES_CONFIG = { serverUrl: "%s" };\n' "$escaped" \
      > /usr/share/nginx/html/config.js
  fi
  echo "[notees-web] /config.js: serverUrl=${url:-<empty>} e2ee=${e2ee:-<empty>}"
else
  echo "[notees-web] NOTEES_SERVER_URL and NOTEES_E2EE empty; leaving /config.js as shipped"
fi
