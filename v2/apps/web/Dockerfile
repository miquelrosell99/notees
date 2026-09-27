# Notees v2 web client — static vite build served by nginx (context = v2/).
#
# Stage layout:
#   deps  — `pnpm fetch` warms the store from the lockfile alone (cached until
#           the lockfile changes; no manifest list to maintain)
#   build — full sources; offline install; explicit package build order
#           (query → protocol → domain → store → sync → export, then the app);
#           output: apps/web/dist (static assets + worker chunk + sql.js wasm)
#   final — nginx:1.27-alpine; the stock /docker-entrypoint.d mechanism runs
#           50-notees-config.sh, which writes /config.js from
#           NOTEES_SERVER_URL (baked as a build ARG, overridable at runtime
#           with -e) before nginx starts.
#
# The explicit package order exists because of a dev-only dependency cycle
# (protocol imports @notees/query for the query-token schema); see
# packages/protocol/SCHEMA.md owed work for the structural fix.

# ---------- deps ----------
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN pnpm fetch

# ---------- build ----------
FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
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
