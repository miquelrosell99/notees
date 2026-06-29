#!/bin/bash
set -e
cd "$(dirname "$0")/mobile"

# Launch the app in Niri at a screenshot-friendly smartphone size.
# The Niri window rule (match app-id="^es\.rosellramos\.") handles floating.

WIDTH="${FLUTTER_NIRI_WIDTH:-540}"
HEIGHT="${FLUTTER_NIRI_HEIGHT:-960}"

export FLUTTER_WINDOW_WIDTH=$WIDTH
export FLUTTER_WINDOW_HEIGHT=$HEIGHT

# Prefer a host Flutter SDK; fall back to the vendored copy in mobile/.flutter.
if command -v flutter >/dev/null 2>&1; then
  FLUTTER=flutter
else
  FLUTTER="./.flutter/bin/flutter"
  if [[ ! -x "$FLUTTER" ]]; then
    echo "Error: flutter not found in PATH and $FLUTTER is not executable." >&2
    exit 1
  fi
fi

exec "$FLUTTER" run -d linux "$@"
