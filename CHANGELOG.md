# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-06

- **fix(ops): the web container proxies /api to the sync service — one
  origin for UI+API; compose carries the build contexts (no more tag
  envs).** Following the tailnet-edge migration (same day): the nginx config
  in the web image now proxies `/api/*` to `notees-sync:8377` over the
  compose network (websocket headers included), so browsers only ever talk
  to the one web origin — no CORS, no separate sync URL to configure, https
  over the optional edge wraps everything in one secure context (browser
  storage requires it). The web client's default sync URL is now simply the
  page origin (vite dev gained the same proxy). The edge's Caddyfile
  simplifies to a single proxy. App publishes return to zero-config wildcard
  defaults (the fleet host's loopback pins were serve-era only), the
  `18xxx` LAN-shadow publishes are removed, and `NOTEES_SYNC_TAG` /
  `NOTEES_WEB_TAG` are gone — compose carries the build contexts, so the
  development flow is `docker compose build && docker compose up -d` (the
  deployment always runs the local codebase; hosts that haven't built pull
  `:latest`). Verified on the fleet host: `http://atlas:8378` serves,
  `/api/version` answers same-origin through the proxy and through the
  edge, `VERIFY-PASS`.

- **fix(ops): the containers could not start — a wildcard app bind collided
  with the tailnet edge; HTTPS moved from tailscale serve to an optional Caddy
  edge.** Incident (2026-10-07): the sync/web containers sat in `Created`,
  failing to bind `0.0.0.0:8377` — tailscaled's serve held the tailnet IP on
  the same port number; the loopback pin had gone missing from the host's
  `.env`. Root fix, per the owner's direction: app publishes are now remappable
  full `ip:port` envs (`NOTEES_SYNC_HTTP`, `NOTEES_WEB_HTTP`, `*_LAN_HTTP`,
  zero-config wildcard defaults); TLS moved off `tailscale serve` into an
  optional compose **edge profile** — Caddy + the tailscale plugin, one
  published port, ts.net certs via the mounted tailscaled socket, `/api/*` →
  sync + everything else → web over the compose network so the https page is
  same-origin (browser storage requires a secure context). The web client
  guesses same-origin on https pages, same-host:8377 on plain http; a remapped
  sync port is set from the UI's server field. No-https deployments keep
  working (in-process store banner). Verified end-to-end on the fleet host:
  `VERIFY-PASS`, https name serving the web UI + API. Runbook + ops skill
  updated (deployment.md).

- **chore(sync): the GTK/Flutter wire corpora re-vendored to byte-identity
  (21 fixtures).** The client copies of `packages/protocol/fixtures/` had
  drifted (missing `object-restore.json`, stale `class-property-defaults.json`);
  both now sha256-match the TS reference 21/21 and their exact-list gate
  assertions were extended — the convergence signal, mirroring the protocol
  gate's exact-list law. No wire change: `object.restore` and the
  number-format schema keys already shipped in the reference; the corpus now
  pins them on all three sides. Gates green: TS (262 protocol + 401 store),
  GTK 680 passed, Flutter 578 passed.
- **chore(docs): milestone markers (M1/M2/M3/M5 labels) scrubbed from code
  comments, test titles, and package docs.** Continuation of the record-keeping
  retirement: `apps/server/src` + `apps/server/test`, `apps/server/Dockerfile`
  ("Notees v2 sync server" → "Notees sync server"), and `packages/{domain,
  store,sync,query,export,protocol}` (incl. `packages/query/README.md`,
  `SCHEMA.md`, `WIRE.md`) no longer name delivery milestones — the text stands
  without the labels ("the M1 default" → "the default", "DEFERRED to M2" →
  "DEFERRED", the M2/M3/M5 describe-blocks in the search suite renamed, …).
  Same deliberate exception as the plan retirement: `packages/protocol/fixtures/`
  stays byte-pinned (the fixture comment strings carrying an M-label are part
  of the sha256-pinned convergence corpus), and live version identifiers
  (envelope v3, `/api/relay/v2`, WS framing v2, `v2.0.0-mN` client tags) are
  untouched — only prose labels went. No logic, symbol, or assertion changes.
- **chore(docs): the plan-as-record workflow retired; `CHANGELOG.md` becomes
  the record.** Deleted `.plans/implementation-plan.md` and `.plans/design/`
  (kept `.plans/2026-10-06-1352-main-content-restructure/` as the first
  date-stamped proposal folder), stripped plan §-citations, `.plans` pointers,
  and v1/v2 history mentions from code comments, tests, and docs. `AGENTS.md`
  is now static guidance with a records index; the `notees-development` and
  `notees-operations` skills point here. Deliberate exception: the protocol
  fixtures under `packages/protocol/fixtures/` keep their metadata untouched —
  those bytes are sha256-pinned across the TS/GTK/Flutter convergence gate.
