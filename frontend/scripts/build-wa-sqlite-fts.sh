#!/usr/bin/env bash
# Rebuilds the vendored wa-sqlite wasm/mjs at frontend/src/core/db/wa-sqlite-fts/
# with FTS3/FTS4/FTS5 enabled.
#
# Why: the stock wa-sqlite dist wasm is compiled without any FTS module, but
# the workspace schema stores full-text search in an FTS4 virtual table
# (search_index). This script recompiles the upstream v1.0.0 dist with
# SQLITE_ENABLE_FTS3 (+FTS3_PARENTHESIS) and SQLITE_ENABLE_FTS5, keeping every
# other compile flag identical to upstream.
#
# Requirements: docker, curl, unzip, git. Run from anywhere:
#   bash frontend/scripts/build-wa-sqlite-fts.sh
set -euo pipefail

# Pinned to the commit the npm wa-sqlite@1.0.0 dist was published from
# (gitHead, 2024-01-05; it is not an ancestor of the v1.0.0 tag). The module
# glue there still exposes registerVFS, which our adapter uses; the later
# v1.0.0 tag moved VFS registration into sqlite-api.js.
WA_SQLITE_COMMIT="4aa5a32c3eaae21b676d14ad6b5367041d3993df"
# Era-matched to the npm 1.0.0 publish (2024-01): newer emsdk glue requires
# self.location in worker contexts, which some tests stub minimally.
EMSDK_IMAGE="emscripten/emsdk:3.1.51"
# This commit's Makefile builds SQLite version-3.44.0.
SQLITE_AMALGAMATION_URL="https://sqlite.org/2023/sqlite-amalgamation-3440000.zip"
SQLITE_DEPS_DIR="version-3.44.0"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/frontend/src/core/db/wa-sqlite-fts"
WORK_DIR="$(mktemp -d /tmp/wa-sqlite-fts-build.XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

git clone --quiet https://github.com/rhashimoto/wa-sqlite.git "${WORK_DIR}/wa-sqlite"
git -C "${WORK_DIR}/wa-sqlite" checkout -q "${WA_SQLITE_COMMIT}"

# Pre-seed the SQLite amalgamation so the Makefile does not need tcl/configure
# to build sqlite3.c from the source tarball. sqlite3ext.h is required by
# extension-functions.c.
mkdir -p "${WORK_DIR}/wa-sqlite/deps/${SQLITE_DEPS_DIR}"
curl -LsSf "${SQLITE_AMALGAMATION_URL}" -o "${WORK_DIR}/sqlite-amalgamation.zip"
unzip -o -q "${WORK_DIR}/sqlite-amalgamation.zip" -d "${WORK_DIR}"
cp "${WORK_DIR}"/sqlite-amalgamation-*/sqlite3.c \
   "${WORK_DIR}"/sqlite-amalgamation-*/sqlite3.h \
   "${WORK_DIR}"/sqlite-amalgamation-*/sqlite3ext.h \
   "${WORK_DIR}/wa-sqlite/deps/${SQLITE_DEPS_DIR}/"

docker run --rm \
  -v "${WORK_DIR}/wa-sqlite:/src" -w /src \
  "${EMSDK_IMAGE}" \
  make dist WASQLITE_EXTRA_DEFINES='-DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS5'

cp "${WORK_DIR}/wa-sqlite/dist/wa-sqlite.mjs" "${WORK_DIR}/wa-sqlite/dist/wa-sqlite.wasm" "${OUT_DIR}/"
echo "Vendored FTS-enabled wa-sqlite build written to ${OUT_DIR}"
