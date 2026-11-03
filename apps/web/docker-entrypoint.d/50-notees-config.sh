#!/bin/sh
# Write /config.js (window.NOTEES_CONFIG) from NOTEES_SERVER_URL and
# NOTEES_E2EE before nginx starts. Runs via the stock nginx
# /docker-entrypoint.d mechanism. Both values are JSON-escaped minimally
# (backslash, double quote); leave config.js untouched when BOTH variables
# are empty so the baked placeholder keeps its meaning. NOTEES_E2EE is the
# E2EE kill switch: only the exact value "on" turns workspace keying on.
# A variable that is empty contributes NO key — in particular an empty
# NOTEES_SERVER_URL never emits `serverUrl: ""` (absent key = "no prefill",
# same as the baked placeholder).
set -eu

url="${NOTEES_SERVER_URL:-}"
e2ee="${NOTEES_E2EE:-}"
if [ -n "$url" ] || [ -n "$e2ee" ]; then
  config=""
  if [ -n "$url" ]; then
    escaped=$(printf '%s' "$url" | sed 's/\\/\\\\/g; s/"/\\"/g')
    config="serverUrl: \"$escaped\""
  fi
  if [ -n "$e2ee" ]; then
    escaped_e2ee=$(printf '%s' "$e2ee" | sed 's/\\/\\\\/g; s/"/\\"/g')
    if [ -n "$config" ]; then
      config="$config, e2ee: \"$escaped_e2ee\""
    else
      config="e2ee: \"$escaped_e2ee\""
    fi
  fi
  printf 'window.NOTEES_CONFIG = { %s };\n' "$config" \
    > /usr/share/nginx/html/config.js
  echo "[notees-web] /config.js: serverUrl=${url:-<absent>} e2ee=${e2ee:-<absent>}"
else
  echo "[notees-web] NOTEES_SERVER_URL and NOTEES_E2EE empty; leaving /config.js as shipped"
fi
