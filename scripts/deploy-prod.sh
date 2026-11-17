#!/usr/bin/env bash
# The canonical production update for hosts that pull published images:
# pull → recreate → smoke, as ONE command so the smoke is never skipped.
#
#   scripts/deploy-prod.sh                 # the default profile set
#   scripts/deploy-prod.sh --profile web   # stacks that gate web behind a profile
#
# Run from the stack checkout — the folder whose host-local compose.yaml +
# .env describe the live stack (see docs/developers/deployment.md). Extra
# args are forwarded to the compose calls (e.g. --profile). verify-min
# self-locates the stack dir, API key, admin password, and workspace
# (env → repo root; NOTEES_* overrides for split layouts). Exits non-zero —
# with the verify-min output loud — if any step fails.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose "$@" pull
docker compose "$@" up -d
node scripts/screenshots/verify-min.mjs
