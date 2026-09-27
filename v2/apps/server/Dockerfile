# Notees v2 sync server — all-in-one image from the monorepo root (context = v2/).
#
# Stage layout:
#   deps    — `pnpm fetch` warms the store from the lockfile alone (cached
#             until the lockfile changes; no manifest list to maintain)
#   build   — full sources; offline install; tsup bundles @notees/* TS into
#             dist/server.js (only real npm deps stay external, incl. the
#             better-sqlite3 native module)
#   deploy  — `pnpm deploy --prod` pruned production copy of @notees/server
#   runtime — node:22-alpine, non-root, /data volume, wget healthcheck
#
# Package build order is explicit (query → protocol → domain → store → sync →
# export): a dev-only dependency cycle (protocol imports @notees/query for the
# query-token schema; query devDepends on protocol) makes pnpm's topological
# order arbitrary. Structural fix tracked in packages/protocol/SCHEMA.md.

# ---------- deps ----------
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN pnpm fetch

# ---------- build ----------
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
# Base tsconfig every package extends (tsup's DTS step reads the chain) and
# the sources arrive with the COPY above.
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
