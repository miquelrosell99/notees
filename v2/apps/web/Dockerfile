# Notees v2 web client — static vite build served by nginx (context = v2/).
#
# Stage layout:
#   deps  — frozen workspace install (needs every workspace manifest)
#   build — full sources; `web...` builds the shared packages (their dist,
#           which the production export conditions resolve to) then the app;
#           output: apps/web/dist (static assets + worker chunk + sql.js wasm)
#   final — nginx:1.27-alpine; the stock /docker-entrypoint.d mechanism runs
#           50-notees-config.sh, which writes /config.js from
#           NOTEES_SERVER_URL (baked as a build ARG, overridable at runtime
#           with -e) before nginx starts.

# ---------- deps ----------
FROM node:22-alpine AS deps
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
RUN for p in query protocol domain store sync export; do pnpm --filter @notees/$p build; done \
    && pnpm --filter @notees/web build

# ---------- runtime ----------
FROM nginx:1.27-alpine
# Baked default (overridable at runtime: docker run -e NOTEES_SERVER_URL=…).
# index.html loads /config.js first; App.tsx prefills the server URL from
# window.NOTEES_CONFIG.serverUrl, keeping the manual form as fallback.
ARG NOTEES_SERVER_URL=http://localhost:8377
ENV NOTEES_SERVER_URL=$NOTEES_SERVER_URL
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx-gzip.conf /etc/nginx/conf.d/00-gzip.conf
COPY apps/web/docker-entrypoint.d/50-notees-config.sh /docker-entrypoint.d/50-notees-config.sh
RUN chmod +x /docker-entrypoint.d/50-notees-config.sh
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
