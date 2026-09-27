# Notees v2 sync server — all-in-one image from the monorepo root (context = v2/).
#
# Stage layout:
#   deps    — frozen workspace install (needs every workspace manifest)
#   build   — full sources; tsup bundles the @notees/* TS into dist/server.js
#             (only real npm deps stay external, incl. better-sqlite3 native)
#   deploy  — `pnpm deploy --prod` pruned production copy of @notees/server
#   runtime — node:22-alpine, non-root, /data volume, wget healthcheck
#
# better-sqlite3 ships no musl prebuilds, so the toolchain for node-gyp lives
# in the deps stage (glibc hosts can drop the apk line).

# ---------- deps ----------
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/domain/package.json packages/domain/
COPY packages/store/package.json packages/store/
COPY packages/sync/package.json packages/sync/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
# Base tsconfig every package extends (tsup's DTS step reads the chain).
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
# `@notees/server...` = the server plus its workspace dependencies, so the
# packages emit their dist (production export conditions) before tsup runs.
RUN for p in query protocol domain store sync export; do pnpm --filter @notees/$p build; done \
    && pnpm --filter @notees/server build

# ---------- deploy (pruned production copy) ----------
FROM build AS deploy
# Copies the package files plus a prod-only node_modules into /out. The dist
# bundle is self-contained; the pruned deps exist for better-sqlite3 (+ any
# other external runtime dep) and to satisfy package resolution.
RUN pnpm --filter @notees/server deploy --prod /out

# ---------- runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production \
    NOTEES_DATA_DIR=/data \
    NOTEES_PORT=8377 \
    NOTEES_HOST=0.0.0.0
WORKDIR /app
COPY --from=deploy /out ./
# /data: named volumes inherit this ownership; bind mounts need `-u`/chown.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8377
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8377/healthz || exit 1
CMD ["node", "dist/server.js"]
