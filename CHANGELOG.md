# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-22

- **feat(scripts): the batch-migration orchestrator — one stopped-stack
  window for every pending stored-log migration.** Running
  `scripts/migrate-*.mts` one at a time costs one stack-stop + one full
  derived-store rehydration per migration, and the rehydration is the pain,
  not the rewrite. `scripts/migrate-pending.mts` surveys the
  `schema_meta` idempotency markers (`--db <path>`, dry-run by default),
  reports each registered migration pending/applied, and in `--apply` runs
  every pending entry's own `--apply` sequentially — the batch pays one
  backup/epoch/restart cycle. Safety first: `--apply` aborts while
  `docker compose ps notees-sync` reports the container running (never edit
  `relay.db` under a live server) unless `--assume-stopped`; the orchestrator
  itself never writes the DB — each entry script keeps its own timestamped
  backup + quick_check + epoch bump. The registry carries the four
  marker-keyed rewrite scripts (`migrate-node-type`, `migrate-color-tokens`,
  `migrate-is-embedded`, `migrate-class-delete`); scripts without a marker
  row (the append-only kind-A pass, the pre-marker rewrites, and
  `repair-log-conformance` — a repair tool, not a pending-check migration)
  stay per-script invocations. New marker-keyed migrations must add their
  registry entry (kind: "rewrite" vs "marker-only"). Tests:
  `packages/store/test/migrate-pending.test.ts` — pure classification plus an
  end-to-end arm on a synthetic relay DB (child-process `--apply` lands the
  marker; a second pass plans nothing; the running-stack arm refuses).
  Runbook: `docs/developers/migrations.md` "Running migrations".

- **feat(web): the hub surfaces restructure — flush card-border scrollbars
  and the headers into a pinned in-card top bar.** The main content card's
  generic 800px centered cap pushed every internally-scrolling hub view's
  scrollbar to the floating column's right edge, mid-card; and each hub
  carried its own hand-rolled header block. Now all nine hub surfaces
  (Journal, Calendar, the collection hubs — Pages / Classes / Inbox /
  Whiteboards / Assets / Tasks — Trash, Archived, Shares, Search, Queries)
  are full-bleed exceptions in PageCard.css with one shared three-layer
  shape: a new fleet primitive, `SurfaceTopBar` (icon + title + muted count
  + freeform context + right-aligned actions cluster, the NodeView
  `.nt-node-topbar` register generalized), pinned at the card's top; a body
  scroller spanning the full card width so the scrollbar rides the card
  border; and the content measure kept on an inner capped column inside
  each view's own CSS. Each view converted: the journal's prev/Today/next
  day nav and the calendar's date line + day nav close over their existing
  handlers inside the bar (Today is a fleet ghost Button now — the custom
  pill retired); the tasks hub's bucketed surface prepends the collection
  inside the shared scrolling body (CollectionHub grew a `prepend` slot) so
  the whole hub keeps ONE bar; the queries hub's mode switcher joins the
  bar's actions cluster while the saved-view tabs stay in the body. The
  shared `.nt-hub-header` / `.nt-hub-title` / `.nt-hub-count` /
  `.nt-hub-switcher` / `.nt-hub-actions` registers in app.css are retired
  (no user remains — verified), and `.nt-hub`'s padding re-homed into the
  new co-located CollectionHub.css. The app-shell TopBar is untouched; the
  GraphView stays full-bleed as-is.
  - **Verification**: `pnpm typecheck` clean; `pnpm test` green (the
    windowing/shares count pins and the journals Today pressed-register pin
    updated to the new DOM — the count rides `.surface-topbar__count`, the
    pressed register rides the kit Button).

- **chore(migrations): the classes-gallery stored-log migration ran live — 3
  envelopes rewritten, epoch bumped, VERIFY-PASS.** `migrate-class-delete.mts
  --apply` against the production relay: 3 `class.delete` envelopes rewritten
  to their routing equivalents (2 personal workspace, 1 test workspace), 0
  drops, 29 class-addressed `object.delete` envelopes inspected and correctly
  left unchanged (user-class trash arms); snapshots + derived caches purged,
  `restore_epoch` bumped for both workspaces. The full-log rehydration
  replayed 238k envelopes into a fresh derived store in ~39 minutes; backup at
  `relay.db.bak-20261022-091640` (`quick_check` ok); post-restart
  `verify-min.mjs` VERIFY-PASS. The LOCKSTEP-PENDING gate held: GTK `0537d39`,
  Flutter `7b07a01`, CLI `6214b26` converged before the rewrite.

- **docs(changelog): the classes-gallery lockstep converged — GTK `0537d39`,
  Flutter `7b07a01`, CLI `6214b26`.** All three clients now speak the `1423ce2c2`
  contract; the LOCKSTEP-PENDING note in that entry is closed. GTK
  (`notees-gtk`): the four-arm class-node delete routing, the archival
  `active` bit with both refusal guards, the `journal` feature, the retired
  `class.delete` op — 894 tests, ruff/mypy clean, fixture corpus
  byte-identical. Flutter (`notees-flutter`): same port — 689 tests,
  `flutter analyze` clean, corpus byte-identical both directions. CLI
  (`notees-cli`): vendor re-pinned at `1423ce2c2` — zero CLI-code delta (it
  consumes the store applier whole and never issued `class.delete`), 87/87.
  The stored-log migration (`scripts/migrate-class-delete.mts`) is unblocked
  and runs at the operator's next maintenance window.

- **docs(changelog): the WS-admission-ticket lockstep converged — GTK
  `8269285`, Flutter `f9cfe75`, CLI `e8c2c39`.** All three implementations now
  speak the 0ea18fcd5 contract; the LOCKSTEP-PENDING note in that entry is
  closed. GTK (`notees-gtk`): the socket sends `Authorization: Bearer` on the
  upgrade (`websockets` `additional_headers`), URL carries no credential,
  verified LIVE against this server — `tests/test_live_server_e2e.py` 3/3
  handshakes via the header. Flutter (`notees-flutter`): `WsConnector` gained
  a headers map threaded from the account credential,
  `IOWebSocketChannel.connect(url, headers: …)`, analyze clean + 681/681.
  CLI (`notees-cli`): vendor re-pinned `33e4af5e2 → bc3f856e7`, zero CLI-code
  delta (the `packages/sync` transport mints tickets internally), gate 87/87.
  Client release tags remain each client repo's own release step.
  - **Verification**: the three client gates as recorded in each repo's
    changelog this day.

- **fix(sync): the test workspace's relay log repaired — 50,001 envelopes the
  relay had accepted but no strict applier could ever apply.** Owner directive
  (2026-10-22, "repair the log"): fresh clients syncing the shared test
  workspace wedged ("Backend unreachable — working locally") on a
  `class.setExtends` naming Meeting 34s before Meeting's `class.create`. The
  full-replay diagnosis (`scripts/repair-log-conformance.mts`, dry-run by
  default, catalogued in `migrations.md`) found three poison shapes, all in
  the test workspace (the personal workspace replays clean): the reordered
  extends (payload rewrite — drop the not-yet-existing parent), a probe
  clearing Meeting's parents against the system-extends lock (payload rewrite
  — converge to the seeded set), and 50,000 `object.delete` envelopes from
  the 2026-10-14 graph-loadtest naming nodes that were never created in that
  workspace, plus one guard-failing negative-test `object.create` (envelope
  deletion — no payload to neuter). `restore_epoch` bumped (now 8), stale
  snapshot + derived cache dropped; verify = fresh full replay, zero throws,
  and a fresh-browser boot probe against the test workspace (PROBE-PASS).
  - **Verification**: dry-run 50,001 repairable / 0 unknown; post-repair full
    replay VERIFY-PASS; live `verify-min.mjs` VERIFY-PASS; fresh-client boot
    probe against the repaired workspace PROBE-PASS.


- **feat(protocol,store,web)!: the classes gallery, the archival `active`
  bit, and the retired `class.delete` op — two lifecycles, never conflated.**
  Owner rulings (2026-10-22, the classes-gallery batch): the app ships a
  Capacities-style **classes gallery** — the class-creation dialog's second
  tab is now a card grid (icon chip + name + one-line description, grouped in
  sections, a "Create your own" card) of the seeded system classes the
  workspace does not have ENABLED; picking a card enables it. Disabling is
  the delete gesture, and deletion is now routed: `object.delete` on a class
  node is decided by the applier — a LOCKED system class (the date chain +
  table, asset, query, code, template, comment) fails loud; a family base
  (task, event, meeting, source, person) applies as its feature toggle off;
  any other system class is re-wired to **archival** (`active = false`,
  reversible from the gallery), never trash; a user class takes the plain
  trash row. **Membership rides in every arm** — class removal never
  tombstones `class_member_set`; restoring a class brings back every
  assignment (the old `class.delete` sweep is dead). Archival generalizes to
  ANY node: `object.update` gains the presence-write `active` bit
  (false = archive, true = unarchive — locked classes and family bases
  refuse the archival direction), the page/block context menu archives
  without a confirmation, and the new **Archived** hub (the account popup,
  beside Trash — owns `/archived` + the tab title) lists archived nodes with
  Unarchive and Delete; `object.restore` is explicitly NOT the unarchive
  path (no trash row → no-op). Every default read filters `active = 1` AND
  no trash row — the query compiler already rode `is_active`, the web
  `children()` read joined it, and the class picker surfaces disabled-system-
  class matches as dimmed rows with an Enable affordance plus a "Browse all
  types…" row into the gallery. The **journal** toggle joins
  `WORKSPACE_FEATURES` — it gates the journal surfaces (the nav view, Today-
  page management/auto-creation, both hidden while off) while the date
  classes stay always-on; it renders as a surfaces-only row in Settings →
  Features (no class family, no instance count). The `class.delete` op is
  retired outright (strict schemas + registry reject it — no wire compat);
  the undo journal's inverses compose the routing (class.create inverts as
  toggle-restore / archive / trash by kind; class-node deletes invert
  likewise). Wire + model: `packages/protocol` (payload key, feature enum,
  four-arm routing in SCHEMA.md, fixtures `object-update-active.json` +
  `object-delete-class-routing.json`; `class-delete-managed.json` retires
  with the op), `packages/store` (routing applier, `LockedSystemClassError`,
  the family-base archival guard, `children()` liveness filter, restore
  no-trash-row no-op), `packages/domain` (`LOCKED_SYSTEM_CLASSES`,
  `FamilyFeature`, `isFamilyFeature`, the gallery descriptions manifest),
  `packages/sync` (listing-affecting envelope carriers `isEmbedded`/`active`),
  `apps/web` (gallery modal, Archived hub, archive gesture, picker rows,
  Features-tab journal row, journal surface gating), and
  `scripts/migrate-class-delete.mts` — the one-time stored-log rewrite
  (family bases → the toggle op, other system classes → `object.update
  {active:false}`, user classes → `object.delete`, locked/orphan deletes
  dropped) with the membership-rides semantics documented honestly in its
  header.
  - **LOCKSTEP-PENDING (the clients)**: GTK/Flutter must converge on the new
    fixtures (`object-update-active.json`, `object-delete-class-routing.json`,
    the extended `workspace-feature-set.json`) and the retired `class.delete`
    before the live stored-log migration runs — the new server rejects the
    old op outright, so the migration is a deploy-time step (stack stopped →
    new images → `migrate-class-delete.mts --apply` → restart), not a live
    one.
  - **Verification**: fixture gate 38/38; store 646/646 (routing arms,
    membership-rides, archival LWW, archive ≠ trash, migration planner +
    replay convergence); web 1952/1952 (gallery, Archived hub, undo-journal
    routing inverses, picker rows, Features tab); `pnpm typecheck` green;
    `pnpm test` full gate green.

- **feat(sync,server)!: WS admission tickets — bearer credentials no longer
  ride any URL; the `?token=` query fallback is retired.** Owner ruling
  (2026-10-22, "best practice implementation, no hacks"): a session token or
  API key in a WebSocket URL was copied into every proxy/access/error log
  along the path (the morning's incident: two live session tokens pasted
  along with a log dump). New contract (WIRE.md §2): the socket admits
  `Authorization: Bearer` (native clients set upgrade headers) or
  `?ticket=ntk_…` — a ticket minted at the new `POST /api/relay/v2/tickets`
  with the normal credential headers, single-use, 60 s valid, bound to the
  workspace it was minted for, consumed AT the handshake (a bad ticket
  refuses the upgrade with the 401 `invalid_ticket` envelope — a new taxonomy
  code), worthless in a log within seconds of minting. The `HttpTransport`
  mints a fresh ticket per connect including backoff reconnects; a mint 404
  (relay predates tickets) fails loud, a 401/403 surfaces onError and keeps
  retrying, anything else retries silently like a dropped socket. `?token=`
  is rejected outright on the whole API (not just the socket). Server:
  `apps/server/src/tickets.ts` (in-memory sha256-keyed store, TTL injectable
  via the internal `wsTicketTtlMs` config hook), `context.ts`, `config.ts`,
  `routes-relay.ts` (the `/tickets` route + the WS preHandler/handler split
  carrying `wsPrincipal`), `routes-auth.ts` (`extractCredential` loses the
  query fallback), `errors.ts` (`invalid_ticket`), `openapi.ts` (the new
  route + the socket's updated description). Client: `packages/sync`
  `transport.ts` (mint-then-connect `subscribe`). Docs: WIRE.md (auth posture
  + the tickets endpoint + §2 rewrite), `deployment.md` §8 (the stale
  "API key is the only auth" bullet rewritten to the real credential
  surface), the operations/development skill references, the `deploy/
  Caddyfile` logging comment.
  - **LOCKSTEP-PENDING (the clients)**: GTK/Flutter must move their socket
    connect from `?token=` to the `Authorization` header (their WS stacks set
    headers natively); the CLI re-vendors `packages/sync` to pick up the
    transport change (its public options are unchanged). Their next releases
    carry the change — until then their sync sockets stop against this
    server, HTTP sync unaffected.
  - **Verification**: `apps/server` relay-ws suite 16/16 (ticket flow,
    Bearer header, single-use, workspace binding, expiry via the TTL hook,
    retired `?token=`, mint auth/strict-body) + auth/openapi-coverage/e2e/
    relay-batch 52/52; `packages/sync` suite 26/26 (mint-per-connect,
    no credential in the URL, 404 fail-loud with no reconnect, bad-credential
    onError + retry); `pnpm typecheck` green; `pnpm test` full gate green;
    live: rebuilt `notees-sync`/`notees-web`, `verify-min.mjs` VERIFY-PASS.

- **fix(web): the context-menu flyout actually leaves the DOM on close —
  the mount lifecycle rides our state, not Radix Presence.** Owner report
  (2026-10-22): an open submenu flyout stayed visible after hovering a
  different menu entry — sometimes. Live-browser probes (Playwright against
  the running stack, fresh disposable workspaces) pinned it: the controlled
  `Sub`'s state DID close every time (`data-state="closed"`, the `active`
  class dropped), but Radix `Presence` only detached the `SubContent` node on
  alternate close cycles — the flyout element lingered, fully interactive,
  over the page. The jsdom suite couldn't catch it (no animation lifecycle in
  jsdom). Fix: `SubContent` now renders only while our `activeSubmenu` state
  says open, with `forceMount` — React owns the mount/unmount and Presence's
  unmount heuristic is out of the picture. No exit animation is lost (the
  register carries enter-only `panelFadeIn`).
  - **Verification**: `submenu-chevron` / `copy-submenu` /
    `block-context-menu` suites green (14/14); `tsc --noEmit` clean; the
    Playwright hover probe (8 dwell timings × open→hover-sibling) fails 8/8
    before the fix and passes 8/8 after, against the redeployed stack.

- **chore(docs)!: `releases.md` retired — each client owns its releases; the
  file scrubbed from all of git history (all SHAs changed again).** Owner
  ruling (2026-10-22): the main repo documents only that the clients exist —
  `docs/developers/README.md` gains a Clients section (GTK/Flutter/CLI
  siblings, one line each on their release mechanics, the lockstep law stays
  in `development.md`); `docs/developers/releases.md` is deleted and every
  live reference repointed (AGENTS.md, the project skills, parked-decisions,
  migrations, deployment). The client checkouts live as siblings under
  `/root/projects` (moved from the retired periphery `notees-clients`
  folder). The history scrub is the second rewrite of the day — **all commit
  SHAs changed, every tag re-pointed**; any clone, submodule pin (the CLI's
  vendored copy re-pinned the same day), or citation of old SHAs must
  re-fetch/re-pin. The `block-grip` / `classes-gallery` worktrees and any
  other stale clone re-sync from the rewritten remote.
  - **Verification**: zero refs contain the scrubbed path (verified in a
    fresh mirror clone); the rewritten tip's tree is byte-identical to the
    pre-scrub tip; CLI vendor re-pin gate green (87/87).

- **chore(repo)!: history rewritten — every live compose file scrubbed from
  all of git history; 12 stale merged remote branches pruned; `main`
  protection recreated as a ruleset.** Owner directive (2026-10-22): the
  old tracked `compose.yaml` (and its historical siblings `compose.yml`,
  `docker-compose*.yml`, `compose.dev/prod/web.*`, `compose.override.yaml`)
  were removed from every commit, branch, and tag with `git filter-repo` —
  the committed `compose.example.yaml` / `compose.dev.example.yaml` carry
  forward. Verified: zero refs contain the scrubbed paths. **All commit SHAs
  changed** (releases re-tagged; `v1-archive` and every `v*` tag re-pointed) —
  any clone, submodule pin (notees-cli's vendored copy), or citation of old
  SHAs must re-fetch/re-pin. Unmerged branches `backlink-stats-heal`,
  `embedded-model`, `ui/audit-fixes` were fetched in, rewritten, and
  force-updated (content preserved minus the compose files). Merged-and-stale
  remote branches pruned: `brand-margin-green`, the six `condensed-*`,
  `graph-rail`, `greenfield/m1-core`, `hr-rule`, `link-embedded`, `list-style`.
  No content leaked (historic compose files were env-var templates; `.env`
  was never tracked). `main` protection (deleted to permit the force push,
  PATCH/POST on the classic endpoint 404s for this account) recreated as
  repository ruleset `main-protection` (id 25619313): pull_request +
  non_fast_forward, owner bypass — functionally the old rule; one deliberate
  delta: PRs now need 1 approving review for non-bypassed actors (the old
  rule required 0).
  - **Verification**: `git log --all -- <compose paths>` empty locally;
    `main` forced to the rewritten tip; all tags force-updated; ruleset
    active on `refs/heads/main`.

- **chore(deploy): human-readable edge logs — Caddy's console encoder with
  the request/response header dumps filtered out.** The edge's default JSON
  error log dumped every request header (Sec-Fetch-*, Sec-Websocket-Key, …),
  so each 502 was a screen-filling line; the `log` block in
  `deploy/Caddyfile` now wraps the console encoder in the filter encoder and
  deletes `request>headers` + `resp_headers`, leaving one line with
  timestamp, level, client, method, URI, status, duration (the sync token
  stays in the WS URL as in any access log). Access lines and reverse-proxy
  errors share the format; one-shot startup lines remain JSON.
  - **Files**: `deploy/Caddyfile`; `docs/developers/deployment.md` §10 (edge
    logging bullet); `.agents/skills/notees-operations/references/logs.md`.
  - **Verification**: `caddy validate` against `notees-edge:local` — Valid
    configuration; `docker compose restart notees-edge` + a curl through the
    edge — 200, access line in console format with no header dumps.

- **feat(store,web): the system-extends lock — a system class's extends mapping
  is frozen to the seeded set; deviations fail loud with
  `SystemExtendsLockError`.** Owner ruling (2026-10-22): the seeded extends
  edges (`meeting`/`birthday`/`trip` → `event`, the source family, `weblink` →
  `source`, `person`/`organization` → `agent`, …) are platform structure that
  TWO product behaviors derive from — the feature-toggle cascade
  (`systemClassAncestors`) and binding inheritance (the `class_extends`
  walk) — so a user edit would silently diverge the toggle's assumptions from
  the store's actual hierarchy. `class.setExtends` on a system class now
  applies ONLY when the payload's parent set equals the seeded set (compared
  as sets — the seed/ensure re-issue convergence path,
  `apps/server/src/seed.ts` + the web `deploySystemClass`/`meetingFamily`
  ensures); every deviation (detaching a seeded parent, adding an extra
  parent, parenting a parentless system base) throws and is never applied.
  User classes stay freely extensible onto system bases (a runtime subclass
  of `source`/`meeting` is the designed extension point). Enforcement is
  never retroactive — the lock gates new writes only, so no live migration.
  The web class page's extends corner renders READ-ONLY (static pills) for
  system classes instead of advertising edits that must fail. New canonical
  fixture `class-extends-system-lock.json` (gate 36→37; accepting prefix =
  user→system extension + the seeded re-issue, rejecting tail = detach /
  extra parent / parenting a system base).
  - **Files**: `packages/domain/src/seeds.ts` (`SYSTEM_CLASS_EXTENDS_IDS` +
    `isSystemClassId`), `packages/store/src/errors.ts`
    (`SystemExtendsLockError`), `packages/store/src/appliers.ts`
    (`applyClassSetExtends` guard), `packages/protocol/fixtures/`, the
    protocol/store gate tests, `apps/web/src/features/page-sections/pageVariant.ts`
    (the read-only corner), `packages/protocol/SCHEMA.md`,
    `docs/developers/development.md` + `releases.md`. **Verification:** full
    gate green — `pnpm typecheck` clean; `pnpm test` all suites (protocol 546
    incl. the 37-fixture exact list; store 627 on both adapters incl. the new
    lock test; web 1948 incl. the read-only corner test). **Lockstep:**
    GTK 870 passed + ruff + mypy; Flutter analyze clean + 679 tests; fixture
    sha256-matched in both (gate 37/37).

- **chore(deploy)!: live deployment files are host-local artifacts — the
  committed `compose.yaml` is untracked; the repo ships the example family
  only.** Owner ruling (2026-10-22), now enforced fleet-wide by the
  `rosellramos-coding-standards` skill's new "Deployment artifacts" section:
  the actual `compose.yaml` + `.env` are gitignored, never committed; repos
  carry `compose.example.yaml` (+ `compose.dev.example.yaml`: ports
  8379/8380, its own data dir, sync-URL prefill, no tailscale edge — an
  isolated second instance from its own folder) and `.env.example` only.
  Fresh hosts bootstrap with `cp compose.example.yaml compose.yaml && cp
  .env.example .env`. The `name: notees` pin is gone too — the compose
  project derives from the folder name (fleet convention, matching every
  other stack); keep the repo folder `notees` on production hosts. `.env`
  example rewritten to the current variable set (`NOTEES_SYNC_HTTP` /
  `NOTEES_WEB_HTTP` / `NOTEES_DATA_DIR` — the old `*_PORT`/`*_LAN_PORT`
  names were stale). The live file on the fleet host is untouched (gitignored
  now, same content minus `name:`); `docker compose config` still resolves
  project `notees` from the folder, so the running stack is unaffected.
  - **Files**: `.gitignore` (`/compose.yaml`, `/compose.override.yaml`),
    `compose.yaml` (untracked — deletion from the index only, working file
    kept), `compose.example.yaml` + `compose.dev.example.yaml` (new),
    `.env.example` (rewritten), `docs/developers/deployment.md`, `AGENTS.md`,
    `.agents/skills/notees-operations/references/deployment.md`, and the
    `rosellramos-coding-standards` skill (fleet rule, separate repo push).

- **chore(deploy)!: the repo-root compose IS the deployment — the
  source/stack split retires; one compose file, one project (`notees`), the
  data dir the single host-local override.** Owner decision (2026-10-22):
  the dual deploy location (a live compose copy outside the checkout,
  owner 2026-10-19) was more convoluted than protective — explicit project
  names had already closed the 2026-10-20 hijack class structurally, and
  the split broke the documented version-pin procedure on the fleet host.
  The repo-root `compose.yaml` now carries `name: notees` (the template
  name `notees-dev` reverted), build contexts `.`, and the sync data bind
  `${NOTEES_DATA_DIR:-./config/notees/sync}`; the fleet host's `.env`
  (moved from the retired stack folder into the repo root, gitignored) sets
  `NOTEES_DATA_DIR=/etc/periphery/stacks/notees/config/notees/sync`, so the
  live dataset — and the borgmatic `notees` backup source — stays at the
  fleet stacks location, outside the dev repo where `git clean` could never
  reach `relay.db`. The stack folder keeps ONLY the data + a README
  pointer; its compose copy is deleted. Migrated live: `down` from the
  stack folder, `up -d` from the checkout (edge adopted into the project,
  sync healthy, bind verified `/etc/periphery/.../sync -> /data`),
  `verify-min` VERIFY-PASS. Operate the stack with plain `docker compose`
  from the repo root — no aliases, no `-f` paths.
  Komodo manages the fleet host's data folder; UI-managed redeploys re-enabled
  the same day by pointing the Komodo `notees` stack resource at the repo root
  (run directory `/root/projects/notees`, project name `notees`, env file the
  repo-root `.env`) and mounting the repo into the periphery container
  (same-path volume — without it periphery cannot see the run directory).
  Validated with a real Komodo deploy: `VERIFY-PASS`.
  - **Files**: `compose.yaml` (repo root — now the production file),
    `docs/developers/deployment.md`, `AGENTS.md`,
    `.agents/skills/notees-operations/references/deployment.md`,
    `~/.bashrc` (host-local), `/etc/periphery/stacks/notees/` (host-local:
    compose retired, README pointer added, `config/` untouched).
  - **Verification**: `verify-min.mjs` VERIFY-PASS after the migration;
    `docker inspect` bind source = the live data dir; `notees-ps` lists
    all three containers healthy from a foreign cwd.

- **fix(web): the embedded feed's "Open page" button reveals on title-row
  hover.** Owner follow-up (2026-10-22): the button beside the journal/calendar
  feed titles shows only while the pointer is on the title row — hidden at
  rest (opacity, not visibility, so it stays in the tab order), revealed by
  `.nt-page-title-wrap:hover` (the wrap spans the row's free width, so the
  words AND the space beside them trigger it) and by `:focus-within` for
  keyboard users; coarse pointers (touch) keep it always visible. The reserved
  width means the reveal never shifts the title, and a pointer over the
  button's box is necessarily hovering the row — no invisible-click trap.
  - **Files**: `apps/web/src/ui/PageChrome.tsx` (the button takes
    `.nt-page-title-embed__open`),
    `apps/web/src/features/calendar/JournalsView.css` (the reveal block),
    `apps/web/test/hover-press-register.test.ts` (the reveal contract).
  - **Verification**: the affected suites (48 tests across the four files);
    the FULL web suite green.

- **fix(web): menus and floating chrome ride the elevated popup register —
  the surface-container-low blend the calendar-popup fix solved returns; plus
  context-menu flyouts close when the pointer leaves the menu.** Owner report
  (2026-10-22, screenshot): the context menu and its Copy flyout rendered on a
  surface indistinguishable from the dark content behind. `surface-container-
  low` (+3 L* over surface) was not enough on the flat night; every menu and
  floating panel now rides the register the calendar-popup fix proved:
  `surface-container-high` + the level-2 shadow. Sweep: the ContextMenu card +
  flyout, the Dropdown menu + catalog command, the NotificationToast (the
  flagged "follow-up elevation audit" this closes), the block FloatingToolbar,
  the block TriggerPopup, the TemplateListPopup, the FloatingEditor windows,
  and the find/replace widget (surface-bright + no shadow → elevated + level
  2). The M3 menus-sit-on-surfaceContainerLow ruling is superseded in practice
  by the owner's readability report. Second fix (same report): an open
  flyout stayed up when the pointer walked off the menu entirely — the menu
  card now carries an `onMouseLeave` that closes the submenu (the menu itself
  still rides onClose; the flyout is a no-Portal DOM child of the card, so
  entering it never fires the leave). The enter-only BETWEEN-items seam is
  unchanged.
  - **Files**: `apps/web/src/components/ui/fleet/ContextMenu.css` (+ the
    `onMouseLeave` in `ContextMenu.tsx`), `components/ui/fleet/Dropdown.css`,
    `components/ui/fleet/NotificationToast.css`,
    `ui/editor-popups/FloatingToolbar.css`, `ui/editor-popups/TriggerPopup.css`,
    `ui/templates/TemplateListPopup.css`, `features/block-editor/FloatingEditor.css`,
    `ui/editor-popups/FindReplaceWidget.css`,
    `apps/web/test/submenu-chevron.test.tsx` (register assertions moved to
    -high + elevation-2; new tests: leave-closes-flyout, flyout-is-DOM-child).
  - **Verification**: the affected suites; the FULL web suite green.

- **chore(deploy): the compose projects are named explicitly — `notees` prod,
  `notees-dev` template — closing the 2026-10-20 hijack class structurally.**
  Owner decision (2026-10-22): the repo-root `compose.yaml` names its project
  `notees-dev`, so any raw `docker compose` from the checkout lands on an
  isolated dev project (it fails loudly on the pinned 8377/8378 ports rather
  than hijacking the live containers); the live stack's compose names its
  project `notees` explicitly instead of deriving it from the folder name.
  (Both the template name and this slice's `~/.bashrc` aliases retired the
  same day with the deployment collapse below — the repo-root compose became
  the production file and plain `docker compose` from the repo root replaced
  the aliases.) Verified live: both files resolve to their named project
  (`docker compose config`), and the running stack was untouched (container
  set + health identical).
  - **Files**: `compose.yaml` (repo template), `/etc/periphery/stacks/notees/
    compose.yaml` (live stack — host-local, the stacks repo gitignores
    `notees/`), `docs/developers/deployment.md`, `AGENTS.md`, `~/.bashrc`
    (host-local).

- **fix(web): embedded feed titles (journal + calendar day pages) are plain
  headings again — navigation rides an explicit "Open page" button.** Owner
  report (2026-10-22): the headline-sized clickable title with its state-layer
  hover read as noise. The embedded render of `PageHeaderChrome` now renders
  the title as a static `.nt-page-title-embed__text` heading and a kit ghost
  icon button (`mdi-arrow-right`, aria-label/title "Open page") that navigates
  to the full page view — the hover register stays at the icon-button scale,
  the heading stays selectable, and the pattern covers every embedded surface
  (the journal feed and the calendar's daily-note embed share the one
  `PageHeaderChrome` branch). The old `.nt-page-title-link` button + hover
  rule are gone; the right-click node menu on the title row is unchanged.
  - **Files**: `apps/web/src/ui/PageChrome.tsx`,
    `apps/web/src/features/calendar/JournalsView.css` (the `.nt-page-title-embed`
    styles), `apps/web/src/ui/PageView.tsx` + `JournalsView.tsx` (doc comments),
    `apps/web/test/title-editor.test.tsx`, `apps/web/test/journals-view.test.tsx`,
    `apps/web/test/hover-press-register.test.ts` (the register test now asserts
    the title carries NO hover rule — the old contract is inverted).
  - **Verification**: `pnpm typecheck && pnpm test` from the repo root.

- **feat(web): the New-node picker offers “No class,” and its search text
  joins the picker row grid.** Owner correction (2026-10-22): “Blank page”
  named the page’s content; the choice is classification, so the pinned
  first row is the explicit **No class**. It rides on the shared
  `NodeSelector` as an opt-in `emptyQueryOption` — visible only while the
  query is empty, indexed first for Enter, and hidden by typing so class
  search keeps its ordinary keyboard answer. The New-node host maps the
  pick to `createNodesWithClasses(client, [], openPage)`, whose empty list
  now means one standalone class-less page. The compact search field also
  claims the result-row grid: its sm variant gives the 20px glyph a 24px
  icon lane, and anchored pickers zero the field’s internal horizontal
  padding because the panel margin already supplies it — the placeholder
  and result labels now share the same x position.
  - **Files**: `apps/web/src/features/pickers/NodeSelector.tsx` +
    `NodeSelector.css`, `apps/web/src/ui/app/AppTopBar.tsx`,
    `apps/web/src/features/templates/createNodesWithClasses.ts`,
    `apps/web/src/components/ui/fleet/SearchField.css`,
    `apps/web/test/pickers.test.tsx`, `apps/web/test/ui-primitives.test.tsx`,
    `docs/developers/ui-primitives.md`.
  - **Verification**: `pnpm --filter @notees/web typecheck`; the affected
    picker/primitive suites (42 tests); the FULL web suite — 1945 passed
    (167 files); an offline Vite visual probe at 1440/768/390 measured
    input/label x delta `0` and search/result icon-center delta `0`, with
    “No class” first on the empty query and absent after typing.

- **fix(web): anchored picker search bars ride the compact sm register — the
  New-node class picker stops wearing the oversized md pill.** Owner report
  (2026-10-21, the class-picker screenshot): the sibling `SearchField
  size="sm"` fix had only reached the collection filter bar, so every
  node-picker search still inherited the full-height default. Both
  `NodeSelector` render branches now pass `size="sm"` — covering the
  New-node class picker, Add-class/property pickers, page/block/link
  pickers, and the graph rail's inline search-to-select — alongside the
  bind-property popover and the slash-menu template-list popup. The sweep
  deliberately leaves full surfaces and roomy modals at `md` (Search page,
  command palette, template gallery, class-create catalog) and keeps the
  narrow filter popup's field `md` per the preceding ruling.
  - **Files**: `apps/web/src/features/pickers/NodeSelector.tsx`,
    `apps/web/src/features/classview/PropertyDefinitionsSection.tsx`,
    `apps/web/src/ui/templates/TemplateListPopup.tsx`,
    `apps/web/src/components/ui/fleet/SearchField.tsx` + `.css` (the sm
    register's contract comment), `apps/web/test/pickers.test.tsx`,
    `property-definitions-section.test.tsx`, `popup-dismissal.test.tsx`,
    `docs/developers/ui-primitives.md`.
  - **Verification**: `pnpm --filter @notees/web typecheck`; the three
    affected suites (49 tests); the FULL web suite — 1939 passed (167
    files); an offline Vite visual probe at 1440/768/390 measured the
    New-node class-picker field at 30px with the `search-field--sm`
    register and the create row intact.

- **fix(web): two ring sizes, one style — the classic 16px halo returns on
  dot bullets; icon bullets keep the 28px circle.** Owner question
  (2026-10-21): "would having the old ring size for non-icon bullets look
  bad? so, two ring sizes" — answered no and shipped: the ring exists to
  hug its glyph. 28px around the 19.2px class-icon plate reads tight (the
  16px halo hid entirely behind the solid glyph); 28px around the 6px dot
  was a big empty wash, so dot bullets return to the long-approved 16px
  halo — dot rows regain their exact original proportions (with the 6px
  dot from the sibling commit) while icon rows keep the grown circle. Same
  soft primary background for both — the `:has(.nt-bullet-icon)` rule is a
  size variant only, never the retired border/outline treatment. The 46px
  bullet element and the grouped rendering's spacing-3 separation stay.
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet-ring` 16px base + the
    28px `:has(.nt-bullet-icon)` size variant), `apps/web/test/view-modes.
    test.tsx` (the CSS spec pins both sizes and the no-border style).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1938 passed (167 files), run once
    the parallel session's section-props refactor landed.

- **feat(web): no section header counts anywhere — the active tab's badge is
  the one count, and every section counts the same way (displayed nodes).**
  Owner ruling (2026-10-21, on the Backlinks 111 vs Default 109 divergence):
  a visible section already says it holds SOMETHING, and the hosted tab
  bar's active-tab badge names the number dynamically — so the
  NodeViewSection/Section header count badge DIED everywhere. The count
  prop and `.node-view-section__count` register are gone; every call site
  (system sections, classed nodes, class properties/templates, metadata
  panels, graph rail, calendar day sections, TOC) stops passing one. The
  eager reads that ONLY fed badges are dropped; the eager reads that GATE
  (hide-when-empty, the empty-starts-expanded states) stay — they answer
  "is there anything", never display. The block-level backlink gutter
  badge is untouched (a row affordance, not section chrome). The tab badge
  semantics are unchanged: the open tab's displayed row count.
  - **Files**: `apps/web/src/features/page-sections/NodeViewSection.tsx` +
    `.css` (the count prop + register removed), `apps/web/src/ui/Section.tsx`
    (the `badge` prop removed), and every call site: `SystemSections.tsx`,
    `CollectionSection.tsx`, `CommentsSection.tsx`, `CreatedSection.tsx`,
    `lassedNodesSection.tsx`, `PropertyDefinitionsSection.tsx`,
    `emplatesSection.tsx`, `xtendedBySection.tsx`, `PropertiesSection.tsx`,
    `PropertiesSidebar.tsx`, `PropertyView.tsx`, `GraphView.tsx`,
    `DayPageSections.tsx`, `sidebarSections.tsx`; `docs/features/links.md` +
    `queries.md` follow.
  - **Verification**: `pnpm --filter @notees/web typecheck` and the full web
    suite green.

- **fix(web): the dot glyph returns to 6px — the register growth belongs to
  the icon bullets.** Owner review (2026-10-21): collapsed nodes with icons
  "look nice", but the non-icon bullets read too big. The cause: the dot
  had grown 50% with the register (6 → 9px) while the ring settled back at
  28px — a bigger dot inside the same circle reads heavy. The dot returns
  to its long-standing 6px (the `--bullet-dot-size` token value, unchanged
  all along); the 46px bullet element and the 28px ring stay — the growth
  exists for the 19.2px class-icon glyph, and the dot doesn't participate
  in the icon rows at all (the glyph replaces it).
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet-dot` 9 → 6px),
    `apps/web/test/view-modes.test.tsx` (the CSS spec follows).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — see the run below.

- **fix(web): the collapsed ring settles back at 28px — the 40px circle read
  too big; the grown bullet element stays.** Owner ruling (2026-10-21,
  live-size review): "the outer circle was fine, now it's too big." The
  ring returns to the 28px the owner had approved, riding the 46px bullet
  box and the 9px dot from the register growth (which stays — only the
  circle's size walked back). `--bullet-wrapper-size` unchanged at 46px;
  the grouped rendering's spacing-3 separation stays (the grown bullet
  box still overhangs its row even with the smaller ring).
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet-ring` 40 → 28px),
    `apps/web/test/view-modes.test.tsx` (the CSS spec follows).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1938 passed (167 files).

- **feat(web): the hosted tab bar's active tab carries a total-count badge —
  the filter panel's "N of M nodes match" foot line is gone.** Owner ruling
  (2026-10-21): instead of the "109 of 109 nodes match" line on the
  structured-filter panel's foot row, the count shows as a small badge beside
  the currently open tab's name. `NodeCollection` computes the open tab's
  displayed row count (post-refinement — grouped rendering sums the groups'
  rows plus the ungrouped ones) and hands it to `SectionViewTabs`, which
  renders it as an `aria-hidden` pill next to the active tab's label (the
  tab's accessible name stays the bare label). The FilterBar's panel foot now
  carries only the "Save as tab" escape; the bar row's honest "N of M" chip
  while a transient filter is active is unchanged.
  - **Files**: `apps/web/src/features/collection/SectionViewTabs.tsx` (the
    `activeCount` prop + badge), `apps/web/src/features/collection/
    SectionViewTabs.css` (the pill register), `apps/web/src/features/
    collection/NodeCollection.tsx` (the post-refinement count), `apps/web/
    src/features/collection/FilterBar.tsx` + `FilterBar.css` (the foot line
    removed), `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (comments follow), `apps/web/test/filter-builder.test.tsx` + `section-
    views.test.tsx` (assertions follow the badge), `docs/features/queries.md`
    + `docs/developers/architecture.md` (the count's new home).
  - **Verification**: `pnpm typecheck` green; `pnpm test` green (web suite:
    filter-builder, section-views, filter-layer among them).

- **fix(web): the bullet register grows ≥50% (46px box, 40px ring, 9px
  dot), and the group-items separation deepens to match.** Owner report
  (2026-10-21): "the bullet element could be even larger — at least 50%
  larger." `.nt-bullet` 30 → 46px, `.nt-bullet-ring` 28 → 40px (the halo
  now clears the 19.2px class-icon glyph by ~10px), and the dot glyph
  scales with the register (6 → 9px — hardcoded in `.nt-bullet-dot`, the
  `--bullet-dot-size` token stays 6px because it also feeds the
  LoadingScreen). `--bullet-wrapper-size` follows at 46px. The grouped
  rendering's top padding rides along: `spacing-2` → `spacing-3` — the
  40px ring overhangs its row far more than the 28px one did. Rows are
  noticeably taller; that is the owner-directed trade. The CSS spec pins
  the register (46/40/9) and the group padding.
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet` 46px,
    `.nt-bullet-ring` 40px, `.nt-bullet-dot` 9px), `apps/web/src/ui/
    variables.css` (`--bullet-wrapper-size`), `apps/web/src/features/
    collection/OutlineView.css` (`.outline-group__items` spacing-3 top
    padding), `apps/web/test/view-modes.test.tsx` (the CSS spec follows).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1938 passed (167 files); the
    failures seen across full runs (block-dnd, filter-builder,
    section-views — none touched by this CSS-only slice) all pass in
    isolation, the known concurrent-suite contention flakes.

- **fix(web): the bullet and its collapsed ring grow once more (30px/28px),
  and grouped rows separate from the group titles.** Owner report
  (2026-10-21, screenshot of a date-page group): the first row's ring
  crowded the group header, and the bullet element still read small.
  `.nt-bullet` 26 → 30px, `.nt-bullet-ring` 24 → 28px (the halo now clears
  the 19.2px class-icon glyph by ~4px and reads beside the row text),
  `--bullet-wrapper-size` follows at 30px. The grouped rendering's item
  list gains a real top padding (`spacing-2`) — the grown ring overhangs
  its row's line box upward, and with zero top padding it touched the
  header. The CSS spec pins both (ring 28px, bullet 30px, the group-items
  padding) and keeps asserting no icon-specific ring variant.
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet` 30px,
    `.nt-bullet-ring` 28px), `apps/web/src/ui/variables.css`
    (`--bullet-wrapper-size`), `apps/web/src/features/collection/
    OutlineView.css` (`.outline-group__items` top padding), `apps/web/test/
    view-modes.test.tsx` (the CSS spec follows).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1938 passed (167 files).

- **fix(web): the fleet Button is the rounded square again — the visible-box
  reset lost its specificity race.** Owner report (2026-10-21): the topbar
  buttons "are no longer a square with rounded corners". Measured live with
  a geometry probe: every fleet Button rendered 32x48 — `w-icon-only-
  visible-sm` (32px) wide but `min-h-touch` (48px) tall, a portrait
  rectangle. Cause: 146dd7623 widened the visible-box reset from
  `.btn.btn--icon-only` (specificity 0,2,0) to `.btn` (0,1,0) — the same
  specificity as the `.min-h-touch` utility, which wins the source-order
  race (the utilities are emitted unlayered, so the "unlayered beats
  layered" assumption in the old comment did not hold; the pre-change
  specificity edge was doing the real work). The reset is `.btn.btn` now —
  (0,2,0), beating the utility while keeping the reset on EVERY button
  (text buttons included). The 48dp floor lives on, unchanged, as the
  invisible hit-area overlay.
  - **Files**: `apps/web/src/components/ui/fleet/Button.css` (the doubled
    class + the corrected measured-live comment).
  - **Verification**: `node scripts/screenshots/button-shape-probe.mjs`
    against the rebuilt stack — topbar buttons measure 32x32,
    border-radius 6px; `pnpm typecheck` + the apps/web suite green.

- **fix(web): class pills answer edits from read-only reference rows, and
  the whole clickable pill wears one cursor.** Two owner reports from the
  Backlinks outline rows (2026-10-21): (1) hovering a row's class pill
  showed nothing — no ×, no "+", no response. The block row rendered the
  classes column with the row's `readOnly` flag (the "edit/read alignment"
  ruling), so backlinks/unlinked/child-page rows projected STATIC pills.
  Owner ruling: class membership is a working surface on reference rows —
  the column now rides its own lock, the date-chain rule, and answers × /
  "+" / drag-sort on every row (the content, tags row, and properties stay
  read-only; the date-lock is new for the inline column too — date blocks
  in editable pages were mutably wrong before). (2) the hover cursor split
  across a clickable pill — hand over the label, arrow over the colored
  padding. The fleet Pill now carries `.pill:has(button.pill__text) {
  cursor: pointer }`: a pill whose label is a button reads as ONE surface
  (the same ruling the `.pill--add` label already had); non-clickable chips
  (`span.pill__text`) keep the default arrow.
  - **Files**: `apps/web/src/ui/BlockRow.tsx` (the `classesLocked` date
    rule + the column's new contract comment + `parseDateNodeId` import),
    `apps/web/src/components/ui/fleet/Pill.css` (the `:has()` cursor rule),
    `apps/web/src/features/collection/types.ts` (the `readOnly` contract
    doc), `docs/features/pages.md` (the class-pills clause).
  - **Verification**: `pnpm typecheck` + the apps/web suite green.

- **fix(web): the collapsed bullet ring is ONE soft outer circle, grown past
  the class-icon glyph — the bullet element grows to hold it.** Owner
  correction (2026-10-21, reviewing the outline-ring variant shipped in the
  reference-sections slice below): "on icons there should be the same outer
  circle as in collapsed bullets — make it bigger if needed, and also if
  needed make the main bullet element bigger to make it on par with the
  icon's size." The border-outline-above-the-glyph approach is retired; the
  ring stays the shared soft primary halo for dot and icon bullets alike —
  one circle, sized 16 → 24px so it clears the 19.2px class-icon plate that
  hid the old halo entirely, and the bullet box grows 22 → 26px to carry the
  ring on par with the glyph (rows gain a few px of height — the
  owner-accepted trade). `--bullet-wrapper-size` follows at 26px — the
  BooleanToggle lg thumb's bullet-sized token; its single lg consumer (the
  workspace-settings modal) rides along. Hover still deepens the halo.
  - **Files**: `apps/web/src/ui/app.css` (`.nt-bullet` 26px,
    `.nt-bullet-ring` 24px, the icon-outline rules removed),
    `apps/web/src/ui/variables.css` (`--bullet-wrapper-size`),
    `apps/web/test/view-modes.test.tsx` (the CSS spec follows the ruling:
    one 24px background circle, no icon-specific variant).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1938 passed (167 files; the CSS
    spec reads app.css cwd-relative, the condensed precedent).

- **refine(web): the block row's "+ Add class" pill moves to the start of
  the classes cluster — hover-reveal no longer shifts the pills.** Owner
  ruling (2026-10-21), the follow-up to the no-permanent-gap fix: with the
  add pill at the END of the chips, the hover reveal grew the right-pinned
  row-end group rightward-bound — the class pills and the backlink toggle
  slid sideways on every hover. `NodePills` gains `addAtStart`: the block
  row renders the "+" picker FIRST (left of the pills, DOM order matching
  visual order so tab/screen-reader order stays honest), so the reveal
  grows the group leftward over the flexible text column and the pills
  never move. The pill LIST order is deliberately untouched — the pills
  carry the user-defined drag-sort order, and inverting their display
  would flip that semantics (the owner's "invert the list" idea proved
  unnecessary once the add button rides at the start). Every other surface
  (page header, tags, aliases, property cells, the extends row) keeps the
  end-of-list add position.
  - **Files**: `apps/web/src/features/metadata/NodePills.tsx` (the
    `addAtStart` prop + the add-anchor extraction shared by both
    positions), `apps/web/src/ui/BlockRow.tsx` (the block classes column
    passes it), `docs/features/pages.md` (the block-row column contract
    clause).
  - **Verification**: `pnpm typecheck` + the apps/web suite green.

- **refine(web): the AND/OR control settles on the original
  overlapping-circles icons.** Owner reversal, same day (2026-10-21): the
  bold-uppercase AND/OR text segments "look terrible" — the control returns
  to the v1 register (`mdi-set-all` AND / `mdi-set-center` OR, the
  overlapping-circles pair) inside the bordered SelectionButton. The
  SelectionButton `text` segment register, trialed three ways this session, retires unused — the primitive is restored to its pre-experiment form.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (LOGIC_OPTIONS back to set-all/set-center), `apps/web/src/components/ui/fleet/SelectionButton.tsx`
    + `.css` (restored).
  - **Verification**: `npx tsc --noEmit`; `filter-builder` + `graph-view`
    46/46 green (the logic radios keep their accessible names, assertions
    unchanged).

- **feat(web): the outline list opens pages collapsed — a page row with
  child blocks starts folded behind its chevron.** Owner ruling
  (2026-10-21): "in outline nodecollection view mode always show pages in
  collapsed state by default (when they actually have child blocks, of
  course)". The flat outline list (hubs, classed-nodes, query results, the
  pages hub) previously rendered every page's child blocks expanded, so a
  list of pages with content read as a wall of nested text. Now the list
  reads one row per page: any document-chrome row (the
  `rendersWithDocumentChrome` page role, nested child pages included) with
  children defaults to the folded state; block rows keep their natural
  expanded state — the ruling names pages only. Expansion is session-local
  display state: the default rides a per-render `defaultCollapsed` set into
  `useOutlinerValue`, which keeps a session-only override set (never
  persisted — the persisted fold set still stores only explicit folds, and
  the collapse-by-default re-applies next session); the toggle consults the
  effective set, so folding/unfolding a defaulted row composes with the
  existing rail click and keyboard navigation (the visible-order derivation
  reads the same effective set). Out of scope by the ruling's letter: the
  editable outliner tree (the page body, the focused-block zoom) and the
  read-only child-page tree (its rows carry child pages, not child blocks).
  Docs: `docs/features/views.md` (the list-view section owns the ruling).
  - **Files**: `apps/web/src/ui/outliner-context.ts` (the `defaultCollapsed`
    option, the session override set, the effective-collapse derivation,
    the toggle), `apps/web/src/features/collection/OutlineView.tsx` (the
    flat list computes the page-with-children set and passes it; the file
    header records the ruling), `apps/web/test/view-modes.test.tsx` (the
    pages-hub spec re-encodes the collapsed default; two new specs cover
    the fold/expand toggle and the block-rows-stay-expanded carve-out).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1936 passed (167 files).

- **fix(web): the collapsed default generalizes to every row with children
  — blocks included — and reaches the backlinks-style reference rows.**
  Owner review of the slice above (same day): the backlinks section still
  showed rows uncollapsed — its rows render through `ReferenceSubtree` (the
  section renderItem), not the flat list's BlockRow, and they are blocks,
  outside the first slice's pages-only predicate. Two changes: the flat
  list's default-collapse set now collects EVERY rendered row with children
  (the `rendersWithDocumentChrome` predicate is gone — the tasks hub's
  subtask rows fold like everything else), and `ReferenceSubtree` hands its
  own context a `defaultCollapsed` set holding the root id when the root
  has children — the backlinks/unlinked-mentions rows and the property
  carrier cell read one row per reference, the subtree behind the chevron,
  same session-local override. The editable outliner tree (page body,
  focused-block zoom) and the read-only child-page tree stay expanded by
  design — they are documents/trees, not item lists. Docs: the
  `docs/features/views.md` ruling reworded to rows-with-children.
  - **Files**: `apps/web/src/features/collection/OutlineView.tsx` (the
    predicate dropped — children > 0 is the whole condition), `apps/web/
    src/features/block-editor/ReferenceSubtree.tsx` (the root-row default,
    the file header records the ruling), `apps/web/test/view-modes.test.tsx`
    (the block carve-out spec inverts to the generalized ruling; a new spec
    covers the reference subtree's folded root).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1937 passed (167 files).

- **fix(web): the reference sections render as ordinary outline sections,
  and a collapsed class-icon bullet wears its ring again.** Two
  owner reports from reviewing the collapse work (2026-10-21).
  (1) "Backlinks section should be like any other section, wtf": the
  Backlinks/Unlinked-mentions rows were a snowflake — a bespoke renderItem
  drawing a breadcrumb trail plus an inline EDITABLE subtree per row (the
  Logseq-era rendering), next to every other section's shared inert rows.
  `ReferenceList` now renders the standard collection rows like any other
  section — one inert row per referencing block, children folded behind
  the chevron (the collapse ruling applies as-is), the bullet opening the
  source via the container's onNodeClick. The grouping by containing page,
  the ungrouped-page-sources-first ruling, the hosted tabs, the sort
  button, and the transient filter layer were the shared machinery
  already. What a row still owns rides the shared trailing-action seam:
  the bound-verb pill and, on Unlinked mentions only, the Promote/Ignore
  pair (labels and writes unchanged). The dead breadcrumb CSS and the
  Breadcrumbs/ReferenceSubtree imports go with the rendering; ReferenceSubtree
  itself stays (the property carrier cell).
  (2) "Collapsed pages don't have the collapsed bullet outer circle —
  maybe because of the icon": right — the ring is a soft background halo,
  and a class-icon bullet's glyph is a solid plate that paints over it.
  The ring on icon bullets is now an outline circle (1.5px primary-border)
  painted ABOVE the glyph (`:has(.nt-bullet-icon)`, z-index 1, 19px), with
  the hover deepening the border the way the halo deepens behind the dot.
  Docs: `docs/features/links.md` (the reference-sections ruling).
  - **Files**: `apps/web/src/features/page-sections/SystemSections.tsx`
    (the renderItem retired — trailingAction + onNodeClick; the ReferenceList
    doc rewritten), `…/SystemSections.css` (the dead breadcrumb rule
    removed; the verb/actions ride the trailing seam), `apps/web/src/ui/
    app.css` (the icon-bullet outline ring), `apps/web/test/system-sections.
    test.tsx` (the row selector follows the standard rows), `apps/web/test/
    view-modes.test.tsx` (a CSS regression spec for the icon ring).
  - **Verification**: `pnpm --filter @notees/web typecheck` and the FULL
    `pnpm --filter @notees/web test` — 1936 passed; two failures, both
    resolved: the CSS spec's fs read switched to `process.getBuiltinModule`
    (the jsdom builtin seam, the condensed precedent — view-modes then
    passes whole), and the known intermittent block-dnd preview-count flake
    (27/27 in isolation).

- **fix(web): text buttons render at their size tokens fleet-wide — the
  48dp floor moves to the invisible hit-area overlay.** Owner ruling
  (2026-10-21): "the add condition button also has too much top and bottom
  padding, so the problem is global" — the fleet Button's base carried
  `min-h-touch` (M3's 48dp floor, owner ruling 2026-10-16) for EVERY size,
  and only icon-only buttons reset it, so text buttons rode 48px tall
  regardless of their size token (xs/sm/md/lg = 26/30/36/44px). The fix
  extends the 2026-10-20 icon-only precedent to all buttons: the unlayered
  `btn` reset (min-width/min-height 0) now covers every button, `relative`
  rides the base class string, and the invisible min-w/min-h-touch overlay
  span renders for every enabled button — the visible box shrinks to the
  size token, the 48dp floor stays as hit area (the 2026-10-16 ruling is
  honored, as hit area). Blast radius: every text button in the app; no
  test encoded the bloat (jsdom has no layout), no feature CSS was found
  compensating with negative margins (the calendar days' local min-height
  reset anticipated the fix and is now redundant but harmless). Same batch:
  the raw-mode Apply button is `variant="outline"` + `size="sm"` (bordered
  → reads clickable; the rounded-square register from 2026-10-20 stands, no
  pill), and the raw editor's visible "Query AST (JSON)" label is hidden
  (scoped clip register, RepeatPicker's sr-only pattern — the accessible
  name stays via label/htmlFor). Also riding uncommitted in this batch: the
  owner's AND/OR BOLD UPPERCASE TEXT in the SelectionButton (the gate
  symbols from the last slice read worse than words — no MDI word icons
  exist; the text segment register returns with `font-weight: 600`).
  - **Files**: `apps/web/src/components/ui/fleet/Button.tsx` (the overlay
    for every button, `relative` on the base), `…/Button.css` (the reset
    selector `.btn.btn--icon-only` → `.btn`, header rewritten),
    `apps/web/src/features/collection/FilterBlockBuilder.tsx` (Apply
    outline+sm, the label comment), `…/FilterBlockBuilder.css` (the raw
    label's screen-reader-only clip), `apps/web/src/components/ui/fleet/
    SelectionButton.tsx` + `.css` (the bold AND/OR text segments, the
    owner's uncommitted edits kept).
  - **Verification**: `npx tsc --noEmit` (apps/web), css-token-drift, and
    the FULL `pnpm --filter @notees/web test` — 1934 passed, with only the
    known intermittent block-dnd preview-count flake (27/27 in isolation).

- **fix(web): the block row's "+ Add class" pill stops reserving a permanent
  gap.** Owner ruling (2026-10-21): the icon-only add pill rides the chips
  hover-reveal contract (`Pill.css` fades it out until the chips group is
  hovered), but opacity-hiding still occupies its flex slot — a permanent
  gap after the last class pill in the block row's right-hand column,
  pushing the backlink toggle away from the row-end group. The block-row
  override collapses the hidden pill entirely (`display: none`), so the gap
  exists only while the classes list is hovered; `:focus-within` keeps the
  pill reachable and revealed on keyboard entry, and an expanded class
  picker keeps it in flow because the anchored `NodeSelector` re-measures
  its anchor on scroll (a collapsed anchor would jump the popup). The rest
  of the metadata surfaces (page header, tags, aliases, property cells)
  keep the opacity-only contract untouched.
  - **Files**: `apps/web/src/ui/app.css` (the scoped rules beside
    `.nt-block-classes`), `docs/features/pages.md` (the block-row column
    contract clause).
  - **Verification**: `pnpm typecheck` + the apps/web suite green.

- **refine(web): the ALL/ANY logic control returns to the bordered
  SelectionButton with gate symbols — and the mode-switch vs settings
  interaction ruling is documented.** Owner ruling (2026-10-21), the
  third iteration on this control in a day: the ToggleSwitch was the wrong
  idiom for Match ALL/ANY ("we are not enabling anything") — the control
  is the fleet SelectionButton again (root head row AND every nested group
  header), now with the MDI gate symbols `mdi-gate-and` / `mdi-gate-or`
  (verified in the sprite) so AND and OR stop looking identical; the
  accessible names are unchanged ("Match ALL conditions" / "Match ANY
  condition"). Blocks/Raw stays the icon SelectionButton (toy-brick /
  code-braces). The owner's "use the BORDERED switcher" feedback exposed a
  real contrast bug: the SelectionButton container rides the SAME
  `--md-sys-color-surface-container` token as the structured-filters
  panel's background, so inside the panel the container background was
  invisible and only the hairline outline read — a minimal token-only nudge
  in FilterBlockBuilder.css steps the builder's switcher containers to
  `--md-sys-color-surface-container-high`. The interaction ruling is
  documented to stop the flip-flopping (owner ruling 2026-10-21, in
  `docs/developers/ui-primitives.md`'s catalog and both primitives' doc
  comments): mutually-exclusive MODE/VIEW switching ALWAYS rides the
  bordered SelectionButton (the ViewSwitcher component); ToggleSwitch is
  for enabling/disabling a SETTING only, never mode switching.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (the gate-symbol LOGIC_OPTIONS SelectionButton, ToggleSwitch import
    leaves), `…/FilterBlockBuilder.css` (the container-token contrast
    nudge), `apps/web/src/components/ui/fleet/SelectionButton.tsx` +
    `…/ToggleSwitch.tsx` (the ruling cross-reference in both doc
    comments), `docs/developers/ui-primitives.md` (the catalog ruling),
    `apps/web/test/filter-builder.test.tsx` (radio assertions restored).
  - **Verification**: `npx tsc --noEmit` (apps/web) and
    `npx vitest run test/filter-builder.test.tsx test/filter-query.test.ts
    test/filter-layer.test.tsx test/graph-view.test.tsx` — 77 tests green.

- **refine(web): owner reversal on the head-row controls — Blocks/Raw back
  to the icon SelectionButton, Match ALL/ANY becomes the v1 ToggleSwitch.**
  Owner ruling (2026-10-21), one day after the text-segment experiment: the
  Blocks/Raw view toggle returns to the ICON `SelectionButton`
  (mdi-toy-brick-outline / mdi-code-braces — the icons were better), still
  in the head row (the retired viewbar does not come back). The Match
  ALL/ANY group logic becomes a port of the v1 **ToggleSwitch** — a toggle
  pill with the dot inside and text on either side (ALL left, ANY right;
  ANY = checked) — on the root head row AND every nested group header,
  replacing both the look-alike set-all/set-center icons and yesterday's
  text segments. The primitive already existed in the fleet (the Radix-based
  v1 port); this slice extends its a11y contract — an explicit `aria-label`
  names the control (the state rides aria-checked, the side labels stay
  visual) while the labelledby-both-labels default stays for the existing
  call sites. The `SelectionButton` text support from the text-segment
  experiment retires unused — the primitive is restored byte-for-byte from
  712c6995a.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (the ToggleSwitch logic control, the icon view toggle restored),
    `apps/web/src/components/ui/fleet/ToggleSwitch.tsx` (the explicit-name
    a11y contract), `apps/web/src/components/ui/fleet/SelectionButton.tsx`
    + `…/SelectionButton.css` (restored from 712c6995a, the `text` register
    retires), `apps/web/test/filter-builder.test.tsx` (role=switch driving
    + the icon-radio assertions).
  - **Verification**: `npx tsc --noEmit` (apps/web) and
    `npx vitest run test/filter-builder.test.tsx test/filter-query.test.ts
    test/filter-layer.test.tsx test/graph-view.test.tsx` — 77 tests green.

- **refine(web): the structured-filters panel chrome ruling — both switches
  on one top row, the count line at the bottom-right, "nodes" wording; the
  head-row controls are TEXT segments.** Owner layout ruling (2026-10-21)
  on the panel the Save-as-tab and Raw-AST slices just landed. The builder
  gains a HEAD row carrying BOTH switches on ONE line — the root Match
  ALL/ANY logic toggle (left, moved out of the root group's header) and the
  Blocks/Raw AST toggle (right, replacing the floating `.nt-fb__viewbar`
  row) — and a FOOT row with "Add condition" (left) and the caller's
  right-aligned cluster (right): the count line, now "**N of M nodes
  match**" (was "rows"), beside the "Save as tab" button (previously a
  separate panel-header row, retired). The root GroupBlock rides BARE (no
  header/footer — an explicit prop, so NOT-wrapped groups at depth 0 keep
  theirs); the "Add condition" ButtonWithPanel+GridMenu is one small shared
  component (`AddConditionMenu`) plus a shared `withAddedEntry` helper, used
  by the nested group footers and the root foot alike; raw AST mode hides
  the foot's Add condition (no blocks to add) but the count line still
  rides. The FilterBlockBuilder gains an optional `footExtra` prop (the
  FilterBar passes the count + save cluster); the graph color-group editor
  passes nothing and keeps its Add condition. Owner follow-up the same day:
  the two head-row controls are TEXT segmented controls now — ALL|ANY and
  Blocks|Raw — the set-all/set-center icons read identically, text wins;
  `SelectionButton` gains an optional `text` rendering (backwards-compatible,
  `label` stays the accessible name), used by the logic options (root head
  AND every nested group header) and the view toggle; the row-level
  static/dynamic mode buttons stay icon-based.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (the head/foot rows, `AddConditionMenu` + `withAddedEntry` extraction,
    the root GroupBlock `bare` prop, text LOGIC_OPTIONS + view options),
    `…/FilterBlockBuilder.css` (`.nt-fb__head`/`.nt-fb__foot` rows, the
    viewbar retires), `…/FilterBar.tsx` + `…/FilterBar.css` (the panel-head
    row retires, the count + save cluster moves into `footExtra`, "nodes"
    wording), `apps/web/src/components/ui/fleet/SelectionButton.tsx` +
    `…/SelectionButton.css` (the optional `text` segment register),
    `apps/web/test/filter-builder.test.tsx` (the wording, the foot-row and
    the ALL/ANY/Blocks/Raw text assertions), `docs/features/queries.md` +
    `docs/developers/architecture.md` (the count line's placement and
    wording).
  - **Verification**: `npx tsc --noEmit` (apps/web), and
    `npx vitest run test/filter-builder.test.tsx test/filter-query.test.ts
    test/filter-layer.test.tsx test/graph-view.test.tsx` — 77 tests green.

- **feat(web): the structured-filters panel gains "Save as tab" and a
  blocks ⇄ raw AST toggle.** Two owner asks (2026-10-21) — the escapes from
  the transient filter's transience. (1) **Save as tab**: a quiet button on
  the panel's result line (visible while the composed draft is non-empty)
  persists the pruned draft as a new hosted section view — the full QueryAst
  envelope (`{ version: 1, scope: { type: "entire_workspace" }, root:
  <composed group> }`, the same shape the tab bar's "+" and the query modal
  persist), auto-named "View N" (autoViewName), and the new tab is SELECTED
  on save while the transient draft clears (the new tab owns the query, the
  modal's Run behavior). The hosted tab is now OPTIONALLY CONTROLLED:
  `HostedViewsConfig` gains `selected` + `onSelectTab`, NodeCollection uses
  them when both are set and keeps its internal state otherwise (every other
  call site unchanged); the two sections with the identity at hand — the
  reference sections (pageId + sectionKey) and the class page's classed
  nodes (classId + "classed-nodes") — lift their tab state and wire the
  `viewSaver` prop. The quick-search text deliberately never rides the
  saved view (it is the ranked search's input, not AST). (2) **Raw AST
  toggle**: a right-aligned kit SelectionButton on the ROOT builder only
  switches between the blocks and a fleet CodeTextarea holding the COMPOSED
  query as JSON (switching serializes the pruned draft — half-typed rows
  drop; the exchange format is never partial); Apply validates against the
  wire `groupSchema` (invalid JSON and schema violations get an inline
  error line, nothing applies) and replaces the whole draft on success, the
  normalized JSON re-serializing into the textarea as the landed feedback.
  Rides FilterBlockBuilder, so it appears in the FilterBar's panel AND the
  graph view's color-group editor.
  - **Files**: `apps/web/src/features/collection/types.ts` (HostedViewsConfig
    control props), `…/NodeCollection.tsx` (the controlled-tab resolution),
    `…/FilterBar.tsx` (`FilterViewSaver` + the save button + the draft
    prune/persist/select/clear flow), `…/FilterBar.css` (the panel-head
    row), `…/FilterBlockBuilder.tsx` + `…FilterBlockBuilder.css` (the
    viewbar + raw editor), `apps/web/src/features/page-sections/SystemSections.tsx`
    + `apps/web/src/features/classview/lassedNodesSection.tsx` (the two
    hosts: lifted tab state, controlled hostedViews, the viewSaver wiring),
    `apps/web/test/filter-builder.test.tsx` (the fetch-stubbed REST harness +
    the round-trip and save-as-tab tests), `docs/features/queries.md` (the
    two affordances, one sentence each).
  - **Verification**: `npx tsc --noEmit` (apps/web) and
    `npx vitest run test/filter-builder.test.tsx test/filter-query.test.ts
    test/filter-layer.test.tsx` — 60 tests green; the section-views,
    graph-view and view-modes suites stay green.

- **fix(web): the dynamic subgroup's card shows its boundary.** Owner ask
  (2026-10-21): the nested query builder's limits must read. The subgroup
  rode the kit Card's `filled` variant (`bg-surface-variant`, border-less)
  and blended into the dark structured-filters panel — "1 condition" and
  its rows looked like panel chrome. The card now rides the `default`
  variant (surface fill + the outline-variant hairline), one contained
  elevation that nests cleanly at any depth.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (the Card variant; a comment records why `filled` lost).
  - **Verification**: live probe (`scripts/screenshots/pills-probe.mjs`):
    the nested card computes a 1px `outline-variant` border; web `tsc` and
    the filter suites (58 tests) green.

- **feat(web): the filter builder's class "is" inherits class extends, and
  parent/page/root carry single-value is/is-not.** Two owner rulings
  (2026-10-21). (1) With classes, BOTH operators ride the extends-aware
  closure membership — "class is fuente" now matches a node classed book
  when book extends fuente, the same reading "contains" already had: the
  class family's "is" / "is not" bind the `class` closure-membership
  condition (single-pill form; "contains" stays the list form), and
  `classExact` (exact set equality, the 2026-10-16 register) becomes
  UI-unreachable — the wire type stays valid: stored ASTs still parse and
  evaluate as exact equality (compiler + local evaluator arms untouched).
  (2) The functionally single-target container families — Parent (the
  direct parent), Page (the containing page), Root (the workspace-root
  ancestor) — carry is / is not (+ the set bits where they mean something;
  Root's set bit stays vacuous): the wire types stay the list shapes
  (`parentOf`/`pageOf`/`rootIn` carry nodeIds[]) binding 0/1 elements, and
  the value pill cluster hides its "+ Add" pill while the single slot is
  filled (clear via the pill's × first — no silent replace). The genuinely
  set-valued families keep their registers: referencePath (is any of),
  child (contains any of), childPath (contains), parentPath (includes).
  - **Files**: `apps/web/src/features/collection/filterBlockModel.ts`
    (`applyClassOperator` "is" → `class`; `operatorOf`/`operatorOptions` for
    the class + parent/page/root families; the container morph's is/is-not
    cases; the parent pick-set op strings), `…/filterBlockValueControls.tsx`
    (`NodePillsPick` + `ClassPillsPick` single-slot prop, bound on
    `class`/`classExact`/`parentOf`/`pageOf`/`rootIn`),
    `apps/web/test/filter-builder.test.tsx` (the class "is" test now asserts
    extends-inheriting membership with the hidden AddPill; the
    Parent/Page/Root tests ride the is/is-not single-slot flow),
    `apps/web/test/filter-layer.test.tsx` (the extends-closure test pins
    "is project" keeping the node classed client, + the "is not" negation).
  - **Verification**: `npx tsc --noEmit` (apps/web) and
    `npx vitest run test/filter-builder.test.tsx test/filter-query.test.ts
    test/filter-layer.test.tsx` — 58 tests green.

- **fix(web): the nested filter groups' Add-condition menu opens at a real
  width — the dynamic subgroup's menu was an invisible 0-width popup.**
  Live-only bug (jsdom has no layout, so the gate never saw it): nested
  `GroupBlock`s arrived with `menuWidth={0}` (the root builder measures its
  container; the nested builders never did), and the add-menu popup took
  that 0 literally — the popup rendered in the DOM but invisible, so
  "Add condition" inside a dynamic subgroup (now the Class/Tags dynamic
  cards too) opened a menu nobody could see or hit. Nested groups now
  measure their own container (ResizeObserver) and fall back to a 280px
  floor; the root keeps the builder-container width.
  - **Files**: `apps/web/src/features/collection/FilterBlockBuilder.tsx`
    (the self-measure in `GroupBlock`, `addMenuWidth`).
  - **Verification**: live probe (`scripts/screenshots/pills-probe.mjs`):
    inside the Class dynamic card, Add condition opens the visible menu,
    Links inserts, flips dynamic — two nested cards. `filter-builder` 27/27;
    web `tsc` green.

- **feat(web): the filter block builder's node-target values ride pill
  clusters, the single-target families go multi-value, and Class/Tags gain
  the static/dynamic mode.** Owner asks (2026-10-21): node-target filter
  values render as the fleet pill cluster (NodePill + AddPill, the
  MultiNodeCell precedent); the Class is/is-not/contains and Links/Tags
  is/is-not families bind a LIST (ANY-of membership) — the redundant "one
  of" operator collapses into "contains"/"is" (owner ruling: identical
  semantics); Class and Tags blocks gain the static/dynamic mode toggle
  (dynamic = a nested query subgroup inside a kit Card, the nesting
  infinite); the condition row's value column spans the full remaining row
  width (the spacer goes zero-width). Wire: two new dynamic condition
  shapes — `classAnyQuery` (closure-aware membership of ANY class matching
  the nested group) and `tagAnyQuery` (tagged with ANY tag matching the
  nested group) — protocol conditions + zod schema, compiler arms
  (correlated subquery over the group's matches, degrading to the
  never-matching subquery on an empty group like the other dynamic arms),
  and the section probe gate (dynamic leaves ride the runQueryAst query
  channel, never local eval). Latent fix riding along: `familyOf` mapped
  the tag conditions to the PARENT family (wrong label + operator set) —
  they ride the Tags family now, which the mode toggle also needs. The
  multi-value register: Class "contains"
  now binds the picked list (the default Class row seeds `classAny`), Links
  "is" binds `linkedToAny`, Tags "is" binds `tagAny`; "is" on the class
  family stays the single-pill EXACT register (the carried id morphs).
  Value controls: `ClassPillsPick` replaces the single/multi dropdown
  picks (class pills with effective color/icon via the NodePills
  resolution, honest raw-id pills for broken refs), `NodePillsPick`
  replaces the custom chip spans (effective node color + icon, hover-reveal
  ×). Legacy single shapes (`class`, `classExact`, `tag`, `linkedTo`,
  `descendantOf`) still parse, evaluate, and render.
  - **Files**: `packages/protocol/src/query-ast.ts` (the two Condition
    shapes + conditionSchema), `packages/query/src/compiler.ts`
    (conditionSql arms), `packages/query/test/query.test.ts` (SQL-shape +
    behavior cases), `apps/web/src/features/collection/filterBlockModel.ts`
    (family/operator registers + the morphs), `…/filterQuery.ts`
    (createCondition defaults, the dynamic prune arm), `…/filterBlockValueControls.tsx`
    (ClassPillsPick + NodePillsPick, the BlockValue bindings),
    `…/FilterBlockBuilder.tsx` (the mode toggle on class/tags, the Card
    subgroup), `…/FilterBlockBuilder.css` (`.nt-fb-card`, the zero-width
    spacer, the dead chip styles retire), `…/sectionViewResolve.ts` (the
    probe gate), `apps/web/test/filter-builder.test.tsx`,
    `…/filter-query.test.ts`, `…/filter-layer.test.tsx` (the picker-flow +
    multi-value assertions).
  - **Verification**: `pnpm --filter @notees/protocol build && pnpm
    --filter @notees/query build` (dev-condition exports), `pnpm --filter
    @notees/web typecheck`, the protocol (530) + query (252) suites, and
    the web filter suites (filter-builder/filter-query/filter-layer/
    css-token-drift — 70 tests) all green.
- **fix(store): permanent delete heals the materialized counts — a backlink
  badge stops outliving its edges.** Reported symptom: a block showed a "1
  linked reference" badge over an empty "No linked references" list. The
  badge reads `node_stats.backlink_count` (a stored number — it renders on
  every block row, so a live per-row count is what the lazy-loading contract
  forbids); the expanded list runs a live query over the edge index. Two
  delete paths dropped the subtree's edge rows without rebuilding the
  targets' stats, so the targets kept counting dead edges forever (51 stale
  rows in the live workspace): the `permanentlyDeleteSubtree` purge
  (`object.delete {permanent: true}`, `trash.empty`) and the `rebuildEdges`
  gone-source branch. The purge now rebuilds `node_stats` for the subtree's
  edge targets AND its ancestors (their `descendant_count` was stale the same
  way); the gone-branch rebuilds its orphaned targets. Pre-existing
  projections heal with a one-off `rebuildNodeStats` pass + a fresh snapshot
  + a `restore_epoch` bump (the counts are a derived projection — the rebuild
  converges them).
  - **Files**: `packages/store/src/appliers.ts` (`permanentlyDeleteSubtree`
    collects the lost backlink targets + the ancestors before the purge and
    rebuilds after it), `packages/store/src/edges.ts` (the gone-branch
    rebuilds `previousTargets`), `packages/store/test/store.test.ts` (four
    regression tests × both adapters, failing before / passing after),
    `docs/features/links.md` (the badge invalidation contract),
    `docs/developers/architecture.md` (the same contract, developer-facing).
  - **Verification**: store suite 625 green (4 new tests × both adapters);
    full gate `pnpm -r build` + `pnpm typecheck` + `pnpm test` green (166
    files / 1912 tests).

- **refine(web): every empty table cell reads "Empty" — the placeholder
  ruling settles, and multi-value node/asset cells join the idiom.** Owner
  correction (2026-10-21, same day): the "Add \<name\>" placeholder trialed
  on the picker/scalar cells reads like a button label, not a state — date
  fields etc. show "Empty" like the text cells already did; and the
  multi-value node/asset clusters should not wear a separate "+ Add" pill
  before the first value — the same "Empty" placeholder opens the picker on
  click, one UI for every empty property cell. The visible placeholder is
  now "Empty" across text, node, date, asset, and scalar (url/email/number
  input placeholder) cells; a picker cell's accessible name still names the
  action ("Add \<name\>"), the NodeCell and the cluster empties carrying the
  aria label; the "+ Add \<name\>" pill now rides the VALUED cluster cells
  only (adding more), the metadata row's idiom.
  - **Files**: `apps/web/src/features/collection/TableView.tsx` (DateCell +
    NodeCell visible placeholders, InlineInput placeholder, MultiNodeCell +
    AssetCell empty branches opening the picker — the picker element shares
    both branches, the header comment's settled ruling), `apps/web/test/view-modes.test.tsx`
    (the Owner spec's visible "Empty" + action aria name; the new spec:
    empty multi node/asset cells read Empty, open the picker from the
    placeholder, and render no add pill before the first value).
  - **Verification**: web `tsc` green; `view-modes.test.tsx` 45/45.

- **fix(web): the Created/Edited stamp never overflows into the hover-
  revealed Open button.** Owner report (2026-10-21, screenshot): on hover
  the day-stamp's Open button overlapped the date text. The stamp cells
  carry `white-space: nowrap`, and the hover state reserves the button lane
  by growing the td padding — a bare nowrap text child overflows its shrunk
  box into the lane instead of moving (the name-cell idiom works because
  that text wraps). The stamp now rides a `.nt-table-stamp` span (flex
  lane, `min-width: 0`, `overflow: hidden`, ellipsis): on hover a stamp too
  long for the remaining width ellipsizes — never overlaps.
  - **Files**: `apps/web/src/features/collection/TableView.tsx` (the
    Created/Edited markup wraps the stamp), `apps/web/src/features/collection/TableView.css`
    (the `.nt-table-stamp` rules), `scripts/screenshots/datebtn-probe.mjs`
    (the live geometry probe: rest = absolute + hidden, hover = lane
    reserved + visible + no overlap, screenshot).
  - **Verification**: live probe against the deployed stack (test
    workspace): rest opacity 0 / absolute, hover padding 12px → 40px,
    no overlap; screenshot `datebtn-probe.jpg`.

- **feat(web): table cell chrome — the pinned Open button everywhere a cell
  names a target, "Add <name>"/"Empty" empty states, asset cells with the
  asset buttons.** Owner asks (2026-10-21): text cells with a carrier should
  wear the navigate button like the name cell; date text should never
  navigate on click (only edit), with navigation on the pinned button —
  including the Created/Edited stamps, whose click-to-navigate day link
  retires; empty property cells should name their action ("Add <name>",
  "Empty" for text); and asset properties should carry their buttons in
  table cells. Now: (1) an assigned text cell rides `nt-table-node` + the
  pinned Open button (click opens the carrier's page — the embedded carrier
  resolves through the container's `openMember` — shift+click peeks); (2)
  the Created/Edited columns render plain text + the day-page Open button
  (`nt-table-daylink` retires); editable date value clicks still open the
  picker, readonly dates stay inert text; (3) empty picker cells (node /
  date / asset) show the muted "Add <name>" placeholder, empty scalar inputs
  ride it as the input placeholder, empty text cells read "Empty" (the
  click creates-and-edits, so the accessible name names the action "Add
  <name>"), and the multi pill clusters' add pills label "Add <name>"; (4)
  a new `AssetCell` mirrors the metadata asset row, table-scaled: pills
  labeled by the file's original name whose click downloads, the ❝
  annotations toggle opening the annotations panel anchored under the cell
  (the node-pills overflow popup pattern), × per slot, and the picker's
  create row IS "Upload file…" → AssetUploadModal → link at the next free
  idx (single-value schemas replace their authored slot; cover values still
  class the target as an asset).
  - **Files**: `apps/web/src/features/collection/TableView.tsx` (TextCell
    Open button + "Empty" placeholder, AssetCell, the Created/Edited
    rework, the InlineInput placeholder, the MultiNodeCell add-pill label),
    `apps/web/src/features/collection/TableView.css` (the daylink styles
    retire; the text cell flex lane; the input placeholder; the annotations
    popup card), `apps/web/test/view-modes.test.tsx` (the Open-button
    navigation assertion, the asset-cell spec, the no-click-navigate date
    stamp spec), `docs/features/views.md` + `docs/features/pages.md` (the
    cell chrome + the Created/Edited paragraphs).
  - **Verification**: web `tsc` green; `view-modes.test.tsx` 44/44 (the
    asset spec exercises filename pill + ❝ popup + upload create row; the
    date-stamp spec asserts a single button in the cell and its day-page
    navigation; the text spec asserts the carrier's Open button navigating
    to the page).

- **perf(web): the node picker's search coalesces keystrokes on async
  clients — one ranked-index query per pause, not per keystroke.** Owner
  ruling (2026-10-21) on a huge workspace: the FTS itself is fast, but each
  keystroke cost a worker round-trip over the full index. The query that
  hits the index now lags the input by 150ms (`SEARCH_DEBOUNCE_MS`), so a
  10-character query costs ONE search instead of ten; the input still shows
  every keystroke, while results, the create row, and the filter prefixes
  all answer the coalesced query (list, create label, and searched text can
  never disagree). Debounce applies to async clients only — the
  `searchPending` seam doubles as the marker — because the in-process
  client answers in microseconds and its consumers (tests, small
  workspaces) rely on synchronous results. The empty state also learns
  "settled": while keystrokes are still coalescing, the previous query's
  results stay up and "No matches found" stays hidden — a no-match verdict
  only renders for a query that actually ran.
  - **Files**: `apps/web/src/features/pickers/NodeSelector.tsx`
    (`SEARCH_DEBOUNCE_MS`, the `debouncedQuery` state + effect, the pipeline
    and the empty state on the coalesced query), `apps/web/test/capture.test.tsx`
    (the coalescing regression test over the worker-shaped shim).
  - **Verification**: web `tsc` green; full gate `pnpm typecheck && pnpm
    test` green; `verify-min.mjs` VERIFY-PASS after the web image rebuild.

- **fix(web): every dropdown menu item wears the disabled look — and none of
  them click.** The cmdk rebuild (2026-10-19, the catalog-combobox Dropdown)
  inherited the shadcn `CommandItem` classes `data-[disabled]:opacity-50
  data-[disabled]:pointer-events-none` — and cmdk 1.x renders
  `data-disabled="false"` on EVERY item (React stringifies the boolean, so
  the attribute is present even when the item is enabled). This repo's
  Tailwind v3 bridge compiles the bare `data-[disabled]` form to a presence
  selector (`[data-disabled]`), so every option of every fleet Dropdown —
  enabled or not — rendered at 50% opacity with pointer-events off. Live
  symptom (owner report): in the structured-filters panel the Class block's
  operator options all read greyed and unclickable; jsdom never caught it
  (fireEvent bypasses pointer-events; no computed-style assertion). The
  classes now pin the value — `data-[disabled="true"]:opacity-50
  data-[disabled="true"]:pointer-events-none` — matching only the real
  state. A source-level register test
  (`test/cmdk-disabled-register.test.ts`, the css-token-drift pattern) fails
  the build if the presence form returns to the cmdk surface. (The Radix
  primitives — dropdown-menu/select — keep the bare form on purpose: Radix
  renders the attribute only when the state fires.)
  - **Files**: `apps/web/src/components/ui/command.tsx` (the CommandItem
    class string), `apps/web/test/cmdk-disabled-register.test.ts` (the gate).
  - **Verification**: live probe (`scripts/screenshots/operator-probe.mjs`):
    before — every `.dropdown-option` computed `opacity: 0.5` +
    `pointer-events: none`, `elementFromPoint` missed the item, a real click
    on "contains" left the operator at "is"; after — the option rows render
    full-opacity and clickable. jsdom suites green (filter-builder,
    filter-layer, filter-query, the new register gate).

- **refine(web): the Class filter block defaults to "contains", not "is".**
  Owner ruling (2026-10-21, superseding the 2026-10-16 exact-register
  default): the m2m families' block creation defaults to the membership
  reading. For **Class** the default condition is now `class` (closure
  membership — "the class among others", extends-aware); "is" stays
  available as the deliberate narrow exact-set-equality reading. The other
  node-target families need no change: their single-target "is" already
  compiles to membership (`linkedTo`/`tag` are EXISTS-over-the-set probes —
  there is no exact-set trap there). `createCondition("class")` returns
  `{ type: "class", classId: "" }`; the builder tests now assert
  contains-by-default and pick "is" explicitly for the exact-register case.
  - **Files**: `apps/web/src/features/collection/filterQuery.ts`
    (`createCondition`), `apps/web/test/filter-builder.test.tsx`,
    `apps/web/test/filter-layer.test.tsx`, `apps/web/test/filter-query.test.ts`
    (the default assertions + comments).
  - **Verification**: `vitest run test/filter-builder.test.tsx
    test/filter-layer.test.tsx test/filter-query.test.ts` green — the
    Class-default test now reads: default "contains" keeps all three rows,
    switching to "is" drops the double-classed row.

- **fix(web): the node picker searches live, says when it's thinking, links
  what it creates — and the sigils fire after punctuation.** Three reported
  defects, one root each. (1) *Stale results:* the picker never subscribed to
  the workspace client, so on the worker-backed client each new query's FTS
  hits landed in the read cache with nobody re-rendering — the results only
  appeared after one more keystroke re-ran the memo. The picker now
  subscribes (a `dataVersion` the search memo depends on) and renders the
  hits the moment the client's notify lands, plus a **"Searching…"** state
  (`Spinner` + the <300ms-nothing rule) driven by a new
  `WorkerClient.searchPending` seam — a cache miss and a real no-match both
  read `[]` synchronously, so the pending flag is the only way to show
  loading instead of a lying "No matches found". (2) *Create dropped the
  link:* `resolveCreateResult` read the just-created id synchronously, which
  the worker client answers with `undefined` until the create's sync push
  lands — the pick never fired. It now routes through the existing
  `waitForNode` (subscribe + bounded poll), same as the date-suggestion path.
  (3) *Sigils after symbols:* the trigger boundary required whitespace (or
  text start) before `@`/`#`/`+`, so `(@` never opened the picker; the rule
  is now the shared `isTriggerBoundary` helper — any NON-word character
  (punctuation, brackets, quotes) or start-of-text opens the picker, a word
  character (the email `user@host` case) stays silent — applied to both the
  collapsed-caret trigger and the `@`-over-selection / Ctrl+L path.
  - **Files**: `apps/web/src/features/pickers/NodeSelector.tsx` (the
    subscription + `searchPending`-driven searching state, `waitForNode` in
    `resolveCreateResult`, header contract), `apps/web/src/core/worker-client.ts`
    (`searchPending`), `apps/web/src/features/block-editor/captureModel.ts`
    (`isTriggerBoundary`), `apps/web/src/features/block-editor/BlockTextEditor.tsx`
    (both boundary sites + comments), `apps/web/src/features/pickers/NodeSelector.css`
    (the searching row), `apps/web/test/capture.test.tsx` (boundary unit +
    integration, async-search convergence, pending spinner, worker-shaped
    create), `docs/features/links.md` + `docs/features/outliner.md` (the
    widened boundary + live-search contract).
  - **Verification**: web `tsc` green; full gate `pnpm typecheck && pnpm
    test` green (166 files / 1911 tests), incl. four new picker tests over a
    worker-shaped client shim; `verify-min.mjs` VERIFY-PASS after the web
    image rebuild.

- **feat(web): table property cells — multi-value node properties get the
  pill cluster; text cells become carrier block rows.** Owner ask
  (2026-10-21): in table view there was no way to edit or add nodes to a
  node-typed property (an Authors column rendered read-only, first value
  only), and text property cells wore a bordered inline input that read out
  place next to the name cells' title block rows. Now: (1) an editable
  multi-value object column renders every value as the shared `NodePill`
  (the linked node's effective color, click opens, hover-reveal × unsets its
  own idx slot, broken refs keep the dashed raw-id honest state) plus an
  "+ Add" pill appending at the next free idx through the anchored
  `NodeSelector` — the schema's `targetClassFilter` scopes both the search
  and the create row (the metadata `ObjectPropertyRow`'s contract,
  table-scaled). (2) Single-value text cells render the value's carrier
  block through `BlockRow variant="title"` — the name cell's contract:
  inline tokens render read mode, a click swaps in the full block editor
  (rich text no longer flattens to a plain input), an empty cell is the
  muted schema-name placeholder whose single click creates the carrier and
  lands straight in the editor (new additive `BlockRow autoEdit` prop), and
  an emptied carrier unsets automatically (the `TextPropertyRow` auto-unset
  pass, table-scaled: the cell's own client subscription + a focus guard so
  the just-minted carrier survives while its editor holds the caret).
  Read-only tables (and other multi-value types) render every value of a
  property joined, never just the first.
  - **Files**: `apps/web/src/features/collection/TableView.tsx` (the two
    cell components + the `PropertyCell` branches + the joined read-only
    tail), `apps/web/src/features/collection/TableView.css` (the cell
    wrapper/placeholder styles + the title-row-in-td block treatment),
    `apps/web/src/ui/BlockRow.tsx` (the additive `autoEdit` prop),
    `apps/web/test/view-modes.test.tsx` (the carrier-cell flow + the pill
    cluster add/remove), `docs/features/views.md` (the property-cells
    paragraph).
  - **Verification**: web `tsc` green; `view-modes.test.tsx` 42/42 (the
    rewritten text-cell spec exercises placeholder-create → autoEdit →
    typed commit → emptied unset; the new spec exercises pill render,
    per-slot × removal, picker append at the next free idx).

- **fix(web): the add pills wear one cursor — the label rides the button's
  pointer.** Hovering an `AddPill` ("+ Add class/tag/property/alias…") split
  the cursor: pointer over the button's padding, the default arrow over the
  label text. Feature styles reset `span.pill__text` to `cursor: default`
  (plain chip labels must not look clickable), and the AddPill's label IS a
  span inside the button — so the reset beat the button's `cursor: pointer`
  exactly where the text sits. The primitive now sets
  `.pill--add .pill__text { cursor: inherit }` (higher specificity, order-independent), so the label rides the button's cursor across the whole hit area.
  - **Files**: `apps/web/src/components/ui/fleet/Pill.css` (the override next
    to the `.pill--add` block).
  - **Verification**: CSS-only change; specificity check
    (`.pill--add .pill__text` 0-2-0 beats `span.pill__text` 0-1-1 regardless
    of stylesheet load order); web `tsc` green.

- **fix(web): the checkbox box is a square again — the width scale registers
  xs/sm/md.** The fleet Checkbox and Radio size their boxes `h-xs w-xs` (the
  sm/md/lg scale rides the `--height-xs/sm/md` tokens, the height register's
  square-box twins). But the Tailwind config's `width` scale never registered
  xs/sm/md — so `w-xs` generated no CSS, and because `cn` merges with
  tailwind-merge, the caller's `w-xs` also *stripped* the catalog checkbox's
  fallback `w-icon-md`. The box was left with a token height and a
  content-driven width — a rectangle instead of the rounded square the
  buttons wear (same `--shape-medium` corners, owner ruling 2026-10-20). The
  width scale now carries `xs/sm/md → var(--height-xs/sm/md)`, mirroring the
  `minWidth` register the Badge already relied on.
  - **Files**: `apps/web/tailwind.config.ts` (the `width` scale).
  - **Verification**: production build emits `.w-xs{width:var(--height-xs)}`
    alongside `.h-xs{height:var(--height-xs)}` (the table view's selection
    checkbox now renders a 24×24px rounded square at size sm); web `tsc` and
    the css-token-drift gate green.

- **refine(web): the table column default IS the minimum.** Owner ruling
  (2026-10-21, same-day correction on the resizable-columns slice): one
  register instead of two — a column renders at its default share and a
  drag widens it from there, never narrows below it; the separate 72px
  clamp retires. The ch-unit defaults resolve to px through a measured
  10ch probe (the drag works in px).
  - **Files**: `TableView.tsx` (`MIN_COLUMN_WIDTH` gone; `columnMinimumWidth`
    = the column's default ch share × the measured ch width; the drag ref
    carries the floor).
  - **Verification**: live probe (`colresize-probe.mjs`): the far-left drag
    now clamps at 162px (the property column's 18ch default) instead of
    72px; widening and the 30px search field unchanged. `verify-min.mjs`
    VERIFY-PASS.

- **feat(web): table columns have default + minimum sizes and draggable
  dividers; the hosted tab bar's search field rides the sm height.**
  Owner ruling (2026-10-21). The table switched to **fixed layout with a
  colgroup**: every column has a DEFAULT width in ch units (name 32ch,
  classes 16ch, created/edited 12ch, isClass/isEmbedded 8ch, properties
  18ch) and a drag on a header divider commits a px width — live, clamped
  to a 72px minimum, session-state like the sort and the column visibility;
  the divider is keyboard-reachable too (ArrowLeft/Right nudge 16px). Fixed
  layout makes the widths exact: cell content wraps inside its lane, spare
  width distributes proportionally (the name column stays dominant), and a
  crowded table scrolls the wrap horizontally — auto layout could not hold
  this: it sized the table from content and, under column contention,
  starved the name cell to its nested-flex min-content (the live probes
  below). The quick-search pill in the hosted tab bar was huge (~52px in a
  30px-button row): the fleet `SearchField` gained a proper `size="sm"`
  (30px — the sm button height; md, the default, is unchanged everywhere
  else) and the filter bar's inline field rides it.
  - **Files**: `TableView.tsx` (the colgroup, the `colWidths` state, the
    pointer-capture drag + the separator-keyboard nudge, the
    `defaultColumnWidth`/`MIN_COLUMN_WIDTH` registers), `TableView.css`
    (`table-layout: fixed`, the `.nt-table-resize` divider inside the
    sticky header's clip, the `--resizing` cursor/user-select register, the
    `overflow-wrap` guard; the td-level name floor removed — fixed layout
    ignores it, the colgroup width is the claim), `SearchField.tsx` +
    `.css` (the `size` prop: `h-button-sm` input via twMerge, the compound
    `search-field--sm` zeroing the block padding), `FilterBar.tsx` (the
    wide field passes `size="sm"`; the narrow popup keeps md).
  - **Tests**: view-modes + windowing + the filter/query suites green
    (174/174 across the eight table-adjacent files).
  - **Docs**: `docs/features/views.md` (the table paragraph — the column
    sizing contract).
  - **Verification**: `pnpm --filter @notees/web typecheck` clean. Live
    probes (`scripts/screenshots/colresize-probe.mjs` + the sparse-table
    pass, TEST workspace): the search field measures 30px (row 32px); a
    header drag commits 162→282px and clamps at 72px; the crowded 8-column
    shape scrolls with the name lane at 288px; the sparse shape distributes
    spare width proportionally (name 436px, dominant). `verify-min.mjs`
    VERIFY-PASS after the scoped `notees-web` rebuild.

- **feat(web): table name cells ARE block rows — links render as links,
  click edits inline, the hover tint is gone.** Owner ruling (2026-10-21).
  The collection table's Name cell retired its flattened-text button (a
  title carrying a markdown link showed the raw `[label](href)` source) and
  the single-text-token rename input (rich titles couldn't edit without
  flattening). The cell now renders the **page header's title projection**
  (`BlockRow variant="title"`): read mode shows the real inline tokens —
  markdown links as anchors, class chips resolved — and a click inside the
  cell swaps in the **full block editor** (the title variant's relaxed
  contract: Enter flushes and leaves edit, no split/structural gestures).
  The row icon stays, and navigation rides the pinned **Open button**
  exactly as before (click opens, shift+click peeks). The name cell's
  hover color change (the label tinting primary) retired with the old
  button.
  - **Files**: `TableView.tsx` (the `NameCell` rewrite; the table hosts its
    OWN `OutlinerContext` via `useOutlinerValue` — the FlatCards precedent,
    `visible[0]`'s node as the root id — so the block rows edit on every
    host, shell hubs with no enclosing context included; the dead
    `InlineInput autoFocus` prop retired with the rename path), `TableView.css`
    (the `.nt-table-name-btn` rules including the hover tint deleted; the
    cell's flex-lane layout + the headline-typography override ride
    `td.nt-table-name`; the cell's `.nt-block--title` is `display: block` —
    the outline grid's fixed bullet-gutter tracks otherwise set the cell's
    min-content to gutter width — and the column keeps a `min-width: 32ch`
    lane: the retired button's `width: 100%` used to claim the free space,
    and the block-row cell's nested flex min-content (the longest word)
    collapsed the auto-layout column to ~85px under contention while the
    nowrap property headers kept theirs — percentage cell widths are no-ops
    in a content-sized table, the ch floor is the claim that holds).
  - **Tests**: the row-count/name selectors in `windowing`, `filter-builder`,
    `filter-layer`, `query-block`, `view-modes`, `class-view` follow the new
    DOM (`td.nt-table-name` / its `.nt-title-content` — the name cell is no
    longer a button); a new `view-modes` test pins the ruling: a
    markdown-link title renders as a real anchor (href + label, never the
    raw source) and a click in the cell mounts the block editor.
  - **Docs**: `docs/features/views.md` (the table name-cell paragraph; the
    read-only sentence now scopes to cards).
  - **Verification**: `pnpm --filter @notees/web typecheck` clean; web
    suite green except the pre-existing property-definition/editor failures
    (another session's in-flight cog slice) and one flaky block-dnd case —
    none touch the table. Live probe (`scripts/screenshots/namecol-probe.mjs`,
    TEST workspace, 8 bound property columns): the name cell measured 87px
    with a 32px content lane (= the gutter tracks) and a 28-line title;
    after the fix the column holds a 288px (32ch) lane — the link title on
    one line, the long title wrapping to 3 — and the link renders as a real
    anchor (href present, no raw markdown). Redeployed: `notees-web`
    rebuilt (clean worktree at the slice commit — the checkout carried the
    parallel session's uncommitted edits) + stack recreated from the live
    stack folder, `verify-min.mjs` VERIFY-PASS.

- **fix(web): client-side name search folds diacritics — `video` finds the
  class "Vídeo".** The ranked FTS index has folded diacritics since store
  schema v19, but the pickers' client-side name filters compared raw
  lowercased strings, so an unaccented query missed accented names wherever
  a picker filters by name instead of riding the FTS index: the node
  picker's classes tab, the `class:` refine prefix resolution, the
  classes-picker exact-name create-row suppression, the template gallery
  and template list popups, the bind-property popovers (class view +
  metadata row, including their exact-name duplicate checks), and the
  outliner context's mention-candidate filter. Every comparison now folds
  both sides through the store's exported `foldSearchText` (NFD + combining-
  mark strip — the same mirror pair the index uses), so picker name matching
  behaves exactly like full-text search. The `class:` refine slices the raw
  query by the class's RAW name length (folded length can differ — the DŽ
  canonical decompositions). Verification: new jsdom tests (classes tab,
  create suppression, `class:` refine, bind-property popover, template
  gallery — unaccented query vs accented name, both directions) plus the
  full `pnpm typecheck` + `pnpm test` gate green. Docs: `docs/features/
  links.md`'s picker paragraph states the folding rule. Web-only slice —
  redeploy `notees-web`.
- **feat(web): class-property rows are display-only — the whole-row click is
  gone, the hover COG is the one definition-settings affordance.** Owner
  ruling (2026-10-21, second pass on the same rows). Carrying BOTH a
  whole-row click AND the cog was redundant; one had to go, and the cog
  wins by the explicit-affordance criterion: with the hover tint gone the
  row announced nothing, and a text-looking name must not pretend to be
  clickable (select/copy clicks were slapping the modal open). The
  `.nt-propdef-main` / `.nt-propdef-inherited-main` row bodies are now
  plain identity display (spans, no button chrome, no cursor); the
  hover-revealed right side is the whole action surface — COG (opens the S2
  base-definition modal, on system rows too) + REMOVE × (still
  system-locked = absent). The Inherited group converts to the same
  criterion (identity + source pill + hover cog naming the source class in
  its aria label). The criterion is written into the fleet design system
  (`rosellramos-design-system` `law/patterns.md`, new "Action row" pattern —
  whole-row click survives only where activation IS the row's purpose and
  the hover fill announces it).
  - **Files**: `PropertyDefinitionsSection.tsx` (row bodies → spans; header
    comment rewritten to the explicit-affordance contract), `.css` (button
    chrome stripped from the row bodies; the inherited rows gain the same
    `nt-propdef-rowinner` hover-reveal container), tests
    (`property-definitions-section`, `class-bindings`, `class-view`,
    `dates` — click targets move from the row button to the cog; the
    identity-row tests now assert the name is NOT a button).
  - **Verification:** `pnpm typecheck` clean repo-wide; `pnpm test` green;
    `verify-min.mjs` VERIFY-PASS after the scoped `notees-web` rebuild.

- **feat(web): class-property rows — the name-hover tint is gone, and hover
  now reveals a COG beside the REMOVE ×.** Owner ruling (2026-10-21). The
  direct-bindings row of the class page's "Class properties" section lost
  the hover background on its icon+name button (resting rows stay clean);
  the row's hover-revealed right side now carries TWO affordances, both the
  STANDARD fleet ghost icon buttons: the **cog** (`Definition settings for
  <name>`, opens the same S2 base-definition modal the row click opens —
  present even on system-schema rows) and the **×** (the section-level
  remove confirm, still system-locked = absent). The inherited group's rows
  are untouched.
  - **Files**: `PropertyDefinitionsSection.tsx` (the cog Button rides
    before the ×; the row-comment + section header-comment hover contract
    updated), `.css` (the `.nt-propdef-main:hover` overlay rule deleted; the
    cog joins the remove on the `opacity: 0 → row-hover/focus-visible: 1`
    reveal).
  - **Verification**: `pnpm --filter @notees/web exec vitest run
    test/property-definitions-section.test.tsx` — 10/10 (the identity-row
    test now asserts the cog + × as the hover pair; a new test clicks the
    cog straight into the "Property settings" dialog; the system-schema
    test pins the cog riding where the × is locked). `pnpm --filter
    @notees/web typecheck` clean. Redeployed: `notees-web` rebuilt + stack
    recreated from the live stack folder, `verify-min.mjs` VERIFY-PASS.

- **feat(web): breadcrumbs join the plain-text chrome labels — and the
  derivation gets one shared home (`plainTitleOf`).** Owner ruling
  (2026-10-21), rounding out the sidebar slice.
  - **`plainTitleOf(node, resolveClassName?)`** (dateDisplay.ts, beside
    `nodeDisplayName`): the chrome-label derivation = nodeDisplayName +
    markdown link spans reduced to their label (per text token, BEFORE the
    80-char cap — the domain's `splitMarkdownLinks` grammar) + inline class
    chips resolved to the class's current name via `resolveClassName`.
    Extracted from the sidebar's inline strip so breadcrumbs and the sidebar
    rows ride ONE definition instead of two parallel flattens.
  - **Breadcrumbs**: `crumbNameOf` now rides `plainTitleOf` with the class
    resolver. Fixes two owner-reported gaps: a title carrying a markdown
    link showed the raw `[label](href)` source in the trail (now the label
    only, href never — the strip lands before the 28-char per-crumb clip),
    and inline class chips were dropped from mixed titles like "Reunión con
    [persona]" (only chip-ONLY titles had the resolved-name fallback before;
    the resolver now rides every crumb, so that fallback retires). The
    sidebar rows switch to the same helper (identical output — their inline
    strip moves in).
  - **Docs**: `docs/features/pages.md`'s Breadcrumbs paragraph (the
    plain-text contract).
  - **Verification:** `pnpm typecheck` clean repo-wide; `pnpm test` green —
    new `plainTitleOf` units (link strip, cap order, chip resolution, date
    branch) and breadcrumb cases (markdown title, mixed chip title) ride
    alongside the existing chip-only crumb tests.

- **fix(scripts): `verify-min.mjs` self-locates its config — and the stale
  root-copy duplicate is gone.** The smoke failed when run outside
  `scripts/screenshots` (a second, older `scripts/verify-min.mjs` with the
  pre-login flow shadowed the real one and couldn't resolve playwright), and
  the documented invocation relied on a checkout-relative password path that
  doesn't exist on the fleet host (source/stack split). The canonical script
  now resolves everything from `import.meta.url` + env: stack dir
  (`NOTEES_STACK_DIR` → `/etc/periphery/stacks/notees` when present → repo
  root), API key (`NOTEES_API_KEY`/`_FILE` → `<stack>/config/notees/sync/
  api_key.txt`), admin password (`NOTEES_ADMIN_PASSWORD`/`_FILE` →
  `<stack>/config/notees/.admin_password`), plus `NOTEES_API`/`NOTEES_WEB`/
  `NOTEES_ADMIN_EMAIL`/`NOTEES_WORKSPACE`/`NOTEES_VERIFY_OUT`; a missing
  credential fails fast naming the env var instead of attempting an
  empty-password login (rate-limit risk). `node scripts/screenshots/verify-min
  .mjs` from the repo root, zero env → VERIFY-PASS on the fleet host. Docs:
  the invocation in `notees-operations` SKILL.md + `references/deployment.md`
  and `references/health-checks.md` matches reality; `scripts/verify-min.mjs`
  (stale duplicate) deleted. Repo-only slice — no redeploy.

- **refactor(web): `displayNameForSettings` → `nodeDisplayName`.** The old
  name promised a settings-only helper; it is the general setting-aware
  display-name funnel for a node — the dateFormat device setting applied to
  date pages, everything else deferring to the domain's `deriveDisplayName`
  (title-is-content) — and titles, table cells, breadcrumbs, the palette,
  exports, and the new sidebar list labels all read through it (owner
  ruling 2026-10-21: the wrong name invited wrong uses). Pure identifier
  rename, zero behavior change (106 references across 33 files, all in
  apps/web). Verification: `pnpm typecheck` clean repo-wide; `pnpm test`
  green. No redeploy — no runtime delta.

- **chore(compose): the redeploy instruction is plain docker compose — the
  Komodo-enforcement comment is gone.** Owner ruling (2026-10-21), zero
  runtime effect. The template header no longer routes updates through a
  Komodo Redeploy; the live-stack split warning stays (build/up from the stack
  folder, never the checkout), as does the update procedure itself (`docker
  compose build <services> && docker compose up -d` from the stack folder).
  The fleet host's live compose copy carries the same edit.

- **feat(web): the sidebar's Favorites/Recents lists move to
  `features/sidebar/` — and their row labels go plain-text.** Owner asks
  (2026-10-21), one slice.
  - **Plain-text row labels** (owner ruling): the Favorites and Recents rows
    flatten the node's title through `displayNameForSettings` — the same
    text-only derivation the tab title and table cells use — instead of
    rendering the title as read-only block content (`InlineTokens`).
    Mentions, class chips and marks fold into their captured text; a
    markdown link span reduces to its label through the domain's canonical
    `splitMarkdownLinks` grammar — the strip runs per text token BEFORE the
    display name's 80-char cap, so a long href can never crowd the label
    out (the live smoke caught a YouTube-import title otherwise spending
    its whole row budget on a URL). Nothing inside a row label is individually
    clickable or styled, the label's mention links lose their
    click/right-click affordances, and
    the row-menu/node-link-menu right-click split retires with them. The row
    stays one button (click opens, Shift+click peeks, right-click → the row
    menu); date pages keep the setting-aware display name through the same
    helper's date branch.
  - **The extraction**: `features/sidebar/FavoritesRecents.tsx` owns the two
    sections — the nodePrefs hook, the drag-sort, the row context menu, the
    confirmation-gated Delete, the live-label subscription — and
    `features/sidebar/recentPages.ts` owns the device-local recents storage
    (`recordRecent`/`readRecentIds`/`removeRecent`, moved out of Sidebar.tsx;
    it has callers outside the sidebar: App.openPage, the pickers). The
    `sidebarSection` collapsible-section shell moved with the feature (the
    shell's Navigation section renders through it). `Sidebar.tsx` is the
    shell now: the NAV_ENTRIES register + the profile/account popup,
    composing the feature. `AnyClient` is defined by the feature and
    re-exported from the shell, so the existing type importers are untouched.
    The row/section styles stay in `Sidebar.css` — the nav rows and the list
    rows share the same classes.
  - **Docs**: `docs/features/pages.md`'s sidebar paragraph (the plain-text
    contract); `nodePrefs.ts`'s header comment re-anchored to the new home.
  - **Verification:** `pnpm typecheck` clean repo-wide; `pnpm test` green —
    the web suite's sidebar label tests now assert the plain-text contract
    (the mention folds to "Notes on Target", no `.nt-link` inside the row,
    the row button the only click target, right-click anywhere → the row
    menu).
- **fix(web,domain,protocol): content hyperlinks stop hijacking the block
  click; bare URLs autolink.** Two owner asks, one slice (2026-10-21).
  - **The click gesture** (owner ruling): a plain click on a content
    hyperlink used to BOTH navigate to the external URL and enter edit mode
    (the anchor had no `onClick`; the event bubbled to the block row's
    `enterEdit`). Now the anchor `preventDefault`s a plain, unmodified click
    — no navigation — and deliberately does NOT `stopPropagation`, so the row
    claims the click as before (edit mode; `openNode` in read-only
    projections). A Ctrl/Cmd/Shift-modified click keeps the browser default
    (`target="_blank"` opens a new tab); middle-click and the context menu
    are untouched. The anchor carries a `Ctrl+click to open link` title so
    the link stays discoverable.
  - **Bare-URL autolinking**: `splitMarkdownLinks` (`packages/domain`, the
    shared render grammar) previously linkified only explicit
    `[label](href)` markdown spans; a pasted `https://…` rode as literal
    text. After the markdown-span pass, remaining text segments are now
    scanned for bare `http(s)://` URLs and linkified — trailing sentence
    punctuation (`. , ; : ! ? =`) and unbalanced closing parens/brackets are
    trimmed off the match (`https://x.com/a(b)` keeps its balanced parens;
    `(see https://x.com)` leaves the sentence's `)` outside), and markdown
    link labels/hrefs are never re-scanned (order of operations). Non-http(s)
    schemes and bare schemes without a host stay literal — the
    `javascript:` allow-list guard is unchanged. Consumers inherit the
    behavior automatically: the web renderer (`InlineTokens`) and the
    markdown/html/latex export serializers.
  - **Docs**: SCHEMA.md's NORMATIVE render grammar (autolink rules + the
    click gesture — GTK/Flutter port both); `docs/features/links.md`'s
    external-links section (click gesture + autolinking).
  - **Verification:** `pnpm typecheck` clean; `pnpm test` green repo-wide.
    New coverage: `packages/domain/test/markdown-links.test.ts` (the
    splitter's markdown spans, bare URLs, trailing punctuation, balanced
    parens, non-http schemes); `apps/web/test/markdown-links.test.tsx`
    (rendering + the plain/modified-click contract on the anchor);
    `apps/web/test/node-link-gestures.test.tsx` (plain click on a link
    enters edit mode without navigating; ctrl+click leaves edit mode alone).
    One export expectation updated to the new intended behavior:
    `packages/export/test/markdown-hardening.test.ts` now pins that the
    paren-unsafe span's bare URL autolinks in the markdown body (emitted as
    an explicit link with the paren-bearing href in angle brackets) — the
    old assertion passed only coincidentally, via the un-linkified flattened
    title in the frontmatter/heading.

- **feat(protocol,store,web)!: retire the `readonly` render contract —
  derived from the system list; class-view chrome cleanup; aliases hide when
  empty.** Three owner asks, one slice.
  - **Readonly retirement** (owner ruling 2026-10-21): the `readonly` render
    contract leaves `propertySchema.create/update` — an enumeration of the
    seeds (seeds.ts + the GTK/Flutter seed manifests) finds ZERO system
    properties that ever carried the flag, so it was never user
    configuration. `class.property.set`-style precedent: the strict payloads
    reject the retired key outright; store **v26→v27** rebuilds
    `property_schema` without the `readonly` column (no snapshot byte patch —
    nothing to backfill; every hydration path opens through
    `Store.open`/migrate); the effective read drops the field. Clients
    DERIVE readonly-ness from the system property list —
    `isReadonlyProperty(schemaId)` in `packages/domain` (fixed seed UUIDs,
    precise) covering the platform-provenance schemas **generatedFrom +
    alias** — and dim/disable editors exactly where the old flag did (never
    blocking a write, PC1). `hideWhenEmpty` and `display` stay user-facing
    render contracts. The web settings modal loses the Read-only toggle; the
    convert flow stops copying the flag; the undo journal stops capturing
    it.
  - **Class-view chrome**: the "No templates bound" empty-state text is gone
    (the "Bind template" pill sits right there); the class-properties side
    says **"Bind property"** now (the domain verb — API/SCHEMA.md/CLI —
    unifying with "Bind template", not "Add").
  - **Aliases hide when empty**: the metadata panel's aliases row renders
    nothing until ≥1 alias exists — the page-header action row carries the
    "Add aliases" gesture until then; no empty section, no empty-state text.
  - **Migration**: `scripts/migrate-drop-schema-readonly.mts` (Path B,
    dry-run default) strips `readonly` from every stored
    `propertySchema.create/update` payload in place + bumps the restore
    epoch — no compensation (derived, not stored). Also: the two historical
    migration scripts that copied the flag (`migrate-attachments-asset-type`,
    `migrate-retire-class-class`) drop it from their plan/copy shape.
  - **Docs**: SCHEMA.md "Class properties" (the derivation contract),
    `docs/developers/migrations.md` (catalog row), `releases.md`
    (current-wire + lockstep table).
  - **Verification:** `pnpm typecheck` clean repo-wide; `pnpm test` green
    (protocol 530, store 617 on both adapters, query 249, server 236,
    domain 96, web 1880). The live migration dry-run found ZERO envelopes
    carrying the retired key in either workspace (the log was already
    clean — no seed ever set the flag; no epoch bump needed); the scoped
    redeploy + verify-min smoke — VERIFY-PASS. Lockstep: GTK b73a08e (854
    tests) + Flutter f086dd4 (668 tests).
## 2026-10-21
- **fix(web): the page header title row enters edit on a click anywhere in
  the row — the whole row is the click target, like a block.**
  Owner request (2026-10-21): "make page header enter edit mode when clicking
  anywhere in its row, like blocks do". The title is a bullet-less BlockRow
  whose click handler already rides `.nt-title-content` (its own `flex: 1`),
  but that content sat inside `.nt-page-title-wrap` — a bare inline span with
  no CSS rule — which shrink-wraps the title text, so the `flex: 1` filled
  only the text width and the row's empty space (a wide title row's free
  width) was a dead click zone. The CSS now stretches
  `.page-header__title-row > .nt-page-title-wrap` (`flex: 1; min-width: 0`),
  which stretches the title BlockRow beneath it, so a click anywhere in the
  row — the words or the space beside them — swaps in the block editor. The
  header icon keeps its own click (the icon+color picker), the block-bullet
  analog; the embedded render (the static open-page link) and day pages (the
  static date header) are untouched.
  - **Files**: `apps/web/src/ui/app.css` (the wrap-stretch rule),
    `apps/web/src/ui/PageChrome.tsx` (the title-row comment records the
    contract), `apps/web/test/title-editor.test.tsx` (CSS spec: the rule
    pins `flex: 1` + `min-width: 0`), `docs/features/pages.md` (the header
    paragraph names the whole-row click target).
  - **Verification**: `pnpm --filter @notees/web test` (title-editor suite
    green, the new CSS-spec test included) and `pnpm --filter @notees/web
    typecheck`.

- **fix(web): edit mode re-resolves mention labels — a stale captured text
  (import-era nested-link UUIDs baked in) never surfaces in the editor.**
  Read mode always rendered mentions from the label chain (the one-off
  `displayText`, else the target's CURRENT full title, else the captured
  text, else the raw id for a broken target); edit mode keyed its prose
  projection, atom list, and pill DOM off the captured `text` verbatim, so
  entering edit mode on legacy/import-era data showed raw UUIDs. The block
  editor now threads a `MentionNameResolver` through the editor layer —
  the same wiring pattern the class-chip label re-resolution already
  used — resolving the target's UNCAPPED full title (`fullTitleFromClient`,
  read mode's exact funnel; the capped `displayName` would truncate what
  read mode renders). Precedence: `displayText` → resolved live full title
  → captured `t.text` → raw target id. The resolver rides `proseFromAst` /
  `proseSpans` (one prose coordinate system, kept in sync), `editableAtoms`,
  `buildEditableDom`, `editableDomSignature`, `applyTextEdit`,
  `spliceTokens`, and the mark commands — a re-resolved label's length
  differs from the captured text's, so every prose-offset consumer must see
  the same projection or splices land wrong. Without a resolver the
  functions behave exactly as before (non-editor consumers keep the
  captured-text projection). No wire/store/domain change — display-only.
  - **Files**: `apps/web/src/editor/prose.ts` (`MentionNameResolver`,
    exported `mentionProse`, resolver params), `…/editable-dom.ts`
    (atoms/DOM/signature), `…/edit-apply.ts` (`applyTextEdit`,
    `spliceTokens`), `…/marks.ts` (the three mark commands),
    `apps/web/src/features/block-editor/BlockTextEditor.tsx` (the resolver,
    `fullTitleFromClient`-based, threaded through every prose call site),
    `apps/web/test/editable-dom.test.ts` (five label-chain unit tests),
    `apps/web/test/editor-atoms.test.tsx` (five edit-mode integration
    tests: resolved pill, atom-offset keyboard gestures on a re-resolved
    label, the touch-without-flatten flush guard, `displayText` precedence,
    broken-target fallback), `docs/features/links.md` (the mention
    contract: edit mode re-resolves too).
  - **Verification**: `pnpm --filter @notees/web typecheck`; the web suites
    editable-dom (8), editor-atoms (24), suggestion-popup (18) green.
- **feat(web): the node-picker result rows carry a hover tooltip with the
  full node title.** The rows crop long names (CSS ellipsis); resting the
  pointer on a row now raises the native `title` tooltip — the same idiom
  the row's own breadcrumb crumbs and the rest of the chrome already ride —
  showing the SAME string uncropped: the UNCAPPED full title
  (`fullTitleForSettings`, the read-mode link derivation; byte-identical to
  the capped display name inside the 80-char budget, past it the whole
  title instead of a cut). The create/date rows (label-only pseudo-nodes)
  tooltip their label.
  - **Files**: `apps/web/src/features/pickers/NodeResultItem.tsx` (the
    `title` on `.node-result-item__name`), `apps/web/test/suggestion-popup.test.tsx`
    (two tests: a 105-char title — the capped line + the full-title tooltip
    — and the create row's label tooltip).
  - **Verification**: the suggestion-popup suite (18 tests) green.
- **feat(protocol)!: the `external_link` content token retires — links are
  markdown spans in `text` tokens, parsed at render time.** Owner ruling
  (2026-10-21): the token was invisible in the web editor (zero-length prose
  span — unselectable, uneditable), authored only by the `/url` slash command
  with `text = href`, and silently dropped by the document-chrome content
  flatten — so it never worked in page titles at all, while imports (which can
  only place raw text in titles) produced `[label](href)` that rendered as raw
  text. Markdown-in-text survives every boundary (flatten, promotion, export)
  and is editable prose, exactly what the owner asked for. What changed:
  `externalLinkTokenSchema` leaves `inlineTokenSchema`/`contentTokenSchema`
  (strict schemas reject the type — no backward compatibility); SCHEMA.md
  gains the normative render grammar (`\[([^\]\n]+)\]\(([^()\s]+)\)`,
  http/https/mailto only, everything else literal) with the reference
  implementation `splitMarkdownLinks` in `packages/domain` (shared by the web
  renderer and the markdown/html/latex serializers — docx rides verbatim,
  PDF prints as text); the web `/url` command writes a `[href](href)` text
  token (visible, editable, renders linked — the splice merges it into an
  abutting run per `edit-apply`'s text-merge invariant); `InlineTokens` parses
  link spans out of every text token (marks apply to all segments);
  `packages/export` loses the `externalLink` IR span (text spans linkify at
  serialize time — markdown round-trips verbatim instead of escaping the
  brackets). **Migration**: `scripts/migrate-retire-external-link.mts`
  (migrations.md catalog; Kind B — dry-run verified against the live log:
  2,054 envelopes / 2,074 tokens, all in the personal workspace) rewrites each
  retired token to a `text` token — `[text](href)` when the pair satisfies the
  render grammar, else `text (href)` — in the envelope log + snapshot/derived
  `node.content` rows, bumps `restore_epoch`. LOCKSTEP GATE: run only after
  the GTK/Flutter ports ship the retired token's rejection + the markdown
  parse. Derived-state delta: link labels now appear in plaintext excerpts /
  FTS / display names where the retired token was previously silent.
  `packages/protocol/src/content-mark.ts`, `packages/protocol/SCHEMA.md`,
  `packages/domain/src/markdownLinks.ts`, `packages/export/src/{document,
  markdown,html,latex,docx}.ts`, `apps/web/src/ui/InlineTokens.tsx`,
  `apps/web/src/features/block-editor/BlockTextEditor.tsx`,
  `apps/web/src/features/block-editor/captureModel.ts`,
  `apps/web/src/features/node-menu/NodeContextMenu.tsx`,
  `apps/web/src/ui/export-pdf/pdfDocument.tsx`, `scripts/`, docs pass
  (`SCHEMA.md` grammar, `architecture.md` ×2, `links.md` new section,
  `migrations.md` catalog). Full gate green; the sibling GTK/Flutter slices +
  the live migration are follow-ups per the lockstep law.
- **feat(protocol,store,server,web)!: retire binding `sequence` — class
  properties render as a PURE ALPHABETICAL list everywhere.** Owner ruling
  2026-10-21 (a continuation of the property-definition surfaces batch): the
  class→property-schema binding keeps ONLY `active` (the soft-unbind flag) —
  panel order no longer exists to configure, so `class.property.set` is
  strictly `{classId, propertySchemaId, active?}` and the strict schema
  rejects `sequence` outright (the `required`/`defaultValue` retirement
  precedent, 2026-10-20).
  - **Store v25→v26**: `class_property` rebuilds without the `sequence`
    column (the historical v14/v25pre/v25 migration views drop it too; no
    snapshot byte patch — nothing to backfill, every hydration path opens
    through `Store.open`/migrate). `effective.ts` reads alphabetical: bound
    rows by property name, unbound authored rows last, `(idx, element id)`
    tiebreak. The applier's binding upsert is `active`-only; the task-family
    seed-ensure binds sequence-less.
  - **Web**: the class-property panel's drag-and-drop reorder is REMOVED —
    the list is display-only, alphabetical by property name at render time
    (getClassBindings/getRegistryBindings sort by name; the block-row
    display groups sort by label). `SetClassPropertyInput` is `{active?}`;
    the undo journal captures/restores the flag only. Seeds/self-heals
    (task/meeting/system-class-deploy/quick-create/create/convert modals)
    emit sequence-less binds.
  - **Server**: the bind endpoint echoes `{propertySchemaId, active}`; the
    effective-properties API drops `sequence`; the seed emits sequence-less
    binding envelopes (the per-class counter is gone).
  - **Domain seeds**: `SYSTEM_EXTRA_CLASS_BINDINGS` and `TASK_FAMILY_SEED`
    carry no order; the seeded class panels render alphabetically.
  - **Fixtures** (the gate stays 36): `class-property-defaults.json`,
    `class-property-active.json`, `class-unassign.json`,
    `property-schema-scope.json` re-encode the active-only binding.
  - **Migration**: `scripts/migrate-drop-binding-sequence.mts` (Path B,
    dry-run default) strips `sequence` from every stored
    `class.property.set` payload in place + bumps the restore epoch — no
    compensation (alphabetical order is pure derivation).
  - **Docs**: SCHEMA.md "Class properties" (active-only bindings, pure
    alphabetical rendering), `docs/developers/migrations.md`,
    `releases.md` (current-wire + lockstep table), `docs/api.md`,
    `docs/cli.md` (`--sequence` example/flag retired — a pending lockstep
    follow-up in the notees-cli repo), AGENTS.md's property-scope line.
  - **LOCKSTEP SHIPPED same day**: GTK + Flutter ports land with this batch
    (the required/defaultValue convention) — fixtures byte-identical both.
  - **Verification:** `pnpm typecheck` clean repo-wide; `pnpm test` green
    (protocol 530, store 617 on both adapters, query 249, server 236,
    domain 96, web 1881); fixture replay clean; the live migration rewrote
    826 + 44 envelopes (owner + test workspaces; epochs 14/5; full-replay
    verify clean); the scoped redeploy + verify-min smoke — VERIFY-PASS.
    Lockstep: GTK 5fafd87 (854 tests) + Flutter befd834 (668 tests),
    fixtures byte-identical both.
- **fix(web): the workspace-switcher's Manage icon is a dashboard grid, not
  sliders.** `mdi-tune` described configuring; the Manage Workspaces view is
  a responsive card grid of workspaces, so the affordance now previews the
  destination with `mdi-view-dashboard-outline`. The plain
  `mdi-view-grid-outline` was not an option — `CardsView` already spends it
  as the grid-view mode toggle, where it would have read as a view switch.
  Verification: `pnpm build` in `apps/web`; the 28 settings-modals tests
  pass.
- **fix(web): dark popups stop blending into the content — the night container
  ladder ascends, floating chrome rides elevated steps.** Owner report: the
  calendar popup (and similar popups) was the same color as the main content
  area. Root cause at the token level: the dark theme's `surface-container`
  was byte-identical to `surface` and `surface-container-low` was DARKER, so
  the M3 dark tonal-elevation mechanism (owner ruling 2026-10-16: the dark
  theme expresses elevation through the surface-container tone ladder) had
  nothing to work with — every elevated surface rendered at the content
  tone. `variables.css` `[data-theme="dark"]` re-tones the four container
  steps to ascend from `surface` (`-low` +1 → `-container` +3.5 → `-high`
  +5.5 → `-highest` +8.5 L*, seed tint preserved per the night-is-tinted
  ruling; grounds `-lowest`/`surface`/`background` untouched); `[data-oled]`
  lifts its container steps off pure black the same way (grounds stay #000).
  With the ladder working, the floating chrome that still rode plain
  `surface` moves to the app's established elevated steps, per the M3
  elevation ruling: the calendar popups (top-bar + date-picker family), the
  icon picker, and the node-selector picker ride `surface-container-high` +
  the level-2 shadow their siblings (hover preview, history menu,
  condensed-links popup) already carry (the date picker's "no shadow by
  local choice, flagged for the follow-up elevation audit" comment IS this
  audit); the Dropdown menu and the command-palette modal ride
  `surface-container-low` (the ContextMenu and the modal-card family's
  step). Menus, pickers, and modals now read against the flat night in every
  accent and in OLED. Light theme untouched (its ladder already descended
  correctly). `variables.css`,
  `features/calendar/TopBarCalendarPopup.css`,
  `features/date-pickers/CalendarPopup.css`, `DatePickerPopup.css`,
  `features/icon-picker/IconPickerPopup.css`,
  `features/pickers/NodeSelector.css`, `components/ui/fleet/Dropdown.css`,
  `features/command-palette/Modal.css`. Full gate green.
- **fix(web): the workspace-switcher's Manage affordance moved off the
  duplicated cog, and the per-row cog stopped reserving space.** The popup
  footer (cog icon + "Manage workspaces") is gone — that cog duplicated the
  per-row settings gear and read as workspace settings. Manage Workspaces is
  now an icon-only sliders button (`mdi-tune`, the "configure this set"
  glyph) on the right of the popup's search row, keeping the same accessible
  name so the settings-modals test only needed its title updated. Separately,
  the per-row settings cog was always rendered (28px, `opacity: 0`), quietly
  truncating every workspace name to make invisible room; it now collapses
  to `width: 0` with an overflow guard and grows to 28px on row
  hover/focus-within. Verification: `pnpm build` in `apps/web`; the 28
  settings-modals tests pass.
- **fix(server)!: the snapshot-upload sanity gate — an empty/garbage client
  checkpoint can no longer blank a workspace for every fresh client (owner
  incident: the Notas workspace read empty).** Root cause: `PUT
  /snapshot/data` accepted ANY authenticated bytes; an old-device client
  (pre-global-default build) wiped on the restore-epoch bump, failed its
  resync, and uploaded its EMPTY store covering the log tip — `saveSnapshot`
  then replaced the good 124 MB checkpoint (retention keeps only the newest)
  and every fresh client restored empty + no tail. The log and the server's
  derived state were untouched throughout (33 k nodes); the fix rides the
  existing recovery (bad snapshot dropped, epoch bumped, clients re-sync).
  The gate: for a workspace whose log exceeds `SNAPSHOT_REBUILD_MIN_ENVELOPES`
  (1000 — the server's own self-heal threshold), the uploaded bytes must be a
  parseable derived store (SQLite magic fast path, read-only probe on a temp
  copy) WITH node rows, else 422 and the previous checkpoint survives.
  Small logs stay exempt (a fresh workspace's empty checkpoint is legal).
  `@notees/store` gains the `./better-sqlite3` export (tsup entry + package
  exports) so the server tests can build store bytes. Tests: the gate's three
  reject/accept arms + the small-log exemption, and the rebuilt-snapshot
  suite's client-upload now sends healthy bytes. Server suite green (236).
- **fix(web): the calendar popups' ‹ › period arrows render and size to the
  catalogue.** Two defects, one root: the nav arrows were raw feature-code
  buttons — in the top-bar CalendarPopup and the Calendar view's MonthCalendar
  panel they wrapped `<span class="mdi mdi-chevron-…">`, which this app never
  renders (icons are the `Icon` SVG sprite, the MDI webfont isn't loaded), so
  the arrows were INVISIBLE; everywhere (those two plus the date picker's
  DatePickerPopup and the shared CalendarGrids header) the raw buttons were
  sized to `--button-icon-only-sm` — the 48px INVISIBLE hit-area floor — so
  they read as bloated next to the 32px catalogue standard. All four now
  compose the fleet `Button` (`variant="ghost" size="sm"`, icon-only): the
  SVG chevron renders, the visible box rides the icon-only-visible-sm
  register (32px), and the invisible 48px touch floor rides the catalogue's
  overlay span. The dead `.calendar-nav-btn` / `.month-calendar__nav` CSS
  blocks go with them. `TopBarCalendarPopup.tsx` + `.css`, `MonthCalendar.tsx`
  + `.css`, `DatePickerPopup.tsx`, `calendar/CalendarGrids.tsx`,
  `date-pickers/CalendarPopup.css`. Full gate green.
- **refactor(web): the SystemSections group component dies by subtraction —
  Child pages / Backlinks / Unlinked mentions become self-gating descriptor
  sections (the 2026-10-20 follow-through).** Yesterday's ruling retired the
  wrapper chrome, the all-empty gate, and the single-boundary hairline; the
  group COMPONENT survived one day as a pure mount site. It is gone: the
  three system sections are exported self-gating components (the
  ExtendedBySection pattern — eager count read, `null` at 0, then the lazy
  section mounts; each owns its hide-when-empty ruling, its hooks, its
  FilterQuery), and every variant's `systemSections` list places them as
  DATA (`pageVariant.ts`): plain pages carry [Child pages, Backlinks,
  Unlinked mentions], the class page prepends Extended by (the old mount
  order preserved), and the date family carries [Child pages, Backlinks] —
  the date-page ruling gains a cleaner mechanism: the descriptor OMITS the
  unlinked spec, so neither the section nor its FTS count mounts there at
  all (the old runtime gate forced the count to 0 inside the group; the
  exception becomes spec absence). `embedded` (read-only feeds: no Child
  pages create action) threads through the variant render context — the
  old `<SystemSections embedded>` prop's only payload. PageView loses both
  `<SystemSections/>` mounts and the import; the whiteboard branch's stack
  and the main stack render `variantSystemSections` alone. No visible
  behavior change: same sections, same order, same gates, same focus-mode
  and preview guards — the seams move, the surfaces don't.
  `SystemSections.tsx` (the three sections + module doc re-anchored;
  `ReferenceList` stays exported for the block-level backlink gutter — its
  import path is unchanged), `pageVariant.ts` (the specs, the `embedded`
  context field, the date omission), `PageView.tsx` (mounts + context).
  Full gate green.
- **fix(web): the workspace-switcher popup no longer shrinks to the trigger's
  width.** The panel was stretched to the sidebar trigger (`left: 0; right:
  0`), so on a narrow sidebar the search input, the badge + per-row gear, and
  the "Manage workspaces" footer cramped or wrapped. It now carries
  `min-width: 16rem` (the same floor `TemplateListPopup` uses) and grows past
  the trigger when needed. Verification: `pnpm build` in `apps/web`.

## 2026-10-20
- **docs: the person-facing docs split from two monoliths into a
  feature-centric structure (the Capacities-docs precedent).** `docs/usage.md`
  (install + CLI + web app + API in one 581-line page) and `docs/ux.md` (the
  whole interaction model in one 316-line page) are gone; every section was
  re-homed under the feature it belongs to, no content dropped (the split
  output is larger than the input — merges removed only verbatim duplicates).
  New shape: `docs/README.md` is the front door (grouped like Capacities:
  getting started → core concepts → features → reference); `getting-started.md`
  holds prereqs/install/server env/boot/accounts scope; `cli.md` the CLI
  tutorial (config, a real session, the shell, use cases); `api.md` the Object
  API quick reference; `feature-status.md` carries the Today vs Designed
  honesty table; `philosophy.md` is unchanged but for links; and 19 feature
  pages live under `docs/features/` — pages (view resolution, chrome,
  presenting, promote/convert/copy/divide/merge), outliner (the editor
  contract), links (mentions/chips/verbs, pickers, aliases, references),
  classes, properties, queries, views (list/cards/board, sort, windowing),
  calendar, tasks, templates, tables, whiteboards, graph, search, undo,
  offline-and-sync, exporting, sharing, workflows, plugins. Each feature page
  opens with an intro cross-linking its neighbors; usage+ux duplicate rulings
  were kept once, distinct details kept both. Repo-level follow-through:
  `README.md` (root) + `AGENTS.md` (the `docs/` layout line) re-pointed;
  code-comment pointers updated where safe (`SCHEMA.md`, `routes-shares.ts`,
  `shares.ts`, `keymap.ts`, `BlockTextEditor.tsx`, `undo-keymap.test.tsx`).
  Three files with doc pointers still name `docs/ux.md` — `op-types.ts`,
  `appliers.ts`, `undo-journal.ts` — left untouched because another session's
  uncommitted work owns them; their landing slice should re-point them to
  `docs/features/outliner.md` / `docs/features/undo.md`. No runtime behavior —
  no redeploy. Verification: every relative link and heading anchor across the
  25 new/rewritten files resolves (scripted check); the preservation
  spot-checks pass (env table, search ranking modes, the 2026-10-20 backlinks
  flat-outline ruling, recurrence `completedOccurrences`, graph color groups,
  the condensed layer, `{today}` placeholders, the workflow curl, merge
  dry-run, the 128 MiB/512 MiB body caps).
- **refactor(web): the section stack loses its group — one chromeless
  container, a hairline per section, no group-level hiding (owner ruling
  2026-10-20).** The page-bottom sections ran two visual systems: the
  system sections (Child pages / Backlinks / Unlinked mentions) stacked
  hairline-free inside the `.nt-page-sections` wrapper — one boundary
  hairline, borders suppressed, an all-empty gate whose only job was
  protecting that wrapper — while every other section (Classed nodes,
  Created, the date aggregations, Extended by) rode bare with its own
  hairline. The split forced duplicated separation chrome and already
  shipped one bug (the class page's first section hugging the ghost row,
  fixed this morning). The ruling: the group owns nothing. The sections now
  mount inside a single `nt-page-section-stack` container that is pure
  presentational anchor — no hairline, no margin of its own, no gap, no
  hide. Each section's own top border IS its separator (it renders iff the
  section does, so "is there anything to separate?" stops being a
  question), and one CSS rule (`.nt-page-section-stack >
  .node-view-section { margin-top: spacing-4 }`, margins collapsing
  between siblings) spaces the survivors — ghost row to first section and
  section to section read the same. The system sections' all-empty gate
  and the `.nt-page-sections` wrapper are gone (an all-empty render is
  visually nothing either way); the morning's `.nt-variant-sections`
  wrapper is subsumed. DayPageSections' container div rides the stack slot
  explicitly (its inner sections keep their own rhythm); the whiteboard
  branch's sections ride a stack container too. Focus mode's ruling is
  unchanged (Classed nodes stays, the system sections step aside — the
  guards live inside the container, one per family). Sections outside the
  page flow (side panel, graph cards) are untouched. `PageView.tsx` (the
  stack mounts), `SystemSections.tsx` (gate + wrapper die; comments
  re-anchored), `SystemSections.css` (wrapper chrome deleted, the stack
  rule), `NodeViewSection.css` (the spacing comment re-anchored: spacing-2
  is the header's under-hairline clearance; the hairline is the section's
  own border), `focus-mode.test.tsx` (asserts no section renders inside
  the always-mounted chromeless stack). Structural follow-up, deliberately
  deferred while the parallel session's collection refactor is in flight:
  descriptor-ize the three system sections out of `SystemSections.tsx`
  into the variant's `systemSections` list (Extended by already rides it)
  so the component itself can die by subtraction. (Gate note: the gate is
  red from the parallel session's in-flight breaking property-scope slice —
  `packages/store/src/appliers.ts:1918` on typecheck, `no such column:
  cp.default_value` across ~15 web test files — unrelated and untouched;
  every test exercising the changed files passes: `focus-mode` 7/7 with the
  re-anchored assertion, `dates` 20/20.)
- **feat(protocol+store+web)!: the binding's `required` retires outright and
  `defaultValue` moves to the property schema — ONE global default per
  property, the Logseq shape (owner ruling, the property-definition surfaces
  batch).** `required`'s only render effect was hiding the icon-button's
  "None" row — mild enforcement contradicting the render-contract law
  (suggestion only, never enforcement), and the designed highlight/lint never
  shipped — so it is gone outright; the strict `class.property.set` schema
  rejects it like any retired key. `defaultValue` follows the 2026-10-05
  render-contract precedent (binding → schema): `propertySchema.create/
  update` gain it (PC2-typed at apply — create against the payload's type,
  update against the stored type; keep/clear, the cleared spelling SQL NULL,
  retiring the stored-`"null"`-string wart), the effective read derives the
  schema's single default when a winning ACTIVE binding brings the property
  into the node's context (per-class default conflicts no longer exist), and
  the class-page inline editor is GONE with the move — the class page is now
  just the list of assigned properties (row click opens the base-definition
  modal, where the type-aware default editor lives, Logseq-style). A binding
  is genuinely per-class mechanics ONLY: `class.property.set {classId,
  propertySchemaId, sequence?, active?}`; store v24→v25 (class_property drops
  `required`/`default_value`, property_schema gains `default_value`; the
  v24→v25 rebuild + additive column, the v14/v24 precedent). The three
  default-bearing fixtures re-encode the global semantics (gate stays 36);
  the seeds' spec defaults (citekey's "") author on the schema create; the
  unassignClass default-mirror sweep reads the schema default. Server: the
  binding API echo is sequence/active only, the schema view carries
  `defaultValue`, the OpenAPI summaries re-point. Web: the type-aware
  `DefaultValueEditor` is shared by the S2 settings modal + the S1 create
  modal (the default rides the create payload now — no longer class-context
  only); PropertyConvertModal carries a type-valid default onto the new
  schema; the undo journal snapshots/restores the schema default and the
  binding inverse is sequence/active only. Live logs rewrite in place via
  `scripts/migrate-drop-binding-required.mts` (Path B: retired-key strip +
  per-schema `propertySchema.update` compensation + snapshot byte-patch +
  restore-epoch bump; LOCKSTEP GATE: after the GTK/Flutter ports).
  `docs/developers/migrations.md` + `releases.md` (current wire + batch row),
  SCHEMA.md "Class properties" rewritten. BREAKING (owner-sole-user): the
  retired keys reject at the strict envelope gate; no protocol-version bump
  (payload-key retirement with fixture updates, the established convention).
  (A parallel session's docs restructure retired `docs/usage.md`/`docs/ux.md`
  mid-flight — the user-facing wording for the retired binding fields lands
  in that session's new `docs/features/` tree; the `remap-reunion-evento.mts`
  seed binds sequence-only.)
- **fix(web): outline view, grouped by page — page sources stand at the top
  level (owner ruling).** In the references grouping (Backlinks, Unlinked
  mentions, the block-level backlink gutter), an entry whose source IS the
  containing page — a page mentioning the target from its own body or
  carrying the target in its own property values — used to render inside a
  self-named one-row group (a collapsible header naming the row's own page,
  then the same page indented beneath it). Nonsense chrome: that entry now
  rides the new `ungroupedItems` collection prop and renders as its own row
  in a separated flat outline list BEFORE the group sections, sorted with
  the rendering's sort mode like any flat list. `groupByContainingPage`
  returns `{ standalone, groups }` (a `ContainingPageGrouping`); the hosted
  custom tabs refine the ungrouped rows alongside the items/groups (same
  predicate, container order kept — the groups' precedent). Files:
  `grouping.ts` (the split + the return shape), `types.ts`
  (`ungroupedItems`), `OutlineView.tsx` (the flat layer before
  `GroupedFlat`), `NodeCollection.tsx` + `sectionViewResolve.ts` (the
  resolution threading), `SystemSections.tsx` (the ReferenceList passes
  its page sources); tests — the grouping-split unit, the mixed
  page-source + group rendering (top-level row, DOM order before the
  groups, bullet opens the source), the all-page flat rendering, the
  bound-verb page-source row (verb badge rides the standalone row now).
  Full web suite: 1835 passed; the 40 reds are all the in-flight
  property-default migration's (class_binding `required` / `defaultValue`
  half-done store work), untouched by this slice.
- **fix(web): the class page's first section keeps the page view's ghost-row
  separation (owner report).** On a plain page the first system section
  (Backlinks) sits a comfortable step below the body's trailing "+ Add block"
  ghost — the `nt-page-sections` wrapper owns that clearance (margin-top:
  spacing-4 above the hairline). On a class page the variant's section stack
  (Classed nodes) rode BARE in the content flow, wearing only the section
  chrome's tightened padding-top (spacing-2, the header's under-hairline
  clearance per the owner 2026-10-13 ruling) — so the "Classed nodes"
  hairline hugged the ghost row. The stack now rides an `nt-variant-sections`
  wrapper that adds exactly the system stack's margin-top (the per-section
  borders stay — the multi-section stack still separates by its own
  hairlines, unlike `nt-page-sections`' single-line suppression); geometry
  between ghost and first section is now identical in both views. Renders
  only while the variant actually has sections (plain/date variants mount
  no empty margin-carrying div). `PageView.tsx` (the wrapper), `SystemSections.
  css` (the rule), `NodeViewSection.css` (the spacing-2 comment re-anchored:
  under-hairline header clearance; the above-hairline room is the host
  wrapper's job). Pure CSS/JSX geometry — no behavior, wire, or model touch.
  (Gate note: `pnpm typecheck` is red at `packages/store/src/schema.ts:308` —
  another in-flight session's uncommitted edit, untouched here; the changed
  files pass a standalone syntax check.)
- **feat(web): the binding default editor is type-gated — text/number/
  boolean/select only; node-typed schemas lose the default UI (owner
  ruling).** A class binding's "Default value" never made sense for
  node-typed properties (object/asset — a default that links a node is
  meaningless; PC2 already rejects them at the wire) and the class-page
  expanded card offered a plain TEXT input for every type — writing a
  string where the wire wants a boolean/number failed loud at apply time,
  so the field was broken for exactly the types that could use it. The
  card's default editor is now per-type (owner ruling 2026-10-20): text
  keeps the input, number a numeric input, boolean a None/True/False
  dropdown, select a dropdown of the SCHEMA's options (the stored default
  is the option id); "None" writes an explicit JSON null — the one default
  shape PC2 accepts for every type (a cleared default now decodes back to
  null client-side instead of the "null" string artifact). For every other
  type — the node-typed family (object/asset/image/datetime) plus
  url/email/multi_select — the card shows NO default editor at all (Required
  remains). The S1 create modal shares the gate (`defaultCapable` in
  `metadata/shared.ts`): its default field narrowed from text/number/
  boolean/url/email/select to text/number/boolean/select. UI-only slice —
  the wire validator is untouched (url/email/multi_select defaults still
  validate; existing stored defaults keep deriving). `PropertyDefinitions
  Section.tsx` (the `BindingDefaultEditor`), `PropertyCreateModal.tsx`,
  `shared.ts` (the shared predicate), `types.ts` (`decodeDefault`'s null
  round-trip); tests — the select/boolean/number editor writes, the
  object-typed no-editor rule (class page + seeded class view + R7 panel
  scope), the create-modal type gate + the select-options dropdown.
  Full suite green.
- **fix(web): the dates suite's property-definitions test rides the shipped
  row-cog flow again (the suite's one red).** The class-property row refactor
  (the cog + × became the standard fleet ghost icon buttons) retired the
  in-row "Edit definition…" button — the S2 base-definition modal now opens
  straight off the row's cog ("Definition settings for …"), the in-row
  expansion holding class-level fields only (Default value + Required). The
  dates test still walked the old flow (expand → "Edit definition…") and went
  red; it now clicks the cog, same modal, same write-through assertions
  (precision select, date-range-qualifiers checkbox). Test-only re-anchoring —
  no behavior change; the full suite is green again.
- **fix(web): the ghost add-block leaves the system sections; cards mode gets
  the ghost card (owner report).** The "+ Add block" ghost leaked into the
  node collection system sections: every referencing subtree in Backlinks /
  Unlinked mentions (and the text-property carrier cell) trailed its own
  ghost — a click would have appended a child block to the *source* page from
  inside a read-out section. The ghost is document-body chrome and now mounts
  only there: `ReferenceSubtree` gains an explicit `showGhost` opt-in
  (default OFF — every surface it serves is system chrome; their add flow is
  the section's own "+", `showAddButton`/`onAdd`). Per the owner's mode
  register, the document add affordance is now mode-shaped everywhere: outline
  → the ghost bullet row, prose → the same row with its bullet dropped (the
  focused view's prose ghost now drops it too — it kept its gutter before),
  cards → a NEW GhostCard: a dashed, muted "+ Add card" slot in the grid's
  last cell (via the collection contract's new `trailingGhost` slot — a grid
  needs its slot as a cell, not a row after the grid; an empty cards body
  mounts the grid around the slot alone, the sole add affordance). The click
  realizes any variant into a real empty child block after the last one.
  `ReferenceSubtree.tsx` (the `showGhost` opt-in), `GhostRow.tsx` +
  `GhostRow.css` (`GhostCard`), `types.ts` (`trailingGhost`),
  `CardsView.tsx` (the last-cell ride + the empty-body gate), `PageView.tsx`
  (mode-shaped affordance), `FocusedBlockView.tsx` (the prose flag); tests —
  the system-sections regression (the Backlinks section mounts no ghost; the
  page body's one is untouched), the `showGhost` default/opt-in pair, the
  cards ghost card (presence, grid placement, realize), the focused prose
  bullet; `docs/ux.md`'s ghost rows re-pointed. Full suite green.
- **fix(web): the nodeview top bar's panel toggles go ghost — the same
  register as the main top bar (owner review).** The properties-panel and
  context-panel toggles on the panelled page's nodeview top bar still wore
  the `outline` variant's visible border at rest, setting them apart from
  the app top bar's dock toggles (which went ghost earlier today) and from
  the rest of the bar. Both move `outline → ghost`: at rest they are
  pixel-identical to the other chrome buttons, and the pressed state (panel
  open) wears the same ghost active fill as every other toggle — one
  pressed register across both bars. `PageChrome.tsx` (the NodeTopbar's two
  words); full suite green.
- **fix(web): the class-property row actions are the standard fleet buttons,
  and the expanded card is integrated into its row (owner review).** The
  cog + × are now the catalog `Button` (ghost, sm, icon-only — the
  hand-rolled bare buttons are gone; the nt-propdef classes are reveal
  hooks only). The expanded state is ONE surface: the chevron row is the
  card's header (border/background/radius moved from the inner panel to
  the expanded row; the fields stack beneath the header, no repeated
  identity, no separated box). Probe caught a real side effect at 390:
  the fleet buttons' law-mandated 48px touch-floor slop extended ~8px
  past the section edge and made it horizontally scrollable — the section
  content now clips the invisible horizontal excess (`overflow-x: clip`,
  no scroll container, the add popover and the card's vertical overflow
  untouched). Tests 29 green; probe PROBE-PASS (zero overflow at 390,
  integrated-card capture).
- **refactor(web): the class-property row gets the section-collapse
  treatment — one hover surface, the catalog checkbox, no repeated identity
  (owner rulings, third pass).** The row is now: a collapse CHEVRON
  (NodeViewSection parity — `mdi-chevron-right` rotating open), the schema
  icon, the name — and nothing else chrome-wise. The grip button is gone
  (the whole row is the drag handle, grab cursor, dnd-kit's 4px activation
  keeps clicks expanding); the row hover tint is gone — hover reveals
  exactly ONE surface, the right-side cog + × cluster. The expanded card is
  the row's own expansion: no repeated icon/name header, just Default value
  and the catalog `Checkbox` used as designed (its composed `label` prop —
  the hand-rolled label wrapper that rendered the off-shape box is gone, as
  are the orphaned grip/header/check CSS). Tests re-anchored (29 green;
  typecheck clean); the tracked section probe re-run — PROBE-PASS, the
  capture shows the chevron + clean card + square catalog checkbox, zero
  overflow at 390.
- **fix(web): useDeviceSetting re-reads when its key changes — the focused
  view zoom no longer inherits the previous node's view mode.** The prose
  focused view rendering outline after an in-app zoom exposed it: the
  hook's `useState` initializer never re-runs when the same instance gets
  a new key (`viewMode.nodeBlocks.<id>` moves with the zoomed node), and
  the effect only re-subscribed — serving the previous key's value until
  an unrelated settings event. The effect now re-reads the new key
  immediately (the standard derived-state-from-key pattern). Probe: step
  11 drives the zoom SPA path (pref set, bullet click, no reload) — the
  prose header assertion catches the stale read.
- **refactor(web): removal is a row action — the hover × next to the cog
  (owner ruling).** The expanded panel's Remove footer is gone; the collapsed
  row now carries TWO hover-revealed icon actions — the definition-settings
  COG and a REMOVE × (both stopPropagation, both hidden until row hover; the
  × is absent for system property schemas). The config panel is now purely
  settings: read-only header, Default value, Required — nothing else.
  Tests re-anchored (29 green; typecheck clean); the tracked section probe
  re-run — PROBE-PASS, the hover capture shows grip + cog + × on the hovered
  row only, zero overflow at 390.
- **feat(web): the focused block view becomes a NodeCollection parent —
  each view mode owns the parent display (outline: the root block row;
  prose: an editable top-level header).** Owner direction 2026-10-20 ("in
  v1 we had a prop for NodeCollection to show the parents — each node view
  mode could decide how to handle the display of a parent block"). The
  focused view (the bullet-zoom `rendersAsInlineBlock` branch) rendered
  `ReferenceSubtree` directly — outline-only, hard-wired, a third
  rendering surface. Now: `NodeCollection` takes an optional `parent`
  (the focused block) + `parentTrailing` (the "+ Add block" ghost at the
  child indent level), and the VIEW entries decide the display — outline
  renders the parent as the root block row with the items nested inside
  (the exact zoom grammar, SortableContext included); prose renders it as
  an editable top-level header via the TITLE-VARIANT row (title-is-
  content: the block's own text IS the header, Newsreader display type),
  the children flattened below, the ghost trailing the list. The new
  `FocusedBlockView` (ui/) hosts the outliner context, the edit-thread
  provider + measured overlay (the thread still runs from the focused
  block down to the editing child), the per-node `nodeBlocks.<id>` view
  preference, and the ghost; cards/table have no defined parent display
  yet — the focused view falls back to outline for them (documented gap
  until the modes decide). `ReferenceSubtree` keeps the genuine subtree
  renders (linked references, the hover-preview trampoline). Probe: step
  11 drives the prose focused view — the title-header parent, hidden
  bullets (no thread, the prose law), the ghost, and click-to-edit.
  Docs: NodeCollection/FocusedBlockView/NodeView/ReferenceSubtree headers.
- **refactor(web): the class-page binding panel is a simple inline editor —
  presence is the on/off (owner amendment to R7).** A property applies to a
  class by being in the list — the PC4 "Active on this class" switch leaves
  the panel (the flag stays wire-level; the row's dimmed-name cue still
  renders inactive bindings honestly), along with the "For this class" group
  label and the bordered group box. The panel is now exactly: read-only
  header, Default value, Required, Remove from class (hidden for system
  schemas). The ⋯ overflow is gone — its menu replaced by a row COG
  (`mdi-cog-outline`, hover-revealed) that opens the definition modal
  directly; the panel's "Edit definition…" button went with it. Tests
  re-anchored (29 green); the tracked section probe updated and re-run —
  PROBE-PASS, captures in `scripts/screenshots/.runtime/s6/` (the simple
  panel at 1440, zero overflow at 390).
- **fix(web): the class-page binding panel clarifies the active switch and
  hides non-removable removes (owner review).** The PC4 "Active on this
  class" toggle (was the unlabeled Disabled/Enabled pair) now carries its
  group label + a helper line — off keeps the binding's settings but stops
  applying them. "Remove from class" is HIDDEN for system property schemas
  (panel and the ⋯ overflow alike — non-removable means absent) and the
  "System properties stay on their class" caption is gone. Tests re-anchored
  (29 green in the three section suites; typecheck clean).
- **refactor(web): the class-page property config panel is class-level only
  (owner ruling R7).** The expanded panel duplicated the base-definition
  modal (rename, type/Convert, multi, target classes, date settings); it now
  carries exactly the class-by-class binding fields: a read-only identity
  header (icon + name), the "For this class" group (default value, Required,
  the Enabled switch — `defaultValue`/`required`/`active`, with `sequence`
  staying the drag reorder on the collapsed row), and a footer with the quiet
  "Edit definition…" (the panel's path to the S2 PropertyEditModal) plus
  "Remove from class" behind the existing confirm. The Definition group, the
  editable Target classes group (and its duplicated group label), the
  datetime precision/qualified fields, and the header rename/icon picker
  left the panel — all definition-level, all in the modal. Two modal
  gains in the same pass: the "Unresolved targets" hint moved into the
  modal's targetClassFilter editor (the class-view seed test's `agent`
  assertion moved with it), and the "Allow start/end qualifiers" checkbox
  now also renders for **object**-typed schemas (it was datetime-only,
  leaving the panel's retired object-type "Date qualified" without a home).
  Tests: the section suite gained a class-level-only structural test and a
  modal-context unresolved-targets test; the target-class, rename, and
  date-precision/qualified tests now drive the modal via "Edit definition…".
  Gate green (typecheck + 165 web files / 1865 tests); visual QA via the r7
  probe (offline dev server, panel at 1440 + 390 with zero horizontal
  overflow, the modal's target-classes editor).
- **chore(server): `SERVER_VERSION` rejoins the tag train — 3.2.0 → 4.4.0.**
  The constant had been stuck since v3.2.0 while tags rode to v4.4.0 (flagged
  by the CLI's v4.1.1 alignment — its `doctor` drift check compares against
  the live server). Tests reference the symbolically, no assertions changed;
  server suite 232 green.
- **feat(protocol,store,web): the property-definition batch ships — lockstep
  complete, live-migrated, deployed (VERIFY-PASS).** The 2026-10-20
  property-definition effort lands end to end: `scopeClassIds` replaces the
  retired `scope` enum (the sole locality authority — bindings carry zero
  availability semantics), schema `icon`, update-side `scopeClassIds`/
  `targetClassFilter`/`multi`/`validationRules`, R3/R5 fail-loud eligibility,
  eligible-tagged reads, validationRules value enforcement at `property.set`,
  the web surfaces (S1 pre-creation modal on all entry points, S2 definition
  editor, the R6 convert gate, S4 eligibility pickers, S5 block-to-property
  drag, the S6 class-properties rebuild), and the seed-scope audit (task
  family + weblink `url` global; family-identity seeds stay local).
  **Lockstep:** GTK **v4.2.0** (store v16, 847 tests, fixtures 36/36
  byte-identical) + Flutter **v4.1.0** (DB v31, 664 tests, 36/36) tagged and
  released; the CLI aligns by vendor pin (its own tag). **Live migration
  (Path B):** 5,389 owner-workspace envelopes + 175 test-workspace envelopes
  rewritten in place, both snapshots patched, `restore_epoch` bumped (10/4),
  the seed-flip convergence appended (weblink `url` → global, 1 envelope) —
  `migrate-property-scope.mts` gained a snapshot-patch ordering fix + a
  resumable apply flow + a verify comparison fix (899f8d2c, 668a835b).
  **Deployed:** `notees-sync` + `notees-web` rebuilt from the live stack
  folder, `verify-min.mjs` → **VERIFY-PASS**. Relay backups in `/tmp`
  (`relay.db.bak-property-scope-2026-10-20T16-2*`).
- **fix(scripts): `migrate-property-scope.mts` snapshot patch rewritten —
  the live run exposed the ordering bug.** The first `--apply` rewrote the
  5,389 retired-`scope` envelopes in place and then failed at the snapshot
  step ("no such column: scope_class_ids"): the script wrote the new column
  BEFORE the store's v24 rebuild created it (and the rebuild hard-codes NULL
  for the new columns anyway, so the write had to move AFTER `Store.open`).
  Fixed: the mapping is captured from the pre-migration bytes, `Store.open`
  runs the rebuild, then `scope_class_ids` is written into the rebuilt table;
  the apply flow is now resumable (a run with nothing left to rewrite still
  patches a scope-carrying snapshot, bumps the epoch exactly once, and
  verifies). The live migration was resumed to completion: snapshot
  `01a159f0…` patched (bytes backed up), `restore_epoch` bumped to 10, the
  5,496 propertySchema envelopes re-validate clean, and the full-log scratch
  replay passes. Relay backups: `/tmp/relay.db.bak-property-scope-2026-10-20T16-24-38-944Z`
  and `/tmp/snapshot-01a159f0-….bak-2026-10-20T16-28-19-641Z`.
- **feat(domain,web,server,store): seed-scope audit — the reusable seeds flip
  to global scope; family-identity seeds stay local (owner ruling,
  the follow-up to the property-scope batch b8548e0e).**
  Commit b8548e0e mechanically mapped every old `scope:"class"` seed to
  `scopeClassIds:[<its bind class>]`; the audit found that over-scoped the
  genuinely reusable properties. FLIPPED to global (absent/null
  `scopeClassIds`; binding rows untouched — bindings stay per-class config
  with zero availability semantics): the ENTIRE task family (Status —
  explicitly ruled "can be reused for other nodes" — plus Scheduled,
  Deadline, Priority, Closed, Recurrence) in every emitter (`TASK_FAMILY_SEED`
  consumers: the store applier's `ensureTaskFamilyRows`, the web
  `ensureTaskFamily`, and the schema/seed path), and weblink's `url` (a url
  is generically reusable — new `global` flag on `SystemPropertySpec`,
  honored by the server seed and the web `deploySystemClass`). KEPT LOCAL as
  family-identity fields: the whole source bibliographic family (citekey —
  explicitly ruled "local to the source class and its extensions" — plus
  attachments, authors, ISBN, DOI, publication date, publisher), the meeting
  identity trio (meetingDate, location, agenda), eventDate, birthdayPerson,
  the person given/family split, and the asset/highlight fields (role,
  provenance, highlightAsset); aliases/has-template/generated-from were
  already global. LIVE CONVERGENCE for existing workspaces: the new
  `scripts/migrate-seed-scope-flips.mts` (Path A per migrations.md, the
  `migrate-task-status-styles.mts` precedent — the immutable log is never
  edited) appends one protocol-validated `propertySchema.update
  {scopeClassIds: null}` per still-local flipped schema, planned from a
  scratch snapshot+tail store, `--workspace`/`--all`, dry-run default,
  `--apply` through `RelayStorage.ingest` + read-back/full-replay verify.
  NOT RUN against the live stack in this slice (deployment is later; same
  GTK/Flutter lockstep gate as `migrate-property-scope.mts`). No fixture
  changes — the flip set is seed envelopes only; the `scopeClassIds: null`
  update shape is already pinned by `property-schema-update-fields.json` /
  `property-schema-scope.json` (gate stays at 36). Tests: the store
  tasks-enable suite + the web task-family suite pin the six schemas at
  NULL scope; the domain suite pins the audit's flip set (url global,
  citekey local, every other bound spec local); the deploy suite gains the
  weblink-url-global case. Docs: SCHEMA.md (seed manifest + the tasks-enable
  + source-family bullets), migrations.md catalog row. Verified: `pnpm
  typecheck` + `pnpm test` green; a live-data audit (the relay's 2 workspaces
  × the derived DBs — the script's own dry-run correctly BLOCKS until
  `migrate-property-scope.mts` has run, the shared lockstep gate) shows 13
  envelopes to append: 7/7 flipped schemas in the owner workspace, 6/7 in
  the test workspace (url not authored there).
- **fix(web): an unbound text property added from "+ Add property" no longer
  self-unsets the instant its row appears.**
  The panel add flow (`initializePropertyValue`, the placeholder+init
  pattern) mints a fresh empty carrier block for a text property and never
  moves focus into the row; the 2026-10-09 auto-unset pass
  (`TextPropertyRow`'s `cleanupEmptyValues`) runs on every render and skips
  contentless carriers only while the row holds focus — so the just-created
  placeholder read as an abandoned dead block and the row vanished before
  the user could type (found while probing phase B, commit 5729fa94). The
  placeholder init now records the carrier id in a session-local pending
  set (`propertyValueInit.ts`); the pass skips a pending contentless
  carrier (a non-pending one still unsets — the legacy-data cleanup is
  untouched), clears the mark the moment content or a child lands, and the
  row's focusout handler clears this row's marks and re-runs the pass — so
  the placeholder survives until the user leaves it empty, exactly the
  ruling's intent. The class-bound add flow rides the same protection
  (default-derived rows were never in the pass's authored-only filter).
  Regression: `text-property-blocks.test.tsx` gains the "+ Add property"
  suite — the panel-driven unbound add leaves a stable editable row (no
  unset op, carrier untrashed), unsets only after the user leaves it empty,
  settles once content lands, and the class-bound variant stays. Docs: the
  pass contract comments in both files. Verified: `pnpm typecheck` green;
  the new suite's four tests fail against the pre-fix sources and pass with
  the fix (stash-verified); full gate below.
- **feat(store,protocol): validationRules value enforcement at `property.set`
  — the R2 companion to the property-scope batch (commit b8548e0e).**
  SCHEMA.md's Properties section promised "values validated at
  `property.set`, fail loud"; this slice implements it in the TS reference
  applier. A schema carrying stored `validationRules` validates every
  `property.set` value BEFORE the write (`assertValueForSchema` extension,
  `packages/store/src/property-values.ts`): `number` schemas bound the value
  with inclusive `min`/`max`, checked AFTER the existing legacy
  numeric-string normalization (a migrated epoch-millis string normalizes,
  then validates); `text`/`url`/`email` schemas full-string-test SCALAR
  values against `pattern` (implicit anchors — the HTML `pattern`
  semantics; a text carrier ref `{nodeId}` is not a string and rides
  unchecked, the shape family owns refs). Each multi element is its own
  `property.set` (PG5), so every element is validated at its own add and one
  bad element rejects its op while the surviving elements stay. Rule-free
  schemas and schema-less writes (unknown schema id) stay unchecked, exactly
  like the shape checks; types outside applicability (boolean/select/
  multi_select/datetime/object/asset/image) can never carry rules — the
  update-path applicability enforcement guarantees it. **New apply-time
  guard:** `propertySchema.update` carrying a non-compilable `pattern` now
  fails loud at the rule write (a stored pattern that threw at value-check
  time would be an applier crash — never acceptable); the value check also
  fails loud (never crashes) on a corrupt stored pattern as defense in
  depth. Canonical fixture `property-validation-rules.json` (fixture gate
  35→36): an accepting prefix (boundaries, the normalized numeric string,
  min-only/max-only, rule-free, schema-less) replays on both adapters; the
  six-envelope reject tail (below-min/above-max, two pattern misses, one bad
  multi element, one un compilable pattern) throws on apply by design — the
  file joins the replay-excluded set and each reject is pinned in the store
  suite (both adapters). Docs: SCHEMA.md's validationRules + PG6 paragraphs
  tightened (value enforcement shipped, no pending hedge), the development
  runbook's fixture-gate count 35→36. LOCKSTEP-PENDING: GTK/Flutter converge
  on the three fixtures before the live migration runs. Verified:
  `pnpm typecheck` green; store suite 615 green (incl. the new
  `validationRules value enforcement` + fixture-pinning tests on both
  adapters); protocol suite 528 green (the 36-file gate).
- **feat(web): the class properties section rebuilt (S6) + block-to-property drag (S5) — the property-definition batch's visual slice (phase B).**
  Owner ruling 2026-10-20 (the property-definition proposal: "terrible, horizontal scroll on the sidebar; on par with Capacities and Notion"). **S6 — PropertyDefinitionsSection ground-up** (the missing-P filename typo fixed in the same slice: `ropertyDefinitionsSection.*` → `PropertyDefinitionsSection.*`, references in `classview/index.ts` + `page-sections/pageVariant.ts` updated): the collapsed row is **identity-only** — hover-revealed drag grip (dnd-kit, the reorder→sequence writes unchanged), the schema icon (the owner-2026-10-20 icon field, per-type glyph fallback), and the name with `min-width: 0` + ellipsis; no chips, no row-level flag toggle, no × — inactive bindings dim the name (the only disabled cue). The row click opens the **config panel** (full section width, stacked groups, sidebar-safe at 390): header (icon picker + rename → `propertySchema.update {name}`); a **Definition** group (read-only type + Convert… → the R6-gated PropertyConvertModal, the multi state, "Edit definition…" → the S2 PropertyEditModal); a **For this class** group (typed default-value editor → `class.property.set {defaultValue}`, the Required checkbox, the **Enabled ToggleSwitch now writing `binding.active` live** — the PC4 lockstep shipped, the pending-copy is gone); a type-specific group (**target classes editable** via `update {targetClassFilter}` — the 3A wire, ClassMultiPickField; date precision for datetime; dateQualified for object); footer **Remove from class** behind a ConfirmationModal, disabled for system schemas (the fixed `SYSTEM_PROPERTY_UUIDS` in @notees/domain). **The Inherited group (v1 parity, was missing entirely)**: read-only rows attributed to the NEAREST extends-ancestor binding each schema (BFS over `getClassParents`; the direct/inherited split reads `getRegistryBindings` + the same seed-spec synthesis `getClassBindings` applies, so attribution can never disagree with the effective list); a click opens the base-definition editor. **The add-property popover**: anchored under the AddPill, SearchField + keyboard-navigable listbox (icon + name + type label), filtered by query AND class-context eligibility (global + schemas scoped to this class or its extends-ancestors — `isSchemaEligibleForClass`, the R2 closure); its "Create …" row opens the S1 creation modal pre-filled via `requestPropertyCreate({ contextClassId, initialName })` — the instant text create-and-bind is gone. **S5 — block-to-property drag**: dragging a block from the owner's body onto a text-property row makes it the value's carrier, in the ONE workspace drag session — the row registers a droppable with the `WorkspaceDndHost` (`useWorkspaceDndPropertyDrop`, `workspace-prop-drop:` namespace; the host intercepts over→slot in handleDragMove/handleDragEnd, suppressing the zone drop line); the decision matrix lives in `ui/property-drop.ts` (pure, jsdom-tested): single-value slot EMPTY → one `property.set {value:{nodeId}}` at idx 0 (the placeholder convention); OCCUPIED → no-op (never an overwrite); MULTI → append at nextIdx with a **writer-minted UUIDv7 elementId** (the PG5 OR-Set add — `setProperty` gains the optional elementId pass-through, web layer only, the wire always carried it); same-owner only (a foreign block is refused), the schema must be eligible for the owner (R3's applier guard backs it), garbage cases refused (the owner itself, an ancestor of it), text slots only. Affordance off DragSourcesContext: empty slots accent-ring on block-drag start, drop-over state-layer on the row under the pointer, the no-drop cursor on refused rows — no layout shift. Docs: `docs/usage.md` gains the drag paragraph. Verified: `pnpm typecheck` green repo-wide; web vitest green incl. the rewritten `class-bindings` suite, the new `property-definitions-section` (7) and `block-property-drop` (9) suites; visual QA captures at 1440/768/390 (the capture loop's own probe).
- **feat(web): property-definition surfaces — the S1 pre-creation modal, the
  S2 base-definition editor, R6 convert gating, and the S4 eligibility
  surfaces (the property-definition batch, slices 1+2 = commit b8548e0e).**
  Owner ruling 2026-10-20 (the property-definition proposal, this phase:
  S1/S2/S2b/S4 + the PropertyView footer; S5 drag + the S6 class-section
  redesign are the next phase). S1 `PropertyCreateModal` (v1 PropertyCreateModal 1:1, adapted):
  name with a live duplicate check, the icon picker, the 11-type radiogroup
  grid, single/multi, the options editor (add/remove/reorder, per-option
  icon+color), targetClassFilter class multi-pick, the scope control (global
  default / local-to-classes), and a default-value field in class context
  only (defaults are binding-level — the field writes the class binding after
  the create); one `createPropertySchema` on confirm, followed by
  `setClassProperty(classId, id, { sequence, defaultValue? })` when
  `contextClassId` is given. Entry points route their typed query in: the
  panel's "+ Add property" create row (AddPropertyRow), the VerbPopover
  create-and-bind (LinkEditModal, object/multi pre-selected, the typed-link
  mark binds the new schema), the editor slash `/property`, and the reserved
  Ctrl/Cmd+Alt+P global chord — all through the app-level
  `PropertyCreateHost` (a module-level request queue, the
  requestQueryBuilderOpen idiom); a `nodeId` request initializes the
  placeholder value after the create. S2 grows the settings modal into the
  base-definition editor (the per-label entry stays): rename, icon, the
  read-only type + Convert…, multi (v1's danger confirm on multi→single with
  values anywhere), options, targetClassFilter (now writable), scope
  (update {scopeClassIds}, null = global), number formats, date
  precision/qualified, the render contracts, validationRules editors (number
  min/max; text/url/email pattern — the regex must compile), and a
  standalone Delete flow (v1's confirmation copy; PropertyDeleteModal shared
  with the PropertyView footer, which gains Edit…/Delete…). S2b (R6):
  PropertyConvertModal checks `getPropertyReferences` first — values on any
  node render a blocked state ("has values on N nodes, so its type can't
  change"); the plan/convert UI and the drop-values confirm are unreachable.
  S4: `schemaEligibility.ts` (classClosureOf / isSchemaEligibleForNode /
  eligibleSchemasForNode — the extends-aware walk over getClassParents, R2)
  gates the AddPropertyRow candidate list, and effective rows tagged
  `eligible: false` render dimmed with an ineligible affordance (R4 honest
  rendering, never hidden) across the scalar + grouped row components. Web
  client layer: `UpdatePropertySchemaInput` gains icon/scopeClassIds/
  targetClassFilter/multi/validationRules (keep/clear), the writes pass
  them through, `listPropertySchemas` maps `validation_rules` — and now the
  number-format columns too (pre-existing gap: the SELECT never carried
   them, so the formats always read null). AGENTS.md + the ui-primitives
  runbook's primitive path corrected to `apps/web/src/components/ui/fleet/`
  (the tree realignment moved them; `ui/components/ui/` now holds only
  `calendar`). Two defects the capture loop surfaced, fixed in the same
  pass: the kit Modal card had lost its viewport anchoring (it portals as
  the Radix backdrop's SIBLING and carried no position/z-index — it rendered
  in body flow UNDER the fixed scrim, unclickable; restored `position:
  fixed` + `translate` centering + `z-modal`, and the sheet variant's
  bottom anchoring, plus a `min-height: 0` flex fix so a tall modal scrolls
  its content instead of losing the footer off-screen), and the create
  host's placeholder init re-read the schema type through the worker's
  cached listPropertySchemas (stale → wrong placeholder shape) — the modal
  now passes the created type to onCreated explicitly; AddPropertyRow also
  closes its popup when the modal takes over. Verified: `pnpm typecheck` +
  the web suite green (new
  property-create-modal / property-edit-modal / schema-eligibility suites;
  the PG3 convert tests reworked to the R6 ruling; the slash-command list
  test gains the /property row; the verb create-and-bind suites drive the
  modal flow). Visual QA via the capture loop against a throwaway dev
  instance (offline store mode): the S1/S2/S2b/S4 surfaces at 1440/768/390
  — the modals ride the bottom-sheet register at narrow widths, the blocked
  convert state reads clean, no console errors beyond the honest
  offline-mode transport notice. Known gap (packages frozen this phase):
  the store enforces validationRules APPLICABILITY only — value validation
  at property.set (SCHEMA.md's statement) is not implemented yet, reported
  as a follow-up.
- **fix(web): the edit thread settles — one re-measure 220ms after the
  last change lets transition-driven geometry settle into the path.**
  Found by the live focused-view probe: the editing block's class icon
  scales 1.2 over 120ms, a mutation-driven recompute measures the glyph
  MID-TRANSITION, and the transform settles without touching the DOM — so
  the arm could freeze ~2px off the settled glyph (borderline in the page
  body, visible in the focused view). The overlay now schedules a single
  settling pass 220ms after the last change (re-armed by any new change,
  quiet afterwards) — same technique as the layout-settle probes.
- **feat(web): the focused block view hosts the edit thread — from the
  focused block down to the editing child.** Owner report 2026-10-20: in
  the focused view (the bullet-zoom `rendersAsInlineBlock` branch of
  NodeView) no thread showed for edits at the first children level. Two
  gaps: the focused view renders `ReferenceSubtree` outside PageView, so
  no EditThread provider/overlay existed there at all, and the ancestor
  walk stopped at `parentId === rootId` — in the focused view the root IS
  a block row (a real bullet, per the zoom grammar), so a direct-child
  edit produced a one-point chain. NodeView now wraps the focused-block
  wrapper in the provider + overlay (the wrapper is the host). The walk
  includes the view root when its row renders a measurable bullet — the
  page view keeps the old behavior (the page title row owns no bullet, so
  body edits still stop at the top-level block, and a top-level edit
  shows no thread). Probe: step 10 zooms into A, edits a child, and
  asserts the thread starts at the focused block's bullet and ends before
  the child's icon. Docs: NodeView/ReferenceSubtree/EditThread headers.

- **fix(web): the SPA stops serving stale app versions after a redeploy —
  index.html is never cached, hashed assets are immutable.** Owner-report
  2026-10-20: "I redeployed and still see the old checkbox" — the
  deployed image WAS the new build (bundle verified: `rounded-shape-md`
  present), but nginx served `index.html` with only Last-Modified/ETag,
  so browsers heuristic-cached it for hours: a stale index pins the OLD
  hashed CSS/JS URLs and the user runs the pre-deploy app no matter how
  many redeploys ship. `nginx-spa.conf` now sends `Cache-Control:
  no-cache` on the SPA shell (ETag 304s keep reloads cheap) and
  `public, max-age=31536000, immutable` on `/assets/*` and the sprite
  (content-hashed — a new build is a new URL). Verified on the running
  container: all three headers correct. One hard refresh is needed now
  to drop the already-cached shell; every future redeploy lands on a
  plain reload. (Also that session's store refactor has since landed —
  its changelog entry follows.)
- **feat(protocol+store): property scope becomes `scopeClassIds` — the sole
  locality authority — and the schema's base definition gains icon,
  targetClassFilter/multi/validationRules on update.** Owner ruling
  2026-10-20 (the property-definition surfaces batch, slices 1–2; web UI is
  slice 3, not in this entry). The display-only `scope:
  "global"|"class"|"object"` enum retires: the strict `propertySchema.create`
  payload rejects the key outright, and `scopeClassIds` replaces it —
  absent/null = global, a non-empty class-id list = local to those classes
  AND their extends-ancestors (the empty array is rejected). Bindings
  (`class_property`) keep zero availability semantics (per-class config
  only). Enforcement: `property.set` on an ineligible node fails loud (R3,
  extends-aware closure walk), `class.property.set` outside the scope fails
  loud (R5, dead config), and `getEffectiveProperties` tags every row
  `eligible: boolean` while never deriving a default for an ineligible node
  (R4) — narrowing a scope is never retroactive (authored rows survive,
  tagged). `propertySchema.update` gains `icon`, `scopeClassIds`,
  `targetClassFilter`, `multi`, and `validationRules` (`{min?, max?,
  pattern?}`, keep/clear; min/max on number schemas, pattern on
  text/url/email, enforced at apply time). Store schema v24 rebuilds
  `property_schema` (the `scope` column retires; `icon`/`scope_class_ids`/
  `validation_rules` land). Seeds/self-heals (server seed, task/meeting/
  template/alias/quick-create families) emit the list; the object-scope
  audit found a single emitter (`generatedFrom`), demoted to global.
  Fixtures: two new canonical files (`property-schema-scope.json`,
  `property-schema-update-fields.json`; the exact-list gate 33 → 35) and the
  retired-key fixtures re-encoded. `scripts/migrate-property-scope.mts`
  (Path B, dry-run default) rewrites stored logs in place after the GTK/
  Flutter lockstep. Verified: `pnpm typecheck` + `pnpm test` green (incl. the
  fixture replay on both adapters); LOCKSTEP-PENDING on the GTK/Flutter
  ports (`releases.md`).

- **feat(web): checkboxes wear the same rounded square as the buttons.**
  Owner feedback 2026-10-20 (the task checkbox "looked weird" — a 4px
  corner against the bar's new register). Both checkbox primitives move
  to the shared shape: the fleet `Checkbox` (`rounded-shape-sm` →
  `rounded-shape-md`) and the catalog `checkbox` (`rounded-item` →
  `rounded-shape-md`, the Dropdown composables included). `rounded-
  shape-md` joins the Tailwind radius map as the shared rounded-square
  utility (owner ruling: buttons and checkboxes wear the switcher's
  `shape-medium`). Verified live: a table selection checkbox computes
  `border-radius: 6px`, identical to the top-bar buttons; drift gate
  green (12/12). Full-suite note: the 36 collect failures at this moment
  are entirely another session's in-progress
  `packages/store/src/schema.ts` (a backticked `` `scope` `` inside a SQL
  template string — a pre-parse error in THEIR uncommitted +85-line v24
  edit; zero tests reference the checkbox classes); reported, not
  touched, per the parallel-session law.
- **feat(web): the card view's second view mode is the FLOW — single column /
  grid / masonry — and the old one stands renamed to what it always was, the
  cover position.** Owner request 2026-10-20: the cards view carried one
  "secondary view mode" that was really about cover placement, and wanted a
  second one for layout (single column / grid / masonry), with the open
  design question settled in the same slice: ONE flow enum, not a
  multi-column × grid pair — the boolean decomposition creates a meaningless
  single-column-grid combination, and grid vs masonry only differ in
  multi-column. The rename: `CardLayout` → `CoverLayout` (type, prefs
  functions `readCoverLayoutPref`/`writeCoverLayoutPref`/
  `useCoverLayoutPreference`, the capability flag, the toggle's aria-label —
  "Cover position"; the `cards.coverLayout` storage key and its values are
  unchanged, no migration). The flow: `CardFlow = "stack" | "grid" |
  "masonry"` (types.ts), persisted device-globally like the cover position
  (`cards.flow`, `useCardFlowPreference`, surfaces shape only the unset
  fallback via `defaultCardFlow` — default "masonry", the recovered original
  adaptive multicol, so every existing surface keeps its look). The flat
  grid's toolbar gains the flow picker (stack = full-width rows; grid =
  row-aligned `repeat(auto-fill, minmax(...))` columns; masonry = the
  original CSS-columns flow, now scoped under `.cards-grid--masonry`); the
  raised panel chrome is the shared base. The grouped board rides no flow —
  its columns are the property groupBy, not a visual layout (kanban stays
  cards + groupBy, and the flow is not a fourth board value either).
  Verified: `view-modes.test.tsx` gains the flow test (masonry default,
  toggle switch + device-local write, stale-value fallback) and the
  board-ignores-flow test; full suite green. Docs: `docs/ux.md` (the stick
  ruling), `docs/usage.md` (view modes stick, the cards board section, the
  new flat-cards-flow section, the Assets hub cover-first wording).
- **feat(web): the thread SURROUNDS an in-path icon — a loop of inverted
  rounding wraps its lower-left, and the downward line keeps its original
  position.** Owner correction 2026-10-20 ("keep the downward line in its
  original position and do a flipped round in the corner, surrounding the
  icon — a loop/inverted rounding around the bottom left"). The shipped
  inward-corner variant dropped the vertical into the gap LEFT of the
  icon for the whole descent — the staircase columns zigzagged between
  the gap and the center. The surround refines it: the arm still stops a
  radius early, but the corner then hugs the glyph left edge down, rounds
  the bottom-left, and rejoins the CENTER column just below the glyph (a
  short run passes beneath it — nothing to peek through). Every downward
  segment now rides a bullet center column, straight through dots and
  icons alike; the icon reads as sitting ON the thread. Ships with the
  overlay MutationObserver hardening (an icon arriving via an op — or any
  in-path chrome change without a resize/scroll/store event — re-measures
  the path; caught by the live probe as a stale-geometry race) and the
  probe accent-reference fix (the menu click blurs the editor, so the
  editing dot is gone by the menu-anchor read). Probe: the surround
  asserts the hug, the bottom-left wrap, and the center-column rejoin
  (4 quadratic joins for an iconed chain). Docs: EditThread/BlockRow
  headers.
- **feat(web): the sidebar dock toggles go ghost — inactive toggles read
  like every other button.** Owner feedback 2026-10-20: the outline dock
  pair wore a visible border at rest, setting them apart from the rest of
  the (ghost) top bar; a toggle should only differ WHEN active. The
  dock-left/dock-right buttons move `outline → ghost`: at rest they are
  pixel-identical to the other buttons (transparent, borderless), and the
  active/pressed state (sidebar open / right panel open) wears the same
  ghost active fill as the focus/condensed/layout/calendar toggles — one
  pressed register across the bar. Verified live: at rest only the active
  toggle shows a fill; toggling the right panel moves the fill to its
  dock button. `TopBar.tsx` (two words); full suite green (1810).
- **feat(web): an open block context menu anchors to its block — the
  bullet carries the hover/active highlight while the menu floats.**
  Owner ruling 2026-10-20: the node menu renders free at the pointer, so
  the block it belongs to must name itself. Both menu entries (grip and
  prose right-click) ride the same row-level `gripMenu` state — the block
  root wears `nt-block--menu-open` while it is set, and the bullet
  dot/class-icon/list-marker mirrors the hover-active register (accent +
  scale 1.2, the same register as the editing bullet); the highlight
  survives the pointer wandering (it out-specifies the row-hover rule)
  and clears with the menu. Probe: right-click opens the anchored
  highlight, Escape clears it. Docs: BlockRow header.

- **feat(web): the thread circumvents in-path icons — an inward rounded
  corner drops the vertical into the gap left of an intermediate glyph.**
  Owner feedback 2026-10-20 ("any way we could circumvent in-path icons
  too? maybe an inward round corner"). The round-6 arm stopped BEFORE an
  icon, but an INTERMEDIATE glyph still had the next vertical passing
  under it — and hollow glyphs (the quote icon) let the line peek
  through their transparent strokes. Now the arm ends a radius early and
  an INWARD quarter-round drops the vertical into the 3px gap column
  left of the glyph: the line rides the gap to the next level and never
  crosses the icon at all. The path start moves too: a top-level glyph
  gets the line beginning just below its bottom edge instead of under
  its strokes. Dot links unchanged (the cusp hides under the opaque
  dot). Probe: the intermediate-glyph assertions now expect the turn +
  arm + inward-corner quartet and the gap-column descent (3 quadratic
  joins for an iconed chain). Docs: EditThread/BlockRow headers.

- **feat(web): the top bar rides one register — and the ad-hoc icon button
  retires app-wide.** Owner question 2026-10-20 ("the rest of the icons are
  bigger and look out of place" next to the sidebar toggle). The mismatch:
  the dock toggles are fleet catalog `Button`s (32px box, 17px icon), the
  rest of the bar rode the legacy `.nt-icon-btn` with raw 24px glyphs.
  Every top-bar control now composes from the fleet `Button` (ghost/sm/
  icon-only — the quiet idiom for momentary actions; the dock pair stays
  outline as the persistent-state toggles; the pressed focus/condensed/
  layout/calendar states ride the ghost active classes). The owner then
  asked why stop there — so the remaining `.nt-icon-btn` call sites
  converted too (NodeMenuButton's "…", ThemeToggle, the Sidebar settings
  gear, the CommentsSection send) and the class RETIRES: base/hover/active/
  disabled blocks, the mobile touch-target compound (the fleet icon-only
  overlay carries the 48dp floor at every width), the dead TopBar.css
  rules, and the comment-only NodeMenuButton.css all go. Answers the
  owner's other question too: the fleet Button IS the normalized shadcn
  catalog button (cva + Radix Slot) with the app register on top — the
  drift gate exists to keep chrome on exactly that primitive. Two stale
  test assertions follow the new contract (the ghost active class; the
  responsive-pass assertion moves to the star, the icon buttons' floor
  being the overlay). Verified live: uniform 17px icons across the bar.
  Full suite green (1810).
- **fix(web): breathing room between the page title and the tags row.**
  Owner feedback 2026-10-20 (screenshot: the "Tags:" row sat flush under
  the multi-line page title). The page-header tags row gains a
  `margin-top: var(--spacing-3)` (it had only the bottom margin) — the
  identity pills read as a separate hierarchy tier, not a continuation of
  the title line. Token-only, header-scoped (`.nt-page-header
  .nt-tags-row`); block-level tags rows untouched. Gate green
  (typecheck + 1810 tests).

- **feat(web): chevrons reveal on hover only — no resting chevron on
  editing blocks — the thread arms end before class icons, and the path
  bullets wear the accent at resting size.** Owner feedback 2026-10-20.
  **Chevrons:** the focus-within reveal (row-scoped earlier the same day)
  retired entirely, outline and prose — an editing block shows its
  chevron only when the pointer hovers the grip, like every other block;
  a collapsed block's persistent chevron (the indicator) is untouched.
  **Glyph endpoints:** the thread's horizontal arms ended mid-glyph on
  icon/list-marker bullets and read as striking through them; each arm
  now ends at the bullet's NEAR EDGE — under a dot, 3px before an icon or
  marker — and at an intermediate glyph the path jogs back to the center
  column under the opaque icon (hidden behind it) so the next vertical
  still descends from the bullet column. The v1 icon-lift animation was
  weighed and passed over: a floating chip above the row collides with
  dense rows and fires on every arrow-key caret hand-off; the endpoint
  solves the overlap with zero layout or motion cost (recorded as the
  fallback if the flourish is missed). **Path bullets:** while a block
  edits, every ancestor dot/class-icon/list-marker on the thread takes
  the accent at RESTING SIZE via `:has` — the thread reads through the
  bullets; only the editing bullet grows (the scale stays the
  engaged-row signal). Probe: own-chevron-hidden, path-dot recolor
  (path vs non-path), and glyph-endpoint assertions (arm-before-icon on
  the editing target and an intermediate link, the hidden jog) join the
  overlay suite; gate green.

- **feat(web): every button is the rounded square, and icon-only buttons
  hug their icon.** Two owner rulings 2026-10-20. **(1) Shape:** the fleet
  button radius register (`--radius-button-lg/sm`, the 2026-10-19
  corner-full) moves to `shape-medium` — the view-mode switcher's
  rounded square — so ALL button variants (the top-bar toggles
  included) wear one shape; the 2026-10-19 ruling and the drift-safe
  comment wording follow (a bare "rounded" in a comment trips the
  radius gate — hyphenated only). **(2) Icon-only padding:** the top-bar
  toggles floated a 17px icon in a 48px box (≈16px gap) — the base
  utility string's `min-h-touch` floor plus a NEVER-EMITTED width
  utility: `icon-only-visible-*` existed only in the Tailwind HEIGHT
  map, so the width silently rode `aspect-square` and blew up with the
  min-height. Fixed properly: the four `icon-only-visible-*` sizes join
  the WIDTH map (the box is now the register value — 32px at sm, 8px
  gap), and the new co-located `Button.css` pins `.btn.btn--icon-only {
  min-width/min-height: 0 }` (the utility-layer race lost by source
  order — the raised specificity is deterministic); the invisible
  min-touch overlay span still carries the 48dp hit area, the division
  it was built for. Verified live: 32×32 boxes, 17px icons, 8px gaps,
  overlay present. `variables.css`, `tailwind.config.ts`, `Button.tsx`,
  `Button.css` (new). Full suite green (1810).
- **fix(web): the close/remove hover washes go back to the rounded square
  — the view-mode switcher's shape.** Owner preference 2026-10-20: the
  corner-full circle from the last round is reverted to `shape-medium`
  (the `SelectionButton` option radius) on the eleven remove-button
  classes. Careful net-diff sweep while reverting: six PRE-EXISTING
  `shape-full` values the blanket replace had clobbered are restored
  (`.pill--add`, `::-webkit-scrollbar-thumb`, `.nt-selection-bar` (+ its
  buttons), `.nt-propdef-chip`, `.nt-property-hint`, `.nt-property-link`)
  — the net tree diff now touches only the intended radius-sm/
  shape-small→shape-medium flips. Verified live: the panel cluster nav +
  clear computed radii equal the switcher option's (6px), screenshot
  confirms the rounded-square wash. CSS-only; drift gate green.
- **feat(web): the outliner level grid — the indent rail column derives
  from the bullet by construction, no hand-guessed margins.** Owner
  question 2026-10-20 ("why hand-guess the margin pixels — can't a grid /
  subgrid system be implemented"). Every `.nt-block` is now one grid,
  `grid-template-columns: var(--nt-row-gutter) var(--nt-grip-half)
  var(--nt-grip-half) minmax(0, 1fr)` — the two half-tracks split AT the
  bullet centerline (the grip spans them, centered by construction), and
  the children container spans from that centerline track, so the rail
  rides the bullet column with zero margin arithmetic. The constants live
  once on `.nt-block`: `--nt-row-gutter` (14px) feeds both the template
  and the row's padding; `--nt-grip-half` (9px) feeds the template and
  the grip width — a grip resize propagates to the rails and the thread
  column automatically. Consequences: the container's `border-left`
  retires (the rail draws the only line everywhere the border showed);
  the rail becomes a 10px centered hit area drawing a gradient-centered
  2px hairline (resting outline-variant / hover accent) — exact column,
  full click target; full-width siblings ride a `:not(.nt-block-children)`
  sweep; prose flattens with `display: block`. **Paint order completed:**
  the rail is a POSITIONED button — z-auto left it striking over the
  thread by DOM order — so the overlay now carries z-index 1 and the
  bullets/chevron z-index 2 (thread over the rails, under the dots).
  Probes: the thread-probe's alignment/z assertions update to the new
  contract (rail-button center vs bullet ≤1.2px, z 1/2). Subgrid for the
  row internals not taken — the block-level grid already removes every
  hand-derived constant; noted as the escalation path if the row chrome
  ever needs track alignment.

- **feat(web): the indent rails ride the parent bullet's center column —
  the 2026-10-15 alignment math was 2px off — and the edit thread paints
  above the rails, under the dots.** Owner feedback 2026-10-20, revealed by
  the measured overlay. **The alignment:** the resting hairline is the 1px
  container border + the rail's 1px gradient — a 2px line whose center sat
  at bullet+2.5px, because the 2026-10-15 fix assumed the 22px bullet
  started at the 18px grip's left edge (center at 14+11=25); the bullet is
  CENTERED in the grip (justify-center), overflowing 2px a side, so its
  true center is 14+9=23. `.nt-block-children` margin-left 24 → 22 lands
  the composite line exactly on the column (comment math corrected).
  **The paint order:** the overlay's z-index −1 (behind the rows, from the
  third pass) let the resting rails strike OVER the thread where the
  columns coincide; the overlay is now positioned-z-auto (above the static
  tree chrome) and the bullets + the hover chevron carry z-index: 1 — the
  thread passes over the rails but under the dots and glyphs. The
  `isolation: isolate` host trick retires with the −1. Probe: rail-vs-
  bullet offset (≤1.2px) + z-index contract assertions join the overlay
  suite. Docs: the thread comments (app.css, EditThread.tsx, BlockRow.tsx)
  + `docs/ux.md`.
- **feat(web): three owner refinements on the property-cell chrome.**
  Owner 2026-10-20: **(1) the Classed nodes table shows no remove-from-class
  button** — the table `trailingAction` consumption from the gap-fix round
  is reverted (unassign stays outline-mode quick-action plus the cards
  classes-row ×; the empty-cell half of that round stands). **(2) every
  close/remove button's hover wash is corner-full** — the custom × buttons
  predated the fleet's 2026-10-19 corner-full ruling and washed as rounded
  SQUARES beside the circle-washing fleet buttons; eleven button classes
  (`pill__right-button` fleet + metadata variants, the panel nav/clear,
  the class-member/propdef/asset/dateslot/table-panel/filter/whiteboard
  removes) now carry `border-radius: var(--shape-full)` — verified
  computed 9999px == the fleet button's. **(3) the single-value node
  property value is PLAIN TEXT, not a NodePill** — the
  `PropertySelectCell` content names the node like a select option or a
  date value (no chip, icon, or color tint); the pickers test's
  pill assertion follows the new contract. (One stale-CSS build-cache
  round on this host needed a `--no-cache` rebuild — bundle diff-verified.)
- **fix(web): the two pre-existing gaps the navigate-button sweep exposed.**
  Owner 2026-10-20, "resolve them too": **(1) the empty date cell** — an
  unset datetime cell's trigger rendered EMPTY and collapsed to zero
  height (near-unclickable); the editable cell now shows the muted
  schema-name placeholder (the panel "Select" / NodeCell precedent — an
  honest line box AND an affordance), and the READ-ONLY empty node/date
  cells show the same placeholder instead of a blank. **(2) the
  class-member unassign was outline-only** — `trailingAction` rendered in
  list mode alone, so table/cards mode had no unassign path (cards
  already unassign through the card's classes row). TableView now honors
  `trailingAction`: the action rides the name cell's hover cluster,
  pinned beside the Open button (the × keeps its `mdi-close` from the
  icon sweep), the hover lane widening to host both via `:has()`. The
  switcher half of the old note was a probe artifact — the options carry
  `aria-label`s (Outline/Cards/Table) and were re-verified. Verified live
  (8 checks): placeholder + height + popup on click; the × revealed
  beside the Open button and unassigning the member end-to-end.
  `TableView.tsx/.css`. (One full-suite flake observed and re-isolated
  green, the known load pattern.)
- **feat(web): the edit thread becomes a separate measured overlay — one
  SVG polyline with rounded turns at each level change — and the ancestor
  chevrons stop pinning open during edit.** Owner correction 2026-10-20,
  third pass. The two `:has()` takes (rail accents + grip pseudo arms)
  highlighted the tree's own vertical bar — full-height subtree columns —
  where the reference look is one continuous line anchored AT the bullets,
  turning right on each level change with rounded corners, a shape the
  tree chrome cannot draw. **The overlay** (`EditThread.tsx`): BlockRow
  reports its edit state through a new `EditThreadContext` (guarded clear —
  a caret hand-off can't tear the new thread down); the select surface
  hosts the SVG, resolves the ancestor chain via the client, measures the
  path bullets, and draws `M … L … Q …` (quadratic turns, RADIUS 5) from
  the top-level bullet to the editing dot — recomputed on edit changes,
  store notifications, host resizes, and any scroll, rAF-throttled. It
  paints BEHIND the rows (the host isolates its stacking context,
  `z-index: −1`) so the bullets sit on the line, and is pointer-events:
  none — the rail's fold click still fires beneath it (probe-asserted).
  No thread for a top-level edit (no ancestors), in prose (bullets hidden,
  nothing to measure), or in cards. The rail-accent/elbow/stud CSS and
  the chevron's thread z-index retire. **The chevrons:** the focus-within
  reveal matched every ancestor of the focused editor (all contain the
  focus), pinning the chain's chevrons open during edit — row-scoped now
  (`.nt-block-row:focus-within`, prose variant too). The round-2
  direct-row accent fix stays. Docs: `BlockRow.tsx` header + `docs/ux.md`.
  Verification: `thread-probe.mjs` rewritten for the overlay (path turns,
  start/end at the path bullets, rails resting, pointer-events, click-
  through fold, caret-follow, chevron + subtree-accent regressions);
  gate green.
- **feat(web): every close/remove × in the app is an mdi-close icon, not a
  plain-text glyph.** Owner 2026-10-20: the text × read differently from
  the icon buttons beside it. 21 sites swapped: the property pills
  (NodePills ×2, AliasedNodeRow, ObjectPropertyPill, TagsRow,
  PropertySettingsModal's option rows, DatetimePropertyRow's multi pill —
  all `pill__right-button`, size 0.6), the small remove buttons
  (PropertySelectCell's cluster ×, the class-member remove, the property-
  definition remove, the template unbind, the asset-item remove, the
  date-slot clear, the table sort-panel remove, the filter-builder
  multipick remove, the whiteboard card delete — size 0.7), the sidebar
  card close (0.8, its arrow neighbor's size), and the four hand-rolled
  modal close buttons (PropertyView, PropertySettingsModal,
  PropertyHistoryModal, PropertyConvertModal) which now ride the fleet
  `Button` with `mdi mdi-close` — the exact idiom the fleet `Modal`'s own
  close already used. `Icon` imports added where missing (DateSlotControl,
  DatetimePropertyRow, ObjectPropertyPill, WhiteboardCanvas). Verified
  live: the panel cluster ×, and a fleet-Button modal close both resolve
  `/mdi-sprite.svg#mdi-close`. (Unrelated pre-existing gap the sweep
  exposed: `trailingAction` — the class-member × — renders in outline
  mode only, and the section's switcher labels don't expose it to role
  queries; left as found.) Typecheck + full suite green (1810).
- **fix(web): the single-value cell's × clear rides the revealed chrome
  cluster — and stops opening the picker on its way out.** Owner
  2026-10-20: the × moved INSIDE the trigger, adjacent to the → navigate
  button and the dropdown chevron (one cluster: value → → ⌄ ×, 12px
  steps), instead of detached at the cell's far right. The move also
  fixes a live bug the relocation exposed: the ×'s click bubbled to the
  trigger, so clearing a value simultaneously opened the picker —
  `stopPropagation` now, the nav button's precedent. Verified live:
  cluster order/adjacency, the click empties the cell without leaking
  the picker. `PropertySelectCell.tsx`.
- **feat(web): the page-header action row's pills carry per-action icons
  instead of the generic "+".** Owner 2026-10-20. The Capacities action row
  ("Add icon" / "Add description" / "Add aliases") rendered the same `+`
  glyph for every action; each now gets a specific leading icon — a shape-plus
  for the icon+color picker entry, a short-text line for the description
  editor, a link-plus for the alias picker (all verified against the
  `mdi-sprite.svg` sheet). The `AddPill` primitive grows an optional `icon`
  prop (defaults to `+`, so the metadata-panel pills are untouched).
  `AddPill.tsx` + `PageChrome.tsx` only; `apps/web` typecheck + 1810 tests
  green.
- **feat(web): the single-value property cell's chrome is hover-revealed —
  navigate button, dropdown chevron, and × clear.** Owner 2026-10-20,
  the panel half of the pinned-button idiom: at rest the
  `PropertySelectCell` reads as pure value text (the pill label, nothing
  else); hovering the cell (or focusing in) expands the → navigate
  button, the dropdown chevron, and the × clear out of the collapsed
  state — the pill × `max-width` idiom, `motion-duration-short` — and the
  value content flexes out of their way. The always-visible round
  shipped minutes earlier and read as chrome noise. Supersedes the
  "visible at rest" note in the navigate-button entry below.
  `MetadataSection.css` only.
- **feat(web): the edit thread passes THROUGH the path bullets (the stud),
  and the editing bullet highlight stops spilling to the subtree.** Owner
  feedback 2026-10-20, same day as the thread's first pass. **The stud:**
  the first pass touched each path bullet only from the left — the owner's
  reference look has the thread anchored at the dots, so every ancestor now
  also grows a short vertical stud (`::before` on the grip — the bullet's
  own pseudos stay retired) from just below its dot down into its children
  rail below (a half line-height + the row padding, `calc(0.5lh + 6px)`);
  an intermediate path link wears both the elbow (from the rail into its
  dot) and the stud (down from its dot) — the ├ junction of the mock — the
  top block grows only the stud, the editing block only the elbow. The stud
  is scoped to ancestors that render a real `.nt-block-children` rail (a
  table container's grid gets none) and both arms are killed under
  `.nt-prose` — the grip still renders in prose, so the round-1 claim
  "prose finds nothing" was wrong for the elbow: the flattened layout drew
  orphan stubs (latent from the first pass, fixed here). **The subtree
  spill:** the editing bullet/marker/icon highlight (resting-calm chrome,
  2026-10-06) was a DESCENDANT selector — entering edit on a parent lit
  every bullet in its subtree (accent + scale), which read as the children
  being active; the three rules are direct-row scoped now
  (`.nt-block--editing > .nt-block-row …`). Docs: `BlockRow.tsx` header +
  `docs/ux.md`. Verification: `thread-probe.mjs` grows stud assertions
  (ancestors only, 2px geometry, pointer-events) and a subtree-accent
  regression step; gate green.
- **feat(web): the navigate button extends to single-value node/date
  property cells — table view and the properties panel.** Owner
  2026-10-20: the click/value distinction the pinned Open button
  established for the name cell now governs the single-value node-typed
  and datetime property cells too. **Table view**: the value click owns
  the picker (the NodeSelector / the canonical date-popup, unless
  read-only), and the retired inline open-arrow's two navigations — the
  link target and the day-page jump — move onto the same pinned
  hover-revealed → button (shift+click peeks the target/day in the
  sidebar), with the cell's lane yielded on hover via the `:has()` host
  selector (no class plumbing — the td opts in when the cell renders a
  button); read-only property cells (query results) gain navigation they
  never had. **Properties panel**: `PropertySelectCell` grows an
  `onNavigate` → button beside the chevron (revealed on cell hover /
  focus-in like the table's — see the follow-up below); `DatetimePropertyRow` gains the `onOpenPage`
  plumbing (GroupedPropertyRow passes it) and a date ref jumps to its day
  page through the ensured chain, anything else opens as a node. The
  read-only projections stay click-to-navigate pills (deliberate, noted
  for the owner). The `↗` `OpenArrow` retires with its CSS.
  `TableView.tsx/.css`, `PropertySelectCell.tsx`, `ObjectPropertyRow.tsx`,
  `DatetimePropertyRow.tsx`, `GroupedPropertyRow.tsx`,
  `MetadataSection.css`. Verified live (11 checks): table node/date cells
  reveal on hover, value clicks open the pickers, buttons navigate to the
  target and the deterministic day page; panel buttons navigate from both
  rows. Probe-found pre-existing quirk noted: an EMPTY date cell's trigger
  collapses to zero height (clickable only via its line box) — untouched,
  a panel/cell-sizing follow-up.
- **feat(web): table name cells wrap long titles over multiple lines — and
  the Open button is a hover reveal whose lane the text yields.** Owner
  2026-10-20, three refinements on the pinned Open button: **(1)** the name
  label drops the single-line ellipsis and WRAPS (`overflow-wrap:
  break-word`) — the row grows with the text, and the cell's intrinsic
  width collapses to its longest word, which also dissolves the
  narrow-column clipping the long titles used to cause. **(2)** the cell
  reads the FULL title — `nameCellText` switches from the 80-char
  dense-chrome budget to the links' uncapped `fullTitleOf` (chip
  resolution kept; date nodes keep the settings-formatted branch) — the
  CSV projection and the sort key ride the same text. **(3)** the button
  hides at rest and reveals on cell hover / focus-in / button focus (the
  class-pill × idiom), and the reveal is IN the layout, not over it: the
  cell's right padding grows `spacing-3 → button-icon-only-visible-sm +
  spacing-2` on engagement (animated, `motion-duration-short`) so the
  wrapping text moves out of the button's way instead of running under
  it. `TableView.css` + `TableView.tsx`. Verified live (rest: hidden
  button, full-width text; hover: revealed pinned button, text re-wrapped
  into the narrower lane; click opens).
- **feat(web): the edit thread — in edit mode the ancestor chain from the
  top-level block to the editing block wears the accent thread.** Owner
  2026-10-20. While a block is in edit mode, every ancestor's indent rail
  takes the hover-weight accent hairline (the same 2px primary gradient the
  rail's hover/focus wears — the thread reads as a persistent hover along
  the path), and each link on the path grows a horizontal elbow from the
  rail column into its bullet, ending at the editing block's own bullet
  (which already carries the engaged-row accent). Purely structural CSS:
  `:has()` matches the true ancestor chain off `.nt-block--editing`, so no
  JS state threads the BlockRow recursion and every surface composes. The
  elbow rides `::after` on the GRIP (the bullet's own ::after stays retired
  — the condensed-layer register bans the old ring hook; the `top` carries
  a `-2px` compensation for the bullet's optical shift), is `pointer-events:
  none` so it never eats the rail's fold clicks nor widens the grip's drag
  target, and the hover chevron gains `z-index: 1` so its glyph paints
  above the crossing hairline. Outline-only by construction — prose hides
  the bullets and renders no rail, and table cells live outside
  `.nt-block-children`, so the selectors find nothing there; the thread
  ends AT the editing block, its own subtree stays on the resting hairline,
  and it follows the caret (editing a sibling tears the old chain down).
  Docs: `BlockRow.tsx` header + `docs/ux.md` the editor section.
  Verification: `scripts/screenshots/thread-probe.mjs` (chain rails accent,
  elbows 31×2px into the path bullets only, click-through to the rail,
  caret-follow) against the live stack.
- **fix(web): the pinned Open button's live-probe round — four findings from
  driving the real stack.** The scratch playwright probe (test workspace,
  click/hit-test/geometry instrumentation) verified the shipped button and
  fixed what it caught, all in `TableView.tsx` / `TableView.css` /
  `lassedNodesSection.tsx`: **(1) CSS specificity** — the fleet Button's
  icon-only `relative` utility beat the bare `.nt-table-open-btn` position
  rule (same specificity, later source), so the selector is now td-qualified.
  **(2) The name cell blew out on long titles** — a percentage max-width on
  an inline-flex inside a table cell resolves cyclically and is ignored, so a
  long title grew the cell past the table, the label clipped without an
  ellipsis, and the pinned button stranded under the context column
  (`elementFromPoint` proof); `.nt-table-name-btn` is now block-level flex
  (`width/max-width: 100%; min-width: 0`) and the label ellipsizes inside its
  lane. **(3) The peek fallback** — the class page's Classed nodes section
  never wired `onNodeShiftClick`, so the button's shift+click (and the name
  cell's) silently no-op'd there; TableView now falls back to the enclosing
  OutlinerContext's `openInSidebar` (CardsView's precedent), covering query
  blocks too. **(4) The first-click no-op** — the section's onNodeClick
  re-reads the node through the worker-client's cachedRead, which serves
  `undefined` on a key's first-ever read (the value lands a macrotask
  later); the click was dropped. A miss now opens the id directly (a
  rendered row exists — the miss is a read-cache artifact, not a missing
  node). Verified end-to-end on the running stack: pinned at the cell's
  right edge on short and ellipsized rows, plain click opens (history push
  on the row's own id), shift+click raises the right rail with the peeked
  card. Pre-existing, left for a future slice: the class page's narrow
  content column still clips a long-title table at its boundary (the old
  in-flow arrow died there too).
- **docs(deploy): the source/stack split lands in the runbooks — the
  compose-from-the-checkout trap is recorded.** The 2026-10-19 split (live
  stack = a thin Komodo-managed folder outside the checkout; the repo's
  compose is the fresh-deployment template) reached the docs after an
  incident: a raw `docker compose up` from the checkout hijacked the live
  containers (both files share the project name `notees`), recreated them
  against the checkout's empty config path, and the sync server crash-looped
  on an empty data dir until the stack was rebuilt and recreated from the
  live stack folder (live data untouched; `VERIFY-PASS` after). Deployment
  law now: build/up from the live stack folder on split hosts, never the
  checkout. `docs/developers/deployment.md` (split paragraph + the retired
  "no build: section by design" line corrected), the tracked
  `compose.yaml` header, and the deploy lines of `AGENTS.md`.
- **feat(web): the table's Open button — the name cell's inline open-arrow
  retires in favor of a pinned navigate button.** Owner 2026-10-20: the
  hover-revealed `↗` that trailed the name text is replaced by a
  ghost/sm/`mdi-arrow-right` button — the same register as the workspace
  card's "Open workspace" action — absolutely pinned to the right edge of
  the name cell regardless of the text content (the td anchors it and
  reserves a right padding lane of `button-icon-only-visible-sm + spacing`
  so the label ellipsizes clear of it; centered via `top/bottom + margin-
  block` so the press-scale utility keeps the transform). Click opens the
  node; **shift+click peeks it in the sidebar card** (`onNodeShiftClick`).
  The quiet `↗` open-arrow survives only where it navigates to a *different*
  node — the date cell's day-page jump and the node-typed cell's link
  target. `TableView.tsx` (`OpenButton`, `NameCell`) + `TableView.css`;
  the web suite stays green (one unrelated apps/server snapshot test
  flaked at 5s under full-suite load, passes in isolation).

## 2026-10-19

- **refactor(web): the full tree realignment — the layer-first tree becomes the fleet's feature-first canonical tree, one cohesion cluster at a time.** The owner ruling (full alignment, no shortcuts) supersedes the register's incremental move-on-touch entry: `src/ui/components/` (~135 entries) and `src/ui/views/` are retired in eleven commits — **collection** (views + graph engine/renderer + query/filter builder + hubs → `features/collection/`), **metadata** (property rows/modals, class pills, alias surfaces, node pills), **classview + templates** (class detail, system-class families, the template family), **calendar** (view/journals/day pages/grids/top-bar popup) **+ date-pickers**, **shared pickers + icon-picker**, **node-menu + page-sections + block-editor** (context/link/sidebar-item menus, hover preview, breadcrumbs; the activity/comments/created/version/system/node-view sections + page banner/card/footer; the floating editor, selection bar, quick-create), **workspaces**, **sharing/trash/command-palette**, **settings/export/modals/find-in-page**, **the primitive layer** (`src/components/ui/fleet/` joins the normalized catalog — a subdir because the kebab catalog files and the PascalCase fleet wrappers collide by case in one flat dir; the drift gate's registered-mapping catalog check skips the wrapper layer, and its JS-scoped owner walk covers shell + features + fleet), and **the shell** (Sidebar/TopBar join `ui/app/`). `src/ui/` is the shell + composition root only; every feature carries an `index.ts` barrel. Imports repointed across src/test/e2e (including `vi.mock` paths and the source-level contract tests' CSS paths); the repo-root remap script's import follows. Register: the tree entry is superseded as DONE with the clustering map.
- **refactor(web): the two scheduled composite migrations — ContextMenu
  rebuilds on the Radix context-menu/sub composition; Dropdown on the
  catalog combobox (popover + cmdk command).** The register's scheduled
  slice, executed same day. **ContextMenu** (~13 call sites) composes
  `ContextMenuPrimitive` (Root/Content/Item/Sub/SubContent/SubTrigger)
  with a hidden Trigger driven by a synthetic contextmenu event as the
  virtual anchor (position prop or anchorEl rect — the app drives menus
  open itself), the overlay stack stays the single Escape authority
  (Radix's own Escape disabled, the Modal-wrapper precedent; Escape
  closes the active submenu first), the enter-only hover seam + the
  pointer-fine gate stay synchronous on mouseEnter (Radix's 100ms
  pointermove hover doesn't meet the owner ruling), the flyout SubContent
  rides Radix's popper (flush edge, viewport flip) with focus-outside
  dismissal prevented (a spawned confirmation modal must not collapse
  the menu the row lives in), and sub-item selects fire onClick + the
  onClose notification without self-unmounting (the menu is
  caller-controlled). `@radix-ui/react-context-menu` joins the deps.
  **Dropdown** (~20 call sites) composes the catalog `command` (cmdk)
  inside a Radix popover: the popper owns portal/flip positioning (the
  old imperative viewport-fit retires), the listbox/option ARIA + the
  arrow-key walk + label-only filtering (custom renderers can't pollute
  the match) are cmdk's, and the fleet register (menu surface, option
  rows, group overlines, the boxed SelectTrigger, multi-select toggles)
  is unchanged — options graduate from `<button>` rows to `role=option`
  (the a11y upgrade the bridge prescribes; the drift gate's JS-scoped
  list gains `--radix-popover-trigger-width`, Radix's trigger-width
  var). Test suites updated where they drove the old mechanics (role
  queries, pointer-down dismissal, macrotask wait for Radix's document
  listener, jsdom `scrollIntoView` stub in the shared setup). The
  capture pass caught one real-browser bug the jsdom suites can't see:
  the menu stylesheet's `position: fixed`/`absolute` rules broke
  floating-ui's align math (alignRight menus anchored start, clipped at
  the viewport edge) — positioning now rides the Radix popper wrapper
  exclusively, and the source-level flyout assertion moved with it.
- **refactor(web): the full-alignment leaf sweep — 12 catalog-covered
  leaves become thin wrappers; Dropdown/ContextMenu documented as the
  scheduled remainder.** The owner ruling (2026-10-19: full alignment,
  no compat shims) continues: Badge, Separator, Spinner (a normalized
  registry spinner added via `npx shadcn add`), LoadingSkeleton,
  Checkbox, Radio, Input, SearchField, BooleanToggle, Slider (added via
  the CLI), CodeTextarea, and SelectTrigger all move onto the
  normalized catalog — fleet registers re-expressed as cva/utilities on
  token-mapped Tailwind keys (the config grew: icon/sep/skeleton/
  shimmer/spinner-arc/slider/inset-ring/error-ring keys + the
  shape-xs/shape-sm radii, registered in the drift gate's strip list),
  full prop APIs and marker classes preserved, ~1,900 lines of leaf CSS
  retired (Spinner/SearchField keep only the reduced-motion cue, the
  clear-button hit floor, and the wrapper focus ring — the bits
  utilities can't express). Documented interaction deltas per the
  bridge contract: Checkbox/Radio/BooleanToggle onChange now receives
  the boolean state (the change-event shape retired with the native
  inputs; TableView's tri-state header checkbox moves from an
  imperative ref hack to the `indeterminate` prop; the export-layout
  radio group recomposes as one RadioGroup). **Dropdown and ContextMenu
  stay custom into the tree-realignment stage** — composite widgets
  (multi-select+search dropdown; the two-form submenu context menu)
  that the catalog's Radix select cannot express drop-in; documented in
  `.agents/design-overrides.md` as a scheduled migration, not drift.
  Also: the compat shims are gone — `core/workspace-client.ts` (268
  importing files repointed at the folder barrel) and the
  `MetadataSection.tsx` barrel (whose orphaned side-effect import had
  left the panel stylesheet unloaded since the feature-folder
  relocation; the CSS now lives in `features/metadata/`, the drift
  gate's CSS half covers `src/features`).
  **Verification:** `npx tsc --noEmit` clean after every commit; the
  drift gate 12/12 throughout; the per-group affected suites green
  (Badge/Separator/Spinner/Skeleton 59; Checkbox/Radio 132;
  Input/SearchField 87; BooleanToggle 76; Slider 29; CodeTextarea 16;
  SelectTrigger 43); the shim removals 1,413 + 28.

- **refactor(web): delete the `MetadataSection.tsx` compat barrel — the
  metadata feature folder is the only surface.** The shim's seven importers
  were already re-pointed when the panel moved to `features/metadata/`
  (218f7ec0); what the shim still carried was the panel's stylesheet as a
  side-effect import — and with zero importers left, `MetadataSection.css`
  (742 lines) had not been loading at all since the relocation. The
  stylesheet moves to `features/metadata/MetadataSection.css` (co-located,
  fleet-canonical) and loads through the feature barrel's side-effect
  import; the shim and the old `ui/components/` copy are deleted. The
  drift gate's CSS half now walks `src/features` alongside `src/ui` so
  feature-folder stylesheets stay gated (all 12 checks green).
  **Verification:** `npx tsc --noEmit` clean; the drift gate 12/12; the
  properties-panel + recurrence suites (28 tests) green.

- **refactor(core): the `workspace-client.ts` compat shim is removed — the
  folder module is the only import surface.** The thin file
  `src/core/workspace-client.ts` (re-exporting `workspace-client/index.ts`)
  is deleted; all 268 importing files (278 specifiers — 149 `@/…`, 128 test
  `../src/…`, 1 relative — plus 3 `core/` siblings importing
  `./workspace-client.js`) now import the folder barrel directly
  (`…/workspace-client/index.js` — TypeScript bundler resolution does not
  map `dir.js` → `dir/index.ts`, so the explicit index segment is
  load-bearing). No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the 120 suites touching the
  module (1,413 tests) green.

- **refactor(web): extract the value-column controls out of
  FilterBlockBuilder — `components/filterBlockValueControls.tsx` (Stage D,
  extraction 2 of 2).** The typed per-family pickers move verbatim to
  their own module: the single/multi class picks, the family switch
  (BlockValue) over node targets, containers, dates with the
  relative-period picker, the property family's schema select + typed
  value control, the node single/multi picks, and the property operator
  label table (its only consumer went with it). FilterBlockBuilder keeps
  only the builder composition — the root, GroupBlock, NotBlock, and the
  condition row (1,255 → 601 lines; the monolith pair is now 601 + 872 +
  676 across three modules). No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the filter/query/search
  suites (filter-builder, filter-layer, filter-query, query-block,
  query-builder-guard, search-page, search-palette, child-query — 115
  tests) green.

- **refactor(web): extract the condition model out of FilterBlockBuilder —
  `components/filterBlockModel.ts` (Stage D, extraction 1 of 2).** The
  v1/Odoo register ([type][operator][value][mode]) as pure functions
  over the draft query AST moves verbatim to its own React-free module:
  `blockView`, `familyOf`, the operator-column options per family
  (adapting to the selected property schema), `operatorOf` (+ its
  negation), the operator-application morphs with carried ids/values/
  timestamps (`applyClassOperator` … `applyOperator`), and the family
  option/label tables. FilterBlockBuilder keeps the builder composition
  (the root, GroupBlock, NotBlock, BlockRow) and imports the model back
  (2,099 → 1,255 lines). No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the filter/query suites
  (78 tests) green.

- **refactor(web): drop the dead duplicate switch cases in
  FilterBlockBuilder.** Three `case` labels could never evaluate — each
  duplicated an earlier label in the same switch, so the earlier branch
  already won at runtime and the removal changes no behavior: (1)
  `applyOperator`'s `case "descendantOfQuery"` (the live morph is the
  earlier `descendantOf/…/descendantOfQuery/descendantSet` branch's
  `applyPickSetOperator` — the dead twin would have kept the query type
  behind a not-wrap); (2) the value column's `case "descendantOfAny"`
  (the live render is the earlier CHILD PATH branch's "Targets"
  multi-pick — the dead twin relabeled it "Parents"); (3) the value
  column's `case "descendantOfQuery"` (the live render is the earlier
  "matching" word — identical body). The `linkedToQuery` clauses in
  both switches are their first occurrence and stay. Clears the three
  pre-existing esbuild duplicate-case warnings.
  **Verification:** esbuild transform warnings 3 → 0; `npx tsc
  --noEmit` clean; the filter/query suites (filter-builder,
  filter-layer, filter-query, query-block, query-builder-guard — 78
  tests) green.

- **refactor(web): extract the viewport anchors out of BlockTextEditor —
  `features/block-editor/anchors.ts` (Stage D, extraction 3 of 3).**
  `selectionAnchor` (selection-end center, the verb popover) and
  `caretLineAnchor` (below the caret line with the caret top for
  flip/clamp, the slash and template popups) move verbatim to their own
  module — the DOM rect reads the popups anchor from at open time
  (BlockTextEditor 2,223 → 2,205 lines). The ~1,950-line component body
  itself stays one file: its ~25 states and ~40 handlers share the
  draft ref and the span refs in one closure — splitting it into hooks
  would be a rewrite (behavior risk), not a modularization, so Stage D
  takes the module-level concerns out and leaves the component intact.
  No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the four editor suites
  (58 tests) green.

- **refactor(web): extract the capture model out of BlockTextEditor —
  `features/block-editor/captureModel.ts` (Stage D, extraction 2 of 3).**
  The trigger-gesture state machine moves verbatim to its own module:
  the capture kinds and trigger chars, the slash popup's candidate
  contract, the `CaptureState` machine (trigger offset, query,
  selection-replacement range, fixed label, hint, viewport anchor), the
  mention token shape, the node-link context-menu state, the quote
  grammar's admitted child types, and the helpers (picker-hint
  truncation, the /query starter AST, strict local YYYY-MM-DD). Pure
  data and functions — the module carries no React. BlockTextEditor
  imports the names back (2,328 → 2,223 lines). No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the four editor suites
  (58 tests) green.

- **refactor(web): extract the code-block surface out of BlockTextEditor —
  `features/block-editor/codeBlock.tsx` (Stage D, extraction 1 of 3).**
  `codeTokenOf` (the single-code_block-token probe) and `CodeBlockEditor`
  (the debounced CodeTextarea surface, blur/Esc flush, clean-draft
  remote re-sync) move verbatim to their own module; BlockTextEditor
  imports them back. The component loses 122 lines (2,449 → 2,328);
  the only import churn is the CodeTextarea import following the
  extraction. No behavior change.
  **Verification:** `npx tsc --noEmit` clean; code-block-editing +
  outliner-editor (30 tests) green.

- **refactor(web): the block editor relocates to `src/features/block-editor/`
  — Stage D monolith split, move slice.** `ui/BlockTextEditor.tsx` (2,449
  lines, the last Stage D monolith) moves verbatim to the second
  `src/features/` folder; a barrel carries `BlockTextEditor`,
  `SAVE_DEBOUNCE_MS`, and the `EditorCaret` type, and the two src
  importers (BlockRow, WhiteboardCanvas) plus three test suites
  re-point through it. The component is a feature surface (React
  composition over popups, pickers, the toolbar, and the outliner
  contract), not pure editor logic, so it does not join the React-free
  `src/editor/` primitives (caret/selection/prose/marks/capture/
  edit-apply) it builds on. No behavior change.
  **Verification:** `npx tsc --noEmit` clean; the editor suites
  (outliner-editor, table-nodes, code-block-editing, title-editor —
  58 tests) green.

- **refactor(web): the metadata panel relocates to `src/features/metadata/`
  — the tree realignment's first feature folder.** The
  `ui/components/metadata/` folder module (the ui/components stage of the
  modularization pipeline) moves verbatim to `features/metadata/`, the
  first folder under `src/features/` in the canonical tree (lib/,
  components/ui/, features/&lt;name&gt;/); internal relative imports are
  re-pointed (`../` → `../../ui/components/`, `../../` → `../../ui/`).
  A barrel (`index.ts`) carries the public surface; the seven importers
  (PageView, PageChrome, BlockRow, CardsView + three test suites) now
  import through it, and `ui/components/MetadataSection.tsx` survives as
  a thin compatibility barrel re-exporting from the feature (its CSS
  side-effect import unchanged). No behavior change — the nt-* class
  hooks are untouched.
  **Verification:** `npx tsc --noEmit` clean; the metadata/property
  suites green (block-metadata, class-bindings, class-create-modal,
  class-view, node-aliases, properties-panel, property-icon-button,
  property-owner-rulings, property-view, system-class-deploy-bindings,
  text-property-blocks, recurrence — 120 tests).

- **refactor(core): the workspace-client's inheritance chain becomes
  composition — pure structural conversion, no behavior change.** The
  folder-module split's intermediate checkpoint (a
  `WorkspaceClientBase → … → WorkspaceClientDates` class chain with
  `protected` members shared across domains) is dissolved into the
  composition end state in two slices: (1) the chain's infrastructure
  (store/options, envelope + outbox seam, engine lifecycle, notify funnel,
  read caches, undo journal) moves into a shared `ClientContext`
  (`client-context.ts`), constructed first and owned by the base behind
  thin delegating accessors; (2) every `client-*.ts` domain becomes a
  standalone class taking the context (plus its sibling domains) with no
  `extends`, the `protected` members landing either in the context or as
  private domain helpers, and `WorkspaceClient` owning the context + nine
  domain instances and delegating its entire public surface to them
  (109 one-line delegations grouped by domain — class name, method
  surface, factories, and the public `store` field unchanged, so the
  ~110 importers and the `AppModals` `instanceof` check are untouched).
  The shared alias helpers (`aliasPageIdsOf`/`nameEquivalentsOf`) stay on
  the reads-props domain as public methods the references domain calls
  through its sibling reference; the undo capture source becomes a
  standalone factory the context constructor takes, preserving the exact
  journal wiring order.
  **Verification:** `npx tsc --noEmit` clean after each commit; the
  affected suites (workspace-client, realtime, worker-core, undo-journal,
  sync-status-guard, sync-details-modal, clone-engine,
  system-class-deploy-bindings, dates, block-backlinks) all green after
  each (127 tests); the public method surface mechanically diffed against
  the chain (109 names identical).

- **refactor(web): `MetadataSection.tsx` (3,156 lines) becomes the
  `components/metadata/` folder module — pure moves, no behavior change.**
  The metadata/properties panel is user-visible chrome, so the slice is
  deliberately move-only: no visual or behavior change, no token drift
  (the panel's CSS is untouched and still loads through the shim). One
  extraction per commit, `tsc --noEmit` clean for the slice after each:
  (1) the shared helpers (`AnyClient`, the minimal-editor text
  round-trip, node-ref/asset/class resolution, the contrast pick) →
  `shared.ts`, the datetime slot decomposition + ISO readers →
  `datetimeValue.ts`; (2) the node-typed and asset rows →
  `PropertySelectCell`, `ObjectPropertyRow` (its per-value pill split
  into `ObjectPropertyPill` — the only sub-400-line seam), `QualifierRange`,
  `AssetPropertyRow` + `AssetItemRow`; (3) the typed rows →
  `DatetimePropertyRow`, `SelectPropertyRow`, `BooleanPropertyRow`;
  (4) the identity/add rows → `ClassesRow`, `TagsRow`, `AliasesRow`,
  `AddPropertyRow`; (5) the rows model (`propertyGroupsOf`,
  `propertiesCountOf`, `metadataRowCount`) → `propertyGroups.ts`, the
  per-type row switch → `GroupedPropertyRow`, the scalar/carrier value
  cell → `ScalarPropertyValue`; (6) `PropertiesTable` +
  `PropertySettingsModal`; (7) `PropertiesSection` + `PropertiesSidebar`,
  and `MetadataSection.tsx` becomes the compatibility barrel — the
  historical import surface (`components/MetadataSection`) keeps working
  through the shim (same pattern as `core/workspace-client`), the public
  exports (`ClassesRow`, `TagsRow`, `AliasesRow`, `metadataRowCount`,
  `PropertiesTable`, `PropertiesSection`, `PropertiesSidebar`) unchanged.
  Verified: `tsc --noEmit` clean; the metadata-adjacent suites green
  (properties panel, aliases, recurrence, text-property blocks, asset
  attachments, block metadata — 60+ tests across the per-commit runs);
  the full 1,813-test suite green at the final gate; the captured
  metadata panel renders identically at 1440 and 390 (sections, badges,
  register styling).
- **refactor(core): `workspace-client.ts` (3,836 lines) becomes the
  `workspace-client/` folder module — pure moves, no behavior change.**
  The in-process client was the strongest remaining modularization
  candidate (pure logic, no visual risk, two+ reasons to change).
  One extraction per commit, `tsc --noEmit` clean after each: (1) the file
  relocates behind a compat barrel — the historical import surface
  `@/core/workspace-client.js` keeps working through the thin shim
  `core/workspace-client.ts`, which re-exports the folder's `index.ts`
  (TypeScript's bundler resolution does NOT map `dir.js` → `dir/index.ts`,
  so the shim file is load-bearing); (2) the public contract (~640 lines
  of wire-facing types + `createAnnotation`) → `types.ts`; (3) the
  store-row mappers (`mapNode`, `nodeRowStamp`, column parsers) →
  `mappers.ts`; (4) the asset REST helpers → `asset-transport.ts`; (5) the
  per-user prefs device cache → `prefs.ts`; (6) the hosted section-view
  wire types → `section-views.ts`; (7)–(15) the class splits by operation
  domain along the file's own section seams, chained as
  `WorkspaceClientBase` (fields, bootstrap, envelope/outbox, notify) →
  `Reads` (nodes/listings/class bindings) → `ReadsProps` (properties,
  tree, search, query bridge) → `ReadsRefs` (icons/colors, backlinks/
  references, aliases, features) → `Sync` (push/pull, realtime, status) →
  `Server` (assets/prefs/section-views/history feeds) → `Undo` → `Writes`
  → `Dates`; (16) `client.ts` is now just the concrete class + the four
  construction factories (84 lines). `private` becomes `protected` on
  cross-domain members; the barrel re-exports exactly the old public names
  (internal helpers stay unexported), so every one of the ~110 importers
  (worker path, clone, tests, UI) is unchanged.
  **Verification:** `npx tsc --noEmit` clean after each commit; the
  client's own + affected suites (workspace-client, realtime, worker-core,
  undo-journal, sync-status-guard, sync-details-modal, clone-engine,
  system-class-deploy-bindings) green; full `npx vitest run` green
  (1,813 tests incl. the untracked zz-dbg scratch files).

- **refactor(web): `ui/app/` gains its public-surface barrel.**
  `src/ui/app/index.ts` re-exports the family's public surface — the 16
  modules App.tsx, BootForm, and the tests consume (storage, routing,
  keymap, railCardOrder, HubView, store-connection, the connection/boot
  hooks, BootForm, the gesture/rail/undo hooks, the four shell regions).
  App.tsx imports the family through the barrel: 29 → 16 import
  statements. Internal-only modules (`clients.ts`, `storeMode.ts`) stay
  out of the barrel, and cross-imports inside the family stay direct so
  the barrel can't become a cycle. No behavior change.
  **Verification:** `npx tsc --noEmit` clean (no circular-import type
  errors); app-smoke/banner/routing/settings suites green.

- **refactor(web): the boot-flow hook monolith dissolves — `useBootFlow`
  composes `useServerProbe` + `useAuthFlow`.** The App.tsx split's own
  assessment flagged the 438-line `useBootFlow` (a ~25-member state bag) as
  a relocation, not a dissolution. Pure moves, no behavior change: the
  probe path (server URL, signup flag, hint + same-host suggestion,
  `connectTo`/`handleServerSubmit`/`handleServerSuggestion`) moves to
  `useServerProbe.ts`; the credential path (account form fields, auth tab,
  user/token identity, setup/login/signup/API-key submits with session
  persistence) moves to `useAuthFlow.ts`; `useBootFlow.ts` (~200 lines)
  keeps the composition: the workspace list, the remembered-session resume
  effect (deep links, offline fallback), and "Work offline". Each unit has
  one reason to change. `BootForm` and `App` consume the same flat
  `BootFlow` shape as before (no call-site churn). The "App.tsx stays at
  ~750 lines" decision is recorded in `.agents/design-overrides.md` under
  the coding-standards monolith rule's over-target escape.
  **Verification:** `npx tsc --noEmit` clean; the boot/app-mount suites
  (app-smoke, banner, settings, tab-title, focus-mode + the `ui/app/`
  consumers) all green.

- **refactor(web): App.tsx becomes the composition root — the monolithic
  shell splits into `ui/app/` modules.** App.tsx shrinks from 2,834 lines
  (~207 functions) to 767: the device-local storage seam (`storage.ts`),
  rail-card order (`railCardOrder.ts`), the store-mode probe
  (`storeMode.ts`), the URL/routing seam (`routing.ts`), the key-chord
  factories (`keymap.ts`), the nav hubs (`HubView.tsx`), the
  framework-free connection core (`store-connection.ts`) with its React
  half (`useWorkspaceConnection.ts`), the boot/auth flow (`useBootFlow.ts`
  + `BootForm.tsx`), the global gesture wiring (`useGlobalGestures.ts`),
  the rail/undo chrome hooks (`useRailCards.ts`, `useUndoChrome.ts`), and
  the four shell regions (`AppTopBar.tsx`, `AppBody.tsx`,
  `AppModals.tsx`, `AppOverlays.tsx`) each own their slice; App keeps the
  view/presenting state, the navigation orchestration, and the phase
  gates, composing everything by props. Pure moves only — no behavior
  change; exported helpers keep their tests (imports re-pointed).
  **Verification:** `npx tsc --noEmit` clean; the full web suite (1,813
  tests) green; dev-server smoke captured at 390/1440 (boot wall +
  offline-in-process shell render).

- **docs(register): the custom-primitive-layer exception retires — the
  catalog migration is the record.** `.agents/design-overrides.md` (the
  per-project deviation register) replaces the "catalog adoption at touch
  points" exception entry with the completed migration: the bridge + 20
  normalized components + the six wrapper migrations (commits `c5ebaac1`,
  `21aef837`, `f646dbbc`), what stays fleet-owned per the sourcing table
  (shell chrome, SegmentedControl/Chip, EmptyState, ConfirmationModal, and
  the app-specific registers the wrappers carry), and the remaining custom
  leaves' path (catalog at touch points — new work goes through the
  catalog, normalized). `docs/developers/ui-primitives.md` gains the
  catalog section: the normalization contract, the Tailwind
  implementation layer (preflight off + the base-layer border-style), the
  wrapper architecture, the drift gate's class half, and the bridge
  fixture. No runtime behavior. **Verification:** docs only; the gates
  they describe are green in their slices.

- **feat(web): the design-bridge fixture — computed-behavior proof across
  themes, accent switches, and interaction states.** The shadcn bridge's
  CI half lands: `/__design-bridge-fixture` (renders instead of the app —
  `main.tsx` branches on the pathname, so no auth, no sync server, no
  workspace; excluded from every surface by construction) mounts the
  normalized components with `data-fix` hooks, and
  `e2e/bridge-fixture.spec.ts` (adapted from the skill's
  bridge-fixture.spec.ts.template to the app's accent register and color
  serializations) asserts in dark, light, and after an accent switch:
  token resolution (not library defaults), primary/on-primary contrast ≥
  4.5:1, the hover register (state-layer overlay by computed value), the
  focus ring (never suppressed), disabled dimming, `aria-busy` on loading,
  dialog elevation, and that flipping `data-accent` re-themes the catalog
  through the alias layer. Playwright arrives as a devDependency with
  `playwright.config.ts` (vite dev server on the fixed fixture port,
  reuse in dev; full-chromium channel and a generous timeout for the
  loaded fleet host — the suite runs in seconds on a quiet machine). Two
  adaptations from the template worth recording: Radix renders
  `DialogOverlay` only for MODAL dialogs, so the fixture pins the scrim
  register as a static `pointer-events-none` swatch (a modal overlay
  would block the pointer-driven state checks — hover — on the buttons
  beneath it), and the spec's color comparison normalizes hex, rgb(a),
  and CSS Color 4 space-separated serializations. **Verification:** the
  suite passes (observed green across the theme scenarios; token
  resolution, hover overlay, focus ring, contrast, and the accent seam all
  asserted by computed value in dark/light/teal).

- **feat(web): the six fleet primitives migrate to the normalized catalog —
  Button, TextField, Card, Tabs, ToggleSwitch, Modal become thin wrappers,
  their CSS retires.** The third slice of the shadcn-alignment ruling. Every
  call site keeps working unchanged: the wrappers preserve the full prop
  APIs (72 files import Button by relative path — zero call-site edits
  beyond the class-contract tests). What changed per component: **Button**
  composes the catalog cva button; the fleet variant register
  (default/primary/outline/ghost/danger/danger-solid, the active-toggle and
  loading registers, MDI icons, icon badges, haptics, xs–lg sizes) ports to
  token utilities; Button.css (406 lines) deletes; the `btn` and
  `btn--icon-only` marker classes stay as documented hooks for feature CSS
  that compounds on them (calendar days, icon-picker items) — unlayered
  feature CSS still wins over the utility layer, so the overrides behave
  exactly as before. Buttons go corner-full at every size (fleet ruling
  2026-10-19 — the pre-catalog 12px corners retire with the migration).
  **TextField** composes the catalog input with the app's underline register
  (two new tokens: `--shadow-field-focus/error`, the 2px active underline);
  TextField.css deletes. **Card** composes the catalog card; the
  variant/elevation/radius/padding registers port to utilities
  (`--scale-card-press` token for the TE tactile lift); the `card` marker
  stays for ContextMenu/Dropdown compounds; Card.css deletes.
  **ToggleSwitch** puts the Radix switch underneath (role/aria/keyboard are
  the catalog's) with the dual-label register and the calc'd track/thumb
  geometry as token-referencing inline styles (no utility can express calc);
  ToggleSwitch.css deletes. **Tabs** puts Radix tabs underneath (focus
  management, arrow-key activation, the tab/tabpanel ARIA wiring) keeping
  the sliding-indicator register in Tabs.css and the `tabs__*` hooks;
  triggers activate on click as well as Radix's mousedown (the app's
  interaction contract). **Modal** puts Radix Dialog underneath (focus trap,
  focus restore, portal layering) keeping the app chrome: the header/footer
  structure, the bottom-sheet swipe-to-dismiss gesture, the scrim register
  (Modal.css), and the app overlay stack as the single Escape authority
  (Radix's own Escape is disabled so LIFO ordering across every overlay
  surface survives); the Card composition the modal rode becomes token
  utilities on the dialog content. **Two real bugs the migration exposed
  and this slice fixes:** the hosted-views delete/reset confirms never
  closed their own modal (the old portal never hid the inert tree, so the
  stuck modal was invisible to the test queries — Radix's correct
  aria-hidden surfaced it); and `twMerge` needed the app's custom type-scale
  names registered (it mistook `text-button` for a color and dropped real
  color classes as conflicts). **Test-contract updates:** ui-primitives,
  hover-press-register, submenu-chevron, graph-view, node-link-gestures
  assert the new catalog class contract (source-level register pins where
  they used to read the retired CSS files); the modal backdrop test fires
  pointer-down (Radix's dismissal event) and waits out Radix's macrotask
  listener registration. **Verification:** full web suite 1811/1813 — the
  2 failures are the pre-existing mobile-layout baseline that also fails on
  unmodified HEAD; typecheck carries only the 3 pre-existing App.tsx
  errors (same baseline); `vite build` green with the token utilities in
  the bundle.

- **feat(web): the normalized shadcn catalog lands — 20 components under
  `src/components/ui/`, tokens-only.** The second slice of the 2026-10-19
  shadcn-alignment ruling: button, input, textarea, label, card, dialog,
  alert-dialog, tabs, switch, checkbox, radio-group, badge, select,
  dropdown-menu, popover, tooltip, separator, skeleton, scroll-area,
  command — authored from the shadcn new-york sources and normalized per
  the fleet bridge checklist (never imported unmodified, never an npm
  dependency): theme-key utilities only (no default palette, raw radii,
  arbitrary values, default shadows/durations), hover = state-layer
  overlay through the `--accent` alias, focus ring from `--ring` and never
  suppressed, menus on the 4px popover radius, modal chrome on the sheet
  radius + level-3 elevation, chrome icons swapped from lucide to the
  fleet `Icon` primitive (zero lucide dependency). Behavior rides Radix
  primitives (+ cmdk for the command palette). The app's six fleet
  primitives are NOT superseded by this slice — they migrate as thin
  wrappers composing these components in the next slice; the fleet
  variants (danger/danger-solid, MDI icon + badges + haptics + the loading
  register, the dual-label switch, the sliding-indicator tabs) live in the
  wrappers per the sourcing table. The Tailwind config grows the small
  set of mappings the catalog cites (ring width, icon widths, panel/menu
  widths, the 6px menu-item spacing token `--spacing-1-5`). **Verification:**
  drift gate 12/12 (the registered-mapping check now proves every
  theme-key utility resolves to a config key); `tailwindcss` CLI emits
  every cited utility; typecheck adds zero new errors; full web suite
  re-run in the migration slice.

- **feat(web): the shadcn bridge lands — Tailwind wired to the tokens, the
  alias layer, and the class half of the drift gate.** Owner ruling
  2026-10-19 ("full shadcn alignment and implementation") starts here: the
  catalog alignment program retires the custom-primitive-layer exception
  (`.agents/design-overrides.md`) and migrates the component layer to the
  normalized shadcn catalog. This slice is the foundation, no visual change.
  Tailwind v3 arrives as an implementation layer only — `tailwind.config.ts`
  maps every utility a component may cite to a design token (colors to the
  Material roles + the shadcn alias keys, radii to the fleet shape scale,
  spacing/height/opacity/elevation/motion to the existing token families);
  preflight stays OFF so the co-located CSS layer is untouched. The token
  file gains the bridge alias layer (`--background`…`--ring` as `var()`
  aliases of the canonical roles — `--accent` deliberately maps to the hover
  register, not the seed) and the `--radius-*` family (buttons corner-full
  per the 2026-10-19 fleet ruling). `components.json` adopts the fleet
  template (new-york style, `@/` aliases, utils → the app's `cn`). `cn`
  upgrades to clsx + tailwind-merge (merge semantics the catalog needs; the
  old joiner behavior is unchanged for non-Tailwind classes). The drift gate
  grows the class half (checks 8–11): no default-palette utilities, no raw
  radii outside the registered family, no arbitrary values/default
  shadows/default durations, and a registered-mapping check that proves
  every theme-key utility in the catalog resolves to a config key —
  detectors fixture-tested like the original seven. **Verification:**
  drift gate 12/12 (7 CSS + 5 class); `vite build` green; full web suite
  green; typecheck carries three pre-existing `App.tsx` errors that also
  fail on unmodified HEAD (another session's in-flight work — reported, not
  touched).

- **fix(web): the sidebar foot is the three-column layout it should be
  (owner report, same-day).** The identity restore shipped with two CSS
  regressions: `.nt-profile-text` (the column layout + truncating buffer
  between the avatar and the gear) had been dropped in the account-popup
  rewrite and was never restored — so the name and email rendered on ONE
  inline row and overflowed into the settings gear — and the sync badge's
  offsets were still computed against the old 48px button, parking the dot
  INSIDE the avatar instead of on its rim. Restored `.nt-profile-text`
  (flex column, `flex:1; min-width:0`, the ellipsis contract) and
  re-anchored the badge to the avatar: `right/bottom: -3px` so the 10px
  disc straddles the circle's bottom-right corner. **Verification:**
  targeted suites green (48 tests); rendered-footer probe against the
  built CSS (screenshot + geometry: badge straddles the rim, two stacked
  rows, email ellipsizes clear of the gear, gear flush to the row's right
  edge); live screenshot on the deployed stack.

- **fix(web): the sidebar profile row wears the identity again; the
  settings gear returns (owner 2026-10-19, same-day follow-ups).** The
  account-popup slice made the bottom-row trigger avatar-only; the owner
  flagged the lost name/email read (and considered moving the button to
  the top bar — rejected: the top bar's right cluster is already dense,
  and the sidebar foot is the account's conventional home). The trigger
  is the wide identity row again — avatar + display name + email — with
  the sync badge re-anchored to the AVATAR's corner (it rode the button's
  corner for one day). And the popup-only settings door lasted a day too:
  the owner doesn't want a shortcut as the settings path, so the **gear
  button is back** beside the profile (same `showSettings` gating as
  always, same target as the popup's Settings entry; the Ctrl/Cmd+, chord
  and the popup entry remain as alternates). **Verification:** web
  suites green (sidebar-menus incl. the identity-row + badge-anchor
  assertions, settings-modals incl. the gear's direct-open); docs
  aligned; live screenshot check on the deployed stack.

- **feat(web): picker recents, node-link icon alignment, the account popup
  (sync badge, Shares hub, Trash relocation) (owner 2026-10-19).** Four
  owner-reported UI slices in one pass. **(1) Node pickers open to your
  recents:** every unscoped `NodeSelector` (the `@`/`#`/`+` popups, property
  pickers) lists the device's Recently Used nodes (MRU order, "Recently
  used" caption) on the empty query instead of an empty list — the first
  keystroke replaces the list with ranked search hits; class-scoped pickers
  keep their member listing, blocks-mode keeps the inline-block filter, the
  classes picker is untouched. The recents read rides the new exported
  `readRecentIds` (the sidebar's storage shape, shared with the palette).
  **(2) Node-link icons actually align:** the `Icon` component forced an
  INLINE `vertical-align: middle`, which silently beat the designed
  `.nt-link__icon { vertical-align: -0.15em }` — mentions rendered a hair
  LOW. The default moved to a base `nt-icon` class (app.css), so the
  designed offset (glyph center on the cap height) now applies. **(3) The
  sync indicator relocated:** the top-bar SyncDot is gone; a sync-state
  badge (idle/syncing/backlog/error, the pulse + reduced-motion rules
  preserved) rides the user profile circle's corner in the sidebar foot,
  and the sync details modal opens from the account popup's Sync entry
  (its caption names the live state — "up to date" / "N waiting" /
  "error"). **(4) The account popup is now a proper user menu** (the v1
  `AccountMenu` shape, adapted): identity header (avatar, name, email),
  Sync, Shares, Trash, Settings, Admin settings (admin accounts, opens the
  active workspace's settings on the admin-gated plugins tab), and a danger
  Sign out. The sidebar nav lost its Trash row and the foot lost the
  settings gear — both live in the popup now; Trash and Shares are
  `menuOnly` NAV_ENTRIES (routes `/trash` / `/shares`, tab titles, and the
  render switch intact). New **Shares hub**: the v1 `SharesUnifiedView`'s
  "Shared Out" tab ported over the v2 public-link register (`GET/DELETE
  /api/shares`) — node icon + name resolved through the local projection,
  link with the shared copy pattern, created/expiry stamps, Open, and the
  inline-confirmed Revoke; v2 has no user-share inbox endpoint, so the v1
  Inbox tab has no data to port (stated as a reduced subset, not a silent
  default). **Verification:** full gate green (`pnpm typecheck && pnpm
  test`, 1802+ web tests incl. +14 new or rewritten: picker recents MRU /
  scope filters / classes-picker immunity, the account popup's entries +
  gating + badge states + Trash-out-of-nav, the Shares hub's list / revoke /
  open / empty / retry, tab-title Shares case, topbar/sync prop fallout);
  `docs/ux.md` (sync-dot section, node-picker paragraph) + `docs/usage.md`
  (account popup, Shares hub, picker recents, settings entry) updated.

## 2026-10-17

- **fix(web): the slash Date entry shows the calendar again; the picker's
  date row links on create; node links wear the target's icon (owner
  2026-10-17, second round).** **(1)** The slash menu's Date entry lost its
  calendar on the v2 port (a bare `/date` silently linked today and an
  unparseable remainder fell back to plain prose — v1 opened the
  DatePickerPopup at the caret). Restored: a parseable typed remainder
  (`/date feb 14`) still links directly; a BARE `/date` or an unparseable
  remainder now opens the calendar popup anchored at the caret, and the
  picked day ensures the journal chain and inserts the mention on commit
  (Escape/outside close strips the trigger and refocuses the block at the
  caret). The popup's portaled root carries `data-editor-companion` so the
  edit session survives the focus hand-off. **(2)** The node picker's
  typed-date row dropped the pick on the CREATE path: `ensureDateChain`'s
  RPC resolution outran the projection's sync notify, the immediate
  `getNode` read answered undefined, and the row flipped to "Link to daily
  page" with nothing inserted — so every not-yet-existing date ("tomorrow"
  lowercase among them) dead-ended on first click while an existing date
  page ("Tomorrow", after the failed create had authored it) appeared to
  work. The row now waits (bounded, subscription-driven) for the node to
  land and links in the same gesture. **(3)** Node links (mention tokens)
  render the linked node's DEFINED effective icon — its own icon else its
  first class's (`definedNodeIcon`, no display-default glyph) — ahead of
  the label, wired through InlineTokens' new `resolveIcon` resolver by the
  block row. **Verification:** web suites green (slash-breadth /
  capture / rendering / editor-popups / pickers / dates, +5 new or
  rewritten: bare-/date opens the calendar + Today links, unparseable
  remainder opens the popup + Escape refocuses, the create-date row links
  in one gesture, mention icons for own- and class-icon targets with an
  iconless negative); `docs/ux.md` + `docs/usage.md` updated.

- **fix(web): outliner keyboard round — the focused block view's ghost, the
  Tab edit-mode drop, cross-block arrow navigation (owner 2026-10-17).** Four
  owner-reported editor fixes, one slice. **(1)** The focused block view (the
  bullet-zoom view, ReferenceSubtree) trailed no ghost at all — it now trails
  exactly ONE "+ Add block" ghost as the LAST CHILD of the focused block
  (BlockRow's new `trailingGhost` slot renders inside the children container,
  at the child indent level — never a sibling of the focused block; the
  children container mounts for the ghost alone, so an empty focused block
  can grow a child; the read-only hover preview mounts none). **(2)** Tab /
  Shift+Tab reparents remount the moved row under a different parent, and
  React dropped the component instance — edit mode died with it; the caret
  offset is now captured before the `object.move` and the edit session is
  re-requested on the moved block when the move lands (indenting never
  leaves edit mode). **(3/4)** The arrow keys now carry the edit session
  across blocks in VISIBLE document order (folded subtrees contribute no
  rows — new `nextBlockId`/`previousBlockId`/`firstBlockId` accessors over a
  collapse-aware order in the outliner context): `↑`/`↓` keep the browser's
  within-text line movement and hand off only on the first/last VISUAL line
  (rect-probed via the new `caretClientRect`/`proseOffsetRect` selection
  helpers); `→` at the end / `←` at the start hand to the next/previous
  block (caret at start/end); `↑` on the first top-level block hands the
  caret to the page title, and `↓`/`→`-at-end on the title enter the first
  block. The atomic-pill arrow gestures and the slash-popup capture keep
  their priority; Shift/Alt-modified arrows stay on the browser default.
  **Verification:** web gate green (49 tests across outliner-editor /
  outliner-keys / render-cascade, +8 new: the child-level focused-view ghost
  incl. realize-and-focus, Tab/Shift+Tab edit-mode retention, ↑/↓/←/→
  cross-block hand-offs both directions, the first-block→title hand-off, the
  title→first-block entries); `docs/ux.md` keyboard table + ghost paragraph
  updated.

## 2026-10-16

## 2026-10-19

- **feat(web): the query block's identity is READONLY — the field → operator
  → value register (owner 2026-10-19).** The block's TYPE column was a
  dropdown that could morph the whole row into another family, and the
  PROPERTY family showed an operator list computed for an UNSELECTED
  property, with the property picker buried in the value column ("the
  properties query block is weird — the mode selector before a property is
  even selected"). The owner proposed the Notion/Odoo register, and the
  reference check agreed: Odoo's Add Custom Filter reads `[Field] [Operator]
  [Value]` with no rule morphing (delete + re-add), Notion reads `[Property]
  [Condition ▾] [Value]` with the condition list scoped to the property
  type, and Airtable/Metabase/Retool/Jira's structured builder carry the
  same field-first triplet. Now: the TYPE slot renders a static label naming
  the family (the SelectTrigger box register, muted, no chevron — identity,
  not a control); the row kind changes only by delete + re-add through the
  add menu (the morph machinery and the FAMILY dropdown register are gone).
  The PROPERTY family is the carved-out exception: the property (schema)
  dropdown rides the type slot — the row reads `[Property ▾] [Operator ▾]
  [Value]`, the operator list already adapted to the selected schema's type,
  and nothing operator-shaped renders before a property is picked.
  PropertyValue lost its schema dropdown (value controls only).
  **Verification:** `pnpm typecheck` + the filter suites green
  (filter-builder/filter-query/filter-layer 55 — the property tests drive
  the picker by its aria label, unchanged); no behavior change to the
  grammar/evaluators (presentational reorder + readonly identity). Docs:
  the module docstring + this entry.**

## 2026-10-16

- **feat(query): the rest of v1's node-family register — Parent (direct),
  Child, Child path, Reference path (owner 2026-10-16, round 4).** Completes
  the v1 port the owner asked for ("parent, child, child path, reference
  paths — all v1", per `v1-archive` `conditionConfigs.ts` / `query_ast.py`).
  **Parent is now v1's DIRECT parent** (one hop up) — `parentOf {nodeIds}` /
  `parentOfQuery {root}`, operators is-any-of / is-not-any-of / is-set /
  is-not-set (the set bit rides the existing `parentSet`); the parentless
  NULL reads two-valued via `COALESCE` so a parentless row matches the
  negation exactly like the sync evaluator (the empty-parent test owns the
  NULL case). The old subtree "Parent" family moves to its v1 name, **Child
  path** (`descendantOf` / `descendantOfAny` / `descendantOfQuery` +
  **`descendantSet`**, operators contains / does not contain / is set / is
  not set). **Child** is new — `childOf {nodeIds}` / `childOfQuery {root}` /
  **`childSet`** (a DIRECT child is one of the picks / matches the subquery /
  at least one direct child exists; v1's contains-any-of wording). **Reference
  path** is new — `referencePathOf {nodeIds}` / `referencePathOfQuery {root}`:
  v1's rollup where the row OR any of its ancestors links to a target, OR a
  target is a STRICT ancestor of the row (v1 folded containment into the
  reference rollup); both forms ride the probe path (edge metadata). All four
  get the static/dynamic mode switch (chip-list node multi-pick ⇄ nested
  builder) and recurse unbounded through the same compiler/evaluator. The
  evaluator's client surface gains `getChildren` (the child/child-path sync
  arms; the descendant set is a cycle-guarded DFS). **Verification:**
  packages/query 197 green over both adapters (+14: parentOf incl. the
  two-valued NULL arm, parentOfQuery, childOf/childOfQuery, childSet,
  descendantSet, referencePathOf both arms + the not-wrap, the dynamic
  form); web filter suites green (+3 end-to-end: Parent direct with the set
  bit, Child with the set bit, Reference path through the probe — plus the
  Child-path rename of the old subtree test); prune/registry/createCondition
  updated. A test-seeding lesson re-confirmed along the way: create-as-page
  stringifies rich content, so a mention edge must ride a BLOCK's content —
  a page cannot be an edge source.**
- **fix(query): the node-container blocks are NODE-target, not class-target
  (owner correction 2026-10-16, the v1 semantics restored).** Round 1 shipped
  the classed-container conditions (`pageClass` / `ancestorClassed` /
  `rootClass` + their ANY-of/set shapes) — the owner corrected the concept:
  "the idea is to be able to walk up a path. The Page query block should not
  be 'page is classed as…' but 'Page is these nodes' in static mode, or 'Page
  is one of these nodes, based on this subquery'. The same for almost all
  node-type blocks — and the subquery dynamically informs the node list of
  its parent block, as many levels deep as the user wants." That is exactly
  v1's register (`v1-archive` `conditionConfigs.ts` / `query_ast.py`: Page /
  Parent / Parent path / Child / Child path / Reference / Reference path all
  node-target with the static/dynamic toggle and a nested `GroupNode`). The
  class-container grammar types are REMOVED (they shipped two commits ago,
  nothing persisted uses them — the transient layer only, and the no-compat
  law applies) and replaced by the v1 node-container family: **`pageOf
  {nodeIds}` / `pageOfQuery {root}`** (the containing page is one of the
  picked nodes / the subquery's matches — a page row reads its own page, so
  picked it matches itself), **`pageSet`** (the row lives inside a page),
  **`ancestorIn {nodeIds}` / `ancestorInQuery {root}`** (v1's Parent path:
  some strict ancestor is one of the picked nodes / matches the subquery —
  the "classed ancestor" use case rides the DYNAMIC mode: `Parent path
  includes [subquery: Class contains Day]`), **`rootIn {nodeIds}` /
  `rootInQuery {root}`** (the workspace-root ancestor — a parentless row is
  its own root). Links was already node-target (single / one-of / set /
  dynamic since round 2) and stays. Compiler: the containing-page and root
  ids ride correlated scalar subqueries (the Revision-12 page-role
  flattening, depth-capped CTEs); the dynamic arms correlate the container
  against the group's match set through a fresh `node n` scope — a real bug
  was caught here (the first cut compared the ROW against the group instead
  of the container). Evaluator: sync arms for the static/set shapes, the
  dynamic shapes ride the probe path (their nested group may carry
  joined-metadata leaves), nesting recurses through the same compiler/evaluator
  unbounded. FilterBlockBuilder: Page / Parent path / Root get the v1
  static/dynamic mode switch (chip-list node multi-pick ⇄ nested builder),
  the v1 operator labels (is any of / is not any of / is set / is not set;
  includes / does not include on the parent path), and the class-based
  container UI is gone — "page is classed as Day" now reads `Page → dynamic →
  [Class contains Day]`. **Verification:** packages/query 183 green over both
  adapters (the container suite rewritten: pageOf/pageOfQuery/pageSet,
  ancestorIn/ancestorInQuery, rootIn/rootInQuery with self-inclusion and
  closure semantics); web filter suites green (filter-builder +5: Page static
  multi-pick, Page dynamic through the nested builder, Page is-set, Parent
  path includes + set, Root static — and the dynamic probe beat awaited with
  waitFor); prune covers the new shapes.**
- **feat(query): the FULL Odoo operator set across the query block families
  (owner 2026-10-16, round 2).** Round 1 shipped the class register + the
  classed-container conditions; this round applies the same operator set to
  every family, per the owner's screenshots (Odoo's date list `=, !=, >, >=,
  <, <=, está entre, está dentro de, está definido, no está definido`; the
  numeric list with `is between`/`contains`; "the same options for node type
  like parent, parent path, root, page, link"). Grammar (additive query-AST
  v1): **content** gains `eq`/`neq`/`starts`/`ends` (plaintext equality +
  edge-anchored LIKE over the search plaintext) + **`contentSet`** (non-empty
  text); **tags** are a new family — `tag` / `tagAny` / `tagSet` over the
  OR-set `tag_ids` (a tag is any page, no hierarchy); **links** gain
  **`linkedToAny`** (rollup membership of any picked node) + **`linkSet`**
  (≥1 inbound edge — probe-path leaves like `linkedTo`); **parent** gains
  **`descendantOfAny`** (subtree of any picked node, anchors excluded) +
  **`parentSet`** (`parent_id IS NOT NULL`); the classed containers gain the
  ANY-of + set shapes (`pageClassAny`/`ancestorClassedAny`/`rootClassAny`,
  `pageClassSet`/`ancestorClassedSet`/`rootClassSet`); **created/edited** gain
  the Odoo date operators — **`createdCmp`/`updatedCmp`** (eq/neq are
  DAY-granular: tokens and plain `YYYY-MM-DD` dates resolve through one
  shared `resolveDayBounds`, instants compare directly), **`createdBetween`/
  `updatedBetween`** (inclusive day-start→day-end), **`createdWithin`/
  `updatedWithin`** (relative periods via one shared `resolvePeriodBounds`
  against the run clock). The set bits are deliberately ABSENT from the date
  families — `created_at`/`updated_at` are written at create time, so every
  row reads "set" (a lying control; `updatedSet` was prototyped, measured
  vacuous, and removed). **property** gains **`propertyBetween`** (the
  inclusive range over the effective value — numeric for JSON numbers,
  lexicographic for ISO dates, date-node refs speak through the existing
  dateRef arms) + **`propertyWithin`** (the date-valued property inside a
  relative period). FilterBlockBuilder UI: every family's operator column
  now carries its Odoo set (the picked ids/values/timestamps carry across
  operator morphs); "one of" over NODE targets (links/parent/tags) rides a
  new chip-list **`NodeMultiPick`** (anchored NodeSelector appends, × removes
  — node targets are unbounded, never a dropdown); "one of" over classes
  rides the kit Dropdown multi-select; the date "is between" renders two
  bound inputs, "is within" a period picker; the PROPERTY value control is
  now type-aware (the owner's "select a property and get the option dropdown
  based on the property type"): select → options dropdown, boolean →
  true/false, datetime → date inputs (+range/period), node-typed → the
  anchored node picker, number → numeric keyboard, text → plain input — and
  the property OPERATOR list adapts to the selected schema's type (the
  BuilderFacts pickers now carry the schema row's options + target filter).
  Cover/banner/alias stay at is-set/is-not-set (the owner punted on asset
  file-type filters); the boolean structural bits keep their tri-state.
  **Verification:** packages/query 229 green over BOTH adapters (24 new:
  content ops + contentSet, tags, linkedToAny/linkSet, descendantOfAny/
  parentSet, the date operators with the pinned run clock, propertyBetween,
  the container ANY-of/set shapes); web filter suites green (filter-builder
  +6 end-to-end through the panel — content is/starts-with/is-set, tags
  one-of through the chip picker, created between/within, property between
  on a number, page one-of + page is-set; prune coverage for every half-
  typed shape). No op/wire/fixture change — the query AST is a content-token
  payload. Known follow-ups (owner's call): node-based "parent of" (ancestor
  of a picked node), asset file-type filters.**
- **feat(query): the Odoo operator set + the classed-container conditions —
  `classExact` / `classAny` / `classSet` / `pageClass` / `ancestorClassed` /
  `rootClass` (owner 2026-10-16).** Two owner requests drove this slice:
  "Class is not Day still shows day pages" (the Backlinks section groups rows
  by their containing page — journal day pages are GROUP CHROME, not filtered
  rows; what was missing is a condition over the container) and "the same
  operator options as Odoo: is / is not / contains / does not contain / one
  of / not one of / is set / is not set, plus child-of/parent-of-style
  filters". Grammar (packages/protocol `query-ast.ts`, additive within v1):
  **`classExact`** — the class set is EXACTLY `{classId}`, nothing else (the
  Odoo "=" register; the plain `class` condition stays closure MEMBERSHIP);
  **`classAny`** — ANY-of membership over a picked set (Odoo "one of",
  `classIds` min 1); **`classSet`** — the class set is non-empty (Odoo "is
  set"); **`pageClass`** — the CONTAINING PAGE (nearest self-or-ancestor with
  document chrome — a class, a parentless node, or an `is_embedded = 0`
  node, the same flattening the "pages" scope uses; the parent-page condition
  is write-time impossible to violate) is classed, closure-aware — "blocks
  whose page is classed as Day"; **`ancestorClassed`** — some STRICT ancestor
  (the parent path, self excluded) is classed — "blocks that have a Day-
  classed block up their parent path"; **`rootClass`** — the workspace-root
  ancestor (a parentless row is its own root) is classed. All negations ride
  the existing not-wrap. Compiler (packages/query): six SQL arms — the exact
  arms count `json_each(class_ids)`; the container arms are depth-capped
  correlated recursive CTEs over `parent_id` probing `class_hierarchy`
  (verified on BOTH adapters, sql.js FTS4 and better-sqlite3 FTS5). Sync
  evaluator (`sectionViewResolve`): the same six arms over the client reads,
  memoized closures, cycle-guarded walks (the one-evaluator ruling holds —
  no probe path involved). FilterBlockBuilder: the class family's operator
  column is now the full Odoo set (the picked ids carry across operator
  morphs; "one of" rides the kit Dropdown's multi-select), the add menu
  gains Page / Parent path / Root, and the class row's DEFAULT operator is
  "is" = exact (a semantics change of the transient filter layer only —
  nothing persisted; the Queries-hub modal composer is untouched).
  `filterQuery` prunes the half-typed shapes (empty exact/container classId,
  empty `classAny`); the modal builder's guard now NAMES the new conditions
  as unsupported instead of silently dropping them. Query README condition
  table updated (including retiring a stale `presentAsMain` row for
  `isEmbedded`). **Verification:** packages/query 163 green over both
  adapters (12 new: exact/any/set × closure + not-wrap, page/ancestor/root ×
  the France/Paris/Lone world + negation); web filter suites green
  (filter-builder +6 end-to-end through the panel — exact-vs-contains witness,
  one-of multi-pick, is-set, page/parent-path/root on an embedded-block
  container world; filter-layer's closure test now drives "contains";
  filter-query createCondition/registry/prune updated). No op/wire/fixture
  change — the query AST is a content-token payload, not an op.**
- **fix(web): the "Database closed" unhandled rejection — a test-teardown
  race in PageView's alias self-heal (owner 2026-10-16).** The full gate
  intermittently reported a stack-less `Unknown Error: Database closed`
  unhandled rejection attributed to template-create-flow.test.tsx. Two
  layers, both fixed: (1) the rejection's *shape* — sql.js throws the frozen
  STRING "Database closed" after close, and the sqljs adapter's
  `tagSqliteError` let strings fall through to a bare re-throw (its own doc
  comment promised wrapping), so the failure carried no stack and failed
  every `instanceof Error` check; it now wraps ANY non-Error throw in a real
  Error (translation path unchanged — strings can take no `code`). (2) the
  rejection's *source* — with the stack visible, the caller was PageView's
  alias-property self-heal effect firing `void ensureAliasProperty(client)`
  with no rejection handler: a passive effect can flush after a test's
  teardown closes the client (CalendarView's embedded day PageView mounts
  the moment a quick-create ensures the date chain), and the deploy then hit
  the closed store. PageView now rides the CalendarView family-ensure
  ruling: fire-and-forget with `.catch(() => {})` — the ensure is
  idempotent and the next mount re-runs it. No model/wire/store semantics
  change. **Verification:** packages/store 583 green; the full web suite
  (162 files / 1769 tests) run repeatedly — the rejection no longer
  surfaces; `pnpm typecheck` + `pnpm test` green.**
- **fix(web): the query builder surfaces ride the kit dropdown/input
  registers — the audit-and-align slice (owner 2026-10-16, design-system
  audit).** The filter bar's structured panel rendered its condition
  columns as **raw native `<select>`s with zero token styling** — the kit
  CSS still styled the retired `nt-fb-condition*` classes while the TSX
  rendered `nt-fb-block*`, which had no CSS at all: the browser's grey
  dropdown chrome against the token interface, exactly the reported
  misalignment. The same drift class lived in the query-block builder
  popover and the Queries-hub "New query" modal (`QueryBuilderFields` —
  one-off styled selects) and in `QueryBlockView`'s ad-hoc
  hand-styled action buttons. Now: the FilterBlockBuilder's TYPE /
  OPERATOR / VALUE selection columns ride the kit **Dropdown** (sm), its
  text values the new kit **Input** primitive (the boxed text field — the
  `SelectTrigger` register applied to a native `<input>`, barrel-exported
  and catalogued in ui-primitives.md); the block rows lay out as a
  hover-filled list row with fixed-basis type/operator columns so they
  align across rows, the value column flexing. `QueryBuilderFields` (the
  scope bar + every condition card) migrated to the same Dropdown/Input
  registers; the dead `nt-fb-condition` CSS block and the one-off
  `nt-vb__card-body` control CSS are gone. The node-pick trigger and the
  load-more / Apply / Cancel / Edit-anyway buttons compose the kit
  registers (SelectTrigger-matching field with a rotating chevron +
  `aria-expanded`; kit `Button` variants), deleting the app.css ad-hoc
  button block. No model/wire/store change — chrome only. **Verification:**
  `pnpm build` + `pnpm typecheck` (8/8) + `pnpm test` green — the six
  query-builder suites (filter-builder, filter-layer, section-views,
  queries-hub, query-block, query-builder-guard) updated to drive the
  Dropdowns and re-passed.**
- **feat(web): horizontal rule blocks — a block whose content is exactly
  `---` renders as a divider, inserted via the slash menu (owner
  2026-10-16).** Zero wire/store/fixture changes: the node is an ordinary
  text block everywhere on the wire and in the store — the rule is purely a
  display-time derivation (the new domain `isRuleContent` helper: exactly
  one plain text run equal to `---`, no marks, no whitespace tolerance).
  Web: the block row renders an `<hr>` in place of bullet + text, children
  of a rule never render (a rule terminates a section), and clicking the
  rule enters edit and shows the raw dashes — the block is never a trapped
  surface, and typing anything else turns it back into prose by
  construction. The slash menu's existing **Divider** entry (`/hr`) is the
  insertion affordance: it now strips the trigger and inserts a sibling
  block whose content is exactly `---` through the standard `object.create`
  path (sync + undo ride along), then focuses the rule's editor (the
  `/table` cursor precedent). The retired inline `hr` content token stays
  parseable for old logs — only the menu's authoring path changed. Export:
  the IR gains a `rule` block kind (the same domain derivation); HTML maps
  it to `<hr>`, markdown/latex/docx keep the literal dashes — byte-identical
  to the pre-derivation paragraph. Docs: SCHEMA.md (a display-time
  derivation next to the link-based one), ux.md/usage.md.
  **Verification:** `pnpm build` + `pnpm typecheck` (8/8) + `pnpm test`
  green — domain 95, export 247 (html `<hr>` mapping + markdown
  pass-through), web 1766 including the new hr-rule suites (rule render,
  children suppressed, near misses, edit-shows-dashes, `/divider` insert +
  focus, undo); no protocol/store/query/server deltas.**
- **feat(model): per-block list styles — numbered / alpha / roman via the
  `listStyle` wire node field (owner 2026-10-16).** Block rows rendered a
  bullet dot and nothing else; a block can now carry a **list style** that
  replaces the dot with a derived marker — **numbered** (`1.`), **alpha**
  (`a.`), **roman** (`i.`). Wire: `object.create`/`object.update` gain the
  optional nullable `listStyle` (strict enum; absent/null = bullet, the
  zero-migration default; present-null clears — the `icon`/`color`
  precedent). Store: `node.list_style TEXT` (schema v22→v23, guarded
  additive ALTER; presence writes, null clears, rides the row LWW).
  **The number is never stored**: it derives at render time from the
  node's position in the contiguous run of same-style siblings directly
  above it — any sibling without the same style resets the count — so
  inserts and reorders renumber automatically and nested lists number
  independently. Web: the marker renders in the bullet's place (the
  class-icon and collapse-chevron logic untouched — listStyle is
  orthogonal to class membership and task cycling); the block context
  menu gains **List style ›** (Bullet / Numbered / Alphabetical / Roman,
  checkmark on the current) writing through the standard `object.update`
  path — undo/redo (`change list style`, the prior null restores
  honestly) and sync pick it up for free. Fixtures: gate 32→33
  (`object-list-style.json`, create-with-style + set + null-clear).
  **LOCKSTEP-PENDING**: strict-payload additive, so the GTK/Flutter ports
  accept the key before the marker clears — no log migration, pre-existing
  nodes default to bullet. Presentation state is not queryable: no query
  predicate, no export change. Docs: SCHEMA.md "Node structure", WIRE.md,
  releases.md (current wire + lockstep table), ux.md/usage.md.
  **Verification:** `pnpm build` + `pnpm typecheck` (8/8) + `pnpm test`
  green — protocol 421, store 583 (both adapters), web 1760 including the
  new list-style suites and the css-token-drift gate; one benign
  `status=error: Failed to fetch` sync-poll line in the web suite (the
  backend-down overlay's own path) and one pre-existing block-dnd flake
  under full-suite parallel load (passes in isolation; unrelated to this
  slice — no dnd code touched).
- **fix(web): node-link underlines rest on the visible link token, not
  outline (owner report 2026-10-16: dark-mode underlines are gray and
  almost invisible when the node has no color).** `.nt-link` (read mode)
  and `.nt-atom` (edit mode) drew their dashed underline from
  `--md-sys-color-outline`, which the dark graphite theme mixes to a near-
  invisible dark gray. Both now ride `--md-sys-color-on-surface-variant` —
  the token the class-link family already uses for its wavy underline, so
  the whole link family reads consistently; the hover lift to primary is
  unchanged. Web-only, CSS-only — no wire touch. **Verification:**
  `pnpm test` green (css-token-drift + the style-asserting suites).
- **feat(model): node links carry their own `isEmbedded` flag — manual,
  default false (owner ruling 2026-10-16, same-day follow-up to the
  Revision-12 slice).** The earlier link-based display transformation
  inferred embedding from block shape (a link-only block transcluded);
  the owner corrected it: embedding is a MANUAL PER-LINK choice, and an
  unmarked link — including every pre-existing link — is an ordinary
  inline link even when it is its block's whole content. Wire: the
  `mention` content token gains optional `isEmbedded` (absent/false =
  ordinary link); the derived `edge` table projects it as
  `is_embedded INTEGER NOT NULL DEFAULT 0` (store schema v22, guarded
  additive ALTER — every pre-existing edge backfills 0, the owner-facing
  backfill of the Notas workspace verified live: 19,462 edges, zero
  embedded). The flag is not part of the edge identity — toggling it
  updates the row in place like the alias resolution. Web: the link-only
  transclusion gate now requires the token's manual flag; the Edit-link
  dialog gains an "Embed this link" toggle writing the flag through the
  standard content path. Fixtures: gate 31→32 (`link-embedded.json`).
  LOCKSTEP (same day): GTK (mention schema + fixture re-vendor, 804
  tests) and Flutter (MentionToken + local schema v30, 642 tests)
  converged; the additive slice deployed with a normal scoped redeploy —
  no log migration — and `verify-min.mjs` returned VERIFY-PASS. Docs:
  SCHEMA.md transformation paragraph + philosophy/ux wording.
  **Verification:** `pnpm typecheck` + `pnpm test` green (protocol 410,
  store 576, web 1715); live backfill count verified.
- **fix(web): the fleet taste calls reverse to M3 — 48dp touch floors, M3
  elevation levels with cards at level 1, 4px menu radius (owner ruling
  2026-10-16: "I want M3's approach, not the fleet").** The design skill
  moved to pure M3 and the app follows; three fleet deviations reverse in
  one slice. (1) **Touch floor 44 → 48px** (M3's 48×48dp minimum target):
  the change centralizes in `--button-min-height` and the
  `--button-icon-only-*` tokens — every invisible `::after` hit-area overlay
  (calendar day grid / WeekStrip / MonthCalendar / CalendarPopup picks,
  editor row chrome, comments/trash actions, sync dot, property icon
  buttons, NodeSelector rows, NotificationToast dismiss, …) rides that
  token, so the whole register moves at once; the floor prose in every CSS
  comment updates with it. Deliberately untouched: button heights
  (`--height-button-lg: 44px` is a size, not a floor), `--topbar-height`,
  the toggle track width, the whiteboard zoom label, and the sidebar's
  mobile row height (documented exception surface). The underline TextField
  (46px via `--height-xl`) is flagged below with the shape scale. (2)
  **Elevation per M3** (m3.material.io/styles/elevation): new
  `--shadow-level1/2/3` with the M3 ambient+key values verbatim — ONE
  theme-independent set; the dark block's per-theme shadow overrides delete
  entirely (dark keeps tonal elevation through the surface-container
  hierarchy, which the palette already carries). `--shadow-elevation-1/2/3`
  and `--elevation-0..5` become aliases of the levels so the ~30 existing
  consumers carry M3 values without a rename sweep; `--shadow-floating` /
  `--shadow-modal` retire outright (Card.css was their only consumer). The
  kit Card's elevation map is the point: `card--elevation-low` → level 1 —
  static content cards regain their M3 level-1 shadow; medium → level 2
  (menus, popovers), high → level 3 (dialogs, modals). (3) **Menu surface +
  radius per the M3 menu spec** (m3.material.io menus): the ContextMenu root
  and its submenu flyout move from `surface-container-high` to
  `surface-container-low` (menus ride surfaceContainerLow at elevation
  level 2), and the kit menu/popover panels — ContextMenu (root + flyout)
  and the Dropdown menu — take the M3 4dp container shape via a new
  `--radius-menu: var(--shape-small)` token. `--shape-floating-panel`
  itself is untouched (its ~25 other consumers — popups, previews, toasts —
  keep 8px); the `--shape-*` scale (2/4/6/8/12/20) is flagged as a separate
  decision, NOT changed here. Specs: `submenu-chevron.test.tsx` re-pins the
  menu surface (`-low`), the 4dp corner, and the Card.css level mapping;
  the 44px-floor prose in `calendar-hit-area.test.ts`,
  `hover-press-register.test.ts`, `condensed.test.tsx`, and
  `mobile-layout.test.ts` rides the new floor; `docs/ux.md`'s narrow-screen
  paragraph follows. `.agents/design-overrides.md` gains no entries — the
  app is coming INTO alignment, not deviating; its existing entries never
  cited the 44px floor or the no-shadow rule. **Verification:** `pnpm
  typecheck` + `pnpm test` green; web-only — no wire touch.
- **fix(web): the six remaining sweep notes close — token literals, badge
  radius, control width family, journals hover register, empty states
  compose EmptyState; the hover register retires to the skill.** The final
  cleanup of the drift sweep (owner-mandated alignment, 2026-10-16): (1)
  the palette row's magic `gap: 2px` cites `--spacing-micro`. (2) the
  month/year picker grids keep their fixed `repeat(4,1fr)` / `repeat(3,1fr)`
  arity — the column count derives from the content (12 months, a 3×4 year
  window) in a fixed-width side panel, not the viewport — now cited as the
  deliberate choice per §5's fixed-where-constant spirit. (3) the journals
  embedded page-title link's hover leaves the accent ink for the state
  layer (`--md-sys-color-hover-overlay` on the base rule's `--shape-small`
  radius — the hover register of foundations.md §4, never accent ink/fill).
  (4) the settings badge's full-pill radius retires to the §7 tag/badge
  tier — `--shape-large`, the kit Badge's tier. (5) the retention-days
  input's width moves off the spacing scale onto the layout-size family
  (`--layout-size-2xs`; 64px → 80px — the family's smallest step, no exact
  match existed). (6) the hand-rolled journals and trash empty states
  compose the kit `EmptyState` (journals: sentence-as-title + the primary
  CTA, the CalendarView precedent; trash: icon/title/description) — the
  dead local CSS deletes, the journals stylesheet keeping only the `flex: 1`
  feed anchor. The palette's one-line no-results hint stays hand-rolled: it
  is a list-embedded hint inside the results scroller, not a centered empty
  state, and the kit's padded hero recipe would change its shape. The
  `.agents/design-overrides.md` hover entry retires — the rule it
  registered became fleet-standard in the skill (foundations.md §4), so the
  deviation no longer exists; the sidebar/top-bar/canvas exceptions stay.
  Specs: the `hover-press-register.test.ts` pins ride on (new pins for the
  six notes; the journals-CTA pressed pin moves to Button.css, the single
  source of truth). The sidebar, top bar, and canvas surfaces stay
  untouched. **Verification:** `pnpm typecheck` + `pnpm test` green;
  web-only — no wire touch.
- **feat(model): the Revision-12 embedding model — `isEmbedded` replaces
  `presentAsMain` (polarity inverted), the link-only block transclusion, and
  the export zone split (owner 2026-10-16).** The node model's three concerns
  are now named separately: classification (`is_class` — what the node
  represents), parent relationship (`parent_id`), and embedding (`is_embedded`
  — whether the node's content belongs to the parent's body). The wire render
  bit `presentAsMain` is retired outright and replaced by `isEmbedded` with
  inverted polarity (`is_embedded = 1 - present_as_main`): `true` (the
  DEFAULT for parented nodes) = embedded in the parent's body — the Block
  role; `false` = a standalone structural element under that parent — the
  Page role. Page/Block stay the user-facing words, re-documented as
  structural roles of one node kind; an entity (a classified meeting, quote,
  city) is independent of its role. Wire: `object.create`/`object.update`
  carry optional `isEmbedded` (strict schemas reject `presentAsMain`); the
  query AST condition/sort/aggregation rename with inverted values; the
  parent-page condition (owner ruling 2026-10-15) is preserved — a
  standalone claim under a non-page parent still fails loud (MoveGuardError),
  now expressed as the `isEmbedded: false` claim. Store: derived schema v21
  (column rename + inversion via a table rebuild; class rows converge to 0 so
  the ladder and the appliers' canonical writes meet); applier defaults
  parentless → 0, parented → 1; promotion = the false claim and still
  stringifies. **Link-based display transformation (new behavior):** a block
  whose ENTIRE content is a single mention/link presents the referenced node
  in its place — the web editor renders the target's content inline in place
  (transclusion-style, the EmbedView presentation + its cycle guard),
  regardless of the target's structural role; a link mixed with other content
  keeps the ordinary chip; presentation only (the contentAst stays a mention —
  editing, sync, undo untouched). **Export zone split (new behavior):** a
  parent's exported body carries the EMBEDDED children only; standalone
  children render as a separate Pages section in the markdown/html
  serializers (previously zone-blind nested bullets; the PDF and the zip
  already split). The JSON archive bumps to version 2 (the renamed boolean).
  Web: the query builders relabel the family as "Structural role" (Page
  (standalone) / Block (embedded in body)); the drag-drop zone flip, the
  context-menu gestures, and the undo-journal labels ride the toggle.
  Server: the REST API renames the filter/payload/projection. Scripts:
  `migrate-is-embedded.mts` (kind B — payload + embedded query-AST rewrite,
  snapshots dropped, derived DBs rebuilt, restore_epoch bumped; NO mixed
  window: old code rejects `isEmbedded`, new code rejects `presentAsMain` —
  stack down → new images → migration → restart); the pending-window
  migration scripts modernized; `migrate-main-parent-page`'s test retired
  with its closed window (the script stays as the historical artifact, the
  `migrate-node-type.mts` treatment). Fixtures: gate 30→31 —
  `object-is-embedded.json` added, `present-as-main-parent-page.json` renamed
  to `is-embedded-parent-page.json`. Docs: SCHEMA.md "Node structure"
  Revision 12, AGENTS.md invariant, philosophy.md, ux.md, usage.md, the
  developers/ runbooks, the project skill references. **Verification:**
  `pnpm typecheck` + `pnpm test` green (protocol 404, store 575, domain 92,
  query 203, export 243, server 232, web 1711); new store tests pin the
  defaults/explicit-claim/toggle chain and the legal explicit-embedded claim
  under any parent; new web tests pin the link-only transclusion (inline
  render, mixed-content negative); new export tests pin the zone split in
  markdown + html. **SHIPPED 2026-10-16 (same day):** the GTK (804 tests +
  ruff + mypy), Flutter (641 tests + analyze), and CLI (87 tests + pin bump
  to converged main) ports converged on the renamed fixture corpus, and the
  kind-B rollout ran in a stopped-server window — stack down → new images →
  `migrate-is-embedded.mts --apply` (32,371 payload rewrites, zero unmapped,
  zero stored query-AST references; snapshots dropped, derived DBs rebuilt,
  restore_epoch bumped; backup at `relay.db.bak-20261016-144149`) → up →
  full-log rehydrate (~40 min of CPU-bound replay with the v20 indexes,
  event loop blocked — expected, one-time) → `verify-min.mjs` VERIFY-PASS.
  Live probe in the test workspace: defaults and explicit claims store
  correctly, the `isEmbedded` list filter selects blocks/pages, the
  parent-page guard 422s a standalone claim under an embedded block, and the
  zip export splits the zones both ways; probe data permanently deleted.
- **fix(web): the four carried-forward re-audit notes close — export
  selected signal joins the established register, residual renderer px
  literals convert (the board/calendar notes verified already closed by
  the 2026-10-15 owner-rulings slice).** The re-audit's carried-forward
  list (`.audits/design-system-2026-10-15-reaudit.md`) walked against
  HEAD: CardsBoard's columns/min-heights and the calendar title button's
  hover were already closed by `fdc31c65` (the clamp + token min-heights
  and the hover-overlay ruling verified in place, unchanged here). The
  export modal's format cards had that slice's one miss — a primary
  hairline ring + 600 label, a third selected variant next to the app's
  established register; it retires in favor of the shared Card's
  `card--selected` (primary-container fill + primary border), the same
  register as the Dropdown's selected option, already applied via the
  Card's `selected` prop — the local CSS overlay (ring, radius, label
  weight, icon tint) is deleted. The renderer note's headline literals
  were already on tokens; this pass sweeps the co-located residue it
  missed: the code-block margin (4px → `--spacing-1`), the badge/pre
  hairline borders (1px → `--border-width-default`, the component idiom —
  no px kept), inline `code`/`mark` paddings (4px/2px → `--spacing-1` /
  `--spacing-micro`), the cover-picker popover offset (calc 4px →
  `--spacing-1`), the cover placeholder gap (2px → `--spacing-micro`),
  and the placeholder-name ellipsis cap (160px → `--layout-size-xl`, the
  exact token). No visual density changes; sidebar, top bar, and canvas
  surfaces untouched. **Verification:** `pnpm typecheck` + `pnpm test`
  green; web-only — no wire touch.
- **fix(web): the drift sweep's criticals and warnings — range-syntax media
  queries, the hover register on palette/calendar rows, 44px floors and
  pressed states, the §7 row register on hubs (design-system alignment
  sweep 2026-10-16).** The two Criticals were §8 legacy media syntax in JS
  matchMedia strings — the re-audit's normalization claim missed these two
  sites: `useIsMobile` now builds `(width <= <bp>px)` from the token
  breakpoint, and the sidebar's open-by-default gate keeps its deliberate
  801px threshold (a non-register value — noted at the call site, behavior
  preservation over breakpoint purity) in range syntax `(width >= 801px)`.
  Warnings: the palette cursor is a genuine active state — mouse hover
  drives `activeIndex` AND ArrowUp/Down moves it — so the row keeps
  primary-container via the hover ruling's combined-rule pattern
  (`--active, --active:hover`), with plain `:hover` on the overlay and a
  pressed layer added; the calendar's has-note day (grid + popup — one
  convention) joins the same combined rule at label weight 600, and the
  popup's generic hover now sits alongside instead of washing the fill.
  The comments Reply/Delete and trash restore/delete-permanently actions
  (24–28px) gain the invisible 44px `::after` hit-area overlay (the
  Slice-B calendar pattern) plus `:active` pressed layers; the journals
  Today + empty-state CTA, the settings theme buttons, and the palette rows
  gain pressed layers too (the filled primary CTA presses with
  `primary-pressed`, the Button.css register). The settings accent swatch
  drops the hover `scale(1.15)` (not in the tactile map — the
  IconPickerPopup precedent) for the state-layer overlay (an inset
  `::after`, since the accent fill is inline) and the five swatches expose
  `aria-pressed` in their `role="group"`. The §7 list-row register converges
  on the hub rows: task-bucket, calendar-view, and trash names at 14px/600
  with the single-line ellipsis contract kept, secondaries at 12px muted;
  the shortcuts group title cites `--letter-spacing-section`. Specs:
  new `hover-press-register.test.ts` CSS-source pins (palette contract,
  hit-area overlays, pressed layers, the §7 rows, the range-syntax
  call sites), calendar pins in `calendar-hit-area.test.ts`, an
  `aria-pressed` assertion in `settings-page.test.tsx`. The sidebar, top
  bar, and canvas surfaces stay untouched per the override register.
  **Verification:** `pnpm typecheck` + `pnpm test` green; web-only — no
  wire touch.
- **fix(web): the extract rows read "Extract without children" / "Extract
  with children", and the flyout rides flush against the menu — no overlap
  (owner feedback 2026-10-16).** The labels name what the extracted node
  keeps, from its own perspective — it is the same node becoming a page,
  not a new one — and stay short for the row; the hover tooltips carry the
  full explanation (link block in its place, children under the link or
  with the block). The flyout's 4px overlap (the original "hover bridge")
  visually covered the parent rows' right edge; it retires — enter-only
  hover semantics never needed it (leaving the parent fires no close, and
  crossing to the panel hits no handler), so the panels now share a flush
  edge. Same pass in the design system's web-patterns submenu entry and
  the ui-primitives catalog line. **Verification:** `pnpm typecheck` +
  `pnpm test` green (menu specs assert the new labels and the tooltip
  strings); web-only — no wire touch.
- **fix(web): the Convert to page extract rows read short — "Children stay
  here" / "Children follow" — with the full explanation on hover tooltips
  (owner feedback 2026-10-16: "Extract to root — children stay here" is too
  long for a menu entry; move the text to a hover tooltip).** The
  description-line experiment (visible muted second line, shipped hours
  earlier) is replaced by the native `title` tooltip on submenu items — a
  new optional `tooltip` on ContextMenuItem, zero new chrome. Hovering
  either extract row now spells it out: the block becomes a ROOT page (the
  same node, parent_id removed — never "a new page"), a link block takes
  its exact place, and the children stay under the link or with the block.
  "Keep under" gains a tooltip too. The `description` field and its stacked
  label CSS retire unused. Docs: `usage.md` item 17. **Verification:**
  `pnpm typecheck` + `pnpm test` green (menu specs assert the short labels,
  the exact tooltip strings, and that no explanation text renders in the
  row); web-only — no wire touch.
- **fix(web): "children stay here" actually keeps the children — the
  extraction plans its reparenting from a FRESH children read, not the
  render cache (owner report 2026-10-16: the children stayed with the
  extracted page).** Same stale-cache family as the slot bug: the
  WorkerClient's `getChildren` is a `cachedRead` that answers a cold key
  with the empty default before the refresh round-trip — the composition
  planned zero child moves and the children silently rode along with the
  extracted node. The write-composition surface now requires
  `getChildrenFresh`: on the worker it is one raw RPC straight to the
  store (cache bypassed); in-process it aliases the already-fresh read.
  The regression spec stubs a cold cache (cached read always `[]`) and
  pins that the child moves still fire in order. Same pass, the owner's
  wording ruling: the "children follow" description no longer says "the
  new page" — the page is NOT new, it is the same node with its
  parent_id removed: "…the children stay with the block — the same node,
  now a root page." Docs: `extractToPage.ts` surface contract.
  **Verification:** `pnpm typecheck` + `pnpm test` green (new stale-cache
  regression spec; description-line specs updated); web-only — no wire
  touch.
- **fix(web): the Convert to page link block inherits the block's exact
  sort slot, and the extract rows say a link block is left in place
  (owner feedback 2026-10-16: "the new created block is moved to be the
  last sibling… no info tooltip that a node link will be placed").** The
  extraction anchored the link block via a SIBLING lookup (afterId the
  previous sibling) — a stale cached children read could miss the block or
  mis-order siblings, and the no-anchor fallback appended the link as the
  last sibling. Now the create carries `beforeId` THE BLOCK ITSELF: the
  applier's beforeId midpoint lands the link immediately ahead of the
  source on every position (first, middle, last, only child), and the
  source's departure completes the hand-off — the anchor node is always
  present in the store, so the stale-read failure mode is gone. The sibling
  read and its anchor branches retire; the composition reads only the
  block's children now. Menu clarity: ContextMenu items grow an optional
  `description` (a muted second line under the label), and both extract
  rows carry one — "A link block takes its place; the children stay nested
  under the link." / "…the children move with the new page." — the
  link-block placement is stated in the menu, not just the docs. Docs:
  `packages/protocol/SCHEMA.md` extraction leg 1. **Verification:** `pnpm
  typecheck` + `pnpm test` green (composition asserts pin `beforeId` the
  source; NEW real-store integration specs assert the slot for middle,
  first, last, and only-child extractions plus the children-stay reparent
  order; menu specs pin both description lines); web-only — no wire touch.
- **perf(store): the v20 bulk-replay read indexes — `node(aliased_node_id)`
  and `node_child_order(child_id)` (owner follow-up 2026-10-16: "index
  whatever is needed so these problems don't happen in the future").**
  The parent-page migration dry-run profiled two full-table scans that made
  a 50k-op log-tail replay ~20× slower than live-paced application: every
  `reresolveEdgeTargets` alias-closure walk scanned `node` for want of an
  `aliased_node_id` index, and the child-order-by-child cleanup scanned
  `node_child_order`. Both are invisible one-op-at-a-time on the live server
  (a few milliseconds per user gesture) and dominant at bulk-replay scale —
  exactly the shape the v15 list-reads index fixed for render bursts. The
  indexes ship as schema v20 (the LIST_READS/RESOLVED_TARGET precedent:
  constants outside the canonical DDL — pre-v16 tables lack the alias
  column — plus a version-gated ladder step and an explicit re-assert on the
  snapshot-repair path), so every existing derived DB self-heals at next
  open, restored snapshots migrate inside `Store.restore`, and the browser
  worker's OPFS DBs gain them on next boot. `scripts/migrate-main-parent-page.mts`
  drops its migration-local helper indexes (its scratch stores are v20
  now). Semantics are untouched — pure derived-state acceleration, so no
  fixture gate (no op/wire change); the GTK/Flutter ports may add the same
  indexes in their own derived stores whenever convenient. **Verification:**
  `pnpm typecheck` + `pnpm test` green (new pinning tests: fresh stores
  carry both indexes at v20; a v19-stamped store migrates and gains them —
  both adapters).
- **fix(web): three register deviations retired — calendar cells, context-column
  type, and editor row chrome align with the skill (the 44px floors via the
  invisible hit-area overlay, the §7 list-row type register; owner ruling
  2026-10-16: the selection tradeoff on inline chrome is accepted).** The
  100%-alignment program's first fixes, one per retired override entry.
  **Calendar date-grid cells**: the shared day grid, the WeekStrip, and every
  month/year pick (MonthCalendar, the top-bar popup, the datepicker) keep
  their visible grid geometry exactly as-is and gain the skill's invisible
  `::after` hit-area overlay (`max(100%, var(--button-min-height))`, centered)
  so each cell's interactive area reaches ≥44×44; the range-aware dated dot
  moved from `.dated::after` to a real span so the overlay owns the
  pseudo-element. **Context-column feeds**: the Activity log, Version
  history, and Comments rows (the ~340px right rail) ride the §7 list-row
  register — primary 14px/600 on-surface, secondary 12px muted — replacing
  the 12px/400 + 10px dense register; the Comments row keeps its
  single-line ellipsis contract. **Editor row chrome**: the condensed
  layer's "…" mark and hidden-links badge (22px visible) and the collapse
  chevron (14px glyph in the gutter) carry the same 44px overlay; the
  chevron self-reveals on overlay hover so it is never an invisible
  click-eater, and the bullet keeps its hit priority above the overlay.
  The three register entries ("Calendar and date-grid cells ride the panel
  width", "The context column rides a dense type register", "Inline row
  chrome rides a 22px tap floor") are deleted from
  `.agents/design-overrides.md` — nothing to register: the app matches the
  skill. **Verification:** `pnpm typecheck` + `pnpm test` green
  (`calendar-hit-area` pins the overlay contract across the four calendar
  stylesheets; `condensed` + `context-column` pin the overlay + type
  registers); web-only — no wire touch.
- **docs(design): the 100%-alignment program opens — sidebar, top bar, and
  canvas chrome are the documented exceptions; everything else is in scope
  (owner ruling 2026-10-16).** The owner directed the app to 100% alignment
  with the RosellRamos design system except three surfaces: the sidebar, the
  top bar, and on-canvas chrome (whiteboard/graph/presentation). Registered
  as one entry in `.agents/design-overrides.md` per the override contract —
  the exceptions are documented decisions, and every other deviation
  (documented or not) is drift to fix. The program then works the known
  list: the three fixable register deviations (calendar date-grid cells,
  context-column dense type, editor row-chrome floors), the four
  carried-forward notes from the 2026-10-15 re-audit (calendar title hover
  ink, export-modal selected signal, CardsBoard geometry, content-renderer
  px literals), and a fresh §1–§10 walk of the surfaces the re-audit did
  not sweep. **Verification:** docs-only slice — the register is the
  record; no runtime change.
- **fix(web): the app implements the skill's elevation table instead of
  registering its drift — floating layers regain their shadows, the menu
  cites Material roles directly, and the token gate now rejects both
  failure modes for good (owner ruling 2026-10-16: "don't override in the
  app", "make sure this never happens again").** The previous slice had it
  backwards: Card zeroed every elevation level (contradicting the skill's
  elevation table, which gives popovers/menus a soft level-1 shadow), and
  that drift was about to be registered as a project override while a menu
  cited the app alias `--md-sys-color-sidebar-card`. Corrected at the
  source: `variables.css` gains the table's shadow values as
  `--shadow-floating` (level 1) / `--shadow-modal` (level 2), per theme;
  Card's elevations map to them (`medium` = level 1, `high` = level 2,
  static stays shadow-free); ContextMenu and Dropdown move to `medium`
  (menus/popovers are level 1), Modal keeps `high`. The menu root and
  flyout cite `--md-sys-color-surface-container-high` — the top of the
  skill's card ladder — directly, and the design-overrides entry from the
  previous slice is deleted (nothing to register: the app matches the
  skill). **Never again, enforced:** css-token-drift gains check 7 —
  definitions in the `--md-sys-color-*` namespace must be canonical
  Material roles or registered extensions (with a reason), and a surface
  alias may only be cited on its home files. The skill itself gains the
  standard (`tokens.md` → Namespace hygiene). **Verification:** `pnpm
  typecheck` + `pnpm test` green (drift check 7 incl. its first live catch
  — the alias itself was unregistered; `submenu-chevron` pins the new
  surface + the elevation mapping); web-only — no wire touch.
- **fix(web): floating context menus ride the raised chrome surface — the
  sidebar color — instead of vanishing into the backdrop (owner feedback
  2026-10-16: "menus get lost over the background color").** The menu card
  used base `surface` (≈8% primary tint) over a page card of nearly the
  same tone, and this app bans elevation shadows (Card zeroes every
  elevation level) — so a floating menu had nothing separating it from
  what sat behind it. Now the menu root and its flyout submenu ride
  `--md-sys-color-sidebar-card` — the same step the nodeview sidebars
  use (`surface-container-highest` in the dark theme), the top of the
  container ladder per the design system's "pick the surface step by the
  elevation of content" rule: with no shadow to do the work, the step
  carries the whole separation. Scoped to the context menu (the sole
  `radius="floating"` consumer); modals keep their scrim-backed register.
  Registered in `.agents/design-overrides.md` with a review trigger.
  **Verification:** `pnpm typecheck` + `pnpm test` green (the
  `submenu-chevron` CSS-source spec pins the raised surface on both the
  menu root and the flyout); web-only — no wire touch.
- **fix(web): the flyout submenu renders again — the menu card no longer
  clips it (owner report 2026-10-16: submenu invisible even on click).**
  The flyout paints past the menu card's right edge, and the card radius
  class (`.card--radius-floating`) sets `overflow: hidden` — so the first
  deployed flyout was cut from view entirely (jsdom asserts structure, not
  paint, so the gate stayed green; a CSS-source pin now guards the
  override). The menu card overrides back to `overflow: visible` with a
  specificity-qualified rule (`.card.context-menu`, no `!important`); the
  rows inside still can't bleed — they are inset by the card padding and
  carry their own radius. Same caveat recorded in the design system's
  web-patterns submenu entry. **Verification:** `pnpm typecheck` + `pnpm
  test` green (the `submenu-chevron` CSS-source spec now pins the menu
  card's `overflow: visible` alongside the flyout's absolute positioning);
  web-only — no wire touch.
- **fix(web): submenus fly out to the side of the parent row (the Notion
  pattern) instead of expanding inline — ending the grow-then-refit dance
  at the viewport's bottom edge (owner feedback 2026-10-16).** The inline
  expansion grew the menu's own box: near the bottom the taller menu no
  longer fit, the whole menu flipped above the cursor, and the next cursor
  move collapsed the submenu and flipped it back. Now the submenu renders
  as a second card positioned absolutely INSIDE the menu card but outside
  its flow — its box never affects the menu's, so the menu's fit is
  stable no matter how the submenu opens or closes. The flyout rides to
  the right of the parent row (overlapping the menu edge by a hair as a
  hover bridge, aligned to the row's top), flips to the left side when the
  right lacks room, and clamps vertically into the viewport — all written
  imperatively in the same positioning pass as the menu itself (scroll,
  resize, and element resize re-run it). Both submenu forms fly out: the
  native `submenuItems` action list and custom `submenu` content (the
  whiteboard color row). The inline-expansion CSS (panel borders, expand/
  collapse keyframes, subitem indent, chevron rotate) retires; Escape and
  outside-press semantics are unchanged (submenu first, then the menu).
  Docs: `ui-primitives.md` ContextMenu catalog sentence. **Verification:**
  `pnpm typecheck` + `pnpm test` green (`submenu-chevron.test.tsx` pins the
  flyout's absolute positioning and asserts the panel is a second card
  inside the menu card); web-only — no wire touch.
- **fix(web): the submenu chevron and the breadcrumb separator read at full
  strength, and submenus open on hover over their parent line (owner
  feedback 2026-10-16).** Both chevrons rode `--md-sys-color-outline` — a
  border token, nearly invisible as a glyph color on the dark card — and the
  menu's was a thin `›` text glyph on top. Now: the menu chevron is the mdi
  sprite's `chevron-right` (size 0.8, `aria-hidden` so the menuitem's
  accessible name reads clean — "Copy", not "Copy ›") and the breadcrumb
  trail separator bumps 0.7 → 0.75, both in `--md-sys-color-on-surface-variant`
  (the Material icon role). Hover seam: entering a submenu's parent line
  opens its inline panel on pointer-fine devices (`(hover: hover)` —
  touch keeps the tap as the explicit toggle, since a synthesized
  mouseenter would open the panel a moment before the click collapses it),
  and entering a plain item closes the open panel; the panel itself carries
  no handler so the pointer can travel into the subitems. Docs:
  `ui-primitives.md` ContextMenu catalog sentence. **Verification:** `pnpm
  typecheck` + `pnpm test` green (new `submenu-chevron.test.tsx`: hover-open,
  hover-close, touch inertness, sprite chevron, CSS-source pins on both
  rules); web-only — no wire touch.
- **feat(web): the node context menu groups its two ambiguity-prone surfaces
  into submenus — Convert to page › (keep under parent vs extract to root,
  children staying or following) and Copy › (markdown / with children / node
  id / link) — retiring the Shift-click badge and the standalone Move to
  Pages item (owner decision 2026-10-16, second pass).** Yesterday's
  extraction shipped as a flat "Convert to page" with a cryptic "⇧ children
  follow" badge next to the pre-existing "Move to Pages" — two siblings that
  read as synonyms, plus an undiscoverable modifier. Now one self-describing
  bucket per intent, each variant a plain click: **Convert to page ›**
  (inline blocks only; date-chain nodes still never offered) offers *Keep
  under "\<parent\>"* (the `presentAsMain` zone flip — content still
  flattens, so the BC4 confirm names what will flatten, now titled
  "Convert to page?"), *Extract to root — children stay here* (the link
  block takes the slot; children reparent onto it, order preserved), and
  *Extract to root — children follow* (the link block simply replaces the
  block). Root sits in both extract labels on purpose — the node leaves its
  parent entirely, the distinction the owner asked for. **Copy ›** replaces
  the lone "Copy link" item: *Markdown* (the node's own content via
  `renderContent`), *Markdown with children* (the inline block tree as
  nested bullets via `nodeToMarkdown`, frontmatter OFF — the export package
  gains the `includeFrontmatter` option, default ON for every download
  path), *Node id* (the raw UUID for CLI/API use), and *Link*. The
  ContextMenu primitive grows the native `submenuItems` action-list form
  (custom `submenu` content still rides alongside — the whiteboard color
  row): subitems render indented with the item styling, fire their own
  onClick, close the whole menu unless `keepOpen`, and stay out of the
  arrow-key walk. `extractBlockToPage` is unchanged (`keepChildren` is the
  seam); the menu's client surface and the export composition now share the
  structural `ExportReadSurface` instead of the concrete client union.
  Docs: `docs/usage.md` web-app items 17–18, `docs/ux.md` flip clause,
  `packages/protocol/SCHEMA.md` extraction leg 3, `ui-primitives.md`
  ContextMenu catalog line. **Verification:** `pnpm typecheck` + `pnpm
  test` green (new `copy-submenu.test.tsx` against the real client with a
  stubbed clipboard; `render-cascade` zone specs rewritten for the submenu
  flow; export package's `includeFrontmatter` spec incl. the defaults-bag
  pin); web + export packages touched — no wire change.

- **fix(web): offline, every remembered workspace stays listed — the ones
  without a local copy render muted with a cloud-off marker instead of
  hiding (owner ruling 2026-10-16).** The registry slice offered only the
  workspaces holding a synced copy; the rest of the account's workspaces
  vanished from the switcher and the manager during an outage, which read
  as data loss. Now the offline fallback lists every remembered workspace:
  rows/cards without a copy on this device stay visible but inert — reduced
  opacity, a `mdi-cloud-off-outline` marker, a disabled open/switch with an
  honest title ("Not available offline — open it once while online to keep
  a copy on this device"), and a "Not on this device" meta line on the
  manager card — while the local ones keep switching normally. Captions name
  the rule ("Offline — workspaces without a copy on this device can't
  open"). `offlineWorkspaceList()` retires; the surfaces list
  `rememberedWorkspaceList()` and mark availability per row via
  `localWorkspaceCopies()`. Docs: `usage.md` account-boot clause.
  **Verification:** `app-smoke.test.tsx` case updated (Orchard present,
  disabled, muted, titled; the local Garden still opens); `pnpm typecheck`
  + `pnpm test` green. Web-only — no wire touch.

- **feat(web): a block's context menu converts it to a page — a mention link
  block takes its slot, children stay by default, Shift/Ctrl/Cmd-click
  carries them over (owner request 2026-10-16).** New **Convert to page**
  item on inline blocks (pages and parent-locked date-chain nodes never
  offer it): the block leaves its parent and becomes a root page — identity
  and rich content preserved (unlike the `presentAsMain` promotion, an
  extraction does not stringify) — while a fresh link block holding one
  `mention` of it lands in the block's exact slot (m2 `afterId`/`beforeId`
  anchors), so the page keeps reading where it did. By default the block's
  children STAY in the original page, reparented onto the link block in
  their order (`object.move` afterId chaining); **Shift/Ctrl/Cmd-click**
  instead carries the children over to the extracted page (the badge
  "⇧ children follow" names the variant — then only the link-block
  replacement lands). The gesture is a client composition of existing
  carriers — `object.create` + `object.move`s, no new op type, zero applier
  changes (the Node merge precedent) — composed by the new
  `extractBlockToPage` (`apps/web/src/core/extractToPage.ts`), with loud
  client-side guards before anything reaches the log. Docs: `docs/usage.md`
  web-app list item 17; `packages/protocol/SCHEMA.md` "Block → page
  extraction". **Verification:** `pnpm typecheck` + `pnpm test` green
  (new `apps/web/test/extract-to-page.test.tsx`: composition anchors +
  child-order chaining + keepChildren + guards, menu presence/badge/
  modifier-click wiring); web-only — no wire touch.
- **fix(web): all locally-copied workspaces stay reachable offline — the
  device-local workspace registry backs the switcher and the manager
  (owner question 2026-10-16).** The outage-resume slice opened the
  remembered workspace locally but left the workspace *list* server-only:
  every workspace the user had ever opened on the device already holds a
  full local copy (the OPFS worker store is keyed by workspace id), yet the
  switcher and the manager fetched the list live and showed an error when
  it failed — so offline, the other workspaces were unreachable. New
  `apps/web/src/core/workspace-registry.ts` persists the device-local
  chrome the derived stores intentionally don't carry (the list is not
  op-log data): the last server list seen (`notees.workspaces`, replaced
  on every successful fetch, rename-aware) and the ids this device has
  booted (`notees.localWorkspaces`, a superset proxy for "has a local
  copy"). When the list fetch fails, the switcher and the manager fall
  back to the remembered entries that hold a local copy — openable now,
  switching included — under an explicit "Offline — showing workspaces
  stored on this device" caption; server-only affordances wait for
  recovery instead of failing loudly (switcher: per-row settings gear and
  the create suggestion; manager: create/rename/delete/export, read-only
  otherwise). The offline-resume label reads the registry too, so the
  topbar shows the real workspace name while the server is down.
  Boundary, by design: a workspace never opened on this device has no
  local copy and is not offered offline; a server-side delete lingers in
  the registry until the next successful list fetch. Docs: `usage.md`
  account-boot clause. **Verification:** new `app-smoke.test.tsx` case
  (offline switcher + manager fall back to the local copy, non-local and
  server-only surfaces stay hidden); `pnpm typecheck` + `pnpm test` green.
  Web-only — no wire touch.

- **fix(web): a server outage on load no longer signs the user out — the
  remembered workspace opens from its local copy and syncs on recovery
  (owner report 2026-10-16).** Fresh tab with the server down used to land
  on the "select a sync server" screen — and, worse, the boot resume treated
  the network failure as an invalid credential: it cleared the stored
  session/API key, so even after the server returned the user had to sign in
  again. Clicking "Work offline" from there opened the separate device-local
  workspace, so the user's workspaces read as gone. Now the resume effect
  distinguishes the two failure classes: a 401/403 (`AuthRequestError`,
  new typed error in `auth-api.ts` carrying the HTTP status) still clears
  the credential and lands on the sign-in screen, while an unreachable or
  erroring server keeps the credential and `connect()`s to the remembered
  workspace in the normal online mode — the worker store already boots from
  local bytes when the relay is down, the `BackendUnavailableOverlay`
  banner reports "working locally until it recovers", and the realtime
  transport's backoff reconnect catches up when the server returns. The
  in-process store fallback (`connect()` in `App.tsx`) now swallows the
  bootstrap sync failure the same way `WorkerCore.create` already did, so
  the degraded path behaves identically in both store modes. With no
  workspace remembered yet, the server form shows with the credential
  intact. The no-account "Work offline" flow (device-local workspace) is
  unchanged. Docs: `App.tsx` boot-flow header + `docs/usage.md` account-boot
  clause. **Verification:** new `app-smoke.test.tsx` cases (unreachable
  server keeps the credential and opens the remembered workspace with the
  degraded banner; no remembered workspace keeps the credential on the
  server form); `pnpm typecheck` + `pnpm test` green. Web-only — no wire
  touch.
- **feat(model): the parent-page condition — a parented node is a page only
  when `present_as_main = 1` AND its parent is also a page (owner ruling
  2026-10-15).** The Revision-11 render cascade gains its second conjunct: a
  class or an inline-block parent makes the render bit inert — the node
  renders inline in the parent's body. Per the impossible-states law the
  invariant is write-time enforced and render assumes it: the applier fails
  loud (`MoveGuardError`, the quarantine-compatible error class, so
  historical violations never brick a fresh replay — the date-chain-locks
  precedent) when `object.create` or a promotion claims the bit under a
  non-page parent, when `object.move` carries a main node under a non-page
  parent, and when a parented page with `present_as_main` children is
  demoted (demote or move the children first). The domain predicates
  `rendersWithDocumentChrome` / `rendersAsInlineBlock` take an optional
  parent-facts argument (omitted = the stored invariant is trusted); every
  web call site with the client at hand now passes the parent, the
  ancestor-walk reads (query-result routing, class-member routing, backlink
  breadcrumbs, containing-page labels) honor the condition mid-walk, and the
  context menu hides "Move to Pages" where the store would reject it. SQL
  read paths (search scopes, pages listings, the query compiler) need no
  parent join: the invariant makes `present_as_main = 1` equivalent to
  "renders with document chrome" over stored data. Old logs: the one-time
  migration `scripts/migrate-main-parent-page.mts` (dry-run default) is
  snapshot-anchored (the relay prunes compacted envelopes, so violations
  born below the snapshot horizon live in the snapshot bytes): tail
  envelopes claiming the bit under a non-page parent are rewritten in place
  (`presentAsMain: true → false`), snapshot-baked rows are cleared by
  derived-state surgery (the patched bytes replace the snapshot blob), and
  historical move/demote-class breaches replay-quarantine rather than
  rewriting.
  Test workspace verified clean by a dry-run (zero rewrites). Fixture gate:
  `present-as-main-parent-page.json` pins the throwing scenario (30-fixture
  list), the store suite pins the guard matrix on both adapters, and
  `apps/web/test/migrate-main-parent-page.test.ts` pins the migration's
  walk/verify core (deep-as-of cascade included). **LOCKSTEP-PENDING: the
  GTK/Flutter ports converge on the new fixture before the marker clears.**
  Docs: SCHEMA.md "Node structure", `docs/developers/architecture.md`,
  `AGENTS.md` + the notees-development skill reference, the fixture table in
  `docs/developers/development.md` §3, the migrations catalog. Semantic
  consequences worth knowing: a class has no child pages anymore (its
  children are inline body children), and promoting a block whose parent is
  a block now requires moving it under a page first.
  **Verification:** `pnpm install && pnpm typecheck && pnpm test` green;
  migration dry-run against the test workspace (`c491595f-…`) reports a
  clean log. The owner's live workspace needs the same dry-run, then a
  stopped-stack `--apply` (the script prints the exact steps).

## 2026-10-15

- **fix(web): focus mode reads centered again — the 46rem cap returns inside
  the panelled layout (owner feedback 2026-10-15, second pass).** The first
  pass kept the panelled layout's full-width columns in focus mode; the
  owner's verdict: full-bleed read worse than the old centered column. Now
  the content column caps at the compact layout's 46rem measure and centers
  inside the card (`margin-inline: auto`), with the compact layout's
  spacing-6 lateral padding carried inside the cap — the panelled spacing/
  chrome behavior stays (both panels, toggles, classes cluster hidden; view
  switcher + node menu on the full-width top bar), only the measure is
  comfortable again. CSS-source spec in `apps/web/test/focus-mode.test.tsx`
  (the `[data-focus="true"] .nt-page--panelled .nt-page-content` rule: 46rem
  cap, centered, spacing-6 padding, no row-spacing overrides). Docs:
  `docs/ux.md` focus-mode clause. **Verification:** `pnpm typecheck` +
  `pnpm test` green; web-only — no wire touch.
- **fix(web): focus mode keeps the panelled spacing and hides the chrome;
  the collapse line rides the parent bullet (owner feedback 2026-10-15).**
  Focus mode previously fell back to the compact layout — the page snapped
  into a 46rem centered column, which read as condensed in the block list.
  Now the panelled main layout stays on in focus mode: the content column
  keeps the full-width normal spacing, and the chrome simply doesn't
  render — both side panels (properties + context; the device collapse
  prefs untouched, exiting focus mode restores them exactly), the nodeview
  top bar's panel toggles + classes cluster (dead chrome while the panels
  are hidden), plus the already-suppressed banner/cover/icon/tags/
  properties/system sections/footer. The view switcher, the condensed
  chrome, and the node menu stay — the page is still a working surface.
  Same pass: the outline's vertical collapse line (the `.nt-block-children`
  left border + rail) moved from a 20px to a 24px indent so it rides the
  parent bullet's center (14px chevron gutter + half the 22px bullet ≈
  25px — the line sat a noticeable step to the left); the in-flow block
  metadata indent rides the same grid, and the 48px child-drop line/zone
  now lands within ~1px of the child row's actual start. Specs updated in
  `apps/web/test/focus-mode.test.tsx` (panelled root class + top bar stay,
  both panels + toggles + classes cluster asserted hidden). **Verification:**
  `pnpm typecheck` + `pnpm test` green; web-only — no wire touch.
- **fix(web): the pinned cue becomes a filled chip; the bullet ring retires
  (owner feedback 2026-10-15).** The owner's screenshot verdict on the first
  cue — "looks weird. Making the … a solid fill like the other toggle
  buttons would be better, and dropping the bullet indicator." The pinned
  "…" is now a SOLID-FILLED toggle chip in the app's active-toggle register:
  the exact fill the focus-mode TopBar button's `nt-icon-btn-active` wears
  (`--md-sys-color-primary-container` / `--md-sys-color-on-primary-container`,
  `--shape-medium` radius), riding the mark's 22px hit zone, the fill held
  through hover/pressed (the active-toggle precedent). The contrast pair:
  muted mark = closed, filled chip = open. The bullet ring is gone
  completely — its `nt-block--pinned` root class (no other consumers), the
  `::after` ring rules, and the editing/cards suppressions all retire; the
  chip is the single cue in outline, prose, and cards alike. Specs updated
  in `apps/web/test/condensed.test.tsx` (chip class + fill/radius pinned by
  the CSS-source spec; the ring hooks asserted absent). **Verification:**
  `pnpm typecheck` + `pnpm test` green; web-only — no wire touch.
- **feat(web): the pinned block reads at a glance — accent …, outline
  bullet ring (owner ruling 2026-10-15).** Two cues, both quiet, no row
  chrome beyond them: (1) the pinned row's trailing "…" toggle wears the
  ACCENT treatment at rest (`--md-sys-color-primary`, full opacity — the
  accent every engagement surface wears; hover/pressed get a faint accent
  state-layer) — the control expresses its own state: muted = "more
  available", accent = "open". The condensed row's "…" stays muted. (2) In
  outline mode a pinned block's bullet wears a small accent ring — a 1.5px
  outline (`color-mix` 70% primary), the bullet stays a bullet, distinct
  from the collapse ring's filled tint. Prose hides bullets and cards
  content rows carry the cue on the mark alone — no bullet ring there. The
  editing highlight wins: while a pinned block edits, its bullet keeps the
  accent fill and the ring is suppressed; the ring returns on blur. No row
  backgrounds, no borders, nothing else touched. Specs in
  `apps/web/test/condensed.test.tsx` (accent modifier on the pinned mark,
  `nt-block--pinned` root class, CSS-source specs pinning the accent rule,
  the ring, and the editing/cards suppressions). **Verification:** `pnpm
  typecheck` + `pnpm test` green; web-only — no wire touch.
- **feat(web): the condensed layer's … is the toggle — the pin and condense
  buttons retire (owner ruling 2026-10-15).** The permanent muted "…" (the
  classic stretchtext mark) becomes the layer's ONE control in both
  directions: on a condensed row it is a real tappable button (generous hit
  padding — it is a small glyph; visually the same muted mark, `title`
  "Show full content") that pins the block; on a pinned row it returns at
  the END OF THE TEXT — inline after the last word, wherever the text wraps,
  not the row's right edge (the detached placement was the owner's
  complaint) — tap to un-pin (`title` "Condense"). The lens pin button and
  the back-arrow condense button are deleted with their CSS; no replacement
  icons — the mark is the affordance. The hidden-links badge never rides a
  pinned row (all text visible, the hidden count is 0 by definition).
  Everything else holds: click-to-edit on the body, blur re-condenses only
  the un-pinned, the stretched set stays purely mark-pinned, condense-all
  stays on the nodeview bar. Specs rewritten in
  `apps/web/test/condensed.test.tsx` (mark pins/unpins with storage
  asserted, retired controls gone, mark aria labels, tap-floor CSS source
  spec); `docs/ux.md` carries the ruling.
  **Verification:** `pnpm typecheck` + `pnpm test` green; web-only — no
  wire touch.
- **feat(web): the block's text owns the bullet's context menu (owner ruling
  2026-10-15).** Right-clicking anywhere on a block's prose — the rendered
  tokens or the condensed excerpt — now opens the same node context menu the
  bullet grip carries (BlockRow's `.nt-block-content` mirrors the grip
  handler). Two carve-outs: while editing, the session keeps its own
  context-menu flow (mention pills, typed links, browser menu on plain
  text) — the guard returns before `preventDefault` so that path is
  untouched; and an inner element that already claimed the menu (the
  mention pill preventDefaults on its own `onContextMenu`) wins through
  `defaultPrevented`, so the read-mode node-link menu is not overridden.
  Read-only projections suppress the native menu without opening anything,
  exactly like the grip. Gate: `pnpm typecheck` + `pnpm test` green;
  `apps/web/test/block-context-menu.test.tsx` covers text / grip parity,
  the pill carve-out, the editing guard, and the read-only suppression.

- **feat(web): the SearchField gets the modern register — borderless, with
  wrapper-carried focus — and "Add parent" joins the AddPill (owner
  screenshots + ruling 2026-10-15).** The outlined search box stacked three
  cues (hairline border + border-color shift + focus ring), worst inside
  the command palette. The component is redesigned on the Spotlight/Linear/
  GitHub register: no hairline outline — the tinted fill carries the shape;
  hover is the state-layer wash, focus steps the fill to the base surface,
  and the accent ring wraps the whole field wrapper (relocated from the
  bare input — replaced, never suppressed). Two placements: filled
  (toolbars/filter bars/list headers) and `search-field--borderless`
  (chromeless on existing filled surfaces — the palette, sheet headers).
  Documented in the design-system skill: `patterns.md` gains the "Search
  field" recipe, the audit checklist §7 gains its row. The breadcrumbs'
  hand-rolled dashed "+ Add parent" button (a third add dialect, despite
  comments calling it a pill) now composes `AddPill` — one add-affordance
  register everywhere. Gate: full `pnpm typecheck` + `pnpm test` green.

- **feat(web): one add-affordance register — the page-header add actions join
  the dashed AddPill (owner ruling 2026-10-15).** "Add icon" / "Add
  description" / "Add aliases" in the page header were plain ghost Buttons —
  a second dialect for the same meaning the metadata sections speak with the
  dashed `AddPill` ("+ Add class" / "+ Add tag" / "+ Add property"). They
  now compose `AddPill` (dashed hairline + plus + label; the aliases pill
  keeps its popup anchor ref + `aria-expanded`). The add-affordance audit:
  every optional field already has exactly one affordance at its locus —
  cover/banner at the banner's empty-slot Add, classes/tags/properties at
  their rows, description/aliases/icon at the header — so no new buttons;
  more header chrome would be noise. Gate: full `pnpm typecheck` + `pnpm
  test` green.

- **feat(web): flat everywhere — the right rail loses its shadow (owner
  ruling 2026-10-15, re-audit thread).** The nodeview panel layer now speaks
  one register: side/context panels (10-15 audit) + the right rail (this
  slice) carry surface-step + hairline only; elevation remains on transient
  layers (popups, menus, drag ghosts, hover toolbars) and on the main
  content card alone — its lift is the sanctioned card-on-backdrop surface
  (owner file-header ruling), not a panel. Rationale recorded in-code:
  shadows are near-invisible on the dark-first tinted ground, the zero-noise
  rule forbids static-card elevation, and this removes a deviation instead
  of registering a new one. Gate: full `pnpm typecheck` + `pnpm test` green.

- **feat(web): the unswept surfaces get their pass — palette/search, calendar
  grids, activity/comments, boot screens — with two density exceptions
  registered.** Three sweeps covered the surfaces the re-audit left open;
  findings closed: (1) **CommandPalette** — the orphaned `components/Modal.css`
  chrome joins the 28px dialog register (was 12px); the active row wears the
  registered primary-container register (mouse hover drives activeIndex, one
  state covers both); Escape closes from anywhere inside (focus may have
  Tabbed onto a row). (2) **SearchField** — the quiet-focus suppression is
  removed per the 2026-10-15 reversal (global ring applies; border/background
  shift stays); the clear button gets the invisible 44px floor.
  `.nt-search-mark` takes `on-primary-container` ink (dark-mode 4.4:1 → the
  designed pair); the dead `.nt-search-input` block leaves app.css. (3) **Boot
  screens** — form errors announce (`role="alert"` ×3), the connecting phase
  is a `role="status"` region, the auth tabs get the floor + unified
  hover/pressed + kit tokens, the backend-unavailable dismiss trades its solid
  error flood for the overlay + floor, LoadingScreen takes motion tokens.
  (4) **Ghost buttons** join the hover ruling (`.btn--ghost:hover` was missed
  by the first sweep — `surface-container` wasn't in its fill tuple; calendar
  day cells inherit the fix). (5) **Calendar** — the selected day announces
  (`aria-pressed`), the agenda-day-title accent hover-ink becomes the overlay;
  arrow-key grid navigation stays a designed-not-built note. (6) **Comments**
  — the composer stops swallowing failures (busy state + inline `role="alert"`
  error + the text stays for retry), the lists go `aria-live="polite"`, the
  version-history preview toggle gets hover/pressed feedback, `.nt-icon-btn`
  gains a global disabled treatment. (7) Two density exceptions registered:
  calendar/date-grid cells ride the panel width (≈36–40px, the grid is the
  control), and the context column rides a dense type register (12px/400
  primary) — both were unregistered drift until now. Cover-card min-width
  takes `--layout-size-md` (the 132px literal). Remaining owner decision: the
  nodeview side-panel shadow (recommendation registered in the audit thread).
  Gate: full `pnpm typecheck` + `pnpm test` green.

- **feat(web): the owner rulings from the carried-forward Notes land — hover
  unified on the state-layer overlay, settings layout repaired, and the
  mechanical notes closed.** (1) **Hover ruling (owner)**: every hover
  background is `--md-sys-color-hover-overlay` across 22 stylesheets —
  rows, links, chips, icon chrome, Button base/default/outline variants,
  calendar/datepicker cells, GridMenu, breadcrumbs, toolbars; combined
  `--active, --active:hover` rules keep the active fill (active identity is
  not washed away); `primary-container` is selected/active-only, per the
  existing register entry. Registered as a decision in
  `.agents/design-overrides.md`. (2) **Settings layout (owner
  screenshots)**: the page inset goes symmetric (`--spacing-4` all around,
  was 12/16/24); the section-nav pills take the card-echoing 8px radius
  (the card's 20px minus the 12px inset — was 4px); the capped content
  column centers in the remaining space (`margin-inline: auto` — it hugged
  the nav rail). (3) **CardsBoard**: columns go adaptive
  `clamp(16rem, 22vw, 20rem)` (was fixed 260px), the 120px min-height maps
  to `--layout-size-sm`, the 40px mins to `--spacing-10`. (4) **Export
  modal**: the selected format card gains a real selected signal — a
  primary hairline ring (box-shadow, no layout shift) + 600 label, icon
  tint alone was too quiet. (5) **Content-renderer px literals**: code-block
  and field paddings map to the spacing scale, the code badge's duplicated
  6px corner takes `--shape-medium`, cover-card max-width takes
  `--layout-size-3xl` (220px), cover-picker paddings take spacing tokens.
  The calendar accent-ink hover the audit flagged is already gone (the
  concurrent condensed slice removed it — its button hovers were normalized
  by the sweep). Gate: full `pnpm typecheck` + `pnpm test` green.

- **feat(web): the design-system re-audit (second pass, updated checklist)
  — all 13 prior fixes verified, the surface-inventory sweep closes its
  Warning cluster, zero Criticals (report:
  `.audits/design-system-2026-10-15-reaudit.md`).** The re-run walked the
  updated skill checklist (Layout & grids is now a dedicated §5; §0 walks
  areas × surfaces): step 0 verified every finding from the first report at
  HEAD; the deeper sweep then closed: the card title gains the recipe's
  single-line ellipsis; the label-weight 500 cluster goes 600 (TextField
  label, toast title, NodeSelector selected/create rows, settings feature
  rows); the two surviving "quiet focus" focus-ring kills (IconPickerPopup,
  MetadataSection add-property popup — stale owner-2026-10-09 comments that
  predated the ruling reversal) are removed like Dropdown's was;
  IconPickerPopup joins the 8px floating tier and loses its hover
  scale(1.12); NodeSelector rows get rounded highlight corners + a pressed
  layer + the pill-remove floor; the toast joins the 8px tier with a
  floored/pressed dismiss; the in-process banner, PropertyIconButton (base +
  popover rows), and the sync dot gain pressed layers; the JS matchMedia
  strings normalize to range syntax. The condensed layer (landed mid-day by
  a parallel session) gets its pass: row-chrome pressed states, a
  `(hover: none)` reveal for the re-condense arrow, keyboard Escape wired
  inside CondensedLinksPopup (the sibling-popup convention), elevation
  parity — and its 22px row-chrome tap floor registers as a deviation
  decision (inline prose chrome cannot carry a 44px zone; panels/bars/
  popovers keep the floor, expressly out of scope). Carried forward as
  Notes: the three-way hover-fill idiom + accent-container hover rows (need
  one owner ruling), board magic numbers, TopBar crowding at ≤768px
  (arithmetic-only flag, needs a visual check). Gate: full `pnpm typecheck`
  + `pnpm test` green.

- **fix(web): the condensed row's affordance is visible at rest, and the row
  stays editable — click enters edit on the full content, blur re-condenses
  (owner feedback 2026-10-15, same-day refinement of the condensed layer).**
  The owner caught the shipped row's affordance nearly invisible — a tiny
  hover-gated glyph at the line end. Two fixes. (1) **Visibility**: a
  permanent muted "…" (the classic stretchtext mark) rides after the excerpt
  text on every condensed row, always visible at rest; the pin button and
  the hidden-links badge sit right after it — revealed with the row on hover
  AND focus-within (corrected in the same day's third pass: resting rows
  stay clean, the "…" names the truncation — the always-visible experiment
  read as noise once the mark existed; `(hover: none)` touch reveals the
  chrome permanently). The pin button wears a magnify-plus-outline lens
  (`mdi-magnify-plus-outline` — "zoom into this block"; the launch
  `unfold-more` read ambiguously, and `chevron-down` was never an option —
  it already names the collapse chevron's expanded state). (2) **The
  interaction contract**: the excerpt click no longer stretches — clicking a
  condensed row now enters EDIT on the block's full content (the standard
  outline click-to-edit; the excerpt is display chrome and the editor always
  edits the real content,
  so no data-path change), and blur re-condenses the row. Only the pin
  button adds to `notees.stretched.v1` — the set is purely the
  button-pinned set: editing never pins, blur never unpins; a pinned row
  clicks into edit like any block and returns to pinned read on blur; only
  the back-arrow / condense-all un-pins. Specs: the rewritten + new specs
  in `apps/web/test/condensed.test.tsx` (permanent mark, click-enters-edit,
  blur re-condenses, pin survives edit cycles, back-arrow un-pins — plus a
  source-level CSS spec pinning the hover/focus-within reveal and the pan
  rules); `docs/ux.md`'s
  editor entry carries the contract.
  **Verification:** `pnpm typecheck` + `pnpm test` green; web-only — no
  wire touch.
- **feat(web): the audit's residual grid/component notes closed — card-grid
  recipe conformance, and the design-system skill gains Layout & grids as a
  dedicated sweep area.** The follow-up verification of the 10-15 audit's
  residual notes shipped: (1) card titles ride the spec's 14px
  (`--font-size-base`, was 15px); (2) the card grid gains the recipe's
  quiet hover lift — the border raises from the blended hairline to full
  outline, no shadow/no scale; (3) the side-cover mat takes the recipe's
  12px cover radius; (4) search-result rows (`NodeResultItem`) join the
  list-row recipe: primary name 14px/600 (was 12px/400); (5) the two
  remaining 6px floating panels — `CalendarPopup`, `CondensedLinksPopup` —
  move to the 8px `--shape-floating-panel` tier, and the settings form
  inputs take the spec's 12px input tier (6px was a stray register).
  Skill-side (rosellramos-design-system `47d4fee`): the audit checklist's
  new §5 "Layout & grids" makes grids a dedicated sweep area — named
  collection surfaces, token gaps, adaptive column derivation, grid-item
  anatomy per the surface recipe, masonry hygiene, table density — and §0
  step 2 walks areas × an explicit surface inventory (shell, editor,
  collections, overlays, forms, feedback, content renderers), requiring the
  report to state which surfaces were swept. Gate: full `pnpm typecheck` +
  `pnpm test` green.

- **feat(web): the condensed layer — stretchtext as a view transform
  (Nelson, 1967): every block in the page body renders its excerpt until
  stretched, over whichever view mode the body wears.** Owner ruling: the
  condensed layer is a DISPLAY LAYER, not a fourth view mode — view mode
  answers how the tree lays out, condensed answers how much of each block's
  own prose shows, and the axes commute (condensed over prose — a flat page
  of excerpts — is the most Nelson-like surface, which a four-member enum
  would lock out). Under the layer a truncatable block renders its
  one-line excerpt — `excerptOf` (new `packages/domain/src/excerpt.ts`,
  exported from the index): the prose-flatten derivation (the same token
  rules as `fullTitleOf`/`proseFromAst`, one coordinate system), cut at the
  first `hard_break` OR the 80-char dense-chrome budget, returning the cut
  offset so hidden tokens classify without a second grammar — with trailing
  chrome (revealed with the row after the same-day refinements above): the pin
  button (launch day: a "…" click-anywhere stretch — refined above to
  click-edits / the button pins; the pinned row is the ordinary row plus a
  back-arrow at the END of the block's own content row, before the children
  — the reader re-condensing has just finished reading) and the links
  badge: a quiet count pill naming the MENTION tokens hidden past the
  cut (`hiddenLinksOf`, computed over the shared `proseSpans` projection;
  typed links are targetless and chips render-only — the badge never
  implies a link the graph can't resolve), opening a bounded popup listing
  the hidden targets (the `@` picker row convention — block targets
  breadcrumbed with their containing page; clicking a row opens the node,
  Esc/outside-click dismissal per the one convention). Prose-less blocks
  (images, queries, code, whiteboards) and one-line blocks never condense —
  nothing silently hidden; a mixed block names its media with a quiet chip.
  In cards mode the card content rows condense as display-only growth (the
  card grows, the masonry reflows — read-only, no edit entry); title,
  classes, tags, properties rows never condense. State is device view
  state, never an op: the toggle persists per page (`condensed.<pageId>`,
  the viewPrefs/deviceSettings seam) and the stretched exceptions persist
  beside the folds (`notees.stretched.v1.<rootId>`, the collapse-set
  pattern — multi-expand recommended, with a condense-all reset riding the
  nodeview top bar only while the set is non-empty). The layer toggle
  itself lives in the app TopBar beside the focus-mode switch and as a
  command-palette action ("Condensed: enter" / "Condensed: exit", the
  focus row's pattern — owner directive 2026-10-15; one surface per
  action, the nodeview-bar toggle removed); both act on the active page's
  per-page pref, and the condensed chrome (…, badge, back-arrow) stays
  visible in focus mode — stretching is the reading act, not metadata
  chrome. The BlockRow branch is
  an explicit opt-in from the page body — the presentation deck, embedded
  feeds, read-only projections, tables, exports, and shares render full
  content by construction. Specs: `excerptOf` (10 domain specs),
  `hiddenLinksOf` alignment, the stretch/re-condense round trip, the badge
  popup open/Esc, one-line blocks, off-by-default, and prose-mode fold
  honoring (`apps/web/test/condensed.test.tsx`). `docs/ux.md` carries the
  ruling (feature table, outliner table, the view-modes layer axis).
  **Verification:** `pnpm typecheck` + `pnpm test` green (domain dist
  rebuilt per the dev-condition law); web-only — no wire touch.
- **feat(web): prose mode honors collapse — folded subtrees hide, the
  chevron start-anchors the prose row, and the persistent chevron IS the
  collapsed indicator (owner ruling 2026-10-15).** Shipped until today:
  prose ignored the collapse set — every subtree rendered and no chevron
  mounted. The ruling: collapse is read, not ignored, making the two view
  layers (collapse, condensed) consistent across modes — flipping back to
  outline shows the same folds, and the `Ctrl+.` / `Ctrl+Alt+←/→` fold
  chords now act on the honored state in prose too (they already rode the
  shared collapse set — no chord change needed). The chevron start-anchors
  the prose row (prose has no bullet gutter): hover-revealed like the
  outline gutter idiom and PERSISTENT at rest while the block is collapsed
  — nothing silently hidden. The v1 indent-line fold gesture stays
  outline-only (prose flattens the indents — there is no line to ride;
  `ignoreCollapse` became `proseMode`, which hides only the rail).
  Collapsed and condensed compose on the same row: the chevron speaks for
  the children, the "…"/back-arrow for the block's own prose. Specs: the
  prose-fold spec in `apps/web/test/condensed.test.tsx` (subtree hidden,
  persistent `aria-expanded=false` chevron, rail absent, click unfolds);
  `docs/ux.md`'s outliner table and editor entries rewritten.
  **Verification:** `pnpm typecheck` + `pnpm test` green; web-only — no
  wire touch.
- **feat(web): the 2026-10-15 design-system audit findings closed in one
  pass — override registered, dialogs to 28px, static-panel shadows gone,
  every warning fixed, and the appearance seam unified behind one gated
  resolver (report: `.audits/design-system-2026-10-15.md`).** The
  full-sweep audit against the RosellRamos checklist found the token
  architecture clean (single-track color, drift gate green) and drift
  concentrated in three undocumented deviations and interaction-state gaps.
  Shipped: (1) the transparent "chrome on canvas" sidebar + the
  state-driven navigator (no rail at 1024) are registered as decisions in
  `.agents/design-overrides.md`; (2) dialogs render at the 28px
  `--shape-sheet` radius (`Modal.tsx` passes `radius="xl"`; the 12px tier
  remains for non-dialog floating chrome); (3) the static page side/context
  panels lose their `shadow-elevation-1` (zero-noise rule — hairline +
  surface-step carries the separation); (4) ~24 ad-hoc `em` font sizes map
  to the `--font-size-*` scale — only the four genuinely adaptive sites
  keep em (heading scale source, inline code, the two deck density
  multipliers), and the drift gate gains check 6 (`em` font-size ban +
  self-checking allowlist) so the px ban can't be walked past again; (5)
  `DataStateView` rides `useDelayedVisible` — sub-300ms fetches no longer
  flash a skeleton; (6) pressed states on `.nt-icon-btn`, sidebar rows,
  chips, and sortable rows (`--md-sys-color-pressed-overlay`), the chip's
  selected-hover now takes a state-layer step toward the on-container ink
  (selected and hover were identical), chip labels 600; (7) focus restored
  where it was suppressed: the graph stage gets an accent ring on
  `:focus-visible` only (pointer focus stays clean per the 2026-10-14 owner
  ruling) and the Dropdown search input stops killing the global focus ring;
  (8) touch floors: `.nt-propicon` and `.nt-sync-dot` get the invisible
  `::after` hit-area overlay (static projections excepted), `HoverReveal`
  shows permanently at 44px on `(hover: none)` touch, and the sync-dot
  pulse freezes under reduced motion; (9) media queries normalize to range
  syntax (`width <= Npx`) and the unused breakpoint tokens drop — only
  `--breakpoint-tablet` survives, the one JS actually reads; (10) the
  appearance seam: `src/ui/appearance.ts` is now the ONE resolver,
  `applyAppearance()` consumes it, the `index.html` pre-paint bootstrap
  mirrors it verbatim, and `test/appearance-bootstrap-parity.test.ts`
  executes both against a ~300-scenario matrix (stored prefs × system
  scheme × malformed JSON × the legacy key) — the gate fails on any drift.
  Two behavior fixes fall out of the unification: the bootstrap validates
  the accent pre-paint (invalid values fell on the DOM before), and the
  no-preference default is follow-system in both writers (the bootstrap's
  hard dark default fought the runtime's system default — a first-paint
  flash for fresh light-OS users). Token hygiene: `--shape-button: 16px`
  completes the button-radius scale, the `variables.css` header comment
  names the real `#141414` tint base, and the stale breakpoint-token comment
  is rewritten. Gate: full `pnpm typecheck` + `pnpm test` green (1667
  tests); the `mobile-layout` contract test pins the new range syntax.

- **feat(store,protocol)!: the no-divergence law — `class_link` asserts
  membership at the applier, `class.unassign` refuses while the content
  references the class, and class deletion sweeps memberships (owner
  ruling: "external writers should not produce the diverged state,
  right?").** The divergence between inline references and `class_ids` is
  now **write-time impossible in both directions**, the house law applied:
  (1) **Assertion** — `object.create`/`object.update` carrying `class_link`
  tokens apply the OR-set membership add for the referenced classes, so ANY
  writer (web, CLI, GTK, Flutter, imports) converges; an inline reference
  can never exist without its membership. Document-chrome content still
  flattens (nothing to assert); date-chain nodes keep their fixed class (a
  foreign link refuses like a foreign classId). (2) **Refusal** —
  `class.unassign` on a node whose stored content references the class
  fails loud (MoveGuardError, never applied); the removal gesture's
  strip-then-unassign order (yesterday's dissolve) is now enforced by the
  wire, and the web's editor toggle awaits the strip's local apply before
  the unassign. (3) **Deletion** — trashing or permanently deleting a
  CLASS node (and `trash.empty`) sweeps its memberships: trash tombstones
  the pairs, permanent purges them, so a deleted class can never dangle a
  membership; the content links survive as the one remaining divergence —
  a dangling reference to a deleted class — which renders pending (the
  dashed link + click-to-assign machinery now serves exactly this case).
  The 2026-09-25 render-only decision retires (SCHEMA.md Fork 3 rewritten).
  This is an applier-semantics change: new `class-link-assertion.json`
  fixture (29-file gate) exercising the full assert→refuse→strip→unassign
  lifecycle; store specs pin the assertion (raw create with no classIds
  class the node; quote children walked; rich-title update asserts) and
  the refusal (loud, membership intact, strip-then-unassign converges);
  **GTK lockstep `74d5cff` and Flutter lockstep `224f446` shipped first**.
  Live data verified safe without a migration: the derived-store scan
  proved ZERO divergent link/membership pairs (the only historical
  membership-removal op is class.unassign, so link-present + membership-
  absent cannot exist unless the refusal would have fired), and the
  assertion's replay adds are redundant on the verified-converged log.
  **Verification:** `pnpm typecheck` + `pnpm test` green (protocol 386,
  store 555, web 1665 — the divergence spec now constructs its state via
  class deletion, the only reachable path); GTK `pytest`/`ruff`/`mypy`
  green (800); Flutter `flutter test` green (638). An epoch bump +
  sync/web redeploy propagates the new derived semantics (the class-delete
  sweep changes ghost memberships on re-derivation).
- **feat(web): removal dissolves the reference — every class-removal gesture
  rewrites the node's inline class links to plain text (the owner ruling:
  "when class is removed, the inline class links should be converted to
  plain text").** An inline class link is a live reference to the
  membership, so a removal that left it would dangle. The dissolution lives
  in `classRemoval.ts` (extended — the non-removable-class rule module):
  `dissolveClassLinksInAst` deep-rewrites one content AST (every
  `class_link` for the class becomes a text token of the label it rendered —
  its `displayText`, else the class's current name, else the raw id; quote
  children walked), and `removeClassDissolvingLinks` pairs it with the
  unassign. Every UI removal path rides it: the pill ×, the metadata
  classes row, the classed-nodes table, the node context menu, the
  selection bar's bulk unassign, the task-cycle clear — and the `+`
  picker's toggle, where the dissolve is computed over the
  post-trigger-strip DRAFT in the same gesture (the editor's draft stays
  the single source of truth). Gesture-level convenience only: the wire
  stays pure — `class.unassign` never mutates content — so external writers
  can still produce the divergent state, which renders dashed and is one
  click from converged (previous slice). The session undo reverts both ops,
  restoring the link. Spec: the toggle dissolves [text "meet ", class_link]
  into [text "meet ", text "correo"] with the membership gone
  (`suggestion-popup.test.tsx`). `SCHEMA.md` Fork 3 and `docs/ux.md` carry
  the ruling. **Verification:** `pnpm typecheck` + `pnpm test` green;
  web-only — no wire touch.
- **fix(ci): the snapshot-rebuild end-to-end stops flaking — a real 30s
  budget replaces the 5s default (the email-per-push killer).** Every push
  mailed the owner a CI failure because
  `workspace-snapshot-rebuild.test.ts`'s "serves the rebuilt snapshot to a
  fresh SyncEngine client end-to-end" timed out at vitest's default 5s on
  shared CI runners (two failures 2026-10-15 — including a docs-only push —
  both timeouts here, both green on re-run). The test is genuinely heavy —
  1,050 seeded objects, two full server boots (replay + snapshot rebuild),
  then a real-socket HTTP pull — IO- and CPU-bound, not assertion-lenient;
  it gets a budget matching the work, not a weaker assertion.
  **Verification:** the suite passes locally in ~5s; the push's CI run is
  watched green.
- **feat(web): divergence handling for inline class links — the
  referenced-but-not-assigned state is legal, visible (dashed), and
  one click from converged.** The owner's question — "we may end up with
  out-of-sync nodes, where they kept the inline class and the class_ids got
  removed; how do we handle these?" — found live data CLEAN (all 75 inline
  `class_link` tokens sit on assigned nodes, verified against the derived
  store), so no migration; the handling is forward-looking. Ruling: the
  state is legal (undo interleavings, v1 imports, external writers can
  produce it; it is not corruption) and must be RENDERED, not hidden.
  `InlineTokens` gains `resolveClassAssigned` + `onAssignClass`: a class
  link whose class is not in the OWNING node's `class_ids` draws the dashed
  "pending" underline (read mode AND the edit-mode atom via the parallel
  `editable-dom` resolver), with a "not assigned — click to assign"
  tooltip; clicking ASSIGNS the class (live — and pill-hidden — from then
  on; subsequent clicks open the class). Wired at every token host: the
  block/title row (both resolvers), the two `EmbedView` surfaces (resolver —
  read-only projections indicate without writing), with quote/heading
  recursion passing the resolvers through. This ships the pre-designed
  class-chip lint (SCHEMA.md's suggestion mechanism — updated to shipped).
  Specs: the pending render + click-to-assign, and the live-render
  regression (`rendering.test.tsx`). `SCHEMA.md` Fork 3 and `docs/ux.md`
  carry the ruling. **Verification:** `pnpm typecheck` + `pnpm test` green;
  web-only — no wire touch.
- **feat(web,protocol): the class pills are a derived view — a class the
  content references inline hides its pill; and the inline class link is
  confirmed NOT a node link (backlinks/graph never saw it).** The owner's
  model, two rulings. (1) Membership stays the single semantic truth — the
  Ctrl/Cmd convert in the `+` popup splices the `class_link` token and
  NOTHING else (a short-lived unassign-on-convert was reverted within the
  same session: the reference is semantic, the dedup belongs at the view
  layer). `NodePills` — the one component behind the header classes row,
  the block classes column, and every read-only projection — parses the
  node's content for `class_link` tokens (quote children walked too) and
  hides those pills: the link IS the marker, never two visible references
  to the same class. The picker still lists the class checkmarked and the
  plain-pick toggle still removes it; the reorder anchors ride the full
  assigned set. (2) The inverse, verified and pinned: the store's edge
  index extracts `mention`/`typed_link`/property edges only — `class_link`
  never produced backlinks, the backlink gutter, graph edges, or link
  analytics; a `graph.test.ts` spec now locks that in. Also this slice: the
  neutral (non-color-tinted) class-link underline rides
  `--md-sys-color-on-surface-variant` instead of the hairline `outline`
  token (owner — it was almost invisible on dark surfaces; read mode and
  edit mode both). `SCHEMA.md`'s Fork 3, `docs/ux.md`, the component and
  editor header docs carry the rulings. **Verification:** `pnpm typecheck`
  + `pnpm test` green (new specs: pill-hiding with membership intact, the
  no-edge pinning); web-only CSS/TS — no wire touch.
- **feat(sync): snapshot retention is one per workspace — every `saveSnapshot`
  prunes the workspace's older snapshots (owner ruling after the 49 GB
  finding).** The owner's two questions — "why are snapshots so huge, why so
  many" — had one answer: a snapshot is a FULL serialized derived checkpoint
  of the workspace (each ~90–120 MB at the owner's data volume), the relay
  kept every snapshot ever taken, and only the newest per workspace is ever
  served (hydration rides `latestSnapshot`; nothing references older ids —
  the log is the authority). 418 personal snapshots had accumulated to 49 GB
  before a manual prune (549 stale snapshots deleted across all workspaces,
  49 GB → 370 MB). The retention ruling stops the pile-up at the source:
  `RelayStorage.saveSnapshot` — the single funnel behind both `/compact` and
  the client-upload path — deletes the workspace's older snapshot rows +
  files in the same save, so the corpus can never exceed one snapshot per
  workspace again. `docs/developers/deployment.md`'s data-layout section and
  the operations maintenance reference carry the ruling; a new
  `relay-snapshot.test.ts` spec pins the prune (two PUTs → one snapshot, the
  newest served). **Verification:** `pnpm typecheck` + `pnpm test` green;
  server-only, `verify-min.mjs` VERIFY-PASS after the scoped rebuild.
- **refactor(protocol,web)!: the inline class reference is `class_link`, never
  `class_chip` — the token is a node link, class variant, and the name now
  says so (owner ruling); the live log migrated in place (252 envelopes), the
  49 GB stale-snapshot accumulation pruned to 370 MB.** The owner's naming
  ruling: `class_chip` renamed to `class_link` across the protocol schema
  (`classLinkTokenSchema`), domain flattening, all five export serializers +
  the export IR (`classLink`), the PDF renderer, and every web surface; the
  "chip" name now names only the membership pills (untouched — a different
  concept). The rename is a strict-schema wire change: new
  `class-link.json` fixture (28-file gate), GTK lockstep (`0d4e520`), Flutter
  lockstep (`4d915a7`), then `scripts/migrate-class-chip-rename.mts` (the
  migrations.md §B sequence) rewrote the 252 live envelopes, patched the two
  remaining snapshots + the server derived store, bumped restore_epoch to 7,
  and verified by a full 234,975-envelope scratch replay with zero retired
  bytes; both images rebuilt, `verify-min.mjs` VERIFY-PASS. The owner-facing
  snapshot corpus was pruned in the same stopped-server window: 549 stale
  snapshots deleted (only the newest per workspace is ever served for
  hydration) — **49 GB → 370 MB**. `SCHEMA.md` and `migrations.md` (script
  catalog) carry the contract; a few inert `class_chip` bytes linger in
  relay.db free pages (SQL state clean; a future quiet window may VACUUM).
  **Verification:** `pnpm typecheck` + `pnpm test` green (1,661 tests); GTK
  `pytest`/`ruff`/`mypy` green (799 tests); Flutter `flutter test` green
  (637 tests); live migration verified per the runbook; stack smoke
  VERIFY-PASS.
- **fix(web): two picker refinements from the gesture work — the classes
  picker's create row no longer duplicates an existing class, and the
  assigned-row gestures are advertised.** (1) An exact-name query (`correo`
  with a class correo already in the graph — assigned or not) used to offer
  `Create "correo"` next to the existing class's row: a duplicate-class trap;
  the create row now suppresses whenever the query exactly names an existing
  class. (2) Nothing in the UI named the checkmarked rows' gestures: the
  picker renders a footer hint while an assigned row is on screen —
  `↵ remove · ⌃↵ convert to link` where the toggle lives (the editor's `+`
  popup), `✓ already assigned` at the idempotent-acknowledgment pickers.
  Also the turn's headline fix: the Ctrl+Enter convert in the `+` popup
  spliced PLAIN TEXT — the owner meant an inline class LINK; the gesture now
  splices the `class_link` token (render-only class reference, wavy
  underline, no membership effect). `test/suggestion-popup.test.tsx` gains
  the specs (create-row suppression, hint on/off, the chip token in the
  converted AST — updated from the text assertion); `docs/ux.md` and the
  `BlockTextEditor` header doc carry the contract.
  **Verification:** `pnpm typecheck` + `pnpm test` green; web-only until the
  rename slice shipped it.
- **feat(web): the inline `+` popup's assigned-class rows are live toggles —
  plain pick removes, Ctrl/Cmd pick converts the trigger to inline text
  (owner ruling).** The editor's `+` capture picker now receives the edited
  node's current classes as the picker's assigned set: already-assigned
  classes hide from the empty-query browse (the candidate set is what can
  still be added) and resurface **checkmark-marked** under a matching query.
  `NodeSelector` gains an opt-in `onAssignedPick` — when set, an assigned-row
  pick reports to the caller instead of the default idempotent
  acknowledgment-close (the header/block "+ Add class" pickers keep that
  ack). The editor's handler implements the owner's gesture set: a **plain
  pick REMOVES the class** (the toggle; the checkmark reads as state) and a
  **Ctrl/Cmd+Enter / Ctrl/Cmd+click converts the trigger to inline text** —
  the `+` drops and the typed word stays as plain block content, the class
  membership untouched. This also fixes the reported "Ctrl+Enter does
  nothing": an assigned class's pick used to strip the trigger silently, so
  `+correo` vanished with no visible effect. `#`/tag rows acknowledge
  idempotently (checkmark, close, no write); the unassigned class path
  (plain and Ctrl picks assign) is unchanged. `test/suggestion-popup.test.tsx`
  gains five specs (browse-hides/uncheck, plain-pick removes, Ctrl+Enter and
  Ctrl+click convert, unassigned path unchanged); `docs/ux.md`'s editor
  paragraph and the `BlockTextEditor` header doc carry the contract.
  **Verification:** `pnpm typecheck` + `pnpm test` green from the repo root;
  web-only, no wire/store/sync touch.
- **fix(web)!: multi-select is deleted everywhere — the top-bar New picker
  is single-pick (one class, one page), and an exact search for an
  already-assigned class/tag resurfaces its row instead of dead-ending into
  the create-class modal (owner ruling).** Two reports, one slice. (1)
  Ctrl+Enter "still does not add the class inline if the class is already
  set": reproduced — the header/block classes pickers hide assigned classes
  outright, so an exact search left only the create row, and Enter/Ctrl+Enter
  there routed to the **New class** modal (for an existing, already-assigned
  class) instead of acknowledging the pick. Now assigned nodes hide only
  while BROWSING (the pinned candidate-set contract in `pickers.test.ts`);
  a non-empty query resurfaces them, checkmark-marked (`isSelected` finally
  renders in the anchored pickers), and picking one closes idempotently —
  no write, no modal. The same contract serves the tags row and every
  value-based property picker. (2) The owner ruling: no multi-select
  anywhere — page creation means ONE class ("create a person", "create a
  project"). `NodeSelector`'s entire multiSelect mode is gone (picked-set
  state, checkbox column, `N picked`/Apply footer, `⌃↵ apply` hints, the
  `onApplyMulti` prop, the multi CSS, `NodeResultItem`'s now-orphaned
  `before` slot); the top-bar New picker commits through plain `onAdd` —
  pick a class, one untitled page of that class is created and opened.
  The editor `#`/`+`/`@` single-pick contract from the earlier slice is
  unchanged. `docs/usage.md`'s New-button sentence and `docs/ux.md`'s
  picker paragraph rewritten; `pickers.test.ts` gains the regression spec
  (exact search resurfaces the assigned class checkmarked; Ctrl+Enter
  closes with no modal, no duplicate write).
  **Verification:** `pnpm typecheck` + `pnpm test` green from the repo
  root; web-only, no wire/store/sync touch.
- **fix(web): the editor's `#`/`+` capture popup is single-pick — the
  checkbox/Apply multi-select layer is gone, and Ctrl/Cmd+Enter assigns the
  highlighted row (owner ruling).** Two complaints, one root: the class/tag
  capture popup rode `NodeSelector`'s `multiSelect` mode (checkbox rows, a
  picked set, an Apply footer, a `↵ toggle · ⌃↵ apply` hint), so Ctrl+Enter
  with nothing checked ran `applyMulti` on an empty set and silently did
  nothing — the reported "can't Ctrl+Enter to add a class inline". The owner
  ruling: `@`, `#`, and `+` all share the ONE single-pick node-picker
  contract — one row, one assignment, the popup closes; stacking classes
  means re-opening the picker. `BlockTextEditor`'s capture `NodeSelector`
  drops `multiSelect`/`onApplyMulti` (the now-dead `commitNodePicks` goes
  with them) and every kind commits through the existing `commitNodePick`,
  which already carried the per-kind writes (mention splice / `assignTag` /
  `assignClass`); Ctrl/Cmd+Enter now maps to the same pick (its
  `withLabel` context stays mention-only, as designed). The `NodeSelector`
  multi-select machinery itself survives — the top-bar **New** picker
  (`App.tsx`) legitimately creates one page per checked class and keeps it.
  `test/suggestion-popup.test.tsx` re-pins the contract: row-click assigns
  exactly one node and closes, plain Enter and Ctrl+Enter both assign the
  highlighted row, and no checkbox/footer chrome renders; `docs/ux.md`'s
  editor paragraph rewrites the `#`/`+` sentences to the single-pick ruling.
  **Verification:** `pnpm typecheck` + `pnpm test` green from the repo root;
  web-only, no wire/store/sync touch.

## 2026-10-14

- **feat(web)!: the Pixi renderer graduates — the default AND the only
  graph renderer; the WebGL adapter is deleted for good (owner ruling,
  go/no-go Stage 3 complete).** The 50k load test made the call: Pixi at
  parity-plus (2× pan/zoom, 5× hover, clean console vs the WebGL
  position-texture 16k wall), the left-drag hang fixed by the
  delta-based streamed-frame path. What changed: `webglRenderer.ts`
  (2,086 lines) is gone — its shared, adapter-agnostic pieces moved to a
  neutral `renderer/edgePlan.ts` (the `CameraState`/`NodeVisual`/
  `RendererEdge`/`RendererOptions`/`EdgeRenderPlan` types, the pure
  `planEdgeRender`, the theme-reactive `getCssEdgeColor`; the three
  GL-only color helpers died with zero consumers); `graphRenderer.ts`
  (the contract) stays, now retargeted at edgePlan. GraphView constructs
  the Pixi adapter unconditionally and the `graphPrefs.renderer` device
  pref is retired — field, load coercion, lifecycle dep, and the
  settings-popover "Renderer" row (WebGL / Pixi beta) all removed; the
  popover opens on the physics preset. The error register is one honest
  empty state: "Graph renderer failed" (shader-link failures keep their
  specific description; the missing-backend case no longer brands "WebGL
  2 required" — Pixi's init throws "no WebGL2 backend for the graph
  renderer"). Specs: `graph-renderer.test.ts` keeps the label-overlay
  contract, the idle-skip signature, the edge/arrow planning, the LOD
  contract, and a retargeted adapter camera-math spec (19 kept, plus the
  Pixi suite's 28); the two WebGL-only describes (honest-error via the GL
  adapter, and the time-lapse/hover uniform contract, ~9 specs) delete
  with the file; `graph-view.test.tsx`'s renderer stub re-points at the
  Pixi module and its fallback specs expect the new register. Docs:
  `docs/usage.md` drops the beta-flag sentence and names the single
  PixiJS renderer. **Verification:** `pnpm typecheck` + `pnpm test`
  green from the repo root; no wire/store/sync touch (web-only).
- **docs(agents): AGENTS.md carries the fleet-workflow block — greenfield/features route through `autonomous-app-builder`, all visuals defer to `rosellramos-design-system`.** Follows the fleet entry-point consolidation and this repo's design-override register: any agent session now finds the workflow and the visual authority in one hop from the repo root, with `.agents/design-overrides.md` as the documented-deviation home per the skill's `references/overrides.md` contract. One-bullet addition to the Skills section; no runtime behavior.
- **docs(agents): Notees adopts the design-override register — `.agents/design-overrides.md` seeds with five rulings and AGENTS.md names it.** The RosellRamos design system gained an override contract (`references/overrides.md`: one register per app, entries cite the rule they override with rationale/ruling/review-trigger, audits treat documented deviations as PASS-with-note and undocumented ones as Critical). Notees is the first registered project: the seed records the seed-tinted dark surfaces, selected chrome wearing the seed's primary-container (M3's nav register says secondary-container — no secondary hue in play), the Margin Green presets replacing fleet copper, the full-page settings ruling, and the 2026-10-09 chrome-register rulings. AGENTS.md's `.agents/` line and the records index point at the register. Repo-record slice only — no runtime behavior, no redeploy.
- **fix(web): the browser tab title names the selection-less surfaces — the open nav hub ("Trash - Notees", "Graph - Notees", "Tasks - Notees", "Assets - Notees", …) and the full-page search ("Search - Notees").** The settings-title fix branched the ONE title effect on the settings route, but a hub view (which clears the selection) still fell through to the bare "Notees" — the same stale-title trap the settings branch fixed for its own surface. The branching rule is now the exported pure `tabTitle` (mirroring the PageCard render precedence: settings section → open node → search → active nav hub, named from `NAV_ENTRIES`; the effect is the only writer and only assigns), so the whole surface register is pinned by `test/tab-title.test.ts` — every nav hub's label, node-over-hub, search-over-hub, settings-over-everything, signed-out fallback. Verified: `pnpm typecheck` + `pnpm test` green; web-only, no wire/store/sync touch.

- **refactor(web)!: the color system is single-track Material You — every
  color token is a `--md-sys-color-*` role, and the selected accent IS the
  primary role (derived, not duplicated).** The old dual-track palette (a
  fixed monochrome `--color-primary*` family beside a user-selectable
  `--color-accent*` family) meant active states could render in an
  accent-independent color (the settings nav's "weird" active tab). Now:
  the five `[data-accent]` presets set ONLY `--md-sys-color-primary` +
  `--md-sys-color-on-primary`, and `primary-container`,
  `on-primary-container`, `primary-hover`, `primary-pressed`, and
  `inverse-primary` derive from them via `color-mix` in the theme blocks —
  one source of truth per theme, the Material You dynamic-color model with
  the curated seed standing in for wallpaper-derived color. The entire
  accent token family is gone (`--color-accent*`, `--color-on-accent`),
  the legacy bare color aliases are deleted (`--accent-color`, `--surface`,
  `--text-secondary`, … — ~65 indirections; their ~14 real consumers now
  reference the canonical role), and every remaining `--color-*` reference
  across ~143 files (CSS, TS `getComputedStyle`/string readers, test
  expectations) was renamed to `--md-sys-color-*`. Also swept: two sizing
  tokens that wrongly carried a `--color-` prefix (`--color-btn-size-*` →
  `--btn-size-*`), the duplicate `--shadow-inset-accent-ring` (→
  `--shadow-inset-primary-ring`), and the dead `--color-accent-subtle`.
  The settings accent picker is unchanged behaviorally (swatch previews
  still preview each preset; the monochrome preview keeps its
  theme-constant token, renamed `--md-sys-color-swatch-monochrome`).
  Note: `colorPresets.ts`'s legacy-var fold now matches
  `var(--md-sys-color-preset-*)` — safe because the 2026-10-03 migration
  rewrote all stored data off the retired `var(--color-preset-*)`
  encoding. Web-only CSS/token rename — no wire/store/sync touch, no
  client lockstep. **Verification:** `pnpm install && pnpm -r build &&
  pnpm typecheck && pnpm test` green in the worktree (protocol 366,
  domain 80, export 240, store 552, sync 25, query 203, server 231, web
  1645 — the css-token-drift gate passes against the new namespace), plus
  the four zero-residue greps (`--color-`, bare aliases,
  `--shadow-inset-accent-ring`). Docs: the ui-primitives law gains the
  Material You color-role rule (renumbered 1–6).

- **fix(web): the browser tab title names the open settings section ("Appearance - Notees", …) — and the development skill now requires URL + tab title for every new view.** The title effect only knew the open node, so any surface without a selection (settings, and the same dead spot for search/hubs) left the title stale at "Notees"; it now branches on the settings route and names the section from `SETTINGS_SECTIONS`. Same-pass skill change per the docs-are-part-of-the-change law: new law 9 in `notees-development` (view surfaces own their URL AND their tab title), mirrored in `references/coding-conventions.md` and canonical `docs/developers/development.md` §7, with the two shipped traps recorded (the PageCard render-precedence race; the stale title on selection-clearing views). Verified: `pnpm typecheck` + `pnpm test` green, live probe (settings view → tab title), verify-min smoke; web-only.

- **feat(web): the quick-tweaks settings modal is dropped — the sidebar gear, Ctrl/Cmd+,, and the workspace manager's settings entry open the full settings page (Appearance) directly; the command palette's Toggle theme command now actually persists.** The modal held exactly two controls (theme, accent), both duplicated on Settings → Appearance, and linked onward via its "Advanced settings" row — a surface with no unique function. `UserSettingsModal.tsx`/`.css` are deleted; the styles the full page shared transitively (accent swatches, about/links/privacy/support) moved into `SettingsPage.css`. The palette's Toggle theme existed but wrote the LEGACY `notees.theme` key through a private helper, which the modern `notees.settings.theme` overrides on reload — the flip didn't stick; it now rides a canonical `flipTheme()` in deviceSettings (flips the resolved on-screen theme — the same source the command's label names → writes the modern key → broadcasts, OLED flag survives a dark round trip). Verified: `pnpm typecheck` + `pnpm test` green (modal tests re-aimed at the exported ThemeModeControl/AccentColorPicker; new palette theme-flip test covering the persist + OLED survival), live probe, and the verify-min smoke; web-only; no wire/store/sync touch, no client lockstep.
- **feat(protocol,store,web): `trash.empty` — the Trash hub's Empty trash is
  a first-class bulk op, with GTK + Flutter lockstep.** A new additive op
  (envelope v3 unchanged, payload the strict empty object — any field is
  rejected outright) permanently deletes every soft-trashed subtree root,
  sharing the `object.delete {permanent: true}` subtree-purge body (extracted
  to `permanentlyDeleteSubtree` in the store appliers). The set is evaluated
  at APPLY time against the trash table, not authored as an id list: the
  envelope stays small at any trash size, and `object.restore` keeps plain
  log-order LWW — a restore landing before the empty survives it (no trash
  row at apply time), one landing after is LWW against the permanent
  tombstones. Roots are snapshotted in id order; a root consumed by an
  earlier iteration (its subtree contained another independently-trashed
  root) is skipped by the missing-row check, and a stale non-permanent trash
  row with no node row is swept rather than failing replay. Replay is
  idempotent. Web surface: the Trash hub header gains an **Empty trash**
  button (hidden when the trash is empty), confirmed through the danger
  ConfirmationModal, emitting one `trash.empty` via
  `client.emptyTrash()` on both the direct and worker clients; permanent
  deletes stay outside the undo journal by design. `trash.empty` joins the
  sync package's listing-affecting ops so remote empties invalidate
  conservatively. Spec: SCHEMA.md deletion/restore semantics; op catalog
  entry; canonical `trash-empty.json` fixture (gate list 26→27: two trashed
  pages, one with an independently-trashed child, a restore-before-empty
  page that must survive).
  **Verification:** `pnpm install && pnpm -r build && pnpm typecheck &&
  pnpm test` green — protocol 366, store 552 (both adapters, incl. the new
  fixture semantic + idempotency pins), sync 25, server 231 (incl. relay
  ingest accept/reject + catch-up round-trip for the payload-less op), web
  1645. **Lockstep:** `notees-gtk` and `notees-flutter` ports of the same
  fixture bytes + applier semantics land in the same window (their
  changelogs record the hashes).

- **fix(web): the quick modal's "Advanced settings →" button was a no-op with a page open — fixed; focus mode moved to the top bar; the Back/Forward arrows moved to the top bar's right side.** Root cause of the dead button: `openSettingsSection` set the settings route but never cleared `selectedPageId` / `searchOpen`, and the PageCard slot checks the selection FIRST — so with a page open the settings page lost the render race and nothing visibly happened (deep links at boot worked, which masked it). The fix is the two clearing calls, mirroring `openSearchPage`. Focus mode left the quick-tweaks modal and the full settings page (theme + accent remain; the description row named page chrome that focus mode no longer hides) for a crop-free bracket button in the top bar's right section — the active chrome carries the on/off state, Esc still exits, Ctrl/Cmd+Alt+F and the palette command ride the same `toggleFocusMode` write path. The in-app Back/Forward arrows moved off the center section (the breadcrumbs alone keep the center) to the head of the right section. The settings page itself also left the card's generic centered 800px cap for a full-card frame — the section nav rides the card's left edge, the content column caps at 900px — and `/settings/<section>` URLs now survive reload (the connect keep-path guard recognizes the settings routes). Verified: `pnpm typecheck` + `pnpm test` green (the modal's focus switch test re-aimed at the shared toggle helper; new top-bar button tests), a live probe over the test workspace (deep link → screenshot → reload keeps the URL → screenshot), and the verify-min smoke; web-only; no wire/store/sync touch, no client lockstep.

- **fix(web): the Pixi adapter's streamed-frame path is delta-based — the
  50k left-drag hang is fixed (go/no-go Stage 3 blocker resolved).** Root
  cause, proven in an isolated harness (esbuild bundle + real Pixi under
  headless SwiftShader, same GL flags as the load-test probe, 50k nodes /
  25k edges, drag frames driven exactly like GraphView's pointer handlers):
  every engine frame during a node drag called `updatePositions`, which
  flagged the full dirty gates — so each rAF frame rewrote all 50k sprites
  AND cleared+rebuilt all ~25k stroked edges + 5k arrowheads in one
  Graphics, while a middle-drag pan only moves the GPU camera transform
  (the asymmetry). Harness numbers: ~260–290 ms/frame at every zoom level
  INCLUDING unchanged "settled tick" frames. The fix is three layers.
  (1) Identity gate: `updatePositions` diffs incoming frames against the
  last accepted positions — unchanged content dirties nothing.
  (2) Culled sprite sync: moved nodes get sprite position/scale writes
  only inside the view cull rect (`viewCullRect`/`syncIndicesForView` pure
  helpers; a node moved outside the rect stays pending and syncs when it
  re-enters — a plain pan never re-dirties; zoom still forces the full
  min-radius pass).
  (3) Edges incident to moved nodes draw in a small dynamic overlay
  re-stroked per frame, bounded by the moved set; the full-E bucket
  geometry redraws only on overlay membership transitions, and wide motion
  (a settling graph) takes throttled (150 ms) full rebuilds — because the
  bisect showed sustained per-frame clear+rebuild of stroked Graphics is
  what melted software GL (variant with the edge redraw disabled: no stall;
  sprite sync alone: stall). Plus sprite/bucket culling via Pixi's Culler,
  which both removed the residual multi-minute SwiftShader stalls and cut
  every frame ~2× (off-screen sprites and empty buckets skip GPU
  emission). After: ~7.5 ms steady drag frames at 50k at every LOD
  (~35–38× faster than the hang), ~88 ms only while a 3k-node-wide
  reheat jiggles per frame, identity frames ~8 ms. Hover/selection/mask/
  time-lapse/structural changes still force full passes; the WebGL adapter
  is untouched. **Verification:** new specs in graph-pixi.test.ts — the
  culled-sync helpers, the identity gate (no sprite/bucket writes on
  unchanged frames), one-node drag writes exactly one sprite with zero
  steady bucket churn (overlay only), quiet stream returns overlay edges to
  their buckets, out-of-view moves stay pending until panned into view,
  zoom still full-syncs; graph-pixi suite green (24); full gate green.
  **Follow-up (owner regression report, same day): panning did nothing —
  the graph never moved.** Not a regression from the streamed-frame work
  (the world-transform lines are byte-identical before and after that
  commit): the adapter's world container was positioned at the canvas
  centre with the camera translation NEVER applied — `worldToScreen`/
  `screenToWorld`/picking/labels all honour the camera, so pan worked in
  every contract except the pixels, and the load test's "pan 11.6 fps"
  only counted rAF callbacks without verifying movement. The same porting
  bug mirrored the graph vertically: the GL shader's NDC y-flip was copied
  into Pixi's y-down canvas space, painting nodes at `-worldToScreen.y`
  (labels and hover highlights sat at the unmirrored positions). The fix
  makes the world transform EXACTLY `worldToScreen` for both axes —
  `position = canvas/2 − camera×zoom`, `scale = (zoom, zoom)` — so pan
  moves the graph, cursor-anchored zoom anchors correctly, and rendering
  matches picking/labels (parity with the WebGL visuals). The cull pass
  already ran on every render with fresh transforms, so cull re-entry
  needed no change. **Verification:** harness pixel probes (real Pixi +
  SwiftShader) — pre-fix a node painted at its mirrored position and the
  view was identical at every pan stop; post-fix all nodes land at
  `worldToScreen` before and after a pure pan, the mirrored position is
  empty, and panning across the 50k field re-renders newly visible sprites
  every stop at ~10–15 ms/frame with no melt. New specs: pan-only camera
  change moves the world transform while scale stays, the culler runs on
  pan-only renders, `viewCullRect` follows the camera; graph-pixi suite
  green (27); full gate green.
  **Second owner report (same day): the released node "stays pinned" —
  investigated, not reproduced, regression-locked.** The suspected
  baseline/identity-gate interaction cannot produce a pin: the gate diffs
  exact float equality, so the first post-release frame that differs from
  the drop-point baseline re-marks the node changed, and any full sync
  reads live positions. A high-fidelity harness (the real EngineController
  in BOTH main-thread and physics-worker modes, 400 and 50k nodes,
  GraphView's exact call sequence — overridePosition + dragMove per
  pointermove, dragEnd on release, post-release hover + selection) shows
  the released node's sprite equal to the engine frame on every one of
  120+ settling frames (0 mismatches, node swings ~200 world units); a
  node dragged past the view+margin goes pending and flushes when its true
  position re-enters the cull rect (sprite parked at its last in-view
  spot meanwhile — correct). New spec: drag release → streamed settling
  frames move the sprite (identity first frame correctly a no-op). Live
  re-verification against the deployed stack was attempted and blocked by
  an ops finding: the test workspace's op log still carries ~126k
  envelopes (Stage-3 churn; its snapshot is stale by ~50k ops), so a fresh
  browser spends 30+ minutes applying catch-up before the shell renders —
  compacting the test workspace log restores fast boots (ops follow-up,
  not a renderer defect); graph-pixi suite green (28); full gate green.
  **Addenda (same batch): minimap zoom verified, tab title owned.**
  Cursor-anchored zoom on the minimap (GraphView's `zoomAtWorldPoint` on the
  world point under the cursor) verified working on the Pixi path in the
  harness: the anchored node's screen position drifts 0 px through a ×1.6
  anchored zoom (2 ms frame), and a control center-anchored zoom moves it
  exactly as `worldToScreen` predicts — no fix needed (the handler is
  renderer-agnostic GraphView camera math; it became correct when the world
  transform started applying the camera). And the tab title: the
  full-surface GraphView now sets `document.title` to "Graph - Notees" on
  mount and restores the previous title on unmount (the same string the app
  shell's one-writer tabTitle rule emits for the graph hub); the embedded
  local-graph card never touches it. New specs: full-surface title set +
  restored, embedded card's hands-off.
- **test(web): the 50k-node graph load test runs — Pixi at parity-plus, one
  blocker before any default-flip (go/no-go Stage 3 of the renderer
  migration).** The test workspace seeded 50,000 main pages + 25,000 mention
  edges through the relay batch ingest (~6 min; edges ride on parented
  blocks — title-is-content flattens mentions in a page's own content), both
  renderers measured from one persistent profile, all probe data deleted and
  verified gone afterward (permanent delete took 34 min at ~24/s). Headless
  SwiftShader floors the absolute numbers, but paired and identical:
  Pixi 2× WebGL's pan/zoom throughput (11.6 vs 5.6 fps; 9.6 vs 4.4 — the
  pan figure counted rAF callbacks only; actual pan movement was broken
  until the world-transform fix in the streamed-frame entry above), 5×
  hover latency (0.39s vs 2.17s), clean console vs the WebGL path's texture-
  upload overflow at 50k (its RG32F position texture exceeds the 16k max,
  breaking edges — a genuine WebGL scalability wall Pixi doesn't have).
  **Blocker found (fixed the same day — see the streamed-frame delta fix
  entry above):** a left-button drag at 50k nodes pegged the Pixi renderer
  at ~195% CPU and never recovered (middle-drag pan was fine; WebGL
  unaffected) — every engine frame rewrote all N sprites and rebuilt all E
  edges. The delta-based streamed-frame path (identity gate + culled sprite
  sync + dynamic edge overlay + culling) removed it: harness drag frames at
  50k went from ~260–290 ms to ~7.5 ms. Also noted: first paint is a
  stacked blob until physics spreads it (shared engine, both renderers), and
  the settle metric is uninformative at overview LOD. Verdict: conditional GO
  — fix the left-drag hang, then re-measure on real GPU hardware before
  considering Pixi as default. Tooling: `graph-loadtest-seed.mjs`
  (count|seed|edges|delete), `graph-loadtest-probe.mjs` (paired probe), two
  diagnostics.
- **feat(web): block collapse state is device-persisted per page (owner:
  "collapse state, at least when triggered from thread line click, is not
  being persisted").** Collapse was documented — and behaved — as
  session-local: folds vanished on reload. It now survives: every toggle
  (chevron and the indent-rail fold ride the same `toggleCollapse`) writes
  the fold set to localStorage keyed by the page id
  (`notees.collapse.v1.<rootId>`), loaded at outliner mount. Device state
  never becomes an op, so the op log is untouched; node ids are UUIDv7-
  globally-unique so no workspace scoping is needed, and stale ids (deleted
  blocks) are inert until the set is next rewritten. The outliner-context
  doc comment, the rail probe (which resets the persisted state before its
  reload), and `docs/ux.md` move from "session-local" to "device-persisted".
  **Verification:** new spec — fold via chevron, unmount, remount: the fold
  (and its expand) restore from storage across three mounts; view-transforms
  suite green (8).

- **feat(web): the drag preview is a FILLED card that PARKS below the drop
  line when a target snaps (owner 2026-10-14: "a better UI would be the
  filled background floating card — way better card text visibility — and
  make it snap to be BELOW the drop target line when the drop target gets
  triggered").** The one-line truncated name chip becomes a filled surface
  card carrying the block's full text (multi-line, wrapped, line-clamped at
  6). Two positional modes share the card look: in free flight the card
  rides the pointer (dnd-kit's DragOverlay); the moment the snap model finds
  a target, the card parks in a portal just below the indicator line, at the
  anchor's x — the winning indentation — so it renders exactly what the
  document will look like after the drop, gliding between targets on a short
  transition while the pointer chip steps aside. A selection stack previews
  as the lead block's text under a "N blocks" badge. The faint in-place
  source and the straight indicator line are unchanged. **Verification:**
  the pinned/stack specs now assert both modes (chip in free flight; parked
  card with the lead text + badge at the anchor's coordinates; unmount at
  drop); block-dnd suite green (27).

- **fix(web): drag edge auto-scroll works on the real page layout (owner:
  "reaching the top or the bottom of the current list does not scroll").**
  The live repro pinned it precisely: the drag session was healthy (chip,
  indicator, rAF all confirmed mid-drag) but the scroll-container collection
  at drag start returned nothing — PageView's zone root spans the WHOLE page
  chrome while the scrolling cell (`.nt-nodeview-body`) is its DESCENDANT,
  and `scrollContainersOf` only walked ancestors. The scroller sweep now
  also covers the root's subtree (one querySelectorAll pass, the same cost
  class as the drag-start row measurement); the jsdom spec gains the
  root-wraps-scroller case. **Verification:** new live probe on the deployed
  stack — 30 blocks overflowing the nodeview body, grip dragged to the
  scroller's live bottom edge and held: before, scrollTop stayed 0 with
  every predicate confirmed green; after, the list scrolls (PROBE-PASS).

- **fix(web): the indent rail folds EACH direct child individually — the
  owner's own expansion stays untouched (owner 2026-10-14, final ruling:
  "it should collapse EACH INDIVIDUAL CHILD BLOCK, not the block that owns
  the thread").** The ruling sequence settled the semantics: not per-height
  (one child per click), not owner-collapse (the owner's chevron flips, the
  children rows vanish) — the click toggles every direct child's own
  collapse state at once: the children rows remain, their subtrees fold; a
  childless child is skipped (nothing to fold); when every collapsible
  child is already folded the click unfolds them all. (The first ship of the
  ruling inverted the toggle condition — `!==` where `===` belongs — and the
  click silently no-op'd: "clicking the vertical thread does nothing now".
  The live probe caught it; the fix rides the same entry.) The line
  extension (reaches the bullet across the metadata) is untouched.
  **Verification:** a jsdom spec pins the fold / owner-untouched / unfold
  contract; the rail probe asserts the full contract in the real browser —
  after one click the grandchild hides while the direct children rows AND
  the owner's expanded chevron stay; a second click unfolds; the
  metadata-gap click behaves the same.

- **fix(web): clicking the indent rail collapses the block's WHOLE children
  group at once (owner correction 2026-10-14: "it collapses the child block
  located at the vertical level where the cursor is — it should collapse ALL
  children at the same time").** The same-day per-height targeting (each
  segment beside a child collapsed that child's children) was a misread of
  the earlier ask; the owner rule is one gesture, one subtree: a click
  anywhere on the line — whatever segment it lands on — collapses the
  owner's entire children group. The per-height plumbing is removed
  (`collapseFromRailClick` toggles the owner again); the line extension
  (reaches the bullet across the metadata) is untouched. **Verification:**
  the rail probe's interaction cases rewritten — a click beside a child and
  a click in the metadata gap each hide ALL the direct children together
  while the owner stays; collapse specs + typecheck green.
- **feat(web): Version history in the nodeview's context column, the Trash
  hub (browse / restore / delete permanently), Back/Forward arrows in the
  main top bar, a "Clear all" for the right rail, and the rail as a
  fixed-height panel (owner 2026-10-14: four UI-only gaps — "the op log
  already retains every edit per node, so a version surface would be a
  projection slice with no wire change").** (1) **Version history**: a new
  context-column section (graph · TOC · Activity · **Version history** ·
  Comments) — lazy like Activity (the first expand fetches, collapsed costs
  nothing), reading the per-node slice of the existing `GET /api/operations`
  relay-log feed (`WorkspaceClient.fetchNodeHistory`, the
  `fetchOperationsFor` pattern generalized: ops whose payload names the
  node, newest-first by HLC, same 30-page bound, same throw-when-unreachable
  honest note). Content-bearing ops carry a full `contentAst` snapshot: each
  expands to a read-only preview, and **Restore this version** composes an
  ordinary `object.update` with that snapshot — the current content keeps
  its own op in the log, so restoring never destroys anything (the
  undo-journal philosophy; the wire is untouched). (2) **Trash hub**: the
  v1 sidebar surface restored — a Trash navigation entry + hub listing
  soft-trashed subtree roots (newest first, deletion stamps) with
  **Restore** (the `object.restore` op, now a first-class web write
  `client.restoreObject` — the CLI's `object restore` is no longer the only
  surface) and **Delete permanently** behind the confirmation modal
  (`object.delete permanent`). Reads ride a new `client.listTrashed()`
  (the `trash` table joined to the inactive node rows — the one surface
  reading the other side of `is_active`). (3) **Back/Forward arrows** in
  the top bar's center, left of the breadcrumbs: `window.history`
  back/forward through the App's OWN navigation stack — every in-app
  pushState now funnels through one `pushNav` seam that records
  (`recordNavPush` truncates the forward tail), and the popstate handler
  reports landings via a new `onNavigated` seam (`recordNavPop` steps
  toward the matching neighbor, resets on a foreign URL) — the disabled
  states ride our cursor, never the browser's (whose stack reaches beyond
  the app); the Alt+←/→ chords are unchanged. (4) **Right rail**: a
  "Clear all" button (under a "Peeked pages" label) closes every card and
  the panel with them (the last-card-close precedent), and the rail is now
  a fixed-height, surfaced panel (the empty-state placeholder's card
  treatment: background, hairline, radius, shadow, explicit
  `align-self: stretch`, internal scroll) instead of a transparent strip
  whose visible area shrank to fit the cards; the nested cards go
  transparent inside it (their bodies keep their content surface). Live
  measurement (`scripts/screenshots/sidebar-height-probe.mjs`, Work-offline
  boot, 0/1/3 real Shift+clicked cards): the rail's border-box held
  constant (889px, Δ24 = its margins) across every card count, before and
  after; the ≤480px bottom-sheet treatment overrides the panel unchanged.
  **Verification:** three new suites green — version history
  (summaries/snapshot/restore/unavailable, 5), trash hub (list/restore +
  open/permanent-delete + cancel, 4), nav arrows (stack tracker pure fns,
  the popstate seam, TopBar states, 7) — plus `pnpm typecheck` +
  `pnpm test` all green.

- **feat(web): the drop indicator repaints above the floating drag chip,
  with a start tick at the line's first pixel — the indentation level is
  never hidden (owner proposal round: "the floating dragged block card
  covers the start of the line… what UI could we use so users can see the
  line fully?").** Approved option A. The opaque ghost chip rides the
  pointer and covered the class-based line's left portion — exactly where
  the indentation cue lives (the line's start x encodes the nesting level).
  A stacking-context constraint shaped the implementation: a line inside
  the editing surface can never paint over dnd-kit's DragOverlay (999)
  portal, so the host now renders a portaled indicator at the snapped
  candidate's anchor — the same geometry the class lines carry, plus a
  3×10px accent tick straddling the line's start — at `--z-node-overlay`
  (1000, one step above the chip). No new measurement: the candidate set
  already carries each anchor, re-measures on scroll, and the drop line
  re-projects right after, so the portal tracks auto-scroll and wheel
  scrolls for free. The row-level `::before`/`::after` lines stay as the
  no-host / no-candidate fallback; `DropCandidate` gains `rowRight` for the
  line's span. **Verification:** new spec (portal geometry at the snapped
  anchor; unmounts at drop) + the merge-candidates specs updated; the
  drop-targets live probe restored to its strict 80px visible-run threshold
  (the 30px stop-gap existed only because the chip occluded the line) and
  re-run against the deployed stack.

- **fix(web): the drag-select's trailing-click swallow is scoped to the
  release row — clicks on any other block edit immediately (owner:
  "two clicks are still needed to enter edit mode with blocks selected").**
  The first mutual-exclusion fix resolved click-made selections (live probes:
  ctrl/shift selections all edit in one click), but the drag-select path kept
  its old global one-shot: `signalDragClick` swallowed the NEXT click
  ANYWHERE — so after drag-selecting blocks, the first click on a different
  block was eaten as "trailing" and only the second entered edit mode. The
  swallow now records the drag's release row and only a click on THAT row is
  treated as the accidental release click; a click on any other row is
  deliberate and edits (and clears the one-shot either way). **Verification:**
  new spec (drag ending on row N: a click on a different row edits in one
  click; the release row's own click stays swallowed) + the existing
  trailing-click and edit-mode-drag specs; live probe extended with the
  drag-select → one-click-edit sequence.

- **fix(web): selection and edit mode are mutually exclusive (owner
  2026-10-14: "selecting blocks while in edit mode on another block should
  exit edit mode… while blocks are selected, it requires two clicks to enter
  edit mode on a different block").** Root cause of both: the selection
  surface preventDefaults every read-mode mousedown to keep read content
  unselectable — which also suppresses the browser's default focus shift, so
  a block still editing elsewhere kept its caret (and its edit state) while
  a selection formed around it; the stale editor then ate the first click on
  the block you actually wanted, reading as "two clicks to edit". Two-lane
  fix: (1) state-level truth — whichever block is editing hands back to read
  mode the moment a selection forms (BlockRow effect), holding in jsdom and
  every browser regardless of focus-event behavior; (2) the selection
  surface's mousedown now blurs the active editor explicitly (focus
  hygiene — the flush-and-exit runs on the gesture that takes the surface
  over). One plain click with a live selection already cleared + edited in a
  single handler; with the stale-editor state gone it now lands on the first
  click. The edit-mode drag contract updates with the rule: when the
  gesture arms block-select at the border exit, the pressed block's editor
  exits too. **Verification:** two new specs (shift+click selection exits
  edit mode; drag-select exits edit mode; one-click edit with a live
  selection over the full press sequence) + the updated edit-mode-drag spec;
  block-dnd/selection suites green (53).

- **feat(web): drag-and-drop feedback and the indent rail move to the accent
  color; the child intent is a line, not a bar; the rail reaches the bullet
  and collapses per height; the pink-purple accent retires in favor of a
  dusty blue (owner 2026-10-14).** (1) Accent: the selection card, the drop
  indicator lines, the child-intent line, and the drag-source tint rode
  `--color-primary` — the neutral ink, which never follows the chosen
  accent — so a green-accent workspace still got grey selection/drop chrome.
  They now ride `--color-accent` (and accent-tinted surface mixes), the same
  engagement color as the focus ring and the editing bullet. (2) The child
  intent ("first child of X") rendered as a 3px bar + row tint ON the row —
  at the child-offset x it read as a stray caret mid-text (owner: "I get the
  vertical line again"). It is now the same 2px divider line as the sibling
  intents, starting at the child indentation — "insert here, one level
  deeper" reads as a line. (3) The indent rail (the collapse line under a
  block with children) started below the block's metadata sections and its
  click always collapsed the owner: it now extends from the row's bottom
  edge (measured + ResizeObserver — the line reaches the bullet, across the
  properties section) and targets per height — the segment beside a direct
  child collapses THAT child's children, the segment across the owner's
  metadata collapses the owner's, and a childless block's segment is inert.
  (4) The curated accent presets swap Purple (#8c47d1, reading pink —
  "looks super ugly") for Blue (#3d6a96 light / #6d99c2 dark, on-accent
  contrast ≥4.5:1 both schemes); stored "purple" selections fall back to the
  default Advance Green through the existing retired-preset path.
  **Verification:** `pnpm typecheck` + `pnpm test` green (settings accent
  specs updated to Blue); three live probes on the deployed stack — rail
  (top == row bottom across a 50px metadata gap; per-height clicks collapse
  the child / no-op on childless / owner from the gap), drop-targets (three
  x-bands land correctly, child line at the element bottom, clean release;
  magenta override moved to `--color-accent`), selection card (differential
  pixel check still passes with the accent tint).

- **feat(web): the experimental PixiJS graph renderer lands behind a device
  flag — Stage 2 of the renderer migration (adapter-first, flagged,
  load-test-gated).** `GraphPixiRenderer` implements the landed
  `GraphRenderer` contract (Stage 1) as a PixiJS v8 adapter: one pre-rendered
  white-circle texture + one Sprite per node (color = tint, the
  multiply semantics the GL fragment shader computed per-pixel), a world
  `Container` carrying the camera as a GPU transform (the GL NDC y-flip is
  the container's negative Y scale), one Graphics for edges and one for
  arrowheads rebuilt only on dirty gates (edges / position frames / hover /
  selection / time-lapse / mask / zoom), selection rings as a ring Graphics
  pass under the nodes. The visual semantics are ported from the WebGL
  adapter: the owner-ruling hover recolor (hovered = accent fill, neighbors
  unchanged, everything else 20% darker, color only never alpha), selection
  dim (alpha × 0.55), edge-hover alpha 0.35, LOD link-type mask, time-lapse
  discard, min screen radius, min 1px edge width, the shared
  `planEdgeRender` arrow eligibility, and the same camera/pick/fit math.
  Documented simplifications: edge color gradient and width taper collapse
  to source color / average width, dashes (no current producer sets them)
  render as sampled 2-on/4-off screen-space dots, and edge geometry is
  CPU-rebuilt on position frames instead of the GL adapter's position
  texture — the 50k load test (Stage 3) decides if edge batching needs the
  same trick. Selection: the graph settings popover gains a **Renderer**
  row (WebGL / Pixi beta, persisted per device in `graphPrefs.renderer`,
  default WebGL); switching rebuilds the renderer+engine like a display
  change. Labels stay on the untouched canvas2d overlay. New dependency:
  `pixi.js` v8 (~560 kB parsed added to the web bundle, one-time — the
  priced-in trade for batched GPU rendering without shader/context-loss
  maintenance). Verified: `pnpm typecheck && pnpm test` green (16 new specs
  in `apps/web/test/graph-pixi.test.ts` — pure hover/mask/LOD/time-lapse/
  curve/camera specs plus a mocked-Application smoke spec), and a live
  probe (`scripts/screenshots/graph-pixi-probe.mjs`) against a local
  preview build with the flag seeded: the graph paints under Pixi (nodes,
  edges, arrowheads, selection ring, hover accent, selection dim), labels
  draw, console clean (only headless-swiftshader ReadPixels perf warnings
  from the one-time texture extraction). Bundle: +258 kB minified (+80 kB gzip) on the index
  chunk, plus Pixi's lazily-loaded renderer backend chunks (~75 kB more on
  first graph mount) — the priced-in one-time trade for batched GPU
  rendering without shader/context-loss maintenance.

- **fix(web): drop targets are correct and multi-level at every divider — the
  line rides the block ELEMENT's bottom, and the pointer's indentation picks
  the nesting level (owner: "I can't position 13 before 14… the drop targets
  are incorrect… they should support multiple levels in the same
  position… the lines should always be after the entire block element").**
  Two long-standing defects compounded. (1) The `below` indicator painted at
  the **text row's** bottom (a box-shadow on `> .nt-block-row`), while the
  snap anchor sat at the **element's** bottom — for a block carrying
  properties/children the visible line drew far above where the drop would
  land (live repro: 64px above the pointer on a subtree block), making
  precise positioning impossible. The above/below lines now render as
  `::before`/`::after` on `.nt-block` itself (the element is
  `position: relative`) — always at the element's top/bottom edge, i.e.
  after THE ENTIRE block element: text row, properties, linked references,
  children. (2) The child candidate anchored at the element's vertical
  CENTER — hundreds of px from any divider on a tall block, so "first child
  of X" was unreachable where it matters. Child anchors now ride the
  element's bottom divider at the child-offset x: at one boundary every
  nesting level the tree allows stacks by indentation (previous sibling of
  the row below at the page gutter, next sibling of the subtree above at its
  own gutter, first child at the child offset) and `nearestCandidate`'s x
  tie-break picks the level — the owner example ("just before 14": sibling
  of 14 / sibling of "el niño no es un adulto" / child of it) is exactly the
  three bands. The mid-element "weird vertical line" (the child bar floating
  at 48px mid-block) disappears with it: child intent only exists at
  dividers now. **Verification:** new unit spec (three x-bands at one
  divider) + updated anchor expectations (26 block-dnd tests green); new
  live probe `scripts/screenshots/drop-targets-probe.mjs` against the
  deployed stack — before: magenta line at the text-row bottom, none at the
  element bottom (repro); after: three bands land C right before B / as A's
  last child / as a child of a2a, the line at the element bottom, no stuck
  indicators — PROBE-PASS.

- **refactor(web): the graph renderer is behind a formal `GraphRenderer`
  interface — Stage 1 of the owner-approved PixiJS migration (adapter-first,
  flagged, load-test-gated).**
  The full public surface of `GraphWebGLRenderer` (init/render lifecycle,
  visuals/positions/edges/times, the color-only hover contract, camera +
  picking, the stats/order getters) is extracted into
  `renderer/graphRenderer.ts`; the class now `implements GraphRenderer`
  (compiler-enforced conformance — the Pixi adapter must satisfy the same
  type), and `GraphView`'s ref is typed to the interface so Stage 2 only
  touches the construction site behind the device flag. The LOD hook is in
  the contract from day one per the owner's design note: `lodLevelForZoom`
  (constellation < 0.25, overview < 1.0, detail beyond) is a pure, tested
  helper every adapter shares, so the 7.5k workspace exercises the same
  code path a 50k workspace will depend on. No behavior change.
  **Verification:** web typecheck green on the graph files + the renderer /
  view / followups suites green (55 + the new LOD spec).

- **fix(web): the graph's canvas colors actually resolve — the minimap was
  never showing its intended colors (latent `toString()` base bug).**
  `hexVarToRgba` built its channels with `.toString()` (base 10): any channel
  ≥ 100 produced a three-digit decimal group, making the 9-digit result an
  INVALID CSS color — silently ignored by canvas, which keeps the previous
  fillStyle (default black). Effects before this fix: every minimap dot was
  black regardless of token (the "all black elements, visibility is trash"
  report), and the viewport rect painted as a solid black block; label colors
  survived only by accident (the dark theme's `--color-on-surface` is a
  `color-mix`, which rides the light-gray fallback; the light theme's
  #221a13 mangles into a valid but brighter color). The channel now emits
  base 16 (`toString(16)`), and `resolveHexVar` chases one level of
  `var(--token)` aliasing (custom properties read via getComputedStyle keep
  `var()` unresolved — the `--graph-minimap-viewport: var(--color-accent)`
  alias was falling back to dark taupe). Verified in an isolated harness at
  7000 synthetic nodes with the shipped dark tokens: light dot field, dense
  cluster readable, accent-bordered viewport with a 0.12 wash. **Side
  effects (token-true, intended):** light-theme graph labels now use the real
  `#221a13` on-surface token and the label halo becomes the real white
  surface token (it previously fell back to near-black); the dark theme is
  visually unchanged (its label colors ride the fallback, as before).
  **Verification:** the five graph suites green (76 specs) + web typecheck
  clean on the graph files; harness screenshots before/after.

- **fix(web): the selection card is visible again — the underlay anchored its
  `z-index: -1` to a far stacking context and painted behind the opaque
  page-card backgrounds (owner: "I don't see a selection UI at all, with 3
  blocks selected").** A negative z-index child loses to every ancestor
  background in the shared stacking context, so the card computed and
  measured correctly but composited invisible. `.nt-select-surface` now
  carries `isolation: isolate` — the surface is its own stacking context and
  the card paints behind the rows but above every ancestor background, which
  is the underlay semantic. **Verification:** new live headless probe
  (`scripts/screenshots/selection-card-probe.mjs`, test workspace): creates
  3 blocks, selects them, pixel-samples the card region with/without the card
  — delta 0 (invisible) before the fix, delta 63 (tint vs page) after;
  deployed and re-probed on the running stack.

- **fix(web): the export modal's orphaned CSS fragment is gone — every build
  since the Oct 9 kit-Radio restyle logged esbuild css-syntax warnings.**
  `5d328784` inserted the radio-group rules into the middle of
  `.export-modal__select-label`, orphaning its `box-sizing: border-box; }`
  tail as a selector-less fragment (unparseable, so it never applied — the
  warnings were the only symptom). The declaration moves back into its
  owner rule; the bundle now builds warning-free and the select label gets
  the border-box it was always meant to have. **Verification:** `vite
  build` logs zero css-syntax warnings (was 2).

- **feat(web): the block-drag preview is frozen, edge auto-scroll finds
  off-screen positions, and a selection stack drags as one (owner
  2026-10-14).** Four owner asks in one slice. (1) Nothing moves during a
  drag anymore: BlockRow never applies the sortable strategy transform (the
  source had suppressed only its own), so sibling rows no longer slide to
  make room — the feedback is the highlight line at the drop position, the
  dragged block(s) reading faint in place (opacity 45, already the drag-
  source treatment), and the floating name chip; the reorder commits on
  drop. (2) A block drag auto-scrolls a scrollable view (the page body, a
  rail card, a floating editor) when the pointer sits in its 40px edge band
  — ramped 6px/frame rAF loop over the zone roots' scrollable ancestors,
  dnd-kit's built-in autoScroll off to avoid double scrolls — and ANY scroll
  during a block session re-measures every zone into the snap set and
  re-projects the drop line at the last pointer, so the indicator tracks
  content under a stationary pointer and freshly revealed rows are
  droppable. (3) Dragging the grip of a SELECTED row drags the whole
  selection stack: the session's dragIds carry the level-capped roots in
  document order, the chip reads "N blocks", every root row renders faint,
  and planStackMove issues one chained move per root (each lands after its
  stack predecessor; the first-slot two-move swap generalizes to a
  three-phase stack swap; blocks already sitting at their intended spot are
  skipped with a prefix gate — a successor is re-anchored the moment a
  predecessor moves; internal structure preserved — only top-level roots
  reparent). Cross-zone and card-header stack drops re-plan from the client.
  (4) The selection itself is now level-capped at its shallowest depth: any
  write maps raw rows to their ancestors at the stack's min depth, so the
  screenshot configuration — "11" (depth 0) mixed with "el hecho de
  proteger…" (depth 1) — is unconstructible: extending a range onto the
  child selects "14" instead, ctrl+clicking inside an already-selected
  subtree is a no-op, and adding a deeper row to a shallower stack promotes
  it to its ancestor. The stored stack (`selectionRoots`) feeds the drag;
  the exposed `selection` stays whole-subtree for the card + group ops.
  Riding along, the selection card is rebuilt to the owner's direction: an
  UNDERLAY (z-index below the rows, so text stays fully readable) spanning
  the run's block elements — shallowest left edge to deepest right edge,
  not the surface's full width — in primary-tinted surface tokens; the
  pointer-through underlay supersedes the earlier border-drag idea (a
  pointer-through layer can't be a drag handle — the bullet grip of any
  selected row is the stack-drag gesture). **Verification:** `pnpm
  typecheck` + `pnpm test` green (16 new specs: frozen-preview transform
  sweep, stack drag end-to-end with faint rows + "2 blocks" chip + chained
  moves, edge auto-scroll + scroll re-anchor end-to-end in a synthetic
  scroller, planner units for chained/first-slot/child/noop/refusal paths,
  edge-velocity + scroll-container units, three level-cap gesture specs);
  50 block-dnd/selection tests pass.

- **fix(web): no focus ring on the content card when clicking the graph, and
  a minimap that reads (owner 2026-10-14).** (1) Clicking the canvas focuses
  the graph stage for keyboard navigation; the stage's `:focus-visible`
  outline drew a 2px accent ring inset at the stage edge — indistinguishable
  from a border around the whole content card. The stage is a chrome-less
  keyboard surface: both `:focus` and `:focus-visible` outlines are now none
  (the keyboard behavior is unchanged). (2) The minimap at 7.4k nodes was an
  unreadable black blob: the dark-theme dot token (`#a9a59f` at 0.55 alpha)
  vanished on the dark surface and thousands of overlapping dots compounded
  into a solid mass. The dark dot token now matches the brightened node color
  (`#d0d0d0`), the viewport rectangle rides the app accent
  (`--graph-minimap-viewport: var(--color-accent)`), and the viewed region
  gets a faint accent wash (`minimapViewportFill`, 0.12) under the stroke so
  it reads at a glance. **Verification:** the five graph suites green (the
  graph-view suite file was blocked mid-run by another session's transient
  `block-dnd.ts` syntax error — unrelated, re-verified after) + `pnpm
  --filter @notees/web typecheck` green on the graph files.

- **fix(web): graph load and hover corrections — a stage loading overlay, no
  lifecycle rebuild on color groups, an instant cached paint, labels that
  arrive together at a closer zoom, and a color-only hover (owner rulings
  2026-10-13/14).** (1) Between "topology projected" (counts shown) and the
  first engine frame the canvas sat blank for seconds at 7.4k nodes — the
  stage now carries a `LoadingScreen` overlay ("Warming up the layout…") until
  the first pixels, and a workspace with ≥70% cached positions paints the
  previous session's map synchronously inside the lifecycle effect (no overlay
  at all — the map is there on the first composite). (2) The GL lifecycle
  effect took `groupColors` as a dep: the async color-group queries resolving
  seconds after mount rebuilt the whole renderer + engine mid-load — the
  visuals effect already re-applies colors live, so the dep is gone. (3)
  Labels appeared sporadically because the cap labeled the first N nodes in
  array order: the regular pass is now viewport-first with radius priority
  (the hubs claim a bound cap), the large-graph floor moved 0.12 → 0.3 with
  the fade running 0.3 → 0.7 ("all of them at the same time, at a much higher
  zoom"), and once everything visible fits the cap, every visible label
  renders at once. (4) Hover is a pure COLOR operation, never opacity (owner:
  "the hovered node was not visible at all, the rest became too faint — 20%
  darker COLOR, not opacity"): the hovered node fills the accent, linked nodes
  keep their color, incident edges and arrowheads paint the accent, and
  everything outside the neighborhood darkens 20% toward black at full alpha;
  `u_hoverDim` and the alpha-dimming path are gone from all three programs.
  **Verification:** `pnpm --filter @notees/web typecheck` green (the 3 red
  files are another session's in-flight BlockRow work, untouched) + the five
  graph suites green (76 specs incl. the recast cap/fade/hover contract and a
  new viewport-priority spec); live headless probe + compositor screenshot
  confirm the fitted graph renders labeled.

## 2026-10-13

- **fix(web): small graphs label at any zoom — the label threshold is now
  node-count-aware.** The first-frame camera fit parks a fitted sparse graph
  below the 0.12 label floor (verified by the live headless probe: a fitted
  54-node graph rendered nodes but zero labels), so graphs up to 150 nodes
  bypass the floor and label at any zoom on a minimum-alpha ramp (0.3 floor),
  cap still binding; larger graphs keep the 0.12 fade-in unchanged. The
  idle-skip signature from the same pass proved innocent — assigning
  `canvas.width` in the resize observer clears the label canvas, but the
  width/height signature fields catch it. **Verification:** new spec (small
  graph at zoom 0.05 → 40 capped labels at 0.3 alpha; large graph → none);
  the renderer + view suites green.

- **fix(web): the graph opens framed and settles fast — first-frame camera
  fit, 4× alpha cooling, warm quiet start, pre-paint warmup, idle label
  pass (owner 2026-10-13: "blank while loading, movement never stops, not
  smooth").** Live headless probes against the deployed stack isolated three
  real causes (the GL renderer itself was exonerated by an isolated harness
  reproducing the exact per-frame call sequence): (1) the force path never
  fit the camera — `cameraRef` kept its `{0,0,0.5}` initial and only the
  fixed-layout branch called `fitToCanvas()`, so an opening view whose
  cached layout sat off-origin painted an empty canvas; the loop now fits
  once on the first engine frame (`fitDoneRef`, never reset — rebuilds keep
  the user's camera). (2) `alphaDecay 0.005` needed ~1050 ticks minimum
  before the settle gate could even fire — minutes of visible wobble at 7.4k
  nodes; decay is now 0.02 (settle horizon ~265–290 ticks, forces unchanged
  in shape), the worker's pre-paint fast-forward runs 150 ticks at 3× dt,
  and a workspace with ≥70% cached positions starts at `initialAlpha 0.2` —
  returning users see ~64% less drift over the first 100 ticks, i.e. the map
  opens nearly still and finishes cooling in about a second (reheats and
  topology updates keep full-alpha semantics). (3) the canvas2d label pass
  redrew unconditionally every frame; a pure `labelSignatureChanged` gate
  (camera, frame identity, hover, selection, name map, time-lapse state,
  canvas size) now skips redraws when nothing that affects labels changed.
  **Verification:** `pnpm typecheck` + `pnpm test` green (1580 incl. new
  warm-start-settles-sooner, signature-gate, and first-frame-fit specs);
  suite settle numbers: fresh 291 ticks vs warm-start 211–265, first-100-tick
  drift 290k vs 801k world-units.

- **feat(web): property provenance flips — manual properties are unmarked,
  class-sourced ones wear a "C" badge (owner 2026-10-13).** The owner turned
  the marking scheme around: don't mark "manual" properties (the retired
  "unbound" pill), mark the ones that come FROM a class. Both properties
  surfaces (the panel's table + the sidebar's name rows, and the card's
  table with it) now render a single **C** badge (title "From a class") on
  rows whose effective value is class-sourced (`boundBy !== null` — an
  authored value on a bound schema or a derived default), riding the
  property-NAME cell (the earlier move — between label and value it grouped
  with the value); manual values carry nothing. The retired "default" pill
  folds into the same badge; the derived default's muted value color
  (`nt-property-default`) is unchanged. **Verification:** the panel and
  annotation specs re-pinned (manual rows unmarked; a bound default wears C;
  a surviving bound default keeps C after a class unassign while the
  unbound row stays bare); 100 tests green across the properties/card
  suites.

- **fix(web): side-cover card grids form TWO columns at desktop widths
  (owner 2026-10-13).** The owner: "make the side cover layouts have 2
  columns when screen is this width, not one." Root cause measured in a
  playwright repro: `column-width: min(400px, 100%)` computes to FULL WIDTH
  inside a multicol (the percentage resolves against the multicol box
  itself — circular), collapsing the masonry to one column. The `:has()`
  override drops the `min()`: `column-width: var(--layout-size-9xl)` gives
  two ~470px columns at the owner's ~990px content width and degrades to
  one column naturally below that. **Verification:** the static repro pins
  the before/after (2 vs 1 columns); the card suites green.

- **docs(developers): the throwaway-stack probe recipe is written down (skill
  + runbook).** Learned the hard way while reproducing an owner screenshot
  against the RUNNING build: `run.sh` pins `:2.0.0-m1`, so hand-roll the two
  containers from the locally-built images (the web image needs the
  `notees-sync` network alias — its nginx hardcodes the upstream name);
  throwaway auth has NO admin password and no user rows until signup — boot
  the sync with `NOTEES_SIGNUP_ENABLED=true`, signup + login for a real
  session; session READS require workspace membership and only the first
  session-authed WRITE auto-claims an unclaimed workspace
  (`authorizeWorkspace`, routes-relay.ts) — one `POST /api/objects` claims
  it before the UI can read; API writes are workspace-scoped by the
  `x-workspace-id` header; the fetch-binding + OPFS-neutralization init
  scripts are required; and the app boots into the fixed test workspace
  `c491595f-…`. New section in `docs/developers/ui-debugging.md`
  (Throwaway-stack probes), pointer in the `notees-development` skill's
  development-workflow reference. **Verification:** every step of the recipe
  was exercised live against the throwaway pair (the probe itself is
  deleted, per the ad-hoc probe rule).

- **fix(web): the hover tint is gone from text property value cells (owner
  2026-10-13).** `.nt-property-value:hover` (the super-clean field's hover
  surface) is removed — the text rides the row with no hover feedback, on the
  card's table and the properties panel alike (one component, one rule); focus
  keeps its surface + the accent ring as the editing signal. **Verification:**
  CSS-only change; the properties suites green (`block-metadata`,
  `table-polish`).

- **feat(web): the card's properties section IS the nodeview properties
  table — name column | value column, editable, every bound property riding
  (owner 2026-10-13).** The owner: "I don't see two columns … it should
  basically be the properties table from nodeview." The hand-rolled `dl`
  retires; the card hosts `PropertiesTable` itself — the same component the
  properties panel renders: one column for the property name (the 140px
  label column), one for its typed value cell, authored values and derived
  defaults marked, bound-but-unset properties as empty rows WITH the add
  affordance, and full editing (typed cells, label settings/history menus,
  add-property row) exactly like the panel. The `cardProperties` scoping prop
  retires with the dl (the table shows the bound set inherently) — removed
  from the collection contract, the Tasks hub, CollectionHub, and the
  classed-nodes section; yesterday's empty-field synthesis (the
  bound-without-default row materialization) is superseded by the table's own
  `emptyObjectBindings` rows. Docs: `docs/ux.md` + `docs/usage.md` re-worded
  (the table, editable). **Verification:** the card spec re-pinned (the
  `nt-properties-list` renders on the card; valued cell by display value; the
  unset bound property's label rides); `tsc` clean; view-modes/covers/
  card-lazy-images/class-view/class-bindings green (78).

- **fix(web): classed-nodes cards show EVERY bound property per member —
  unset ones as empty fields (owner 2026-10-13).** The owner: "why don't I
  see class properties as assigned in class view for classed nodes?" Two
  layers hid them. (1) The card's scoped rows filtered to properties with a
  non-empty display text. (2) Worse, the store's effective-properties read
  (`effective.ts`) emits NO row for a binding with no authored value and no
  default ("bound without a default → continue"), so the unset properties
  never even reached the card. Now, when the container scopes
  `cardProperties` (the classed-nodes section passes its bound columns), the
  card materializes the FULL scoped set in order — a schema with no effective
  row renders as an empty field (the table's full-column-set contract: a
  member card shows exactly the class's columns, valued or empty). The
  unscoped default (every effective property with a value, the v1 register)
  is unchanged. Docs: `docs/ux.md` + `docs/usage.md` carry the full-column
  rule. **Verification:** the card spec gains a second bound-but-unset
  property asserting the row renders with an empty value; `tsc` clean apart
  from the graph session's in-flight files; view-modes/class-view/
  class-bindings suites green (36 + 18).

- **fix(web): graph view owner corrections — brighter base rendering,
  Obsidian-style accent hover neighborhood, colors unify on query groups,
  blank-flash/jank fixes (owner 2026-10-13).** After the round-2 slice
  shipped, the owner's corrections, two rounds: (A) the dark theme's graph
  tokens brighten (`--graph-node-default` `#b8b8b8` → `#d0d0d0`,
  `--graph-edge-color` `#3a3a3a` → `#707070`; the light block untouched).
  (B) The hover neighborhood reworks to the Obsidian reference: the hovered
  node, its incident edges, and its linked nodes highlight in the app's
  current ACCENT color — `graphTheme()` gains `accent` (the `--color-accent`
  token, MutationObserver already re-resolving on `data-accent` flips) and
  `setHoverNeighborhood(nodeId, accent?)` carries it into new
  FRAGMENT-STAGE-ONLY uniforms `u_hoverColor`/`u_hoverMix` on the
  node/edge/arrow programs (the cross-stage declaration stays banned — it
  broke Firefox linking once already). Node highlight flags go THREE-level
  (0 outside · 1 direct neighbor · 2 the hovered node; edges/arrowheads
  stay binary) — the node shader full-alphas everything ≥0.5 and accents
  only ≥1.5, the edge/arrow shaders accent their incident instances.
  Everything outside the neighborhood stays VISIBLE but dimmed at 0.2 alpha
  (`HOVER_NEIGHBORHOOD_DIM` 0.15 → 0.2 — dim-not-hide, own colors kept);
  off = `u_hoverMix 0` + `u_hoverDim 1.0`, exactly the prior path. The
  hovered node's glare ring stays gone (rings are selection-only). The
  label overlay dims with the graph — the regular pass still runs (zoom
  threshold + cap respected) at a quarter alpha — while the hovered node's
  label ALWAYS renders at full alpha, even below the zoom threshold, nudged
  +3·dpr px below its normal offset as the identifier. (C) Node hover shows
  NO tooltip box at all (the round-1 name tooltip retired; the NodeHoverPreview
  card, import, cursor sentinel, notify plumbing, and sentinel CSS stay
  retired); the edge kind/weight/evidence tooltip is unchanged. (D) The
  loading branch renders the kit `LoadingScreen` inline ("Projecting the
  workspace topology…") instead of an EmptyState. (E) Colors unify: the
  rail's Colors section carries query groups ONLY — the class-colors block
  (list, add-class dropdown, reorder, handlers) is deleted; a one-time load
  migration converts each persisted `classColors` entry into a
  class-matching color group appended after the existing groups (label =
  the class's display name, `ast` = a group with a single
  `{type:"class", classId}` condition) and clears the retired list in the
  same write (the prefs field is retained so old stores round-trip); node
  color resolution is now group color → node's own color → renderer default
  (`classColorFor` and the `classColors` parameter retired from
  `nodeVisuals`), and the Colors chip's active state keys on the groups.
  (F) Blank-flash/jank fixes ("Obsidian is snappy, ours goes blank from
  time to time"): `reload` now bails on an unchanged topology — a signature
  over the node-id set + the edge list skips `setTopology`, so the store's
  600ms-debounced fan-in no longer tears the renderer down and reheats the
  physics for an identical graph (every reload used to rebuild the whole GL
  lifecycle); and the label pass's per-frame `new Map(nodeOrder.map(
  nameOf))` is cached in a ref, rebuilt only when the renderer's node-order
  identity changes or the 60-frame names-cache clear fires — no more steady
  per-frame allocation over ~7k nodes. Specs: the color-precedence unit
  tests, the renderer's hover contract (three-level flags, accent via the
  new param, `u_hoverDim` 0.2, `u_hoverMix`/`u_hoverColor` assertions), the
  label suite (dim-not-hide at 0.25 with cap, hovered label below the zoom
  threshold with the +3·dpr nudge), and the component suite (class-colors
  assertions removed; new specs for the classColors→groups migration
  persisting AST groups + clearing the list and the inline LoadingScreen).
  Docs: `docs/usage.md`'s graph hover + Colors paragraphs. Gate: `pnpm
  typecheck && pnpm test` green.
- **feat(web): the sort button leaves the table — list and cards views
  carry it too, the named "dates-first" sort backs the reference sections,
  and the table opens on Edited (owner 2026-10-13).** The mdi-sort control
  was table-exclusive; it now rides every collection view. New kit
  `SortMenuButton` (the ButtonWithPanel sort picker, value-agnostic);
  `SortMode` vocabulary in `views/types.ts` (`dates-first` /
  `alphabetical` / `position` / `edit-date`); the comparators in
  `views/collectionSort.ts` (every one ends in the id tiebreak — stable
  AND deterministic). **List view**: read-only projections only (an
  editable surface's drag order IS its order — the button hides there)
  get a Sort by panel — Dates first / Name A–Z / Default order. Dates
  first (the named mode) orders the PAGES, never the blocks: date pages
  newest → oldest, then the other pages A–Z — a grouped rendering sorts
  its groups (rows inside a group keep their document position), a tree
  sorts every sibling level, a flat list sorts its items; the window
  re-narrows on every resort. **Defaults**: Backlinks + Unlinked mentions
  open Dates first (child pages of a daily note surface first, most recent
  day leading); Child pages, Extended by, and Classed nodes open Name A–Z
  — the classed-nodes table included (container `defaultSort` Name-asc).
  **Cards view**: the flat grid gets the same button — Last edited (the
  default, `updatedAt` newest first) / Name A–Z; tree contexts and the
  grouped board hide it. **Table view**: the machinery is unchanged, but
  an Edited column joins the defaults (`node.updatedAt` in the user's date
  format, Columns-panel toggle, CSV projection, no day-page link), sort
  resolution reads every column (hidden included) so a sort survives its
  column being hidden — and the Sort panel offers the same full set.
  **Containers own table defaults** (an unset table renders the
  container's row order — query results keep the query's): classed nodes
  pass Name-asc, the tasks/assets hubs and the property-view references
  table pass Edited-desc. **The defaults are live**: a container default
  change re-seeds the view's sort until the user picks one (the
  useWindowed resetKey precedent) — while a section's quick search ranks
  its pool, the ranked order leads (the search ruling: its ids are
  membership AND order) and the section's default yields to it
  (classed-nodes alphabetical, references dates-first both step aside;
  an explicit user-chosen sort survives). All session state, never an op. Docs: `ux.md` (the collection-sort
  paragraph), `usage.md` (the section-chrome paragraph). **Verification:**
  new `collection-sort.test.tsx` (12 — comparator units over real
  deterministic date ids plus DOM wiring: grouped dates-first group order,
  tree/flat A–Z defaults, the table's Edited-desc opening, the button's
  presence/vocabulary, its absence on editable surfaces); the full suite
  and `pnpm typecheck` green on the slice branch.

- **feat(web): a NodeCollection flag hides the block-row backlink count —
  set for the Child pages tree and the Class View's "Extended by" list
  (owner 2026-10-13).** The row-end gutter toggle (the materialized
  `node_stats.backlink_count` badge) and its expanded linked-references
  panel honor `hideBacklinkCount` on the collection, threaded to BlockRow
  as `hideBacklinks` (which also skips the count read — the count falls to
  0 and the toggle, the panel, and the row-end's count branch all stay out;
  the classes column is unaffected). Threaded down BlockRow's recursion
  (children, table cells, table containers) and honored by the outline
  tree, the flat list, and cards card bodies alike. Set on the two
  read-only list projections where the count is reference noise: the page
  view's Child pages section and the class page's Extended by section.
  Test: a class with a real materialized backlink renders no
  `.nt-block-backlink-toggle`/`.nt-block-backlink-refs` inside the Extended
  by section. `docs/ux.md`'s block-gutter line carries the exception. The
  implementation landed via the owner-ordered checkpoint `fe9fe0a6` plus
  this commit's cards-body arm. Gate: web `tsc` clean on the touched files
  + `pnpm test` green (145 files, 1561 tests).

- **fix(web): the graph renders again on Firefox-class linkers (Zen included)
  — the time-lapse uniforms were declared in both shader stages.** The three
  new uniforms (`u_timeLapse`, `u_timeCutoff`, `u_hoverDim`) were declared in
  the vertex AND fragment sources, but the vertex shaders default to `highp
  float` while every fragment header reads `precision mediump float;` — a
  cross-stage uniform declaration must not carry two precisions, and Firefox's
  strict linker rejects the program with "Uniform `u_timeCutoff` is not
  linkable between attached shaders" (Chrome/SwiftShader tolerate it, so the
  gate's mock-GL and the dev browser both missed it). The vertex stages never
  used the trio (they only pass `v_time`/`v_hl` through), so the declarations
  drop to the fragment stage alone; a comment in the node vertex pins the
  constraint so the mistake can't recur. The GL error empty state also stops
  blaming the browser: a compile/link failure now reads "Graph renderer
  failed" with the linker's message, reserving "WebGL 2 required" for a
  genuinely missing context. **Verification:** `pnpm --filter @notees/web
  typecheck` + the four graph suites green (55); the scoped `notees-web`
  redeploy + `verify-min.mjs` smoke reports VERIFY-PASS — final confirmation
  is the owner's Zen reload.

- **feat(web): graph view round 2 — the right rail (Selection + Colors),
  query-builder color groups, kit-law finish.** The third stage of the round-2
  chrome reorganization (owner directives 2026-10-13): the right edge now owns
  curation. **(1) The right rail** — a kit `Card` at the graph's right edge
  (full surface only; the local-graph card keeps it out like the other
  full-surface chrome) with two `NodeViewSection` collapsibles, **Selection**
  and **Colors**, both resting collapsed; the rail's open/close persists per
  device in `graphPrefs.full` (`railOpen`), same debounced prefs idiom as the
  rest. The rail is a flex sibling of the stage (`.nt-graph__main`): the
  drawable area excludes its adaptive width (`--graph-rail-w:
  clamp(16rem,26%,22rem)` — also the toolbar's rail-open right inset) and the
  minimap hugs the remaining canvas. **(2) The top-bar chips become rail
  openers** — the Colors chip toggles the rail onto the Colors section; the
  **Selected · N** chip stays as count + opener, opening the rail scrolled to
  the Selection section (second click on the active section's chip closes).
  The retired chrome is deleted: the top-bar `SearchField` + `.nt-graph__search-
  results` dropdown, the Selected·N `ButtonWithPanel` popover, the hand-rolled
  `.nt-graph__groups` floating panel and its `usePopupDismissal` wiring (and
  their CSS). **(3) Selection section** — a permanent search via the shared
  `NodeSelector trigger="inline"` (`searchMode="all"`, `noCreate`: picking
  appends to the selection and never changes topology — the search-to-select
  register), above the re-homed reorderable selected list (kit `ListSortable`,
  per-item remove, Clear) with kit `EmptyState` when empty. Inline mode is the
  permanent-field idiom: NodeSelector's dismissal no longer clears an inline
  field's query (first inline consumer; the anchored/pill-row contracts are
  unchanged). **(4) Colors section** — the class-colors + query-groups
  content re-homed; query groups graduate from the raw text-DSL `<input>` to
  the full visual query builder (`FilterBlockBuilder` over a `@notees/query`
  `Group` AST, explicit full facet scope), the group name an optional kit
  `TextField`, the group list kit `ListSortable` — **the list order IS the
  first-match-wins priority** (order persists per device) — +Add-group a kit
  outline button, Paint-groups a kit `BooleanToggle`, the × a kit ghost
  `Button` (`.nt-graph__tool`/`.nt-graph__toggle` retired). **(5) colorGroups
  storage is the AST** — `GraphColorGroup` now carries `ast: Group | null`
  instead of the text query; `evaluateColorGroups` wraps the group in the
  workspace-scope QueryAst and runs the client's query runner (evaluation
  order = persisted list order). A one-time in-place migration at load parses
  any stored legacy DSL string through the DSL parser (names resolving
  against the workspace) and re-persists the AST via the debounced prefs
  write; a fail-loud parse error keeps the group but marks it erroneous
  (`ast: null` + the message surfaced in the rail's honest error row), the
  same honesty the old live `colorGroupError` had. Docs: `docs/usage.md`
  graph section (the right rail, search-to-select, query-builder color groups
  with sortable priority; stale search/popover wording replaced, the
  Filters → Visibility wording from the previous stage kept).
  **Verification:** `pnpm --filter @notees/web typecheck` green; graph suites
  green (re-pinned toolbar-composition spec; new rail-toggle / search-to-
  select / local-scope-omission / persisted-open specs, legacy DSL→AST
  migration specs at both the unit and component level, sort-order-drives-
  priority spec).
  eye, wired time-lapse, interaction polish, kit Chip.** Round 2 of the graph
  chrome reorganization (owner directives 2026-10-13): the bottom edge now
  owns the canvas. **(1) Control dock** bottom-left (mirroring the minimap):
  recenter + pause/play moved off the top bar, canvas-centered zoom in/out
  (the wheel's exact 1.12 factor / 0.02–40 clamp), and **Focus** (selection
  bbox fit with padding; a single node centers at 1.5). **(2) Minimap
  scroll-to-zoom** — the minimap wheel maps its pixel through
  `GraphMinimap.screenToWorld` and applies the same anchored-zoom math as the
  main canvas; drag-pan unchanged. **(3) Filters → Visibility** — the text
  chip becomes an icon-only ghost eye (`mdi-eye-outline`), lit
  (`aria-pressed`) while anything is hidden; panel content unchanged; the six
  family toggles are now the new kit **Chip** (one element per file,
  co-located token-only CSS, barrel-exported; the Colors trigger and
  +Add-group pill converted too — `.nt-graph__chip` retired). **(4)
  Time-lapse wired** — after every GL lifecycle rebuild the view feeds
  `setNodeTimes` (node `createdAt`, index-aligned) and per-edge stamps (own
  stamp else max of endpoints; synthesized families ride the endpoints); the
  mode bar's toggle opens a slim strip above it: play/pause (min→max over
  ~20s), a kit Slider scrubber over [oldest, newest], an Edges switch (off =
  edge array rebuilt without stamps — static edges; on = stamped), close.
  Scrubbing only moves the `u_timeCutoff` uniform — no repacks. The label
  overlay and node picking honor the cutoff (a not-yet-visible node is
  neither labelled nor hoverable/draggable/openable). Session-local, like
  pause. **(5) Interaction polish** — hovering a node dims everything
  outside its neighborhood (`setHoverNeighborhood`, flag rewrite once per
  hover change) and raises the app-standard **NodeHoverPreview** card through
  a 1px cursor-riding sentinel adapter (`notifyNodeHover`); the hand-rolled
  text tooltip survives for edges only. **Keyboard surface** on the stage
  (tabIndex, no window listeners — the graph also renders inside the local
  card): +/- zoom centered, arrows pan (Shift 4×), F focus, R recenter;
  modifiers other than Shift and text-editing targets pass through.
  **Kit:** `ButtonWithPanel` now honors its `active` prop (was parsed and
  dropped — the Visibility eye is the first caller). New pure
  `views/graph/cameraMath.ts` owns the shared zoom/factor/clamp/pan/fit math
  (spec'd). Right rail, search-to-select rebuild, and the colors-panel
  upgrade remain the next stage. Docs: `docs/usage.md` graph section
  (dock/minimap zoom/time-lapse/hover card/shortcuts, Filters → Visibility);
  `docs/developers/ui-primitives.md` catalog gains Chip.
  **Verification:** `pnpm --filter @notees/web typecheck` green; web suite
  139 files / 1506 tests green (re-pinned toolbar-composition spec; new
  cameraMath + minimap-zoom + label-cutoff specs).

- **feat(store,web): graph time-lapse stage A — creation timestamps through the
  graph projection, first-appearance edge stamps, renderer time cutoff + hover
  neighborhood.** (1) The store's graph projection (`graphTopology`) now
  surfaces `createdAt` on every node (the node row's true create-time stamp)
  and on edges: the earliest contributing row's stamp across a merged weighted
  group (synthesized parent/class and co-occurrence semantic/temporal families
  carry none — null). (2) The derived edge index's `created_at` becomes a
  first-appearance stamp: the re-derivation conflict path keeps the EARLIEST
  stamp (`COALESCE(MIN(...))` — a NULL never wins), and property edges are
  stamped from the value row's `hlc_physical` in the envelope ISO shape —
  deterministic, so wipe → replay converges across independent-write orders.
  Downstream consumers are unaffected: `backlinksWithRollup`/
  `referencesWithRollup` pass the stamp through without ordering on it, and
  the query compiler's date arms read `node.created_at` only. (3) The WebGL2
  graph renderer gains per-node/per-edge creation-time attributes (seconds
  since epoch, `-Infinity` = none), `setNodeTimes`/`setTimeLapse` backed by
  `u_timeLapse`/`u_timeCutoff` (anything created after the cutoff renders
  fully hidden; with the mode off the shaders take the exact pre-existing
  path), and a lightweight `setHoverNeighborhood` that rewrites per-node/
  per-edge/per-arrow Uint8 highlight flag buffers once per hover CHANGE
  (O(N)/O(E), never per frame — deliberately not the setSelectedNodes repack);
  arrowheads follow their edges for both features. `GraphNode`/`GraphEdge`
  shape changes are additive; `GraphView` wiring (feeding the times, the
  time-lapse controls) lands in a later stage.
  **Verification:** `pnpm --filter @notees/store test` (489 green, incl. the
  new first-appearance stamp specs + graph createdAt specs); the web graph
  suites (`graph-renderer` 18, `graph-view`/`graph-sizing`/`graph-followups`/
  `graph-engine`/`graph-controller` 40 — 58 total) green; `pnpm --filter
  @notees/web typecheck` green.
- **feat(web): the card's classes/tags rows are the nodeview bar's own
  elements (addable from the card); right-click on the title opens the node
  menu (the three-dot is gone); a breadcrumbs row rides first; the cover is a
  card element inside its cell with full-width row hairlines (owner batch
  2026-10-13).** Five refinements of the v1 card. (1) The classes row drops
  the read-only projection and hosts the INTERACTIVE NodePills the nodeview
  bar uses (picker with create row, × removal with the journal-class lock,
  drag reorder); the tags row hosts the page header's TagsRow composition
  with its "Tags:" label hidden — classes and tags are addable and removable
  right on the card. Date nodes stay metadata-locked (the ClassesRow rule);
  a locked empty row renders nothing. (2) The title's RIGHT-CLICK opens the
  node's context menu (the v1 context-menu register); the "…" button and the
  hover action cluster are gone — the selection checkbox is the card's only
  hover chrome. (3) The containing-page breadcrumbs ride as the card's FIRST
  row (previously an opt-in `showBreadcrumbs` prop that no surface set);
  a parentless node renders nothing and the row collapses. (4) The
  child-blocks header label reads **Content**. (5) The horizontal-cover
  redesign the owner's screenshot asked for: the cover sits INSIDE the
  content cell as a matted, rounded sub-card (spacing-2 inset, shape-medium
  corners), the image filling the mat absolutely — a portrait cover no longer
  stretches the card beyond its rows — and the content is a two-column grid
  whose row hairlines extend ACROSS the cover column (CSS subgrid, the
  `@supports`-guarded fallback keeps rows in the main column), so the card
  reads as one surface. Docs: `docs/ux.md` + `docs/usage.md` re-worded.
  **Verification:** new specs (add-class/add-tag affordances on the card, the
  title context menu with no three-dot, the breadcrumbs row) plus the
  re-pinned card suite; `pnpm typecheck` + the full web suite green (1516).
- **fix(web): the card's breadcrumb row hides the "+ Add parent" pill — the
  card edits existing parents only (owner 2026-10-13).** The editable trail
  had brought the parentless-node Add parent affordance along ("unneeded
  noise" — adding a parent stays a top-bar gesture; on the card we only allow
  editing or removing existing parents). `Breadcrumbs` gains an `addParent`
  opt-out (default unchanged — the top bar keeps the pill); the card passes
  `addParent={false}`. Reassign parent… / Remove parent on existing edges
  are untouched. **Verification:** the spec re-pins both sides (parentless
  card: no pill; parented card: the crumb renders and its right-click edge
  menu opens); `pnpm typecheck` + the view-modes/system-sections suites
  green (58).

- **fix(web): the card's breadcrumb row is editable like the top bar's (owner
  2026-10-13).** Same component, but the card instance had been wired with
  `editable={false}` (the read-only instinct carried over from the first
  wiring) — no hover chevron, no edge menu, no "+ Add parent" pill. The flag
  flips: the trail's edit gestures (Reassign parent… / Remove parent on the
  edge, Add parent on a parentless node; date-locked edges hide themselves
  inside the component) now ride on the card exactly like the top bar, with
  the component's own client writes. **Verification:** new spec (a parentless
  card offers Add parent); `pnpm typecheck` + the view-modes suite green (36).

- **fix(web): the card's breadcrumb row starts at the card's top-left (owner
  2026-10-13).** The card's Breadcrumbs instance had copied the sidebar
  card's `anchor="right"` — the trail hugged the row's right edge instead of
  starting at the left corner (owner screenshot). The anchor prop drops; the
  component's default left packing applies. **Verification:** `pnpm
  typecheck` + the view-modes suite green (35).

- **feat(web): the Capacities-parity search surfaces — the extended
  full-page search at `/search`, the section quick-searches unified onto
  the ranked order, and in-app find-in-page (owner 2026-10-13).** Three
  surfaces close the comparison gaps. **Extended search** (`SearchPage.tsx`
  + route): Ctrl/Cmd+Shift+F or the palette's "Search all for \"…\"" row
  opens a full-page ranked search — cursor-paginated (`searchPage`, 25 per
  page), `NodeResultItem` rows with breadcrumb + class pills + a
  `<mark>`-highlighted snippet per hit, scope Tabs (All/Main/Blocks) and a
  class Dropdown filtering the accumulated stream, the `"…"` exact and `^`
  starts-with modes documented in the empty state. **Unified quick-search**:
  the FilterBar's quick text in Backlinks, Unlinked mentions, and Classed
  nodes no longer substring-filters titles — it rides
  `rankRowsBySearch(useSectionData.ts)`, where the ranked search's ids are
  both the membership and the ORDER of the pool (structured filters then
  compose over the narrowed pool unchanged; the structured builder's own
  content-contains keeps its LIKE grammar semantics). The regression shape
  is asserted: "gmi dental" renders **GMI Dental Implantology** before GMI
  Ecuador — plain substring matched neither. **Find-in-page**: Cmd/Ctrl+F
  on a page opens the find bar (docked under the node top bar) searching
  the subtree DATA — collapsed blocks count exactly like rendered ones —
  with match counter, prev/next cycling, case and whole-word toggles, and
  replace (one op per affected block via `client.updateObject`;
  cross-token matches are navigable but not replaceable, the honest v1
  scope); the existing Ctrl/Cmd+Shift+F block find/replace widget is
  untouched and the two coexist. Docs: `usage.md` (palette paragraph +
  reference-sections paragraph + a find-in-page line). **Verification:**
  three new test files (search-page 12, find-in-page 12, plus the rewritten
  filter-layer ranked-semantics tests); the full apps/web suite is green
  (142 files / 1532 tests) and `pnpm typecheck` clean on the rebased tree.

- **feat(store): diacritic folding (schema v19) + fuzzy-subsequence rescue —
  the Capacities "find by intent" pair (owner 2026-10-13).** Two gaps the
  Capacities search comparison surfaced, closed in the ranker
  (`packages/store/src/search.ts`). Folding: `peru` now matches "Perú" —
  implemented as INDEX-TIME folding (`reindexNode` strips combining marks
  from the indexed plaintext; `compileSearchQuery` folds the MATCH terms —
  one mirror pair), because the stock sql.js FTS4 tokenizer rejects
  `remove_diacritics` (verified against the shipped wasm, "unknown
  tokenizer"), so a tokenizer option is off the table for the browser
  backend; the tier scorer folds its haystacks through the same
  `foldSearchText`, and the snippet helper folds only its hit check so
  excerpts keep their real characters. The v19 migration drops and rebuilds
  pre-v19 indexes from the derived plaintext (a virtual table's rows cannot
  be UPDATEd with re-tokenized text), module-aware: a cross-backend parked
  table is the queryability repair path's job, and migrations run locally
  before snapshots ship. Fuzzy rescue: the whole query as an ordered
  subsequence (word-start and consecutive bonuses, the palette's fuzzyScore
  semantics) — inside the candidate set it lifts a partial match above plain
  partials, and when NOTHING reached the literal tiers a scan over every
  main node's title rescues the query (`gmi dntl` finds GMI Dental
  Implantology) at tier 6, strictly below every exact/prefix match; the scan
  is gated to ≥3-char default-mode queries and the no-literal-hit case, so
  the common path never pays for it. Docs: `architecture.md` (the FTS4/5
  paragraph), `usage.md` (the palette paragraph). **Verification:** the
  store suite carries both directions of folding, exact-mode folding, the
  snippet's original characters, the fuzzy rescue and its stay-off gate, and
  a v18→v19 migration test (unfolded rows rebuilt, folded rows, ordering
  clean) — 538/538 on both adapters; `pnpm typecheck` green.

- **feat(store,web): priority-ranked search — exact title matches first, `"…"`
  exact mode, `^` starts-with mode, alias terminals, parent-name matches;
  the node picker composes the kit SearchField (owner 2026-10-13).** The
  reported failure — searching `gmi dental` returned nothing (not even the
  **GMI Dental Implantology, S.L** page) — was the old bm25 ordering
  burying the exact-title node under content-heavy pages and mention blocks,
  past the picker's 50-hit window: live data confirmed the node was indexed
  and matched all along, just ranked out of existence. Search is rebuilt as
  priority ranking (`packages/store/src/search.ts`): the FTS match
  generates candidates (multi-term OR, so partials enter the set), one
  shared JS tier scorer orders every hit identically on FTS5 and FTS4 —
  0 exact query (case-insensitive substring) in a main node's title → 1
  exact in a block's text → 2
  all terms in order (non-adjacent) in a main title → 3 all terms in order
  anywhere → 4 the first parent's title matches (blocks surface under a
  matching page) → 5 partial (more matched terms first) — with position /
  span, then text length, then the FTS score, recency, and id inside a
  tier. Query modes: a fully quoted query (`"gmi dental"`) is exact
  (exact case-insensitive substring only, no partials), a leading caret
  (`^gmi dental`) is starts-with (position 0 only); a quoted phrase inside
  a larger query keeps its exact-adjacency AND semantics, and the
  query-package `contains` filter stays conjunctive (documented
  divergence). A matching node alias also contributes its terminal (chain
  walked like `resolveAlias`), so the canonical page appears when searched
  by an alias name; alias text values already rode the FTS row. The
  client's unlinked-references pass rides the exact mode too — its
  every-hit-counts assumption broke under OR (single-word hits counted as
  name mentions), and adjacency is the honest "typed the page's name"
  semantics. In the web
  app the `@` mention picker (NodeSelector) now composes the kit
  `SearchField` — the standard rounded bar with icon and clear affordance —
  replacing its ad-hoc raw input and its one-off CSS (dead
  `node-selector__search*` rules gone). Candidate volume is capped on FTS5
  (bm25-ranked top 1000 UNIONed with an exact-phrase arm, so exact
  matches can never be capped away; the asset-name lookup prepares once
  per connection) — measured on the live-size projection: `gmi dental`
  909 ms → 28 ms, a common-term query 3.2 s → 0.2 s, the org page at rank
  2 behind its own shorter-titled child page. Docs: `architecture.md` (the
  FTS4/5 + ranking paragraph), `development.md` (the store-suite row),
  `usage.md` (the `/api/search` row + the palette paragraph's ranking and
  mode syntax), `ux.md` (the blocks-display paragraph). **Verification:**
  `pnpm typecheck` + `pnpm test` green; the store suite carries the new
  tier contract on both adapters (the GMI scenario, mode constraints,
  parent-name surfacing, alias expansion) and the re-pointed picker-input
  tests (`node-link-gestures`, `block-selection`) pass against the
  SearchField.



- **feat(web): the v1 card's body collapses by default, and the card title
  IS the page-view title row (owner refinements 2026-10-13).** Two amendments
  to the v1 node card shipped earlier today. (1) The child-block body starts
  COLLAPSED (the v1 `isBodyCollapsed` register — the first cut defaulted
  expanded on "always show them" reading as visibility; the owner clarified
  the v1 shape stands: the chevron shows the content on demand). (2) The card
  title stops being a flattened label on a button and becomes the SAME
  implementation as the page header title — a bullet-less BlockRow
  (`variant="title"`, read-only): the content stream renders its inline
  tokens, so class chips ride as live node links (the owner 2026-10-13
  node-link look — click opens the class, the title click opens the node
  through the card's OutlinerContext, the page header's trampoline
  contract), the untitled placeholder and the Newsreader content face come
  along for free. The card-title typography stays the card register (the
  `.nt-page-title` headline font is scoped back, body-lg/600). The head
  button's icon + render-state label retire (the classes row below carries
  that identity — the v1 look). Model note pinned in the spec: document-chrome
  nodes carry text-only titles (the store's flatten invariant — appliers.ts
  object.create), so rich chips render on BLOCK members' cards. Docs:
  `docs/ux.md` + `docs/usage.md` re-worded (title row, collapsed body).
  **Verification:** the v1-card specs re-pinned (collapsed default, expand/
  collapse round trip, chip-link + title-click targets); `pnpm typecheck` +
  the full `pnpm test` gate green.

- **feat(web): the v1 node card, 1:1 — classes + tags chips, property rows,
  child blocks on every card — and the cards/table children ruling (owner
  2026-10-13).** The register was read from the v1-archive tag
  (`KanbanCard.tsx` + `CardItem.css`, law 0). ONE card shape now serves the
  flat grid, the grouped board, and tree contexts (the TreeCards/FlatCards
  split is gone): the cover slot (kept, empty-state Add cover included), a
  header with the v1 collapse chevron + the hover-reveal action cluster
  (open-in-sidebar when the surface wires shift-click, the node-actions
  menu — the v1 right-click context menu rides as the menu button, the v2
  grammar for that menu), the **classes chips row** (`NodePills` read-only)
  and the **tags chips row** (alphabetical `NodePill` chips) — both hidden
  when empty, the v1 read-only rule — the **property rows** (default: EVERY
  effective property with a non-empty display text, the v1 register; a
  container may scope — the classed-nodes section passes its bound columns
  so its cards mirror the table), and the **child-block body** — always
  resolved and shown: attached `children` win, flat collections resolve the
  node's blocks from the client (`childQuery`, revision-cached), EXPANDED by
  default with the chevron as display-state collapse. Cards ignore the
  tree/maxDepth "show children" prop family on purpose (the classed-nodes
  complaint: member cards showed no content); the **table mode** is the twin
  ruling — rows are always flat, children never render (contract docstrings
  carry both). Cards and board host their own OutlinerContext (the FlatRows
  precedent) since card bodies render BlockRow on every surface, including
  the shell hubs. Read-only adaptation, by the standing cards grammar: the
  v1 card's inline editors, add-class/add-tag/add-block affordances, and
  slash commands stay in the outline mode — cards open nodes on click. The
  in-flight backlink-count hiding slice threaded its flag through the old
  TreeCards; its re-land threads the same one line into the unified card
  body. Docs: `docs/ux.md` gains the card-anatomy law, `docs/usage.md` the
  cards paragraph. **Verification:** 4 new `view-modes` specs (client-side
  children resolution, chevron collapse, chips + scoped property rows,
  table-nevers-children); `pnpm typecheck` + the full `pnpm test` gate green
  (1515).

- **fix(web): "Convert to heading" (and its "Convert to plain text" inverse)
  appear only on block nodes (owner 2026-10-13).** The gate lived solely on
  content shape, so the option leaked onto every context-menu surface whose
  content is a single text run — class pills, page-title chrome, promoted
  rows. `headingConversionOf` now returns null unless the node renders as an
  inline block (`rendersAsInlineBlock` — parented, non-class,
  `presentAsMain = 0`), matching the gesture's documented block-menu home;
  `docs/usage.md` already scoped it to blocks, no doc change needed. The
  unit stubs grow the render-state fields, plus a case asserting class and
  main-node shapes offer neither direction. Gate: `pnpm test` green.

- **docs(developers): the v1 source of truth is the `v1-archive` git tag —
  recorded in the skill and the runbook (owner 2026-10-13).** The pre-rewrite
  v1 app (React + Lexical frontend, Python FastAPI backend) survives only as
  the `v1-archive` tag on this repo (found while hunting for the v1 node
  card: the old local checkout at `/root/projects/notees` is long gone and
  v1-era session wires were the only pointer). The `notees-development`
  skill's law 0 now names the tag and points at a register map (the
  dispatcher's prop family, the view registry, the card view — registered as
  `kanban`, body in `KanbanCard.tsx` — list/document/table, immersive
  views, node chrome, backend), duplicated as `docs/developers/development.md`
  §9 with the fetch-and-read recipe. **Verification:** repo-only docs change;
  the map's paths verified against the tag (`git ls-tree`).

- **fix(web): the class page's "Extended by" tree nests each extender under
  its DIRECT parent (owner refinement 2026-10-13).** The first direct-only
  cut of this section (earlier today) rendered a FLAT list of the direct
  extenders — the owner clarified the wanted shape: source's section shows
  book with x nested as book's CHILD, and x never appears as its own
  top-level row under source. The section is a tree again, but built from
  DIRECT extends edges only (`getDirectClassChildren` per level, replacing
  the transitive-closure read that double-listed grandchildren at the top
  level); the badge counts the direct extenders. The test asserts DOM
  nesting via the rows' `data-block-id`s — the leaf row sits inside its
  direct parent's row, and the section carries exactly the two family rows.
  `docs/ux.md`'s class-page line: "a tree of direct extends edges". Gate:
  `pnpm test` green.

- **feat(web): inline class mentions wear the node-link look — a class-colored
  wavy underline, no pill — and their name reads in every flattened surface
  (owner 2026-10-13).** Read mode renders a `class_chip` as a link styled
  like a mention (`.nt-link--class`) but with a wavy underline instead of
  the dashed one, tinted by the class's effective color (the extends-chain
  `effectiveClassColor` walk) via the new `resolveClassColor` prop on
  `InlineTokens`; the old read-mode pill chrome (`.nt-chip
  .nt-class-chip`) is gone, and clicking the chip opens the class exactly
  like a mention opens its target (read-only projections degrade to the
  styled non-interactive span). Edit mode keeps the atomic chip but tints
  its wavy underline at build time (`buildEditableDom` gains an optional
  `ClassColorResolver`; `OutlinerClient` exposes `effectiveClassColor`),
  and the arrow-selected state now hides the wavy underline like the
  mention's dashed border so the focus ring reads as one clean shape.
  Flattened surfaces include the chip's resolved class name instead of
  dropping it: `plainTextExcerpt`/`deriveDisplayName` take an optional
  class-name resolver (a chip's one-off `displayText` still wins), and the
  browser tab title plus the table view's name cell — its CSV projection
  and sort key riding the same `nameCellText` — pass it, so a page titled
  "␣contrato␣ entre GMI…" (chip first) reads complete everywhere.
  **Verification:** `pnpm typecheck` + `pnpm test` green; `VERIFY-PASS`
  from the verify-min smoke after the scoped web redeploy.

- **feat(web): the card cover slot renders even when empty — the missing
  cover is visible and fillable in place — plus a card roundness step down
  (owner 2026-10-13).** In cards mode the cover layouts (cover top/left/
  right) previously rendered nothing at all on a coverless node, so the
  layout's promise ("every card carries a cover") read as a gap with no way
  to close it. Now the slot renders on every card under a cover layout: a
  node without a cover shows the quiet **Add cover** affordance (the
  header CoverCard precedent — image-plus icon + label centered on the
  matted slot, the 16:9 top slot keeps its shape) which opens the
  image-only AssetUploadModal;
  the uploaded asset node becomes the cover through the shared
  `setNodeCover` write (the `coverAssetId` wire field + the asset class,
  error → the notification store). The no-cover layout is unchanged —
  text-only card, no slot, no lazy observation; asset-classed cards never
  hit the empty state (their imagery is their own bytes). The slot's read
  was corrected in the same pass: `cardImageAssetId` still probed the
  RETIRED image-typed `cover` property, so a cover set through the wire
  field (the CLI, the API, the header card) never showed on cards — it now
  reads `node.coverAssetId` like every other surface. Card roundness steps
  down with it: `.node-card` `--shape-card` (20px) → `--shape-extra-large`
  (12px). Docs: `docs/ux.md` + `docs/usage.md` (the cover paragraphs carry
  the empty-slot rule). **Verification:** new `covers.test.tsx` block (4
  specs: the empty slot + its a11y name, the no-cover gate, the
  upload-modal fill flow landing on the wire field, the wire-field read
  regression); `pnpm typecheck` + the full `pnpm test` gate green.

- **fix(web): the class page's "Extended by" section lists DIRECT subclasses
  only (owner 2026-10-13).** The section previously built a multi-level tree
  from the transitive extends closure, so a grandchild subclass (x extends
  book extends source) rendered under BOTH source and book. Now the section
  renders only the one-edge extenders under each class — x shows under book's
  section, source's shows book alone. New read alongside the transitive
  `classChildIds`/`getClassChildren` (kept — the section-view class closures
  still need the closure): store `directClassChildIds` (a
  `class_extends`-table query), `WorkspaceClient.getDirectClassChildren`,
  and the worker-client/worker-core scope-read plumbing; the section drops
  the recursive tree build (the `tree` flag stays so rows render childless
  tree rows rather than the flat view's live-children fallback). The
  ExtendedBySection test flips from asserting the transitive tree to
  asserting the leaf renders under its direct parent only; `docs/ux.md`'s
  class-page line says "direct subclasses only". Gate: `pnpm typecheck` +
  `pnpm test` green.

- **docs(protocol): the date-chain parent/class locks are LOCKSTEP-COMPLETE —
  the GTK and Flutter appliers carry the same guards (owner 2026-10-13).** The
  sibling ports of the date-chain slice (`notees-gtk` `b90beb2`,
  `notees-flutter` `1c4aff7`) implement the five guards with TS-identical
  semantics and messages: `object.move` onto anything but the deterministic
  chain parent, `object.create` claiming a non-chain parent, `object.create`'s
  classIds carrier with a foreign class (running before the OR-Set seeding and
  the re-create early return), `class.unassign` of the precision's system
  class, and `class.create` on a date id — all `MoveGuardError`-typed so each
  client's existing replay-quarantine path covers historical violations. Each
  repo gained the domain helpers (`date_chain_parent_id`/`date_chain_class_id`,
  `dateChainParentId`/`dateChainClassId`), a guard test suite modeled on the TS
  store tests, and its changelog entry; GTK gate `pytest` 782 passed + `ruff` +
  `mypy` clean, Flutter gate `flutter analyze` clean + 630 tests passed.
  SCHEMA.md's two Datetime bullets flip from LOCKSTEP-PENDING to the
  all-three-implementations statement; development.md's lockstep paragraph
  records the TS-first-then-ports precedent.

- **refactor(web): the breadcrumb trails' parent-edit chevron composes the
  core HoverRevealButton (owner 2026-10-13).** The trail affordance that
  originated the hover-reveal pattern now consumes the core element shipped
  for the topbar undo cluster's history chevron: the crumb item carries
  `.ui-hover-reveal-group`, the chevron renders as `HoverRevealButton` with
  its `node-breadcrumb-edit` class kept as the host/test hook, and the
  local CSS copy of the collapse/reveal/hover rules is gone — one
  implementation of the animation, both surfaces. Behavior is unchanged
  (hover-of-crumb reveal, focus-visible reveal, zero footprint at rest,
  date-locked edges still hide the affordance). **Verification:** `pnpm
  typecheck` green (after rebuilding `@notees/domain`'s dist — the
  date-chain slice's `dateChainClassId`/`dateChainParentId` exports were
  src-only); `pnpm --filter @notees/web test` green (1505/1505 across 143
  files, zero errors).

- **fix(web): the first section below the block tree stops floating — the
  Created section on date pages and Classed nodes on class pages (owner
  2026-10-13).** Both wear the shared `NodeViewSection` chrome, whose
  `padding-top` steps down `spacing-3`→`spacing-2`: the hairline already
  sits directly at the child-blocks ghost row (0px above it — measured), so
  the 12px below it read as a void between the blocks and the section
  header. The sidebar-panel and `.nt-page-sections` overrides (both 0) are
  untouched; the gap below every section hairline in the content flow
  tightens with it, one step, in line with the chrome passes above.
  **Verification:** `pnpm typecheck` + `pnpm test` green (single-test flakes
  under the concurrent session's load, green on immediate re-runs);
  `VERIFY-PASS` from the verify-min smoke after the scoped web redeploy;
  live measure-probe diff on a fixture day page in the test workspace
  (ghost row→section header 34→30px; section `padding-top` 12→8px), fixture
  trashed after.

- **feat(web): the topbar's history chevron becomes a hover-reveal
  affordance, and its popup right-anchors to it (owner 2026-10-13).** The
  undo cluster's dropdown arrow now hides at rest — the cluster keeps the
  exact footprint of undo + redo — and expands on hover of the cluster,
  exactly like the breadcrumb trails' parent-edit chevron (same
  width/height + opacity motion, same zero-width-at-rest mechanics). It
  also stays revealed while the history popup is open (including when the
  popup was opened from the Ctrl+Shift+H shortcut, with the pointer
  nowhere near), because the popup mirrors `aria-expanded` onto its anchor
  and the reveal honors it. The pattern is generalized into a core
  element, `HoverRevealButton` (`ui/` kit + barrel export): zero footprint
  at rest, revealed by `.ui-hover-reveal-group` hover, keyboard focus, or
  `aria-expanded` on the trigger. The popup itself now right-anchors —
  `useViewportFlip` grew an `align: 'end'` option (right edges flush,
  viewport-clamped, default `'start'` unchanged) and the history menu
  uses it, so the menu's right edge rides the chevron's right edge.
  **Verification:** `pnpm typecheck` green; `pnpm test` green (the full
  run's three `workspace-snapshot-rebuild` 5s timeouts were load flakes —
  the file passes standalone and in the scoped server suite, 225/225; web
  1503/1503 across 143 files, zero errors).

- **fix(web): breadcrumbs drop the self crumb — the trail is ancestors only
  (owner 2026-10-13).** The breadcrumb trail no longer appends the current
  node as a highlighted trailing crumb: the page header already names the
  page, so the crumb duplicated it (and duplicated it a second time in the
  right-anchored card header and the clipped-trail popup). The `showCurrent`
  prop retires with it; the parent-edit gestures are untouched — the direct
  parent crumb still carries the chevron/right-click menu editing the page's
  own parentage, and a parentless page still offers only "+ Add parent".
  **Verification:** `pnpm typecheck` green; web suite green (the touched
  breadcrumb specs re-verified in isolation after two unrelated timeout
  flakes under full-suite load).

- **fix(web): the chrome tightens one more step — nodeview top bar gaps and
  the sidebar's top/bottom padding (owner 2026-10-13, second pass).** (1) The
  **nodeview top bar** now sits `spacing-2` (8px) off the card top (the
  panelled page's top padding steps down from `spacing-4`) with a
  `spacing-2` margin below (down from `spacing-3`) — the bar is chrome and
  hugs its content like the app top bar above it (top gap 16→8, bottom gap
  12→8). (2) The **sidebar's vertical padding steps down to `spacing-2`**
  (sides stay `spacing-3`): the gap before the first section header under
  the app top bar drops 20→16px, and the pinned user section's bottom gap
  drops 20→16px. The raised-panel comment that mirrored the top bar's old
  margin is corrected with it.
  **Verification:** `pnpm typecheck` + `pnpm test` green; `VERIFY-PASS` from
  the verify-min smoke after the scoped web redeploy; live before/after diff
  via measure-probe (bar top gap 16→8, bar bottom gap 12→8, sidebar header
  gap 20→16, user-row bottom 20→16).

- **fix(web): the nodeview top bar's divider hairline retires (owner
  2026-10-13).** The `border-bottom` under the panelled bar is gone — the
  `spacing-3` margin below stays as the bar's whole separation from the
  columns, and the bar reads as a plain pinned row like the app top bar
  above it (which never carried a divider either). `PageChrome.tsx`'s
  NodeTopbar doc comment updated with it.
  **Verification:** `pnpm typecheck` + `pnpm test` green; `VERIFY-PASS` from
  the verify-min smoke after the scoped web redeploy; live screenshot via
  measure-probe confirms the hairline is gone.

- **fix(web): the top-bar padding stacks are gone — the nodeview top bar, the
  app top bar's gap below, and the sidebar's user section (owner 2026-10-13).**
  (1) The **nodeview top bar lost its own vertical padding**: the panelled
  page's `spacing-4` top padding carries the bar's top gap alone now (matching
  the horizontal padding that carries the sides) — the bar's `spacing-2` used
  to stack on top of it and read as double (27px above vs 12px below, 17px at
  the sides). (2) The **main content card's (and right rail's) top margin
  steps down to `spacing-2`**: the app top bar's 44px height already carries
  slack below its controls, so the full `spacing-3` margin stacked into a
  double gap under the bar (18px below the buttons vs 6px above; now 14px).
  (3) The **sidebar's pinned user section rides the sidebar's own padding**
  (horizontal row padding → 0, the nav-list law): the avatar lines up with the
  nav icons and the gear with the rows' right edge instead of the row's
  `spacing-3` stacking on the sidebar's (24px inset vs the nav column's 20px).
  (4) **Live measurement is now a durable tool**:
  `scripts/screenshots/measure-probe.mjs` signs in (the owner-password login
  API, or an automatic temporary session minted into the relay DB and deleted
  at exit — the operator key answers account endpoints 401 and is not a UI
  credential) and dumps every chrome surface's rect + padding/margin/gap as
  JSON with the recurring derived gaps precomputed, plus a screenshot; run it
  BEFORE against the live stack and AGAIN after the redeploy to diff.
  Recorded in `docs/developers/ui-debugging.md` (Live measurement + Auth) and
  the notees-development skill's development-workflow reference.
  **Verification:** measured live before/after with measure-probe
  (card→node-topbar buttons 27→19px — the bar's top edge itself lands at 17,
  the side padding; topbar→card 12→8px; sidebar avatar 32→20px = the nav
  column); `pnpm typecheck` + `pnpm test` green (3086 tests); `VERIFY-PASS`
  from the verify-min smoke after the scoped web redeploy.

- **feat(web): settings align with the fleet design system — a 5-swatch accent
  picker, a 4-option theme control, and a deep-linkable full settings page at
  /settings/<section> beside the slimmed quick-tweaks modal (owner 2026-10-13).**
  (1) **The accent picker is exactly five curated presets** — Margin Green
  (default), Monochrome, Brown (#a16b45), Teal (#1fbdad), Purple (#8c47d1) —
  replacing sage/rose/navy and retiring the custom color wheel together with
  its `--color-accent-custom` plumbing (variables.css, deviceSettings.ts, the
  index.html bootstrap, the drift-gate allowlist). Dark variants are the light
  value lightened ~L+20% (the copper precedent) and every on-accent foreground
  is computed per pair against WCAG ≥4.5:1 — margin 7.48/6.88, monochrome
  15.81/16.57, brown 4.70/8.09 (brown-light pairs with black — white lands at
  4.46), teal 8.16/12.46, purple 5.33/8.12 (light/dark). A stored retired
  preset falls back to Margin Green on the next apply — device-local, no
  migration. (2) **The theme control is one 4-option segmented control** —
  Light / Dark / OLED / Auto over the unchanged `notees.settings.*` keys
  (Light→theme:light; Dark→theme:dark,oled:false; OLED→theme:dark,oled:true;
  Auto→theme:system,oled:false) — replacing the 3-icon picker and the separate
  "Pure Black" toggle; a stored system+OLED combo resolves to Dark on the next
  save (no migration). (3) **User Settings is now two surfaces**: Ctrl/Cmd+,
  and the sidebar gear open the quick modal (theme, accent, focus mode, and an
  **Advanced settings →** row), and the eight full sections
  (appearance/editor/general/sync/account/security/support/about) live on a
  full settings page in the PageCard slot with a sidebar section nav (a
  horizontal scroll row on narrow widths), rendered behind the same
  session/offline gate as the modal. (4) **/settings/<section> routes ride the
  existing pushState/popstate seam** — deep links boot straight into the
  section, section nav pushes state, back/forward swaps sections, unknown
  sections land on appearance, and hub/node navigation leaves the route.
  Verified: `pnpm typecheck` + `pnpm test` green (1496 web tests)
- **feat(store,server,web): node merge — the v1 merge gesture, extended to the
  v2 model, composed of existing ops (no wire change).** A merge absorbs one
  page into another and trashes the source. The heart is a pure planner over
  the derived store — `packages/store` `planMerge(db, sourceId, targetId)`
  (SCHEMA.md "Node merge", the normative semantics) — emitting a deterministic
  batch of ordinary convergent ops: the source's active children move to the
  target (order preserved, `afterId` chaining); class/tag bindings remap (the
  re-issued `object.create` add carrier + `class.unassign`/`tag.unassign`
  tombstones); authored properties copy into EMPTY target slots only (target
  wins; multi-value slots union under fresh PG5 element ids; self-references
  rewrite); incoming mention tokens in every active referencing page retarget
  (quote/heading nesting included; the edge index re-derives); aliases
  repoint; node-typed property values (object/asset refs, datetime anchors,
  date-qualified metadata) rewrite by re-addressing the same element;
  collection memberships remap; cover/banner/description fill empty target
  fields; the source trashes LAST. Guards fail loud before anything reaches
  the log (`MergeGuardError` → 422): class/collection/trashed source, target
  inside the source subtree, source === target. Because the wire is untouched,
  GTK/Flutter clients converge on a merge by replay alone — no applier
  changes, no fixture-gate slice; the CLI ships its own surface in
  `notees-cli` (`notees object merge`, vendor pin to this commit).
  **Store:** `src/merge.ts` + exports + the `uuidv7` dep; 12 new specs on both
  adapters (end-to-end merge, guards, wipe→replay determinism, field copy,
  rewrite helpers) — **503 tests green**. **Server:** `POST
  /api/objects/:id/merge {targetId}` plans over the server's projection and
  submits through the one write path; `?dryRun=true` returns the plan summary
  without writing (the CLI preview contract); OpenAPI route-table entry (the
  coverage gate pins it); 5 new route specs — **230 tests green**. **Web:**
  `WorkspaceClient.mergeNodes` applies the plan as ONE undo-journal batch (a
  single undo restores the merge); `MergeNodesModal` (source prefilled from
  the open page, pages-only target picker, danger confirmation naming both
  pages) and a command-palette row **"Merge current page into…"** shown only
  while a mergeable page is open (non-class, document chrome; the host
  contributes it only in the in-process store mode — the worker mode has no
  local DB for the planner yet); 7 new specs — **1487 web tests green**.
  Docs in the same pass: SCHEMA.md "Node merge", `docs/usage.md` (web app
  item + the API table row), `docs/ux.md` (the merge section + undo
  coverage), `docs/developers/architecture.md` (the composite-gestures
  precedent + file map). **Verification:** `pnpm typecheck` clean;
  `pnpm test` green per package (store 503, server 230, web 1487; the
  server suite needed one re-run — concurrent sessions' test loads on the
  shared host timed out 25 unrelated specs, all green on retry).
  **Redeployed:** `notees-sync` + `notees-web` rebuilt, `verify-min.mjs`
  VERIFY-PASS.
- **feat(store,web): date-chain nodes are parent-locked and class-locked —
  the breadcrumbs parent-edit affordances hide on date nodes, the classes row
  renders read-only, and the appliers reject any re-parenting or foreign
  class assignment on a date id (owner 2026-10-13).** A date node's parent IS
  its deterministic chain parent (year at the workspace root, month under its
  year, day under its month) and its class set IS its precision's system
  class (year/month/day, nothing more, never declared a class itself —
  SCHEMA.md "Datetime" gains both normative rules): (1) the store's
  `object.move` rejects any other parent with `MoveGuardError` (same guard
  class as the class-no-parent rule, so the replay-quarantine path applies);
  `object.create` claiming a non-chain parent or carrying a foreign class
  fails loud the same way — the classIds guard runs before the OR-Set seeding
  and the re-create early return, so the `class.assign` re-issued-create
  carrier is covered too — while a parentless create stays legal (the
  standalone shape the client chain self-heal adopts) and the move/re-add
  onto the chain-correct parent/class stays legal, which the client's
  `ensureDateChain` self-heal rides. `class.unassign` refuses the precision's
  system class (foreign-class removal stays legal as legacy cleanup);
  `class.create` on a date id fails loud. New `@notees/domain` helpers
  `dateChainParentId` / `dateChainClassId` derive the locked parent/class;
  store tests on both adapters cover every guard, plus domain round-trip
  tests. (2) The web `Breadcrumbs` hide the crumb edit menu / chevron on any
  edge into a date node and the "+ Add parent" pill on a parentless date node
  (both editable call sites — top bar and rail cards — inherit the lock);
  the `ClassesRow` renders read-only (no Add-class pill / × / drag-sort) on
  date nodes, and the block editor's `+` class capture never opens while
  `/checkbox` applies the token without the task assignment on them.
  **LOCKSTEP-PENDING: the GTK/Flutter appliers must carry the same guards
  before all three clients reject alike** (SCHEMA.md marks it;
  development.md's lockstep paragraph records the precedent).

## 2026-10-12

- **feat(web): heading blocks are back — the `heading` content token with
  Convert-to-heading in the block context menu, the Table of content becomes
  a standard section over headings only, the group counts ride the section
  badge, and the content chrome gets its spacing fixes (owner 2026-10-12).**
  (1) **The wire gains the block-scale `heading` token** (`{children}` — the
  inline union; additive, with the canonical `heading-content.json` fixture
  and every content arm wired: domain excerpt/stringify — flattened, NOT a
  promotion survivor; store FTS + edge walks; the five export serializers —
  markdown `##`, html `<h2>`, docx Heading 2, latex `\subsection*`, pdf;
  the editable projection and the word count). **LOCKSTEP-PENDING: the
  GTK/Flutter strict validators must accept `heading` before those clients
  ingest heading content** (SCHEMA.md marks it; the sibling-repo slices are
  the follow-up). (2) **Convert to heading / Convert to plain text** ride
  the block context menu, conditionally visible by content shape (a single
  text run ⇄ a single heading token; richer content offers neither) — each
  an ordinary undoable `object.update`. (3) The **Table of content** section
  (renamed from Contents) rides the standard collapsible section chrome,
  lists **heading blocks only** (the short-one-liner heuristic and the
  sub-page entries retired), hides while the page has no headings, and
  clicking an entry **jumps the main view to the block** (scroll + flash).
  (4) The list-view **group counts wear the section badge pill**, beside
  the group name instead of a bare number at the row's far right. (5)
  Chrome fixes: the **horizontal scrollbar on the main content area is
  gone** (the kit icon buttons' invisible 44×44 hit-area overlay inflated
  every ancestor's scrollWidth — the nodeview column now clips
  horizontally; wide tables keep their own scroll wrapper), the panelled
  page gets **symmetric side padding** (both cards read alike), and the
  context column's **footer is one tidy non-wrapping row**. Verified: `pnpm
  typecheck` + `pnpm test` green; new `heading-convert.test.tsx` (unit +
  menu end to end), TOC specs re-pinned to heading tokens, domain + html
  export heading specs; `docs/usage.md`, `docs/ux.md`, `SCHEMA.md`, and
  `releases.md` (the current-wire line) updated.
- **feat(web): the block multi-selection is whole-subtree and reads as a
  card — one outline per contiguous run, standing out where the per-row tint
  whispered (owner 2026-10-12).** (1) **Subtree closure:** every selection
  write path (`replaceSelection`, `toggleSelected` in `outliner-context.ts`)
  closes the set over the selected blocks' descendants — selecting a block
  selects its children, so the selection is always a contiguous vertical run
  and the outline is a true rectangle. The closure reads the current tree
  through a latest-value ref (the callbacks are stable `[]`). (2) **The card:
  `SelectionOutline`** renders one absolutely-positioned box per contiguous
  run inside `.nt-select-surface` — full surface width, from the first run
  row's top to the last run row's bottom — with a primary border + soft
  primary-container fill, `pointer-events: none`; the retired per-row tint
  rule goes (the `.nt-block--selected` class stays: semantics + tests). Rects
  are measured from the DOM relative to the surface (scroll-invariant),
  recomputed every render + on resize, state-updated only on real change.
  Verified: `pnpm typecheck` + `pnpm test` green; `block-selection.test.tsx`
  gains three specs (ctrl+click subtree closure, one-card-per-run + disjoint
  second card + Escape clears, shift+click anchor closure).
- **feat(web): the selection law — text selection exists only inside the block
  being edited; a press-drag outside edit mode is the block-range gesture, and
  it arms only when the pointer exits the pressed block's borders (owner
  2026-10-12).** Read-mode block content becomes `user-select: none`
  (restored under `.nt-block--editing`), so the native cross-block text
  selection — drag starting in an edited block, extending across read blocks —
  is impossible by construction. `useBlockSelectionSurface` re-arms on the
  border exit instead of the retired 4 px vertical threshold: a press inside
  the editing block keeps its in-block text selection (the press is recorded,
  never preventDefaulted) until the pointer leaves the contentEditable's
  borders — then the native selection is dropped and the same drag continues
  as a block-range selection from that block. Verified: `pnpm typecheck` +
  `pnpm test` green; `block-selection.test.tsx` gains a read-mode border-exit
  spec and an edit-mode hand-over spec.
- **feat(web): Ctrl/Cmd+L over a selection opens the node-link picker in the
  @-replace mode (selection prefilled as the search query, pick swaps the
  selection for the link); Ctrl/Cmd+Shift+L opens it with an empty query and
  keeps the selection as the inserted link's custom label; the picker banners
  the mode under a faint one-liner above the search field (owner 2026-10-12).**
  `openMentionFromSelection` grows a `query | label` mode (label mode stashes
  the selection as `capture.fixedLabel`, which wins over the query-based
  Ctrl/Cmd+Enter label in `commitNodePick`); the anchored `NodeSelector` gains
  a `hint` prop (`node-selector__mode-hint`). The @-over-selection gesture and
  the selection toolbar's @ button ride the same banner ("Replacing selection
  with link"), and the toolbar button now names the chord. The Ctrl+L chord
  keeps the typed-`@` word-boundary rule (mid-word selections don't open);
  Ctrl+Shift+L opens anywhere a selection exists. Without a selection neither
  chord intercepts (the browser keeps Ctrl+L). Verified: `pnpm typecheck` +
  `pnpm test` green; `capture.test.tsx` gains three chord specs.
- **feat(web): a bare 4-digit year outside the date-node window labels the
  create row "Create year \"1711\"" instead of "Create \"1711\"" — in the
  `@`-mention picker and the command palette alike (owner 2026-10-12).**
  `dateParser.ts` gains `isPlainYearQuery` (bare `\d{4}` outside the domain's
  1900..2200 `DATE_UUID_*` window — inside the window the date suggestion row
  already owns the year affordance, so the plain create row stays generic
  there). Verified: `pnpm typecheck` + `pnpm test` green; `pickers.test.tsx`
  and `search-palette.test.tsx` gain year specs.

- **feat(web): the owner-corrections batch — narrow search popups, the
  Properties rename, the + back beside the tabs, favorites with icons +
  drag-sort, and six smaller fixes (owner 2026-10-12).** (1) At **≤768px
  the quick search folds into a magnifier button** whose anchored popup
  carries the field (`useMediaQuery` + the kit `ButtonWithPanel`; wide
  widths keep the permanent field). (2) The **Metadata section is renamed
  Properties** everywhere user-facing (the in-flow section, the panelled
  first column, the block-row sections; internal class names unchanged).
  (3) The add-view **+ rides the tablist's end** again (the right-cluster
  experiment reverted per owner). (4) **Favorites** render the same row UI
  as Recents (icons), say plainly "**No favorites yet**" when empty, and
  are **drag-sortable** (dnd-kit vertical sort over the rows; the committed
  order writes through the nodePrefs store, `reorderNodeFavorites` — the
  same optimistic+server channel as the star toggle). (5) The side panel's
  section contents lose the title-alignment indent (spacing-7 → spacing-3
  in the narrow column). (6) **Extended by** stops showing a stale count
  over an empty list — the tree rebuilt per render instead of a memo keyed
  only on [client, classId], which cached the mount-time [] forever (the
  "34 subclasses, no rows" bug). (7) **Popups toggle on anchor re-click**:
  the kit ContextMenu no longer treats its own anchor as an outside press,
  and NodeMenuButton closes on a second click. (8) The panelled class page
  no longer overlaps the "…" menu on the context toggle — class pages ride
  the same chromeMenu slot as pages (the absolute corner is inline-block
  views only). (9) The panelled layout retires its right padding so the
  scrollbars hug the card's border (the top bar keeps its own inset). (10)
  **Child pages hides when empty** — the main-surface always-render
  exception retired; creation lives in the "…" menu and the New button.
  (11) The Templates section's **Browse gallery** button retires (it
  duplicated the bind pill's picker). Verified: `pnpm typecheck` + `pnpm
  test` green; new specs for the narrow fold, the menu toggle, and the
  favorites reorder; system-sections re-pinned to the hide-when-empty
  ruling; `docs/usage.md` + `docs/ux.md` reworded.
- **feat(web): the class side panel loses its divider stack, the tab row
  breathes before the view below it, and the context column rides class
  pages too (owner corrections 2026-10-12).** (1) The panelled first column
  showed a hairline per section — every `NodeViewSection` carries a default
  top rule, the sections-stack wrapper added one more — three rules inside
  one bordered card. The side panel now suppresses the sections' top rules
  (`.nt-page-side-panel .node-view-section`) and the wrapper's own hairline
  retires: whitespace-only separation. (2) `.nt-section-views`'s column gap
  rises `--spacing-1` → `--spacing-2` — the hosted tab bar sits off the
  collection it drives. (3) The **context column is enabled for class
  pages** — the "class renders no context column" ruling retires ("for any
  nodeview in general"): `showContext` folds into `panelled`, the top bar's
  context toggle is unconditional again, and class pages gain graph/TOC/
  Activity/Comments + the footer in the third column. Verified: `pnpm
  typecheck` + `pnpm test` green; the context-column spec flips its class
  assertion (column present, top bar present); `docs/ux.md` reworded.
- **feat(web): the class page renders the properties-sidebar layout — Metadata
  + Class properties + Templates ride the first column, Classed nodes the
  content column — and the app top bar gains a session-only layout toggle
  (owner 2026-10-12).** The class variant re-joined the panelled main layout
  (`panelled` no longer excludes it): the variant descriptor grows a
  `sidebarSections` stack (Class properties + Templates, under the Metadata
  panel in the first column), the content stack keeps Classed nodes as the
  centerpiece, and the class page keeps the standing **no-context-column**
  ruling (the nodeview top bar's context toggle is now optional and hidden).
  The extends pills re-anchor to the nodeview top bar via a `classesCorner`
  override (the compact corner keeps them top-left). The **top-bar layout
  button** flips the current node between the sidebar layout and the in-flow
  **sections** layout — component state, never stored; the icon names the
  active mode (`view-split-vertical` sidebar / `view-agenda-outline`
  sections); hidden while no node is open. The compact layout preserves the
  pre-change class flow exactly (the moved sections return to the content
  stack in their original order). Verified: `pnpm typecheck` + `pnpm test`
  green; class-view gains two specs (panelled placement + the compact
  ordering); `docs/ux.md` (the Class View paragraph) and `docs/usage.md` §2
  reworded.
- **feat(web): one chrome row on the hosted tab bar — every button right,
  permanent search, the builder below without moving the row; sidebar hover
  star displaces the class flag; Favorites always renders; classed nodes
  re-default to table; the table stops stealing focus on load (owner
  corrections 2026-10-12).** (1) The add-view **+** left the tablist (a
  button has no business inside `role="tablist"`) and joins the bar's
  right-hand cluster; the quick search is a **permanent field** again (the
  magnifier fold shipped this morning and is reverted — `collapsibleSearch`
  is removed); the views' own toolbars (the table's columns/sort/more, the
  cards/board selection + cover-layout rows) **portal into a slot** in the
  same row (`views/viewChrome.tsx` — a hosted `NodeCollection` provides the
  target; un-hosted surfaces keep the body-top row), and the FilterBar
  renders **last** in the cluster so its structured panel wraps a full-width
  line beneath the row **without moving the other controls**. (2) The
  sidebar's favorite star renders **in-flow** on hover and displaces the row
  content (the class flag chip) instead of overlaying it. (3) **Favorites
  always renders** — empty, it names how to fill it ("No favorites yet —
  hover a row and star it to pin it here."). (4) Classed nodes read TABLE:
  fresh classes already did; a marker-guarded **one-time migration** drops
  the stored per-class pre-ruling choices so every class reads the default
  again (`viewPrefs.ts`). (5) The table stops focusing the last cell on
  load: `InlineInput.autoFocus` is now opt-in (the click-to-edit rename path
  passes it; the always-mounted editable property cells never do — the last
  rendered autofocus input in the DOM was winning the page focus). Verified:
  `pnpm typecheck` + `pnpm test` green; a filter-layer spec pins the
  cluster's ordering contract (the + outside the tablist; switcher and table
  toolbar precede the search field; nothing moves when the panel opens);
  node-prefs gains the empty-Favorites placeholder spec; `docs/usage.md` §2/§4,
  `docs/ux.md`, and `docs/developers/architecture.md` reworded.
- **feat(web): the collection filter/view chrome rides the hosted tab bar's
  far right — the quick search folds behind a magnifier toggle (owner
  2026-10-12).** The classed-nodes section's toolbar row (search box,
  structured-filters toggle, view switcher) and the reference sections'
  body-top FilterBar give way to ONE chrome row with the section's tabs:
  `NodeCollection` gains a `tabBarTrailing` slot (forwarded to
  `SectionViewTabs`' `trailing`, rendered at the bar's far right; only in
  the hosted tab bar), the FilterBar gains `collapsibleSearch` — the quick
  text search hides behind a magnifier toggle that opens the field beside
  it (focused); a set text facet never folds away — and the structured
  builder still drops a wrapped full-width panel beneath the row (the bar
  now wraps). The classed-nodes view switcher rides the same slot; the
  un-hosted surfaces (hubs, the Created section, the blocks toolbar) keep
  their ViewToolbar unchanged. Verified: `pnpm typecheck` + `pnpm test`
  green; filter-layer tests re-pinned to the folded search plus a new
  fold-behavior spec; `docs/usage.md` §4, `docs/ux.md`, and
  `docs/developers/architecture.md` reworded to the tab-bar chrome.
- **feat(web): the graph chrome is streamlined — one quiet bar, two popovers,
  and a transparent overlay layout (owner rulings 2026-10-12).** The toolbar
  carried ~14 same-weight controls in mixed registers; now: (1) The **top
  bar is a transparent overlay** — no background, no rule, floating on the
  canvas — holding only the canvas controls: recenter, pause, the Filters
  and settings popovers, the counts (inline), colors, search, and the
  selection chip. (2) A **mode bar centered at the bottom edge** (the v1
  position, owner ruling) carries the layout switcher, also transparent.
  (3) A new **Filters popover** decides what is drawn: the six link-family
  chips, Class nodes, Orphans, the journal Visibility levels (migrated out
  of the settings popover), and — deleted from its lonely bottom bar — the
  two Semantic detail sliders now ride next to the families they bound. The
  chip lights when anything is filtered. (4) The **settings popover is
  physics + sizing only** and the physics preset is a named **dropdown**
  (the icon-radio guesswork is gone); the size-by-metric cycling button is
  retired (it duplicated the popover's Node sizing control — one pref, one
  control). Verified: `pnpm typecheck` + `pnpm test` green; the
  toolbar-composition spec re-pins the new chrome contract (Filters
  popover, preset dropdown, bottom mode bar); `docs/usage.md`'s graph
  section rewords the chrome paragraphs.
- **fix(web): the property value popups stop bleeding the page through —
  both pickers portal to the body, viewport-fixed; the stray hairline
  between a block and its children is gone; the property icon names its
  default-sourced value.** (1) The block-row property icon popover
  (`PropertyIconButton`) and the metadata select picker
  (`SelectionPropertyControl`) rendered in-flow absolute — inside stacked/
  transformed contexts the page content painted over their surface, the
  "transparent popup" the owner caught on the graph. Both now ride the
  established `useViewportPosition` pattern (body portal, fixed position,
  viewport flip + clamp) — the same mechanism the date picker uses.
  (2) The 1px line under metadata-carrying blocks was the per-block
  collapsed `Metadata` section's `border-top` (`.node-view-section`'s
  divider read as a stray hairline between a block and its children,
  owner 2026-10-12) — in-flow block metadata no longer draws the top
  divider; page-level sections keep theirs. (3) The effective-value
  semantics the owner asked about already hold — `effective = authored ??
  winning binding's defaultValue`, derived never stored
  (`packages/store/src/effective.ts`) — but the Task class's bindings carry
  no defaults, so unset status reads as unset; the property icon's tooltip
  now names default-sourced values (`Status: Backlog (default)`, the same
  hint the metadata table carries). Verified: the property icon / block
  metadata / properties panel / property view suites green; the hairline
  and popup fixes confirmed by Playwright probes against the live stack
  (the exact node from the owner's screenshot: zero border candidates
  after the fix path, scratch fixtures trashed).

- **feat(web): the list view IS the outline view — full block rows in every
  collection's list mode, editable inline, with recursive children; the
  read-only variant is the inert twin (dead content click, the bullet opens,
  no full-row hover).** The flat path of `OutlineView` used to render a
  reduced thin row (bullet + label + render-state chip, whole row a button).
  That row kind is deleted: the list mode now renders the same `BlockRow`
  machinery the page body and the read-only tree projections use — one real
  outline row per item, hosting its own `OutlinerContext` (the
  `ReferenceSubtree` precedent) so it renders outside a page view, with open
  gestures resolving to the container's `onNodeClick`/`onNodeShiftClick`
  (falling back to the enclosing context's navigation). Rows show recursive
  children (the item's own `children` when the container supplied them, else
  the client's live children, depth-capped) with the collapse chevron; the
  windowing contract (`useWindowed` + Show more) is unchanged. Editable
  containers get inline editing: the **Tasks hub now passes `editable`**
  (new `CollectionHub` prop), so its list mode edits content in place and the
  status property rides the row as the clickable bullet icon button (the
  task family binds Status with the bullet display) — click the row's text
  to type, click the circle to change status. Read-only rows are the new
  inert variant (`BlockRow.readOnlyInert`, class `nt-block--inert`): the
  content click does NOTHING, the cursor stays the reading default, the
  row-hover bullet brightening is scoped back to the bullet's own hover, and
  **the bullet element is the only open gesture** (click opens, shift+click
  peeks) — the old full-row hover wash died with the thin row. Edit/read
  alignment: read-only rows now render the SAME metadata chrome statically —
  property icon buttons (`nt-propicon--static`), the classes column
  (`NodePills.readOnly` — static pills, no add/remove/reorder/menu, the "+N"
  overflow popup lists without mutation chrome), the tags row
  (`TagsRow.readOnly`), and the collapsed **Metadata** section
  (`PropertiesSection`/`PropertiesTable`/`readOnly` threaded through every
  row type — scalars as text, carriers via the read-only `ReferenceSubtree`,
  selects/dates/objects as static pills, booleans as a disabled checkbox,
  assets without actions, no add-property row, no label settings/context
  menus, no text-row auto-unset pass). Block-scale widget tokens inside a
  list row render their compact PLACEHOLDER (`BlockRow.suppressWidgets`,
  threaded down the recursion) instead of the live surface — a live query
  inside a query result row could recurse, and the list names the widget
  while the page body owns the live surface. The read-only TREE paths keep
  their click-content-to-open contract (Child pages, "Extended by") — only
  the flat list is inert. Verified: `pnpm typecheck` + `pnpm test` green
  (1454 web tests; the view-modes suite now pins the tasks-hub inline-editing
  contract — status buttons on both row kinds, click-to-edit — and the new
  inert read-only contract: content click opens nothing, the bullet does;
  query-block/query-builder/queries-hub suites re-pinned on full rows;
  windowing + class-view unbroken).

## 2026-10-09

- **feat(web): graph settings surface for clustering — the toggle and the
  separation slider are real, and the docs say what the sim now does.** The
  `clustering` flag was hardcoded `true` in the physics bag both at engine
  init and in the live-tuning effect — now it is a persisted pref (default
  on) with a **Clustering** row in the Simulation section, and when it is on
  a **Cluster separation** slider (0–100, default 65) rides below it,
  mapping to the soft-shell margin multiplier (0.5×–2× the preset gap) —
  the same mapping the engine reads. `docs/usage.md`'s graph section names
  both controls and documents the energy-gated contract: the simulation
  settles to a true equilibrium and rests; dragging a node reheats only its
  neighborhood. Verified: `pnpm typecheck` + `pnpm test` green; the
  graph-view and followups suites (settings composition included) pass.

- **feat(web): the graph view clusters for real — type-weighted full Louvain
  (phase 1 + phase 2), a size-aware soft shell between communities, and
  honest force balance.** The hairball had three separate causes. (1)
  **Community detection never found communities.** The Louvain port ran
  only phase 1 (single-node local moving): on any graph it stalls in a
  pair-fragmented local optimum (moving one node out of a pair is always a
  modularity loss), and it ignored link types. Now: edges are weighted by
  type (structural links count most, cooccurrence/temporal least), the
  resolution parameter γ defaults to 0.8 (below 1 = coarser, more visible
  communities; above ~1.25 the resolution limit shatters real
  communities), and phase 2 — whole-community merges with the correct ΔQ
  (internal edges stay internal, no loss term) — alternates with phase 1
  for up to 5 rounds. Verified on planted partitions: 4–8 dense
  communities of 12–60 nodes all detect intact. (2) **Cluster forces were
  diluted to nothing.** Cohesion was ~100× weaker than repulsion
  (0.0012→0.006); the centroid push was divided per member (`/cnt`) so a
  200-node community's share was 1/200 per node — now `clRad` surfaces +
  a soft-shell term (`clusterShellStrength`, t² overlap envelope between
  each community's radius and the separation margin, present in both the
  direct and Barnes–Hut paths) give size-aware contact repulsion, and the
  per-member distribution is `/√cnt` so communities move as units.
  Inter-cluster bridges are loosened (rest ×2.2, stiffness ×0.35) — they
  stay visible but stop welding communities together. (3) **Central
  gravity re-created the blob.** The default origin spring (0.015/node at
  slider 30) pulled every community toward the same point and balanced
  the soft shell into a mixed mass; the mapping is now 0–0.02 (slider 30
  → 0.006) so clusters clear each other under the default gravity —
  verified: two bridged 30-node communities settle with >2 shell radii
  between surfaces (gravity off) and >1.5 (default gravity). Also: the
  settle gate's energy is now per-tick displacement² (dt-aware — a
  shrunken adaptive timestep can no longer freeze a far-from-balance
  layout), and alpha decay halved (0.01→0.005) so convergence has time
  to finish. Verified: `pnpm typecheck` + `pnpm test` green; the engine
  suite carries the detection (bridged planted communities stay two
  intact clusters) and separation (surface clearance, both gravity
  regimes) specs.

- **feat(web): the graph physics reaches a true equilibrium and freezes —
  per-node activity alpha, energy-gated settling, and reheat locality (a
  drag perturbs only its neighborhood).** The engine docstring always
  promised "alpha cooling for natural settling" but `step()` passed a
  hardcoded `1.0` every tick and all six forces ignored the parameter; the
  sim ran at 60 fps forever and stillness was faked by a per-tick ×0.92
  velocity multiplier, a 1e-4 sleep clamp, and a velocity cap. Now: (1)
  every node carries an activity alpha that decays exponentially per tick
  and scales every force — the long-ignored `apply(alpha)` contract is real,
  via `engine.alphaArr`. (2) The integrator uses constant dissipative drag
  (`drag: 0.9`, replacing `friction`/`damping`, the latter dead) — at
  equilibrium forces scale to zero with alpha so velocity bleeds out at a
  true force balance instead of being frozen mid-tension by damping. (3) A
  settle gate (every active node below `alphaMin` AND mean kinetic energy
  below epsilon for 30 consecutive ticks) declares the graph `settled` and
  zeroes velocities, accelerations, and every alpha — frozen means frozen,
  not merely quiet. (4) The worker STOPS its self-ticking clock at settle
  (no more permanent 60 fps wakeups on a converged graph) and interaction
  reheats: topology/config changes globally, drags LOCALLY — `reheatLocal`
  injects activity only within `influenceRadius` (400) of the pointer, so
  moving a node slightly never makes distant nodes budge; distant nodes hold
  exact position, verified to the float. The cluster-centroid force is
  distributed per member as `clFx/√cnt` instead of `/cnt` so a large
  community moves as a unit instead of having its push diluted away. The
  `settled` flag rides the frame message (both the postMessage and
  SharedArrayBuffer paths) and the main-thread fallback mirrors the
  worker's reheat semantics. Verified: `pnpm typecheck` + `pnpm test` green
  (new engine specs: settle-then-freeze is bit-exact, alpha decays, local
  reheat leaves the far node unmoved with alpha 0, global reheat restarts);
  the six graph suites (engine/controller/sizing/view/renderer/followups)
  green. Docs: the engine docstring now describes real behavior.

- **fix(web): block-row property icons ride the bullet's first line —
  never centered against a multi-line block.**
  Owner 2026-10-09: the value-display icon groups (the schema "bullet" /
  "inline" display positions, the Logseq-DB "beginning of the block")
  carried `align-self: center` in a baseline-aligned row, so on a block
  whose content wraps they sank to the vertical middle of the whole block
  — 32px below the bullet on a 5-line block — instead of staying with the
  bullet on the first line. The groups now baseline-align through the
  `.nt-bullet::before` strut pattern (6px strut + the bullet's shared −2px
  optical lift), landing the 20px icon buttons exactly on the dot's
  geometry; the inline group's content-hugging position is unchanged.
  Same-pass robustness guard: a zero-width content floor
  (`.nt-block-row > .nt-block-content { min-width: 8ch }`, zero kept
  inside `.nt-blocktable-row` cells) — in a column narrower than the row
  chrome (grip + icons + right-end) the content used to collapse to 0
  width and the pre-wrap text exploded into one word per line, stretching
  the row to ~2000px and dragging the centered icons with it.
  Verified: geometry probe on a seeded Task block (bullet-display
  boolean + inline-display select + backlink) — icon centers read equal
  to the bullet center (309.4 vs 309.4) at both 1500px and 760px
  viewports; web suites green.

- **feat(web): Backlinks and Unlinked mentions are two normal
  NodeCollection sections — the references tab strip is retired.**
  Owner 2026-10-09: below the page content the two references leave the
  shared tab bar and each rides the normal collapsible-section chrome
  (NodeViewSection header + eager count badge + hosted view chrome + the
  shared FilterBar at the body top, one FilterQuery per section) with the
  lazy useSectionData contract every other section has. The hide-when-empty
  ruling becomes per-section: each renders only while its own count reads
  > 0 (promoting the last unlinked source retires the section rather than
  leaving an empty tab). Backlinks starts EXPANDED — its read is cheap and
  it is the incoming direction (the old selected tab resolved on mount);
  Unlinked mentions starts COLLAPSED — its list query is the expensive FTS
  pass, and the collapsed start keeps it lazy behind the first expand.
  Filter chrome: the strip-level magnifier/builder row (shipped earlier
  today) gives way to the shared FilterBar per section — the quick search
  is always visible, the builder opens below the bar. The date-page ruling
  stands (no Unlinked mentions section, the count read skipped) and Child
  pages is untouched. The strip's `.nt-backlinks`/`.nt-ref-*` CSS, the
  Tabs primitive usage, and useSectionData's now-orphaned `keepFresh`
  option (the loaded-tabs contract died with the tabs — the
  collapsible-section contract re-runs only while expanded) are gone;
  ReferenceList (the block-level backlink gutter's shared rendering) is
  unchanged.
  Verified: web suites green.

- **feat(web): the references strip's filter chrome rides the tab row.**
  Owner 2026-10-09: the Backlinks/Unlinked mentions strip's FilterBars (one
  per panel body) give way to strip-level chrome on the tab row itself, far
  right — an icon-only magnifier folds/unfolds the quick-search field, and
  the structured-filters toggle opens the query builder in a full-width
  region below the row. The chrome is strip-level: it survives a tab switch
  and binds live to the ACTIVE tab's FilterQuery and counts (an open builder
  follows a switch and edits the newly active tab's draft), while each tab
  still owns its query instance — a switch never leaks a filter across. The
  classed-nodes table and the other FilterBar consumers are untouched.
  Verified: web suites green.

- **fix(web): date pages carry no Unlinked mentions tab.** The whole
  deterministic day/month/year family drops the Unlinked mentions tab from
  the bottom references strip (owner 2026-10-09): the literal date text
  those pages accumulate is noise, never a discovery surface — a date page's
  strip shows Backlinks only, and hides entirely when it has none. The
  unlinked count read (a full FTS pass per render) is skipped for date pages
  too — the journal feed renders one embedded day page per entry. Ordinary
  pages are unchanged (both tabs always show once the strip renders).
  Verified: web suites green.

- **fix(web): the journal and calendar day feeds no longer render an empty
  "Metadata 0" section on property-less pages.** Embedded `PageView` renders
  (the journal feed, the calendar's day pages) now drop the in-flow
  properties section — and its hairline divider — entirely while the page
  carries no effective property rows (the same emptiness test the block
  metadata section already used, exported from `MetadataSection.tsx` as
  `metadataRowCount`). The standalone compact page view keeps the section
  even when empty — it remains that layout's add-property entry point; the
  panelled main layout is unchanged (the Metadata sidebar always shows).
  Verified: web suites green.

- **fix(web): the boot-form connect prompt reads "Connect to a Notees sync
  server — or work offline."** Owner wording ruling across all clients — the
  GTK login description and the Flutter server-setup prompt ship the same
  "a Notees sync server" phrasing (GTK v4.1.2, Flutter v4.0.2); the web's
  "your sync server" line was the last holdout. Verified: web suites green
  (137 files / 1443).

- **feat(protocol,store,query,export,server,web,scripts): the unified
  Datetime property — `date`/`date_range` retire into one `datetime` type with
  per-value Full-day (default on), an All-day-off time, and a Range toggle.**
  (1) Wire: `propertySchema.create`'s strict type enum drops `date`/
  `date_range` for `datetime` (retired values rejected outright, the
  no-backward-compatibility law); a value is a point `{nodeId, time?}` or a
  range `{start: slot|null, end: slot|null}` anchored to the unchanged
  year/month/day node chain — every legacy shape is a legal member of the new
  union, so no value ever needed rewriting (the "date is a node" law stands;
  the time-of-day law is amended: wall-clock `HH:MM` rides the value beside
  the day-node anchor, no timezone handling anywhere). (2) Store/query: one
  `datetime` validation arm replaces the two date arms (bare-uuid
  normalization kept; `time` requires day precision on both the schema
  ceiling and the slot ref; mixed nodeId+start/end shapes and malformed
  times fail loud); the query compiler routes `datetime` with new range arms
  (eq/contains = the bound's period within [start, end], open side
  unbounded; relational ops compare the range start; date-only bounds ignore
  `time`). (3) Export: `NODE_TYPED_SCHEMAS` becomes `{datetime, object,
  asset}`; timed slots render their wall-clock time, ranges keep the
  start/end map, the JSON archive stays verbatim. (4) Web:
  `setDateProperty`/`setDateRangeProperty` fold into `setDatetimeProperty`;
  `DatePropertyRow`/`DateRangePropertyRow` unify into `DatetimePropertyRow`;
  the canonical picker aligns to the reference — month grid under month/
  year dropdowns with ‹ › navigation, a Suggestions column (Yesterday/
  Today/Tomorrow/In 1 week/In 2 weeks, ✓ on the current date), an All-day
  switch (ON by default — full-day is the absence of `time`; OFF reveals a
  24h HH:MM input per slot), a per-value Range toggle (OFF collapses to the
  point), the recurrence picker riding inside, and Remove. TableView cells,
  calendar rows, quick-create, import, property definitions, and the convert
  modal all route `datetime`. (5) Live migration:
  `scripts/migrate-unified-datetime.mts` — Path B in-place rewrite of the
  retired `payload.type` values (snapshot patch, restore-epoch bump, NO
  compensation envelopes; dry-run default, idempotent; ran 2026-10-09 after
  the GTK/Flutter ports — owner workspace 82 envelopes rewritten + epoch 6,
  test workspace 3 + epoch 1, snapshots patched, full-replay verified — then
  the stack restarted onto the new images). Fixture gate 24→25
  (`property-datetime.json`). Verified: every package suite green on both
  store adapters (store 473, query 203, protocol 328, domain 76, export 239,
  server 225), web 1428 green, root typecheck clean, the migration mechanics
  proven against a synthesized throwaway relay (plan / rewrite / full replay
  / idempotency / log-alone convergence).

- **feat(web): every header action row button retires once its gap is filled
  — Add icon hides when an icon is defined (the icon element takes over as
  the picker entry), Add aliases when the page has an alias (the metadata
  panel's row is the entry); the row itself disappears once all three are
  set (Add description already retired when set).** Owner ruling on the
  Capacities row shipped earlier today: the row is a fill-the-gaps surface,
  not permanent chrome — an empty row is chrome for nothing. Day pages and
  the embedded/preview/focus surfaces are unchanged (no row there at all).
  Verified: `page-header-actions` suite green (8 specs — the icon and alias
  flows now assert the button retires after the pick, plus the all-set row
  disappears while the icon element and subtitle stay).

- **feat(web): the sidebar cards stand out — a lighter fill in dark — and
  the footer retires from the card bottom to become the context column's
  bottom section.** (1) New token `--color-sidebar-card` (variables.css):
  light keeps the main card's own surface; dark steps one tone LIGHTER
  (`--color-surface-container-highest`, accent-washed graphite) so the
  nested cards read against the near-black surface — the rest of the card
  element is unchanged (hairline frame, `--shape-card` radius,
  `--shadow-elevation-1`). (2) The card-bottom bar (word count +
  Created/Updated stamps) is deleted from the middle column — it overlapped
  the sidebar cards — and moves into `.nt-page-context` as its bottom
  section (`.nt-page-context__footer`, `margin-top: auto` pins it to the
  card bottom; the panelled footer neutralizes the compact layout's sticky
  + full-bleed insets and rides transparent over the sidebar card).
  Compact surfaces (class pages, peek cards) keep the footer at the card
  bottom — they have no context column. Docs: `docs/ux.md` +
  `docs/usage.md` (footer location + context-column contents). Verified:
  web build green, web suites green; verified live with a probe against the
  redeployed stack (computed styles + screenshots, dark and light).

- **feat(web): the nodeview sidebars wear the SAME card element the main
  content container uses, nested inside it.** The first pass gave the two
  panel columns their own smaller-radius, higher-elevation card — too
  subtle, it read as no card at all in dark. Owner correction: mirror
  `.nt-page-card` exactly (surface fill, hairline frame, `--shape-card`
  20px radius, `--shadow-elevation-1`) on both `.nt-page-side-panel` and
  `.nt-page-context` — a card within a card, like the right rail's peek
  cards. The sketched `--color-raised-card` tone-step token drops with it
  (never shipped; had been swept into the header-slice commit by accident).
  Docs: `docs/ux.md` + `docs/usage.md` say "the same card element as the
  main content container, nested inside it". Verified: web build green;
  verified live with a probe against the redeployed stack (computed styles
  + screenshots, dark and light).

- **feat(web,protocol,store): the page header gains the Capacities action
  row — quiet ghost actions above the title (Add icon / Add description /
  Add aliases) — plus the new `description` wire node field; the header icon
  element now renders ONLY when an icon is defined (own or class-contributed),
  and the empty hover placeholder is gone.** (1) The action row
  (`PageHeaderChrome`, main surface only — not embedded/preview/focus/day
  pages): "Add icon" opens the existing full icon+color picker anchored at
  the row button (at the icon element when one is defined), "Add aliases"
  opens the shared backward-write alias picker — the pick flow extracted
  from the metadata panel's AliasesRow into `AliasNodePicker.tsx` so both
  surfaces run one guard-validated write (no logic drift). (2) The
  `description` wire node field: optional nullable plain text (max 512
  chars) on `object.update` (never `object.create`), presence writes /
  present-null clears, riding the row LWW — the cover/banner/alias
  precedent; node-table column `description`, store schema v18 with an
  idempotent v17→v18 migration arm; `ClientNode` + `updateObject` carry it
  (the node-row identity stamp mixes it in). The subtitle renders under the
  title only when non-empty: "Add description" swaps in the editor
  (Enter/blur commits, Esc cancels, an empty commit clears), then the
  subtitle itself is the click-to-edit surface. The query language gains NO
  `description` predicate this slice — free-text grammar is a deliberate
  follow-up, not a silent default (SCHEMA.md says so). (3) Icon
  hide-when-none: the header icon element renders only for a DEFINED icon
  (`definedNodeIcon` — own or the first class-contributed one via the
  extends-resolved lookup); the generic `defaultIconFor` fallback (class
  shape / page document glyph) stays for lists, mentions, and everywhere
  else, and the `◈` hover placeholder + its CSS token retired. Day pages
  skip the row and the subtitle (the DayPageHeader contract). Export
  projections do not carry `description` yet (web-rendered field this
  slice). `notees-cli`'s vendored pin is NOT bumped — it picks the field up
  on its next vendor update. **Client lockstep (the fixture gate law):**
  `object-wire-fields.json` gains the set + clear envelopes, byte-identical
  in the GTK and Flutter repos — the GTK store bumps to schema v14 with the
  same idempotent additive migration (pytest 741 green) and the Flutter
  store to v28 (`flutter test` +613 green); their UIs don't render the
  subtitle yet (store+wire first, chrome follow-on). Verified: protocol
  suite green (fixture gate + the 512 cap + create-rejects specs), store
  suite green (463 — fixture replay, v18 LWW/absence/clear, v17→v18
  migration + idempotence), web typecheck green, new
  `page-header-actions` suite green (7 specs: row gating incl. day/embedded/
  preview, icon hide/show incl. the class-contributed case, description
  add/edit/clear round-trip, the header alias backward write), the
  class-view picker spec re-pointed at the row action, the node-aliases
  suite's Add-alias query tightened (`/^Add alias$/` — the header's "Add
  aliases" also matches `/Add alias/`), css-token-drift gate green.

- **fix(web): the export modal's page-size dropdown wears the app surface
  (the "blue" was the browser default button face — a kit reset gap), the
  PDF's node links are accent-colored and underlined (no grey chip), and the
  screenshot-probe workflow is recorded so it stops being rediscovered.**
  (1) `SelectTrigger` is a bare `<button>` and never reset the UA background
  — every Dropdown in the app inherited the browser's button color (grey
  headless, blue-tinted on the owner's platform); the kit now sets
  surface/on-surface. The modal also constrains the dropdown CONTAINER (the
  kit default is width:100% + flex:1 — a width on `.dropdown` alone loses),
  so the trigger is a compact content-sized control. (2) PDF mentions: grey
  pill chip retired — accent color + underline, icon drawn in the accent.
  (3) `docs/developers/ui-debugging.md` + `scripts/screenshots/probe-
  template.mjs` capture the diagnosis workflow (capture suite vs live probes,
  the login-flow auth pattern, computed-style dumps, the react-pdf/jsdom
  limits, reading exported PDFs back); the runbook is indexed from the
  developers README. Verified live with a probe against the redeployed stack
  (screenshot + computed styles: surface background, 81px trigger), web
  suite green, VERIFY-PASS.

- **feat(web): the nodeview's two sidebars — the properties panel and the
  context column — become raised cards over the main content surface.**
  Each column retired its continuous full-height vertical divider (and the
  negative-margin reach into the page padding) and now rides as its own
  card: surface fill, hairline frame, the layout-card radius, one elevation
  step above the card it sits on (`--shadow-elevation-2`), inset padding,
  stopping a step above the card bottom like the top bar. The panels
  unmount on collapse as before; only the frame changed. Docs: `docs/ux.md`
  + `docs/usage.md` describe the raised-card columns instead of the
  divider. Verified: web build green; web suites green except two reds in
  the in-flight aliases/icon-picker slice (another session's files — a CSS
  change cannot affect them); verified live with a probe against the
  redeployed stack (computed styles + screenshots, dark and light).
- **feat(web): text property values that have no content and no child blocks
  auto-unset — clearing a text property returns the slot to its empty state
  instead of lingering as an empty block or a dead cell (the unset trashes
  the orphaned carrier, recoverable from trash).** The Metadata panel's text
  row runs an auto-unset pass over its authored values on every
  store-synced render and when focus leaves the row: a carrier with empty
  text and no children, an empty scalar string, and a dead reference whose
  target node is gone all emit the ordinary `property.unset` (no op, no
  wire change — every replica converges from the log as usual). Guards: a
  carrier is skipped while focus is anywhere inside the row (an Add-pill or
  Enter just minted an empty value the user may be about to type into) and
  the caret-bearing carrier is never unmounted mid-edit; a dead ref that
  still resolves to a node which merely stopped rendering inline (promoted
  to a page) keeps its re-author recovery cell. The pass reads fresh rows
  from the client, not the (possibly stale) render props. Supersedes the
  2026-10-04 dead-carrier cell workaround in `properties-panel` — the dead
  cell no longer renders for gone targets; the panel drops to its empty
  state. Docs: SCHEMA.md "Node-backed text properties" gains the
  auto-unset lifecycle bullet; ux.md "Properties" gains the "Cleared text
  returns to empty" contract. Verified: text-property-blocks (11 specs:
  empty-carrier unset + carrier trash, content/child keeps, focus-guard
  keep-then-unset on leaving the row, scalar empty unset, dead-gone unset,
  promoted-node recovery kept, Add-pill empty survives), properties-panel
  dead-carrier specs rewritten to the new contract, properties-panel +
  block-metadata + property-owner-rulings + property-view +

- **fix(web): the PDF's visual regressions from the app-chrome slice — no
  more double bullets, pills at deterministic size — and the export modal's
  settings rows look like the rest of the UI (new kit `Radio` primitive;
  layout choice moved into Options as a radio group; the page-size dropdown
  constrained to a compact control).** The inline-block row wrapper rendered
  its own bullet on top of each paragraph's row bullet (two dots per block)
  — the wrapper lost its dot (the block rows keep theirs). The class pill
  could blow up to a tall stretched box (text pinned top-left): the pill now
  has a deterministic height from the theme type metrics, centered content,
  and `alignSelf: flex-start`. The modal side: the PDF layout cards row
  retired in favor of a kit `Radio` group inside the collapsible Options
  section (alongside the page-size `Dropdown`, which the kit styled at
  width:100% — now constrained to `max-content`), one settings surface like
  every other modal; `Dropdown` gained an `ariaLabel` forward and
  `Radio`/`Radio.css` join the kit with a catalog entry in
  `ui-primitives.md`. Verified: web export suites green (50 specs incl. the
  layout-radio flow), css-token-drift gate green.

- **feat(web): the nodeview properties panel is renamed "Metadata", and the
  aliases affordance moves from the title row into the panel as its first
  section — an "Aliases:" node list (pill per alias, × clears, "+ Add alias"
  links a new one).** (1) Rename: the side-panel section header and the
  in-flow compact section read "Metadata N" now (the count still covers
  property rows only); identifiers, CSS hooks (`.nt-properties-panel`,
  `.nt-props-sidebar*`), and the palette's "Properties" search scope are
  unchanged. (2) Aliases relocation: the title-row `AliasesButton` (count
  button + popup with NAVIGATE/Add) is retired; a new `AliasesRow`
  (`MetadataSection.tsx`, exported next to TagsRow) renders at the TOP of
  both the sidebar and the in-flow section — the TagsRow composition reusing
  the shared `NodePill` + `AddPill` + `NodeSelector` primitives (NodePills
  itself stays class-scoped: its picker, color-chain resolution, and removal
  locks are class semantics). Each alias is a pill whose × clears THE
  ALIAS's own `aliasedNodeId` (the new removal path — the popup had none);
  "+ Add alias" keeps the backward write (the picked node's field becomes
  the active node, guard-validated, already-aliased nodes filtered out); the
  pill click keeps the RAW bypass (opens the alias's OWN view — the retired
  popup's NAVIGATE contract) via a new optional `onOpenPageRaw` plumbed
  through PropertiesSection/PropertiesSidebar from PageView; the row
  subscribes for freshness like the old button did. Pages only: the row
  renders null for blocks (BlockRow's hideWhenEmpty usage gains no chrome).
  `PageHeaderChrome` drops the retired `onOpenPageRaw` prop. Verified:
  node-aliases suite green (list/bypass/backward-write/filter/×-removal
  specs rewritten onto the row), properties-panel/block-metadata/pickers/
  asset-attachments/dates/property-view/asset-annotations/recurrence/
  property-owner-rulings header assertions updated to "Metadata", web
  typecheck + full suite green.

- **feat(web,export): the PDF carries the app chrome (outliner bullets, the
  row's class pills on the far right, node icons on mention chips), the
  "Show type labels" option is now "Show classes" and renders colored pills,
  text-property carrier blocks stay out of the exported body, and the PDF
  page size moved into the Options section as a dropdown.** (1) Carrier
  exclusion: the page view's body never renders property-carrier blocks
  (`getBlockTree`'s rule) — the export paths now mirror it
  (`propertyCarrierIdsOf` over authored effective rows, carrier subtree
  pruned) across the markdown bundle, the single-document IR, and the
  asset/whiteboard walkers; spec pins a text-property carrier staying out of
  the preview's body. (2) Notes-layout bullets: every block row draws the
  outliner dot (Essay/Academic stay clean typesetting — the new
  `theme.bullets` flag). (3) Class pills: the IR gains build-time
  `colorOf`/`iconOf` ctx hooks; with Show classes on, every child row (inline
  blocks recursively + child-page entries) and the header's Classes row
  render the row's own class pills — effective colors, contrast text, first
  pill + "+N" overflow — the list-view look. (4) Mention chips draw the
  node's MDI icon before its name, path data fetched from the app's own
  `mdi-sprite.svg` (zero new dependencies; name-only fallback). (5) The PDF
  page size is a kit `Dropdown` inside the collapsible Options section (the
  standalone SelectionButton chrome is gone; `Dropdown` gained an `ariaLabel`
  forward). Verified: web export suites green (bullets/pills/mention-icon
  component specs + the carrier modal spec), packages/export 236 green,
  full web suite green.

- **fix(web): fleet button audit against the state-vs-action register rule —
  state-carrying chrome goes outline, actions go borderless, modal
  secondaries unify on outline.** Audit of every button in the app against
  the owner ruling recorded in the design system (outline marks STATE-
  carrying chrome; actions stay borderless even in chrome): (1) **Fixed —
  state chrome wearing borderless**: the app top bar's two dock toggles
  (left sidebar, right cards rail) become kit `Button variant="outline"`
  with the `active` fill — they were the last state toggles outside the
  register the nodeview panel toggles already wear. (2) **Fixed — chrome
  actions wearing borders** (outline → ghost): the hub/header creates
  (New asset / New class / New page / New whiteboard), the calendar
  quick-create chips + Daily Note create, the hover-preview Pin, the
  queries hub's Edit query, the template gallery's create. (3) **Fixed —
  modal/form secondaries unified**: the filled-tonal `default` cancel/close
  flips to `outline` (workspace name/export, property history/convert, the
  property settings' close, the kit ConfirmationModal — the convention
  setter — and the create-with-UUID footer's Cancel/Create pair, ghost and
  default respectively). `default` survives only as the lone CTA on
  dead-end surfaces (error-boundary reload, data-state retry). Reviewed and
  left as-is: tool-register toggles (graph chips/families/colors, the
  floating text-format toolbar, find/replace match-case, whiteboard
  snap-to-grid, the embed view switch — each carries its own active
  convention), the boot/auth form secondaries (outline, the form register),
  and the destructive `danger`/`danger-solid` pair. The modal register is
  recorded in the `rosellramos-design-system` skill (`references/
  dos-donts.md`). Verified: `pnpm typecheck` clean for the slice; the web
  vitest suites green except the parallel session's in-flight export-pdf
  work (their uncommitted ExportPageModal/test edits — reported, not
  touched). Display-state only.

- **fix(web): class-icon bullets ride at the dot's line height — the grip no
  longer jumps ~6px when a block has a class.** The block row is
  baseline-aligned, and the grip's synthesized flex baseline rides the bottom
  edge of the bullet's first in-flow item: the 6px dot anchored 14px from the
  box top, but a class icon's ~19px SVG anchored ~6px higher, lifting the
  whole grip — bullet and class pill — against the text on class rows. A
  zero-width 6px `::before` strut on `.nt-bullet` is now the first flex item,
  anchoring both bullet kinds at the dot's geometry (the centered glyph never
  anchoring both bullet kinds at the dot's geometry (the centered glyph never
  moves). Verified with a throwaway current-build sync container + vite-dev
  probe measuring bullet and pill centers against the first text line per
  row: dot Δ-1px / icon Δ-7.6px before → both Δ-1px after, pill uniform
  across row types. `pnpm test`: 1412/1413 green — the single failure
  (export-modal checkbox test) and the web typecheck errors both sit in
  the export-pdf files of a concurrently in-flight uncommitted slice,
  untouched here. Display-state only — no model/wire change.

- **feat(web): the section-scoped create affordance moves into the section
  header — a shared trailing-action slot on NodeViewSection, wired for
  Comments, Child pages, and the class view's classed nodes.** (1)
  `NodeViewSection` gains an `action` prop: the header becomes a ROW — the
  collapse toggle (accessible name: title + count) plus one icon-only
  button at the far right, a sibling, never nested. `Section` threads the
  prop through. (2) Comments' quick-add rides it (click expands a collapsed
  thread, then opens the composer); the in-content add button is gone. (3)
  The classed-nodes section's toolbar ghost button AND the collection's
  bottom add row are replaced by the ONE header action. (4) Child pages —
  always rendered on the main surface now (the hide-when-empty ruling's
  deliberate exception, superseding owner 2026-10-08: the create must be
  reachable exactly when the list is empty); its header action creates a
  child page (`parentId` + `presentAsMain`). Embedded feeds keep the old
  ruling — read-only, childless hides — via a new `embedded` prop on
  `SystemSections`. The pattern is recorded in the `rosellramos-design-system`
  skill (`references/dos-donts.md`). Verified: `pnpm typecheck`; the full
  web vitest suite (136 files, 1413 tests) green, incl. the rewritten
  system-sections / class-view contracts. Docs: `docs/ux.md` (the
  hide-when-empty paragraph), `docs/usage.md` (Child pages). Display-state
  only — no model/wire change.

- **fix(web): no search bar glows accent on focus anymore — every search
  input trades the focus ring for a quiet border shift.** The earlier
  SearchField slice dropped the component's own accent glow, but the global
  `input:focus-visible` rule still paints the accent shadow on the raw input
  inside the field — the command palette kept the green ring the owner called
  ugly. Now the input itself sets `box-shadow: none`, and the remaining raw
  search inputs get the same contract: query panel (`.nt-search-input`),
  Dropdown's search, the NodeSelector picker's focus-within container glow,
  IconPickerPopup, WorkspaceSwitcher, TriggerPopup, the DuplicatePage modal
  (which also traded its primary-tinted focus border), and the add-property
  popup. Focus feedback everywhere is the border color deepening to
  `--color-outline` (SearchField keeps its on-surface-variant shift) — no
  accent anywhere. Display-state only; web typecheck + full vitest gate
  re-run green.

- **fix(web): the single-value selection cell names its value with ONE
  compact pill (effective-colored, no subtree), multi-value object pills
  cover every resolved value, and the date cell's repeat picker stops
  overlapping the value.** The morning redraw shipped the single-value
  dropdown's content as a read-only block row — which rendered the linked
  node's WHOLE subtree (children, collapse chevrons, backlink gutter) inside
  the field; the owner asked for "a pill and that's it". The cell's content
  is now the shared `NodePill` element tinted with the linked node's
  effective color (`NodePill` renders a non-interactive label span when the
  host carries the click — the dropdown does); the multi-value branch drops
  its inline-block special case the same way, so every resolved object value
  rides one compact pill (the editable-block treatment stays the TEXT
  property row's contract, not object values'). The date cell's trailing
  repeat picker (the kit Dropdown) defaulted to `width: 100%` of the flex
  row and drew over the trigger text — inside `.nt-property-select` the
  trailing dropdown now hugs its icon (`width: auto; flex-shrink: 0`), and
  the trigger content truncates honestly. The ⟳ control itself is the
  recurrence picker (None/Daily/Weekly/Weekdays/Monthly/Yearly, written as
  the RRULE-lite `metadata.repeat` — SCHEMA.md "Recurrence"), preserved
  from the pill era. Display-state only; the web suites around the panel
  re-run green with the pill-content assertion updated. Docs:
  `docs/ux.md`'s "Single values select" bullet now says one compact pill.

- **feat(web): the panelled layout's chrome gets honest scopes — the
  nodeview top bar spans the whole card, the local graph is a lazy
  collapsed-by-default section, Comments always renders with an icon-only
  quick-add, Activity is scoped to the active node, and the properties
  sidebar is a collapsible section.** (1) The nodeview top bar moves OUT of
  the middle column to span the full card above the column split: its
  controls act on the layout's columns, so it no longer rescales when a
  panel shows or hides — each panel toggle now sits directly above the
  column it reveals, and the side panels' vertical dividers start under the
  bar instead of beside it. (2) `LocalGraphCard` rides a NodeViewSection,
  collapsed by default — the section unmounts its content while collapsed,
  so the GraphView (engine + WebGL renderer + topology reads) never mounts
  and a closed card costs nothing; the first expand mounts it. (3)
  `CommentsSection` always renders (the hide-when-empty gate is gone): an
  empty thread starts EXPANDED with the icon-only quick-add one click away,
  and deleting the last comment keeps the section with a 0 count. (4)
  `ActivityLogSection` is scoped to the ACTIVE NODE (its own Created stamp +
  an Edited stamp when updated postdates creation); the workspace-wide
  created query and pages/classes edited lists are retired — no query
  exists at all now (two node-column reads), so the lazy contract holds
  trivially. (5) `PropertiesSidebar`'s rows ride a NodeViewSection,
  expanded by default — the column names itself with a collapsible header
  and keeps its divider while collapsed. Verified: `pnpm typecheck`; the
  full web vitest suite (136 files, 1412 tests) green, incl. the rewritten
  activity-log / comments / context-column / properties-panel contracts.
  Docs: `docs/ux.md` (Activity paragraph, the layout sentence, the sidebar
  note), `docs/usage.md` (the layout sentence + the context-column item).
  Display-state only — no model/wire change, no fixtures.

- **fix(web): the export modal's child outline is unconditional — the
  "Include child outline" toggle is gone — and the preview re-runs when the
  worker's cached reads land.** The reported symptom: child blocks were
  missing from the markdown preview until the toggle was unchecked and
  re-checked. Root cause was a race, not the toggle: `WorkerClient.getChildren`
  seeds its cache EMPTY and fills it async, and the preview effect never
  re-ran when the fill landed — the first preview of a fresh modal ran
  against an unpopulated children cache, and only an options change forced a
  re-run (the re-toggle "fixed" it by accident). The modal now subscribes to
  the client while open and re-runs both previews (markdown + PDF) on
  notification. And the toggle itself retired (owner ruling): child blocks
  are part of the content — they ride recursively in every export with main
  nodes excluded from the block zone by the engine's childrenOf contract, so
  a switch that hides the content's own children made no sense; the modal
  hard-codes `includeOutline: true` (the package option stays for the CLI).
  Verified: new modal spec drives the race through a stubbed client (empty
  children → notification → bullets appear, no toggle); the retired-toggle
  spec asserts the checkbox is gone and the outline survives other option
  changes; web 1396+30 green, packages/export 236 green.

- **feat(web): the properties panel's value cells redraw — single-value node
  and date properties are full-width selection dropdowns (the selected node
  rides the content area as a read-only block row, never a pill), multi-value
  node pills share the nodeview classes list's pill element tinted with the
  linked node's effective color, empty cells keep the full width with honest
  placeholders, and the sidebar separates its properties with hairlines.**
  (1) `NodePills`' pill shell is extracted into a shared `NodePill` element
  (`apps/web/src/ui/components/NodePills.tsx`) — the class pills render
  through it unchanged, and multi-value node-typed property cells now render
  their value pills through it too, colored by `effectiveNodeColor` of the
  linked node (own color, else its classes') with the same hover-reveal ×,
  label-click-opens-node, and broken-reference dashed chip. (2) Single-value
  (`multi: false`) node-typed and date properties render the new
  `PropertySelectCell` (`MetadataSection.tsx`): a full-width dropdown trigger
  whose content area shows the selected node as a READ-ONLY block row via
  `ReferenceSubtree` (date values show the date node's display name — a raw
  block row would leak the chain's compact YYYYMMDD storage label, the leak
  `dateDisplay.ts` exists to prevent); empty shows the muted "Select"
  placeholder; clicking opens the same ported pickers as before
  (NodeSelector / DatePickerPopup, now anchored at the trigger); a clear
  affordance unsets the authored slot; re-picking replaces the slot in place;
  the date repeat picker, link qualifiers, and asset annotations ride the
  cell's trailing chrome. The trigger is a `div[role=button]`, not a native
  button — the content area hosts the block row's own interactive bits,
  which a `<button>` cannot legally wrap. (3) Empty value cells keep the
  value column's full width so they read as empty fields: single-value node /
  date cells show the "Select" placeholder, and a bound-but-empty text
  property renders the full-width "Type something" placeholder input (typing
  authors the first carrier block). (4) The properties sidebar separates its
  properties with a hairline under each row (the previous "no horizontal
  rules" ruling is superseded). Multi-value rows keep their pills + "+ Add"
  affordance unchanged; the asset-typed row (Upload / Link list) is
  untouched. No model/wire change — display-state only, no fixtures. Verified
  by the web vitest suites (7 files, 82 tests around the panel re-run green;
  full gate green) including new coverage: the single-value dropdown's
  read-only block row + clear, the multi-pill effective-color tint, and the
  empty-text placeholder. Docs: `docs/ux.md`'s Properties paragraph.

- **fix(web,domain): the Highlight system class renders its icon again — the
  seed carried a name that never existed in MDI.** `SYSTEM_CLASS_ICONS.highlight`
  was `mdiFormatHighlight`; the real Material Design Icons name is
  `mdiFormatColorHighlight` (verified against the shipped sprite and the
  upstream project — `format-highlight` 404s there). Every other system class
  icon resolves; only Highlight's silently rendered nothing. Two layers:
  the seed now carries the real name (new workspaces, any future deploy),
  and the web `Icon` resolver — whose contract is already normalizing legacy
  stored values (JSON-wrapped rows, `mdi mdi-` prefixes) — gains a
  `LEGACY_ALIASES` table mapping `format-highlight` → `format-color-highlight`
  so every existing workspace's stored rows render without a log migration
  (the seed/self-heal paths are existence-checked and never rewrite an
  existing class). Verified: new `apps/web/test/icon-resolve.test.tsx` (6
  specs: camel/kebab/`mdi mdi-` forms, the alias both prefixed and bare, JSON
  unwrap, emoji passthrough, empty), domain package 74 green, `pnpm
  typecheck` green. No wire/model change — no fixtures, no lockstep.

- **fix(web): the panel/sidebar toggles get honest icons and a visible
  register — owner rulings, recorded in the design system.** The icon
  depicts WHAT the panel is: the app top bar's left sidebar and right cards
  rail wear the dock family (`mdi-dock-left` / `mdi-dock-right` — a content
  area with the panel docked at the edge, the pair one family, replacing
  today's earlier `mdi-menu` hamburger and `mdi-card-multiple-outline`
  experiments); the nodeview bar's properties toggle is a dotted list
  (`mdi-format-list-bulleted`, the panel's row-per-property shape) and its
  context toggle an info mark (`mdi-information-outline`). Both nodeview
  toggles also move from the borderless `nt-icon-btn` to the kit `Button
  variant="outline"` (size sm) — a persistent panel toggle is visible chrome,
  so the border stays; the `active` state carries the open/pressed signal
  (`aria-pressed` unchanged). The rules land in the `rosellramos-design-system`
  skill (`references/dos-donts.md`: the what-the-panel-is icon rule + the
  outline register for persistent toggles, and the rejected
  hamburger/layout-diagram/cards icons). Verified: `pnpm typecheck`; the web
  vitest panel/context suites green. Display-state only — no model/wire
  change.

- **fix(web,export): the export block zone loads child blocks recursively and
  excludes main nodes at every level — and a page parented under a block is
  hoisted into the child-page list instead of silently dropped.** Verified
  the semantics across every export path: the markdown bundle nests inline
  blocks to arbitrary depth in the page file (pinned by a package spec) with
  child pages filed separately, never as bullets; the PDF body recurses the
  inline zone with main nodes filtered per level (pinned by a component
  spec), and its end list now walks through inline blocks for main
  descendants (`childPagesOf`) so a page nested under a block still appears
  as a titled entry instead of vanishing between the zones. Verified:
  packages/export 236 tests green, web export-pdf 16 green.

- **feat(web,store): the graph view's v1 register, 1:1 — the settings
  popover, four node-sizing modes with the radius slider and link direction,
  mass accumulation in the engine, split journal visibility, multi-select
  with the reorderable selection list, ordered class colors, and
  bidirectional edges drawn as one arrow with two heads.** Owner ruling
  (law 0): a v1 port ships the ENTIRE v1 register, not a reduced subset.
  (1) **The cog settings popover** (kit ButtonWithPanel): Simulation,
  Link-count attraction, Central gravity, Mass accumulation, Node sizing
  (Uniform / Connections / Mass / Content — the v1 four), the Node radius
  slider (3–20, the v1 range), Link direction (all/incoming/outgoing, the
  connections mode), and a Visibility section — **Day / Month / Year pages**
  replace the single Journal switch (each level toggles independently; the
  shipped default keeps the chain off) plus **System pages** (the seeded
  Inbox + the withdrawn scratchpad). (2) **Node sizing rides the v1 curve**
  (`nodeRadius.ts`, pure + unit-tested): MIN 4 / MAX 18 with the v1 power
  exponents (0.7 connections/content, 0.8 mass); the store topology
  projection now carries `contentSize` (descendant blocks, stopping at
  nested main nodes) and `mass` (recursive descendant weight, cycle-safe) per
  node — one memoized walk serves both. (3) **Mass accumulation reaches the
  integrator**: `GraphEngineNode.mass`, `useMass` in the raw config, a
  mass slab, and acceleration divided by mass (heavier parents resist — a
  lone mass-9 node under identical gravity covers measurably less ground,
  the new engine test). (4) **Multi-select** (the v1 register): clicking a
  node toggles it in the selection, double-click opens (and clears), empty
  click clears; the toolbar's **Selected · N** popover lists the selection
  (kit ListSortable drag-reorder, per-row remove, Clear); the renderer
  highlights every selected node (rings + neighbor dimming, the ring buffer
  grows to a 64 cap); the search field now **adds nodes to the selection**
  (results dropdown, Enter takes the first) — the old jump-the-camera
  single-select is retired. (5) **Class colors** in the Colors popover: an
  ordered list (add any class via a searchable Dropdown, kit ColorButton per
  row, drag to reorder, remove) that paints **before** the query groups —
  precedence: class color → query group → the node's own color
  (`nodeVisuals.ts`, pure + unit-tested); new entries cycle the preset
  palette. (6) **Bidirectional relations render as one arrow with two
  heads**: the renderer's new edge plan (`planEdgeRender`, pure +
  unit-tested) dedupes reciprocal same-kind pairs into a single edge quad
  and emits a head at each end; one-direction relations keep their single
  head; property/semantic stay arrowless. (7) **The settings memo takes
  field-level deps** — pause/radius/sizing/preset changes no longer rebuild
  the whole GL stack + engine (every pref change did, before); radii and
  colors reapply live through `setNodeVisuals`. All graph prefs (incl. class
  colors) persist device-local in the existing per-surface blob — settings
  sync across devices (v1's server-side persistence) is a follow-up
  proposal. Verified: the graph + store suites green (store 459 incl. the two
  new projection specs; web graph suites incl. the new `graph-sizing` suite
  and the updated toolbar-composition spec — the residual gate reds at ship
  time were the parallel session's in-flight property-row work, untouched
  here); live-stack probe on the real 7.5k-node workspace (the settings
  register renders, search adds to the selection, zero console errors). Docs: usage.md graph section rewritten to the register.

- **fix(web): honest icons for the chrome toggles — the top bar's sidebar
  buttons and the nodeview panel toggles stop posing as layout diagrams.**
  (1) The app top bar's left-sidebar button is a plain hamburger
  (`mdi-menu`, the affordance the header doc always claimed) and its
  right-sidebar button is a stack of cards (`mdi-card-multiple-outline`) — the rail
  hosts workspace cards. (2) The nodeview top bar's properties-panel toggle
  is a properties affordance (`mdi-tune-variant`) and its context-panel
  toggle a docked-right-panel (`mdi-dock-right`); the context toggle moves
  from the bar's left cluster to the right cluster, between the blocks view
  switcher and the "…" node menu (owner: it belongs with the chrome it
  reveals). `chromeRight` splits into `chromeModes` + `chromeMenu` (NodeView
  → PageView → NodeTopbar) so NodeTopbar can interleave the toggle; the
  compact corner renders the two back to back as before. Verified: `pnpm
  typecheck`; the web vitest suite — the panel/context/modals suites (57
  tests) included, all green except the parallel session's two in-flight
  graph failures. Display-state only — no model/wire change, no fixtures.

- **feat(web): the block tree's vertical indent line is itself a collapse
  control — click the line to fold the direct children of the block it starts
  from (the v1 gesture), and the bullet stops riding low.** (1) Every
  `.nt-block-children` hairline now carries a full-height rail
  (`.nt-block-children__rail`, border + gutter only — no child content lives
  in the strip, so child clicks are never eaten); clicking it toggles the
  same session-local collapse as the chevron, hiding that node's children
  (its whole subtree) and lighting the collapsed ring on its bullet. The rail
  renders only when collapse applies (never in prose view, never in table
  projections) and hover/focus paints an accent hairline as the affordance.
  (2) The row is baseline-aligned, so the fixed 22px bullet box sat ~2px
  below the text's visual center; `.nt-bullet` gains a `translateY(-2px)`
  optical correction — measured delta went from +1px (below the line-box
  center) to −1px (on the cap-height middle). Verified with a live probe
  (`scripts/screenshots/bullet-align-probe.mjs`): playwright measures the
  dot-center vs first-line-center delta and clicks the rail against a seeded
  nested page (children containers 1 → 0, collapsed ring appears); the
  outliner/block vitest suites (95 tests) stay green. Docs: the collapse
  parenthetical in `docs/ux.md`'s outliner section. No model/wire change —
  display-state only, no fixtures.

- **feat(web,export): export downloads carry the node's name + a local
  timestamp; the PDF mirrors the page view (single-title body, inline blocks
  nested body-only, child pages as the end list); v1-migrated property values
  stop leaking raw uuids; booleans render as checkboxes; main node vs block
  node is now defined vocabulary.** (1) Every modal download name is
  `<node-name-slug>-<YYYYMMDDHHmm>.<ext>` — the export modal's single-file
  formats (markdown/html/latex/docx/pdf/json archive), the batch zip names,
  and the table view's CSV/XLSX — so repeated exports of one node never
  overwrite each other in the download folder; in-zip entry names keep the
  E3/E5 `<slug>-<id8>` conventions untouched. (2) The PDF layout restructures
  to the page view's shape: the root title renders once (the single-title
  rule — `withoutLeadingTitle` — now applies to the PDF body, which used to
  repeat the title as its first paragraph); the literal "Outline" heading and
  its divider are gone; inline BLOCK children render nested in the body with
  no title heading (block nodes carry no chrome); child PAGES form the
  separate recursive end list, each a titled entry whose body no longer
  repeats its title (`withoutLeadingTitleBlocks`, exported from
  `@notees/export`). (3) V1-migrated data rides the log with BARE uuid
  strings where v2 wants `{ nodeId }` refs (verified against the live relay:
  an imported book's "Última consulta" date) — the export IR
  (`resolvePropertyDisplay`), the PDF, and the table/cards/CSV/XLSX display
  (`propertyDisplayText`, which also learned date_range display and dropped
  its silent array-entry drop) now resolve bare strings on node-typed schemas
  (date/object/asset) through the settings-aware name resolver; the web
  resolver formats date nodes per the user's dateFormat, so the uuid leak is
  gone everywhere. (4) Property metadata qualifiers resolve at IR build time
  (`resolvedQualifiers` + `qualifierTail`) — markdown/html/latex/docx/PDF all
  render `startDate 2025-06-24`, never a raw uuid or `[object Object]`. (5)
  Booleans render as checkbox glyphs (☑/☐) in every text projection; the PDF
  draws a real vector checkbox (rect + check polyline, no font-glyph
  dependency). (6) SCHEMA.md "Node structure" + AGENTS.md + the development
  skill now define the terms: a **main node** renders with document chrome
  (`is_class = 1` OR no parent OR `present_as_main = 1`); a **block node** is
  a parented non-class node with `present_as_main = 0` — inline in the
  parent's body, no title. Verified: `packages/export` 235 tests green (16
  new leniency/single-title specs), web export-pdf/modals-overlays suites
  green (7 new structure specs), download-name assertions moved to
  `-<12-digit stamp>` regexes.

- **fix(web): one corner radius for every text button — the md/lg sizes drop
  from 16px to the shared 12px.** The 16px `--shape-button-large` token made
  big text buttons ("Resync now", dialog actions) read nearly pill-shaped
  against the rest of the chrome, while square icon-only buttons sat at
  6–12px; the two no longer looked like one family. All text-button sizes
  (base/xs/sm/md/lg) now use `--shape-button-small` (12px), icon-only sizes
  keep their per-size radii, and the now-unused `--shape-button-large` token
  is gone (its only consumers were the two md/lg rules). Verified:
  `css-token-drift` gate green, full suite green.

- **fix(web): the graph view comes back to life — warm starts stop pinning
  the map, drag reaches the physics worker again, navigation is v1's
  1:1, the hover card drops its permanent hint, and the pause button works
  in worker mode.** (1) The freeze: every cached position was handed to the
  engine as `pinned`, so the first topology rebuild (~1s in, on the
  bootstrap-change notify) froze all 7.5k nodes at their warm-start spots —
  and with drag already dead nothing could ever move again. Cached positions
  are a starting point, not a pin; only fixed-layout (circle/tree)
  coordinates pin. (2) Drag: the v2 port renamed the engine's node
  identifier to `nodeUuid`, but `EngineController` still forwarded v1's
  `nodeId` field — the worker's drag/pin handlers read `nodeUuid`, so every
  drag silently no-op'd (verified against the live bundle). The controller
  now sends `nodeUuid`; a `graph-controller` test pins both sides of the
  wire. (3) Navigation is copied from the v1 renderer 1:1: pan was inverted
  on the vertical axis (`+dy` where v1 uses `-dy`), and cursor-anchored zoom
  mirrored Y the same way (the v1 additive anchor form replaces it, with
  v1's 0.02–40 zoom range); dragging also does the v1 instant local
  `overridePosition` so the node follows the pointer before the next worker
  frame. (4) The node hover card no longer carries the always-visible
  "Click to select · double-click to open" line — that belongs in the docs,
  not on the canvas (edge hover cards unchanged). (5) The pause/resume
  toolbar button now reaches the worker's clock (it only gated the
  main-thread fallback before, so it was a no-op in every real browser);
  reduced-motion's start-paused is applied at engine creation too.
  Verified: full gate green (134 files, 1386 tests, new
  `graph-controller` suite), live-stack probe against the real 7.5k-node
  workspace (graph animates, drag/trackpad paths traced through the fixed
  wire). Docs: usage.md graph section still accurate — the fix makes its
  wording true.

- **feat(server,web): env-gated signup (the sonarly pattern) + the context
  menu drops its banner entry.** (1) `NOTEES_SIGNUP_ENABLED` (default off,
  accepts `1/true/yes/on`) opens `POST /api/auth/signup`: creates a non-admin
  account (scrypt hash, KDF record, fresh session — the `/setup` payload
  shape), rate-limited on the login limiter. Off → the route answers **404
  `not_found`**, the surface does not exist at all (sonarly's contract, not a
  403); duplicate email → 409 `conflict` (the pinned taxonomy, no new code).
  `GET /api/server-info` advertises `signupEnabled` so the client discovers
  the flag (older servers predate the field — the client treats absent as
  closed). (2) Web: a **signup phase** on the boot screen — the login
  screen's account tab shows "No account yet? Create one" only when the
  server advertises it; the signup form (email/password/confirm,
  `autoComplete="new-password"`) lands in the same workspace picker as login;
  a 404 mid-flow maps to "Signups are disabled on this server." (3) The page
  context menu no longer offers Add/Change banner — the banner row's own
  affordance is the UI (owner ruling: one surface per action); `onAddBanner`
  plumbing removed from NodeContextMenu/PageView, stale comments swept.
  Verified: server suites (new `env-gated signup` + config parse tests, 33
  auth tests green), web app-smoke (new signup affordance tests) +
  page-banner suites green, OpenAPI coverage gate green (the signup route is
  in the document). Docs in the same pass: deployment.md env table,
  .env.example, compose.yaml, usage.md (boot + scope), ux.md/usage.md banner
  lines, architecture.md account routes.

- **feat(web,query,protocol): the v1 block model 1:1 — every block is
  [type select][operator select][typed value], with the static/dynamic
  node-target mode, the edit-date family, and two more wire conditions.**
  Owner ruling (2026-10-09): the port must be 1:1 with v1, not a reduced
  subset — the law is now in the notees-development skill (law 0). (1) Block
  restructure: the TYPE column morphs the block across the twelve v1
  families (Class, Type, Placement, Content, Property, Links, Parent, Cover,
  Banner, Alias, Created, **Edited**); the OPERATOR column carries the
  per-family options — is/is not (not-wrap sugar, boolean families flip
  their bit), contains/does not contain/full-text, the nine property
  operators incl. **is set / is not set**, after/before for dates, is set /
  is not set for the wire fields; the VALUE column reuses the
  property-table inputs (numeric keyboard, node picker, placeholder
  datalist). (2) **Static/dynamic mode switch** on Links and Parent (the v1
  VALUE_MODE register): dynamic nests a full query builder under the row
  defining the TARGET SET — "links to a person node with age > 50" — backed
  by two new wire conditions, `linkedToQuery {root}` / `descendantOfQuery
  {root}`: the compiler generalizes the backlinksWithRollup and subtree CTEs
  to anchor SETS (the nested group's matches; the single-anchor forms reduce
  exactly), protocol validates the nested group in-schema (group/not/child
  schemas moved ahead of the condition union), and the web evaluates them
  through the probe channel. (3) **updatedAfter/updatedBefore** wire
  conditions (the edit-date facet; store `updated_at` + ClientNode
  `updatedAt` already existed) with compiler arms and sync evaluation. (4)
  The kit SearchField loses the accent focus glow (border shift only, owner
  review) and gains an inside-right **× clear** button while a value rides
  (the FilterBar wires it). (5) List-view chrome: the outliner BLOCK collapse
  button trades its raw Unicode triangles for the sprite chevrons
  (mdi-chevron-right/down — the glyphs read as arrows), and the group list
  gets real top padding below the hosted tabs. Verification: protocol dist
  rebuilt; query suite green (195/195 —
  dynamic-link equivalence, the owner's example shape, NULL-update law,
  dynamic-parent); web suite green (the dynamic-Links e2e drives the nested
  builder and asserts the probed AST carries the nested group verbatim);
  `docs/usage.md` §Section filters rewritten.

- **fix(web): the add-condition trigger sits in the app's quiet button
  register.** Owner review: the bordered-field treatment (fill + border)
  read too dark against the panel, and the "+" icon argued with the
  dropdown affordance — the chevron alone now signals the list, on a
  transparent ghost button like the rest of the chrome. Verification: the
  filter suites green.

- **feat(web,query,protocol): the builder's full link/parent wiring — a new
  `descendantOf` wire condition, links-to + full-text probe support in the
  transient filter, the GridMenu kit popup, and the root de-grouped.** Owner
  round (2026-10-09): (1) a **parent-is** condition was missing from the
  wire grammar entirely — `descendantOf { nodeId }` now matches rows whose
  ANCESTOR CHAIN (any depth up the parents tree, self excluded) contains the
  chosen node: additive zod condition in protocol, compiler arm reusing the
  subtree CTE (`subtree membership minus the anchor`), and a cycle-guarded
  sync walk in sectionViewResolve (so it evaluates locally, no probe). (2)
  **links to** (`linkedTo`) and content **full-text** (`fts`) join the
  builder — the two probe-path leaves now ride useSectionData's probe arm
  (one membership query per leaf through runQueryAst, intersected with the
  base rows, mirrored from useSectionViewResolution — the one-evaluation
  ruling; the last landed probe applies while typing, no flash). (3) The
  add-condition popup is the new kit **GridMenu** (a global component) with
  a `columns` prop — `"auto"` fits as many columns as the width allows —
  and the popup now spans the query-builder container's width, measured via
  ResizeObserver. (4) The add-condition trigger wears the DROPDOWN register
  (bordered field + rotating chevron) — it offers a list, it doesn't act;
  the rule is added to the rosellramos-design-system skill. (5) The root
  level is not a group: no "Empty group" count, no "No conditions in this
  group" placeholder, and the standalone **Add group** button is gone (the
  menu's All-of/Any-of entries are the group constructors). (6) Corner
  radius reduced at the token level: modals 28 → 12px and default
  cards/popups 20 → 12px (`card--radius-md` → `--shape-extra-large`; Modal
  `xl` → `md`) — page cards keep their 20px. Verification: protocol dist
  rebuilt; query suite green (133/133, four `descendantOf` cases incl.
  depth-2 chains and the anchor-exclusion); web suite green (the two new
  builder e2e — Parent-is sync, Links-to probe — plus the registry/menu
  updates); `docs/usage.md` §Section filters rewritten.

## 2026-10-08

- **fix(web): native control chrome follows the theme — the property
  settings modal, the ToggleSwitch white pill, and the table number
  spinners are dark-true.** Reproduced on a throwaway stack (playwright
  probe, verified by screenshot): the app themed via CSS variables but
  never declared `color-scheme`, so every UA-rendered control part stayed
  light under dark themes — the settings modal's inputs (its
  `__field/__label/__input` classes had no styles at all, ever), the
  ToggleSwitch root (a `<button>` showing the light UA button-face around
  the track — the "white pill"), and the number spinners in table cells.
  Three fixes: `color-scheme: light/dark` on `:root`/`[data-theme="dark"]`
  (one line kills the whole bug class — inputs, spinners, scrollbars,
  button faces), an explicit reset on `.toggle-switch` (transparent root —
  only the track is a surface), and the missing property-settings field
  chrome (label-above-control register, token inputs, focus ring). The
  modal's ToggleSwitch rows also gain real layout (the fields were inline
  labels that wrapped mid-row). Verification: throwaway-stack screenshots
  before/after (modal + number-cell zoom); web suite green.

- **fix(web): the structured panel keeps its bordered box.** Owner review on
  the in-flow redesign: the open hairline region read flatter than the rest
  of the chrome — the border + surface frame pairs with the filter search
  box in the control row. The panel is again a boxed region (border,
  `radius-md`, surface-container), still in-flow and full width; the
  builder internals stay un-carded and the add menu stays portaled.
  Verification: web suite green.

- **feat(web): the query builder is an in-flow region with flat list chrome
  — the boxed floating panel is gone (owner review).** The structured panel
  had read as a modal: a bordered floating overlay (a persistent float,
  where the app only floats transient pickers) containing a kit Card with
  header/footer bands — card-in-card. Now: the panel expands IN the layout
  between the toolbar row and the collection, full width, one hairline
  above it (in the classed-nodes toolbar the inline FilterBar renders with
  `display: contents` — control row on the flex line, panel on a wrapped
  full-width line; `ViewToolbar` wraps). Inside, the group cards are
  un-carded: the root group is a bare column (logic toggle + count on one
  quiet line), nested groups indent under a left hairline, condition rows
  are transparent list rows with a hover fill (the sidebar-row register),
  and the kit Card survives only on the transient add-menu popover — the
  one surface elevation is legal. The region change also frees the builder
  from the `42ch` search-box cap (deep nesting breathes) and deletes the
  whole overlay-clipping bug class. Verification: `pnpm typecheck` clean;
  web suite green (1377/1377).

- **fix(web): the builder's add-condition menu is unclipped and readable in
  dark mode.** Two defects in the new block query builder: the add menu
  (`ButtonWithPanel`, non-portal) rendered inside the kit group Card, whose
  `overflow: hidden` clipped it at the card edge; and the menu items had no
  explicit `color` — `<button>` UA `color: buttontext` painted the
  description text black in dark mode. The menu now portals to
  `document.body` (viewport-clamped, positioned under the trigger), the items
  carry token colors with hover/pressed/focus-visible states, and condition
  rows gained a hover border. Verification: `pnpm typecheck` clean; web suite
  green (1377/1377 — the two filter suites' menu helpers query the portaled
  panel).

- **feat(web): the filter bar's structured panel is the v1 query-builder,
  ported over the query AST — block condition rows, nested Match ALL/ANY
  groups, NOT wrappers, per-row reorder, live "N of M rows match".** The
  flat-AND FilterSpec grammar (and its one-field-per-facet panel) is gone;
  the bar's state is now a `FilterQuery` — the quick-search text plus a draft
  query-AST root group the new `FilterBlockBuilder` edits (the v1
  FilterBlocks/ConditionGroupBlock/AddFilterButton registers, adapted to the
  v2 kit: SelectionButton logic toggle, ButtonWithPanel add menu, Card group
  cards, token-only CSS — the v1 per-type accent colors are gone). The draft
  prunes into the schema-valid composed group (`filterQueryToGroup`: blank
  content values, unpicked classes/properties, blank timestamps drop; the
  text unshifts as a content-contains condition), and the one evaluation
  implementation (`sectionViewResolve`) consumes it through a new exported
  `createSectionViewMatcher` — no second evaluator. **The one-evaluation
  ruling:** property conditions now evaluate synchronously over the
  effective-values read model in `sectionViewResolve` (`getEffectiveProperties`
  joined the resolve-client surface; the scalar/ISO-date arms moved verbatim
  from the deleted filterSpec.ts), so hosted custom tabs stop probing the
  server for them — only content-fts and linkedTo remain probe-path leaves,
  and the bar's add menu deliberately does not offer them (nor linkedTo)
  because the transient layer must evaluate on every keystroke.
  `useSectionData`'s filter is now `{ group, nodeOf }`; a plan needing the
  probe channel keeps rows unfiltered and warns once, never throws. The
  offered kinds: class, type (isClass), placement (presentAsMain), content
  contains, property, created after/before, has cover, has banner, is alias,
  plus All of (AND) / Any of (OR) / Exclude (NOT) constructors; the
  FilterBarConfig facets gate the text field and the class/property/date
  kinds. Verification: `pnpm typecheck` clean; full gate green (133 files /
  1377 tests — new `filter-query.test.ts` prune + semantics battery through
  the matcher, new `filter-builder.test.tsx` e2e, `filter-layer` +
  `section-views` reworked, the CSS token-drift allowlist gained the
  `--nt-fb-depth` JS-scoped entry); `docs/usage.md` §Section filters
  rewritten.

- **fix(web): one divider, not two, above the backlinks strip — and no
  dangling line on an empty sections stack.** The hide-when-empty rulings
  left `.nt-backlinks` as the first child of `.nt-page-sections` whenever
  the Child pages section was gated off, and both containers carried their
  own top hairline — two adjacent lines read as a double divider. The
  strip's hairline now suppresses when it is the wrapper's first child (the
  wrapper's line is the separator); and `SystemSections` returns null when
  all three counts are zero, so a childless, referenceless page no longer
  renders the wrapper's hairline over nothing. The early return rides after
  every hook — the component flips between null and rendered as counts
  change, so the hook order must stay unconditional. Verification:
  `pnpm typecheck` clean; the section/layout suites green
  (system-sections, focus-mode, whiteboard-canvas, page-layouts).

- **feat(web): the hide-when-empty ruling covers every system section —
  Child pages and the backlinks strip vanish at zero, and the strip's Add
  child page affordance is gone.** Owner ruling (2026-10-08): a page with
  nothing to show shows nothing. The Child pages section now gates on
  `childPageCount > 0` alone (previously `> 0 || can-create`) — its empty
  state's **Add child page** button died with it (the `embedded` prop's only
  other use; it is gone from `SystemSections` and the two `PageView` call
  sites), while the `Section` component's `emptyText` ("No child pages.")
  stays as the honest rows-empty branch. The backlinks strip (Backlinks +
  Unlinked mentions) renders only while `backlinkCount > 0 ||
  unlinkedCount > 0` — the "both tabs always show" ruling (owner
  2026-10-06) now applies once the strip renders, and a live filter emptying
  a tab keeps the chrome (the gate reads the UNFILTERED counts). The
  always-mounted hosted-views chrome from the previous slice is unchanged —
  it governs the rendered strip, not the gate. Verification: `pnpm typecheck`
  clean; web suite green (1366/1366 — the childless-page tests rewritten for
  the gate plus two new reveal tests: first child page, first backlink);
  `docs/usage.md` + `docs/ux.md` updated.

- **feat(web): the hosted-views tab bar always shows — even on an empty
  section; the empty line rides the selected tab's body.** Three containers
  short-circuited the empty state before `NodeCollection` ever rendered, so
  the section tabs (Default + "+" + the custom views) vanished exactly when
  there was nothing to list: `CollectionSection` and the backlinks/unlinked
  strips rendered their own `nt-section-empty` div instead of the
  collection (the classed-nodes section already rendered the collection —
  unchanged, it keeps its EmptyState create affordance). `NodeCollection`
  gains an `emptyText` prop: when the collection is empty and no EmptyState
  is configured, the subtle empty line renders in the selected tab's body —
  the container's text ("No backlinks.") on the default tab, the honest
  "No matching rows." on a custom tab refined to empty. `CollectionSection`
  and `ReferenceList` now always render the collection and pass their
  `emptyText` through; the block-level backlink gutter (unhosted, no
  emptyText) is untouched. Verification: `pnpm typecheck` clean; web suite
  green (1364/1364 — two section-views tests added: tabs + empty line on an
  empty collection, "No matching rows." on a refinement-emptied custom tab);
  `docs/ux.md` updated.

- **fix(web, domain): date formatting applies only to date-classed nodes, and
  date pages format everywhere they render.** Two halves of one ruling. (1)
  Until now ANY node whose title excerpt matched the 8-digit shape was
  formatted as a date — the sidebar Recents/Favorites rows render the raw
  content tokens (so date pages showed the compact `20261008`), while Table
  view and every `deriveDisplayName`/`fullTitleOf` reader reformatted
  ordinary pages with ISO-style titles. Now the domain derivation formats
  only date NODES: a deterministic year/month/day id formats from the id
  (`dateNodeDisplayLabel`, canonical `YYYY/MM/DD` shape — the web's
  `dateDisplay` funnel keeps applying the user's `dateFormat` setting), and
  the compact-label content branch (`formatDateNodeName`) requires a
  year/month/day class in `classIds`; everything else keeps its literal
  title. The web's `isDatePageNode` drops the name-shape fallback (the
  deterministic id covers migrated date pages), so an 8-digit-titled page no
  longer lands in the palette's Date Pages pool either. (2) Sidebar
  Favorites/Recents rows render date pages through the same setting-aware
  display name as every other surface instead of the raw content tokens.
  **Verification:** new domain cases (literal 8-digit title without a date
  class; id-only formatting) and web `date-display` cases (name shape alone
  is not a date page); measured against the live sidebar Recents and the
  Pokemon class page; full monorepo gate green.

- **fix(web): the child-blocks ghost row gets real clearance before the next
  section's separator — the negative-margin cancellation is gone.** The
  2026-10-08 morning fix pulled the empty child-blocks surface up by exactly
  the ghost row's 2px bottom padding so the next section's border sat "flush"
  — flush turned out to mean the hairline touches the `+ Add block` label's
  line box, which in dark theme reads as the label sitting on (overlapping)
  the separator, on every surface (class view's Class properties, the day
  page's Created section). The `.nt-select-surface--empty` pull and its
  PageView class toggle are removed: the ghost keeps its own bottom padding,
  so empty and non-empty surfaces share one rhythm and the separator has
  genuine clearance. **Verification:** the throwaway probe stack measured the
  day page and the class page before/after (border flush against the label
  box before, ~4px clear after); full monorepo gate green.

- **feat(web): one chrome row for the classed-nodes section, icon-only
  buttons wear hover tooltips, and the table's data actions move behind a
  "…" menu.** The class page's Classed nodes section stacked its chrome
  three high: a full-width Filter bar, then the view toolbar (Add member +
  view switcher), then the tabs. The FilterBar gains an `inline` layout
  (control row joins a toolbar's flex line, capped at `42ch`; the
  structured-filters panel drops below as a floating overlay anchored to
  the bar, `z-popover`, same border/surface register — the zero-elevation
  law), and ClassedNodesSection renders it inside the ViewToolbar left of
  the now icon-only **+** (tooltip "Add member") and the view switcher.
  Icon-only no-text buttons across the chrome gain hover tooltips (native
  `title`, the codebase convention): the FilterBar's structured-filters
  toggle ("More filters") and clear ("Clear filter"), the member-row ×
  ("Remove from class"), and `Tabs.AddButton` (title defaults to its
  aria-label — the section views' add-tab "+" gets "Add custom view"). The
  table view's toolbar no longer carries three text buttons: **Export
  CSV**, **Export Excel**, and **Import table…** move into a far-right
  **…** menu (kit `Button` + `ContextMenu`, `alignRight`, at the
  view-type level next to Columns/Sort) — the view-type level over the
  global level because the exports are table-specific (they read the
  table's sorted rows and visible columns; meaningless in outline/cards).
  Selection-scoped exports stay inline by the selection count. Verification:
  `pnpm typecheck` clean; web suite green; `docs/usage.md` + `docs/ux.md`
  updated.

- **fix(web): the day-page Today flag wears the solid primary pill.** The
  flag styled itself with `--color-primary-container` (#f0f0f0 light) — on
  the near-white page card it read as no background at all. It now takes the
  calendar view's today-marker register: solid `--color-primary` pill,
  `--color-on-primary` text, `--shape-full` radius, `micro/2` padding, so the
  two Today surfaces render identically. Verification: `tsc --noEmit` clean;
  web suite green (1361/1361).

- **fix(web): the date pages' and calendar's Created section lists main nodes
  only.** The `createdAt` range query behind the Created section (day pages)
  and the calendar day view's Created tab matched every node created in the
  window — including blocks, which are inline scaffolding, not content. The
  AST now carries an "isClass OR presentAsMain" arm (the graph's main-node
  predicate — root nodes default to main at projection time, so nothing that
  should list is lost). Verification: web suite green
  (`calendar-view-utils.test.ts` extended to assert the main-nodes arm);
  `docs/usage.md` + `docs/ux.md` updated.
- **fix(web): the collapsed banner strip loses the dark bar and keeps its
  chevron — cover-card parity.** The collapsed banner rendered as a filled
  `--color-surface-container-low` band across the page card, which in dark
  mode (and pure black under OLED) read as a black bar, and its chevron was
  `opacity: 0` until hover. The cover card's collapse chevron — persistent at
  `--opacity-60`, full color on hover, transparent background — is the
  established register, so the strip now matches: transparent background, no
  hover fill (the cover arrow has none), chevron always visible at rest
  opacity. Verification: `pnpm typecheck` clean; web suite green
  (1361/1361; a pre-existing "Database closed" teardown flake in
  `journals-view.test.tsx` passes in isolation).

- **chore(web): drop the dead `.nt-hub-*` CSS and repair the screenshot
  probes.** The hub rows moved to `.outline-row` (CollectionHub restructure)
  but app.css still carried six unused `.nt-hub-list` / `.nt-hub-item` /
  `.nt-hub-item-icon` / `.nt-hub-item-label` / `.nt-hub-empty` rules; they
  are deleted. The `scripts/screenshots` probes were broken two ways: they
  seeded/typed `http://127.0.0.1:8377` as the sync URL, which the server's
  CORS allowlist (localhost origins) rejects — everything now uses
  `localhost`, matching verify-min — and `page-probe` clicked the dead
  `.nt-hub-item` selector (now `.outline-row`) with a placeholder-text
  palette assertion that could never pass (now checks the palette's search
  input). Verification: `page-probe` runs green end-to-end (opens a page,
  screenshots, Ctrl+K palette opens); drift gate 5/5; `tsc` clean.

- **feat(web): the page header title reads in Newsreader.** The brand type
  table puts the 28px H3 in the Text role (Newsreader), and the identity
  claim is "Newsreader for the words, Instrument Sans for the chrome" — the
  header title is the top of the reading experience, not chrome, so
  `.nt-title-content` rides the content face (`--font-family-content`, opsz
  auto) like the body rows. The old "stays chrome" comment (a holdover from
  the title-as-BlockRow restructure) is corrected. The design-system skill's
  tokens note ("page header titles may use the content serif") was already
  written for this. Verification: web suite green; post-deploy screenshot
  probe of a document page in both themes.

- **fix(web): the design-system audit batch — every finding from the
  RosellRamos audit ships.** The audit (`.audits/design-system-2026-10-08.md`)
  found one Critical, 18 warnings, and a notes list; all are fixed. Critical:
  `--tactile-press-scale` was 0.88 (a 12% collapse on every Button press) and
  is now 0.96, with the Pill literals moved onto the token. Warnings: the
  graph minimap's two hardcoded rgba grays now ride new
  `--graph-minimap-dot` / `--graph-minimap-viewport` tokens (the renderer
  re-resolves on theme/accent/OLED flips, not just theme); the PDF export
  palette's Notes theme now actually matches the light-token values it
  claimed to mirror (accent stays a documented neutral ink — an export
  can't know the live accent); `SettingsPanel` composes the `Modal`
  primitive (focus trap, overlay-stack Escape); `Modal` gained an `ariaLabel`
  path and `ConfirmationModal` labels its dialog (no more unnamed
  destructive confirms); a "Skip to content" link leads the shell's tab
  order to the content card; the Slider has a Firefox
  `::-moz-range-thumb` focus ring; a new `useDelayedVisible` hook implements
  the <300ms loading rule (Button's spinner waits 300ms, disabled/`aria-busy`
  stay immediate); sidebar rows are real `<button>`s with a ≤3px accent
  indicator on the active row (previously active ≈ hover); NodePill is two
  real sibling buttons (no `role="button"`, no nested button) with the
  hit-area overlay on the open button; ToggleSwitch gained the invisible
  44×44 hit overlay and TextField's default height rides the 46px token;
  the topbar `ThemeToggle` delegates to `applyAppearance()` +
  `writeDeviceSetting` (OLED/settings no longer go stale); anchor-rendered
  Buttons now honor `disabled`/`loading` (`aria-disabled`, no href, no
  click); EmptyState follows the recipe (on-surface-variant title, ~60%
  subtitle); AddPill's documented dashed affordance is restored (and its
  duplicated hover rule merged); Button's stale `confirm` JSDoc is gone;
  SectionViewTabs' manage row composes `Button` (ghost/danger, xs); the
  auth-tab and whiteboard-card shadow leaks are gone; inline-edit and
  datepicker cells get an accent focus-visible ring distinct from hover;
  dead focus-suppression rules on non-focusable backdrops are deleted; the
  Spinner has an honest "…" fallback under reduced motion. Notes: 112 px
  font sizes → the `--font-size-*` scale, 61 px radii → `--shape-*`, 17
  floating popovers → `--shape-floating-panel`, 572 stale `var(--token,
  literal)` fallbacks stripped, the three off-lattice breakpoints nudged to
  768/768/1024, out-of-band line-heights normalized, and px line-heights
  converted. The drift gate grew from 3 checks to 5: px `font-size`, px
  `border-radius`, and color literals inside `var()` fallbacks now fail the
  build (the minimap literals were the live proof the CSS-only gate had TS
  holes — canvas paint stays a review duty). Verification: `pnpm typecheck` +
  `pnpm test` green; three tests updated to the new contracts (PDF paper
  hex, real-button sidebar row, delayed spinner).

- **fix(web): the brand accent reads as a colour in settings.** The
  default accent's settings label was "Margin" — a layout word, not a colour;
  it is now "Advance Green", the brand colour name. The stored setting value
  stays `margin` (existing user settings keep working). Verification:
  `pnpm --filter @notees/web test` — 1359/1359.
- **fix(web): the monochrome accent swatch previews ink, and the CSS
  fallback accent is margin.** The settings Accent Color row rendered the
  monochrome preset as a static grey circle (`#404040`); it now carries a
  `--monochrome` modifier class fed by the theme-dependent token
  `--color-accent-swatch-monochrome` (iron ink on paper by day, paper white
  on the night ground by night), so the preview matches the preset it
  selects. The stale `ACCENT_COLOR_OPTIONS` hex follows. The light block's
  pre-attribute fallback accent also moved off the retired monochrome grey
  to the brand margin green. Verification: `pnpm --filter @notees/web test`
  — 1359/1359 incl. the css-token-drift gate (the new token lives in the
  defining file); post-deploy screenshot probe of the swatch row in both
  themes.
- **feat(web): the night is accent-tinted and monochrome is ink.** The dark
  theme no longer rides a fixed warm-brown family: every dark surface, outline
  and muted text is now `color-mix`-derived from the active accent preset at
  3–13% in OKLab over a neutral dark family, so each accent (margin, sage,
  teal, rose, navy, custom) washes the night with its own hue at low chroma —
  and the light ground stays the brand paper regardless of accent. The
  monochrome preset is no longer grey: it is iron ink `#1c1a16` on paper in
  light mode and paper white `#f4f3f1` on the night ground in dark mode (new
  `[data-theme="dark"][data-accent="monochrome"]` override), so a monochrome
  choice lands on effectively untinted graphite dark. The dark-mode accent
  baseline already rode the margin night-green roles. OLED pure-black is
  untouched. Verification: `pnpm --filter @notees/web test` + `build` green;
  four-variant screenshot probe (margin/teal/monochrome dark + monochrome
  light) against the live app confirmed the per-accent tints and the ink
  monochrome.
- **feat(web): the client aligns to the Margin Green brand — fonts, tokens,
  accent default, icons.** The web client now carries the shipped identity
  (brand submodule at `brand/`, v1.0.0): Instrument Sans (variable wght,
  self-hosted woff2 via the @fontsource packages) takes the chrome/base and
  display stacks; Newsreader (opsz + wght) carries the reading surfaces (the
  outliner's block content; the header title row stays chrome); JetBrains
  Mono stays for data. The light ground remaps to the brand's warm paper
  (`#f7f4ec`) with iron-ink neutrals from the brand scale, the dark ground to
  the warm near-black family (`#161412`); semantic, graph, and data-preset
  colors are untouched. Advance Green (`#2e5e46`, night role `#6da789`) ships
  as a new `margin` accent preset and becomes the default (the pre-paint
  bootstrap, the device-settings read, and the settings modal all agree); the
  monochrome preset and every other preset keep working. The app icon and
  favicons are the brand mark (small symbol + 16/32/48 PNGs + the green-tile
  app icon for the About surface), and `index.html` declares the
  light/dark `theme-color`. `docs/usage.md`'s appearance line follows.
  **Verification:** `pnpm -r --workspace-concurrency=1 build`, `pnpm -r
  typecheck`, and `pnpm -r test` green on the shipping tree.
- **fix(web): the empty page's ghost add-block row no longer overlaps the
  next section's separator.** On a page with no child blocks, the lone ghost
  row's bullet/label straddled the border-top of the following node-view
  section (e.g. Class properties). The empty child-blocks surface pulled
  itself up by a full `--spacing-2` (8px) while the ghost row only owns 2px
  of bottom padding, so the next section's border cut 6px into the row. The
  pull now cancels exactly the ghost's bottom padding (`--spacing-micro`):
  the section border sits flush below the ghost's content, matching the
  tight rhythm the rule was written for. **Verification:** a fixture
  replicating the empty-surface DOM against the built app CSS measured
  before/after (border 1px above the bullet bottom before; 5px clear
  after); the full monorepo gate green (132 files / 1359 web tests).
- **chore(env): `.env.example` documents the optional edge envs.** The
  `notees-edge` profile's required `NOTEES_EDGE_NAME` (and the
  `NOTEES_EDGE_HTTP` port remap) were missing from the template — any
  `docker compose` command failed interpolation without the real `.env`
  value, discovered at redeploy time. Generic `<host>.<tailnet>.ts.net`
  placeholder, per the fleet-agnostic rule; the real value lives only in
  `.env`. **Verification:** `docker compose config --quiet` clean;
  dev-only template change.
- **feat(web): the shared hub's header creation button per mode — New page /
  New whiteboard.** The collection hub's header action existed only for
  Classes ("New class"); Pages and Whiteboards had no creation affordance
  from the hub itself. `HubView`'s header action is now per-mode: Pages
  writes one main page (the command palette's New-page write) and opens it;
  Whiteboards reuses the sidebar New flow's write with the whiteboard system
  class picked (the created node lists in the hub's members); Inbox — a
  filtered view of the unclassed — deliberately offers none. New
  `hub-create-buttons` suite pins the three modes (3 tests).
  **Verification:** the hub-create-buttons suite green; the full monorepo
  gate green on the shipping tree (132 files / 1359 web tests) — landed by
  the owner's order from a sibling session's verified in-flight slice.
- **fix(web): the section views' Reset-to-default renders only when custom
  views exist.** The hosted-views chrome rendered the reset button always,
  disabled when there was nothing to reset — a permanently disabled control
  in the factory state. `SectionViewTabs` now renders it only when
  `views.length > 0` (the disabled styles go with it); the section-views
  suite's two reset assertions switch from the disabled property to
  presence/null. **Verification:** the section-views suite green; the full
  monorepo gate green on the shipping tree (132 files / 1359 web tests) —
  landed by the owner's order from a sibling session's verified in-flight
  slice.
- **docs(developers): parallel-session hardening — commit-early, landing
  collisions, dev ports, orphan worktrees, trivial-slice exemption** — five
  refinements to the concurrent-agent rules shipped earlier today, each from
  a gap the first live multi-session collision exposed: (1) uncommitted work
  is one rebase away from gone — snapshot-commit coherent files early,
  per-file, verification in the commit body; (2) the landing flow handles
  contention — main moved or `.git/index.lock` present means another landing
  is in flight: wait, re-fetch, redo the rebase; (3) worktrees don't isolate
  dev servers — concurrent sessions take distinct dev ports; (4) a stale
  `git worktree list` entry from a crashed session gets pruned once
  confirmed dead — never a live, unfamiliar sibling; (5) a solo session or a
  trivial docs-only slice may stay in the main checkout. AGENTS.md, the
  `notees-development` skill, and `development.md` updated in lockstep.
  **Verification:** docs-only guidance change; no code touched.
- **feat(query): the wire node-field predicates get their search-grammar
  spellings — `coverAsset:` / `bannerAsset:` / `aliasedNode:`.** The AST and
  the SQL compiler gained the three node-field conditions with the
  wire-fields slice, but the hand-written DSL parser had no production for
  them — `notees search "coverAsset:"` died as an unknown field (the CLI
  test had to POST the AST programmatically). `dsl.ts` now parses them
  like the other fields: bare `:` is the set/unset probe (no value, also
  before AND/OR/NOT — the `prop:` precedent), `=`/`:=` eq and `!=` neq take
  a node reference — a uuid passes through verbatim, anything else
  resolves by node NAME through the injected resolver (the `linked:`
  precedent); range/contains operators are rejected (uuid references admit
  only eq/neq/exists, and under SQL NULL semantics "is unset" reads
  `NOT coverAsset:`, never `neq`). Docs: `packages/query/README.md`'s
  grammar block. **Verification:** the dsl suite — new cases for the three
  fields (exists/eq/neq, uuid passthrough, name resolution, the boolean-
  keyword boundary, case-insensitive field names, the known-fields error
  list, bad operators) — 40/40; the query package 177/177 with dist
  rebuilt; and the page-banner suite's jsdom `URL.createObjectURL` gap
  closed (the stub the covers suite already carried — the unhandled error
  during the upload-modal test is gone, 9/9).
- **docs(developers): worktree-per-session + landing flow for concurrent
  agents** — with multiple agent sessions expected to work concurrently on
  unrelated tasks, AGENTS.md, the `notees-development` skill, and the
  `development.md` runbook now make a worktree per concurrent session the
  default (own branch off main, own install, own gate, in gitignored
  `.worktrees/<slug>/`), define the landing flow (slices land one at a time
  in the main checkout: rebase onto main, fast-forward merge, push,
  promptly), and require cleanup after landing (`git worktree remove` + safe
  `git branch -d`, so `git worktree list` stays truthful). Shared record
  files (`CHANGELOG.md`, `README.md`, `docs/`, `AGENTS.md`) get their own
  discipline: minimal anchored edits, changelog entries prepend under the
  current date, conflicts resolved by keeping both blocks — never dropping
  another slice's entry. The parallel-session detect-and-coexist rules stay,
  scoped to what worktrees don't isolate (deployed stack, dev ports,
  `config/notees/` data). **Verification:** docs-only guidance change; no
  code touched.
- **fix(web): the cover element rides the `coverAssetId` wire node field —
  the web half of the wire-fields follow-on.** The wire-fields slice made
  `coverAssetId` the authority (object.update field + the migration moved
  every stored value onto it), but the web cover chrome still read/wrote the
  retired image-typed `cover` property: a cover set through the field (the
  CLI, the API, the migration) never showed in the page header, and a
  UI-set cover wrote the dead property. `coverProperty.ts` now mirrors the
  banner exactly: `coverAssetIdOf` reads the node column, `setNodeCover` /
  `clearNodeCover` write `object.update { coverAssetId }` (present-null
  clears) + the asset class, and the retired `ensureCoverProperty` /
  `canHaveCoverOf` self-heal + schema gate are gone — the element renders
  for every document-chrome page, set or empty (the `bannerPossible`
  shape). `PageView` loses the cover self-heal effect; the card-view
  **Cover** badge (`isCoverAsset`) switches from `getLinkedReferences` to a
  new shared read, `getCoverReferences(assetId)` (WorkspaceClient SQL probe,
  the `getAssetInfo` precedent; WorkerClient + the worker dispatch carry it)
  because the wire node fields are not mined into the edge index yet — the
  backlinks roll-up follow-on owns that. The cover still auto-expands the
  card when set. Docs: `ux.md` + `usage.md` (the cover paragraphs now say
  wire node field; the stale `prop:cover:` search example is corrected to
  the `coverAsset` AST predicate). **Verification:** the covers (16) +
  deck-view suites green on the wire field, page-layouts/block-backlinks/
  query-block/verb-create-bind/focus-mode/render-cascade/card-lazy-images/
  view-modes suites green (104 tests); the full monorepo gate green (1359
  web tests across 132 files).
- **refactor(web): the kanban view mode merged into cards.** Kanban was the
  card view with a property-dimension groupBy enabled and between-column
  drag-and-drop — a separate view mode no longer earns its place. `KanbanView`
  is gone; the board now lives in `CardsBoard` (the cards view's grouped
  rendering, dispatched when the container's `groupByProperty` resolves to a
  usable select schema — the prop replaces `kanbanProperty`), the CSS classes
  renamed `kanban-*` → `board-*`, and the Tasks hub / classed-nodes section
  offer the outline/cards/table triad unconditionally (cards IS the board
  where a grouping select exists, the flat grid elsewhere). A persisted
  `viewMode.* = "kanban"` reads back as `"cards"`. Drag drops still write the
  property (`applyCardGroupDrop`, the former `applyKanbanDrop`); columns,
  windowing, covers, and selection export are unchanged. Verified: the web
  typecheck clean and the full `apps/web` suite green (1359 tests) with the
  merge in; the kanban-merge suites (`view-modes`, `windowing`,
  `selection-export`, the `page-layouts` L1 persistence block) green
  standalone.
- **feat(web): palette Properties section + the owner-mandated search order.**
  The command palette's search results now rank **Classes → Properties →
  Pages → Content**, then Date Pages and Commands (the flatten step is a
  stable sort on a mode-dependent group rank, so score order inside a group
  survives; the empty-query home keeps Recent → Random → Commands). The new
  **Properties** section fuzzy-matches the workspace's property schemas
  (`client.listPropertySchemas`, both client kinds carry it) by name, with
  the type name as keyword ("date"/"select"/… find the family) and a
  per-type mdi glyph mirroring the Class View's TYPE_GLYPHS; a pick calls the
  new `onOpenProperty` contribution point, which the App hosts as the
  existing PropertyView modal (metadata, bound classes, value carriers).
  Search-mode only, like Pages/Classes — quiet on the empty query and under
  `is_daily:`. Docs: `usage.md` (the palette paragraph's section list and
  order). **Verification:** the search-palette suite — four new tests
  (section + pick wiring, type-keyword match, the empty-query/`is_daily:`
  quiet rule, the Classes → Properties → Pages → Content rank assertion) —
  green; `apps/web` typecheck clean for the touched files.
- **feat(web): the Assets hub's cards default to cover top.** The assets
  sidebar entry's cards read as an image gallery, so the surface now passes
  a `defaultCoverLayout="cover-top"` fallback (new optional
  `NodeCollectionProps.defaultCoverLayout`, threaded through
  `CollectionHub` and honored by the cards view's
  `useCardLayoutPreference` fallback). The rule shapes ONLY the unset
  fallback: `cards.coverLayout` stays one global device-local preference —
  the moment the user picks a layout anywhere, that choice wins on every
  surface. Every other cards surface keeps the shipped "no-cover"
  default. Docs: `usage.md` (the new "The Assets hub's cover-first cards"
  section beside the Tasks-hub one). **Verification:** `apps/web`
  typecheck clean; the view-modes suite green — the cover test now asserts
  the cover-top default + the no-cover switch, and a guard test pins the
  no-cover fallback for surfaces without the prop.
- **docs(developers): commit-and-push standing rule** — AGENTS.md, the
  `notees-development` skill, and the `development.md` runbook now record
  that a finished slice (gate green, changelog entry in) is committed —
  per-file staging, Conventional Commits — and pushed to the current
  branch before the session ends. Pushing is standing authorization in
  this repo, overriding the `agent-repo-workflow` per-push confirmation;
  if the remote moved, integrate (`git pull --rebase`), never force.
  Verified: docs-only guidance change; no code touched.

## 2026-10-07

- **feat(store,server,web): the parked follow-ons batch — the alias
  resolved-target materialization, the REST wire-field projection, and the
  query-builder-guard coalescing-test stabilization.** Three small slices,
  one verification pass.
  **(1) The alias resolved-target materialization** (the documented later
  optimization, store schema v16 → v17): the derived `edge` index gains
  `resolved_target_id`, the alias-terminal of each edge's target,
  materialized BY THE APPLIER — `resolveEdgeTarget` walks `aliased_node_id`
  chains with the `resolveAlias` cycle rule (a revisit yields the starting
  id unchanged) and a deliberate liveness gate (trashed/deleted rows never
  resolve through; a missing/inactive row is its own terminal — so a
  trashed alias's edges stay inert on the alias, exactly the live-only
  semantics the recursive read gave the roll-up). Written at edge-derivation
  time (`rebuildEdges`) and re-resolved by `reresolveEdgeTargets` wherever
  chains can shift: `object.update {aliasedNodeId}` (the reverse closure —
  pointer-based, invariant under the seed's own write), `object.delete`
  (soft + permanent), `object.restore`, `class.delete`, the PB2
  orphan-carrier trash, and the family-archival feature toggles. The
  guarded migration (`PRAGMA table_info` column check + the
  ladder-gated `idx_edge_resolved_target` index, the LIST_READS_INDEX_DDL
  precedent, re-asserted on the snapshot-repair path) backfills pre-v17
  databases through the SAME walk, so a migrated database is byte-identical
  to a wipe → replay at v17. **The read switch:** `backlinksWithRollup`
  answers the alias family from the column (one indexed probe replacing the
  recursive alias-set walk + per-alias client union; `kind: "alias"` rows
  carry the raw target; the carrier filter mirrors the SCHEMA.md page
  restriction so non-page carriers still don't act as aliases; containment
  tests the resolved target — an intra-subtree link via an alias is
  content, not an outward link); `graphTopology`'s structural families read
  it too; `backlinks()` and the `node_stats` badge stay raw-direct (the
  alias page's own view + the badge contract, SCHEMA.md). No wire change
  (derived-only) — the GTK/Flutter stores carry their own derived schemas;
  their v17 follow-on (same column, same write-time semantics) is recorded
  in SCHEMA.md "Node aliases" and does not gate this slice.
  **(2) The REST `ApiObject` exposes the three wire node fields:**
  `coverAssetId` / `bannerAssetId` / `aliasedNodeId` ride `nodeToApi` on
  every object projection (get/list/children/PATCH response; null = unset,
  present-null clears exactly like `color`); the OpenAPI object reads
  document them (the PATCH body schema already carried them). The web
  client's `getLinkedReferences` consumes the store's three-family read in
  one pass — the client-side alias union dissolves into the store's `kind`
  label plus the same both-ends own-subtree exclusion.
  **(3) The query-builder-guard coalescing test is deterministic:** the
  "a synchronous notification burst costs exactly one re-run" assertion
  raced the seeding writes' floating push-ack notifications under
  parallel-suite load (a settle-phase notification landing after the
  baseline capture merged with or added to the burst's trailing run); the
  baseline is now captured after the repo-standard six-tick `flushSync`
  drain, so no notification or re-run is in flight when the burst fires.
  **Verification:** the store suites pin the materialization on BOTH
  adapters (write-time resolution, re-point/clear re-resolution, stale-LWW
  no-op, trash/restore/permanent-delete, the v16 → v17 backfill against a
  fresh v17 replay, wipe → replay byte-identity, the roll-up's
  direct/alias/containment kinds, the page-carrier restriction) — store
  457 (was 437); the server suite pins the wire-field projection (218,
  +1 for the new test); the web alias suites re-green unchanged (the
  roll-up semantics hold through the store read); the guard suite ran 3×
  green, 3× more concurrently with the full gate (the load condition that
  used to flake it). `pnpm -r build`, `pnpm typecheck`, and the full
  `pnpm test` gate green — 2,818 tests across 184 files (protocol 301,
  domain 72, export 219, store 457, sync 25, query 175, server 218,
  web 1,351).

- **feat(web): the transient filter layer — `filterable` sections filter
  their rows post-resolution/pre-windowing.** The section data contract
  (components/useSectionData.ts) gains the filter step: a `FilterSpec`
  applies to a section's resolved rows AFTER the lazy resolution, BEFORE
  the collection's windowing — windowing sees the filtered set (a windowed
  table renders the filtered window, never the first-N-then-filtered), the
  resolution cache is untouched (a spec change re-derives from the cached
  rows and re-runs no query — pinned by a spy assertion), and the eager
  count stays UNFILTERED: an active filter reads "0 of N" in the bar and
  the section never vanishes. **The FilterSpec is one grammar with the
  stored custom views** (components/filterSpec.ts): the documented flat-AND
  subset of the query AST as plain serializable data —
  `{ text?, classId?, propertyPredicates[], dateRange? }` — writing forward
  through `filterSpecToQueryAst` and reading back through
  `queryAstToFilterSpec` (an AST outside the subset reads back null, never
  a lossy default); a strict `parseFilterSpec` fails loud on unknown keys
  and bad shapes. The row predicate mirrors the compiler's scalar
  semantics over the effective-values read model: title substring,
  hierarchy-aware class membership (the class or anything extending it),
  property ops (numeric-when-numeric, the ISO-date arms matching node-typed
  values by their deterministic date id), the inclusive created window with
  `{today}`-style placeholders resolving on the run clock. **The bar
  chrome** (components/FilterBar.tsx + .css) rides each section's body top
  (the section header is a single button — no nested controls; the skin's
  CollectionSection gains the `filterable` prop + slot the same way) and
  composes kit primitives only: SearchField for text, the structured panel
  (class picker, property predicate rows, the created window with the
  placeholder datalist — the query-builder precedent) behind a toggle, the
  honest "N of M" count and a clear. **State is component state — one
  FilterSpec instance per section view/tab, lost on reload, nothing
  persisted.** Enabled on the three filterable sections: the linked-
  references (Backlinks) and unlinked-mentions tabs (per-tab instances — a
  switch never leaks a filter across) and the classed-nodes table (the
  section now resolves through the hook directly — the Section wrapper's
  load path cannot host a post-resolution step; chrome and contracts
  unchanged); every other section renders no bar. `SectionSpec.filterable?:
  boolean | FilterBarConfig` records the contract for the future stacks.
  **Verification:** `npx tsc --noEmit` clean; new suites
  `test/filter-spec.test.ts` (12) and `test/filter-layer.test.tsx` (7)
  green; the sections/windowing/class-view/view-modes/css-drift suites pass;
  the full web suite runs 1350 passed / 1 failed — the one failure is a
  shared exact tab-list assertion in `test/system-sections.test.tsx` that the
  concurrent stored-views slice's added Default tab breaks (not this slice),
  and the known query-builder-guard load flake passed both in the full run
  and isolated.
- **feat(web,server): custom views as stored tabs — every collection-backed
  section hosts custom views.** A page's backlinks, its unlinked mentions,
  and a class's classed nodes each gain a tab bar — **Default** first
  (permanent, never closable, never replaced — it renders exactly the
  factory behavior) plus custom tabs in sequence order, with a **+** that
  opens the FilterBuilderModal and persists the composed filter **verbatim**
  as the view's stored query. **Storage (the prefs channel, the
  favorites/recents ruling):** a new `section_view` table in `relay.db` —
  id, user_id, node_id, section_key (`linked-references` |
  `unlinked-mentions` | `classed-nodes`), name, sequence (dense tab order),
  query_ast (JSON, validated against the QueryAST v1 zod schema at the
  route), view_mode (nullable display pin), timestamps; `UNIQUE (user_id,
  node_id, section_key, name)`; **no `is_default`, no default rows** — the
  default view is derived-not-stored, so emptying the table restores
  factory behavior and "Reset to default" is just "delete every row of the
  section". Five REST endpoints under
  `/api/me/nodes/:nodeId/sections/:sectionKey/views` (list/create/rename/
  reorder/delete), `requireUser` auth like `/api/me/prefs` (per-user API
  keys ride as their owner; the operator key is not a user → 401), unique
  violations → 409, foreign rows → 404 (per-user scoping never leaks),
  OpenAPI-documented (the coverage gate). **Web:** the `useSectionViews`
  hook + module store (the nodePrefs precedent — one shared copy per
  section, device-local cache for offline reads; writes are optimistic with
  revert-on-failure, so offline the tabs are read-only — per-row writes
  cannot replay honestly the way full-list prefs can); `NodeCollection`
  gains the hosted-views chrome via an opt-in `hostedViews` prop
  (`SectionViewTabs`: the kit Tabs bar, the active custom tab's
  rename/reorder/delete manage row, the always-available Reset to default,
  the FilterBuilderModal "+" flow — in this host the modal's Run also
  persists, with an auto label); client plumbing on both `WorkspaceClient`
  and the `WorkerClient` RPC. **Resolution (the composition rule):** the
  section's base query produces the row set, then the stored AST refines it
  — base-column predicates (`class` hierarchy-aware, `isClass`,
  `presentAsMain`, the created window with `{today}` resolution, `content`
  contains over the flattened title text, the cover/banner/aliasedNode
  wire-field predicates) evaluate directly on the materialized rows; joined
  metadata (`property`, `content` fts, `linkedTo`) falls back to one
  `runQueryAst` membership probe per leaf intersected with the base set (the
  FilterBuilderModal's representable subset never produces these — the
  common tab evaluates wholly on the rows); the stored scope and aggregation
  are ignored (the base set IS the scope; a tab refines rows and the AST
  round-trips verbatim); sort applies with the compiler's semantics (name
  NULLs-last, id tiebreak); groups refine alongside items so grouped
  backlinks stay consistent. A custom tab's `view_mode`, when set and
  registered, overrides the container's mode. The three sections wire the
  prop: `SystemSections` (both reference tabs) and `ClassedNodesSection`.
  **Verification:** the full root gate green — server 218/218 (the new
  section-views suite pins the table, the five endpoints, the unique key,
  per-user scoping, the validation taxonomy), web 1351/1351 including the 25
  new section-views tests (resolution both paths, the store, the chrome:
  default permanent + custom additive + reset, the "+" flow persisting the
  AST verbatim, refinement on top of the base set, empty-table = factory
  behavior); `pnpm -r build` + `pnpm typecheck` clean.

- **feat(web): the rail's cards reorder by grip drag, and the hover preview
  renders the shared NodeView in preview mode.** Two registered follow-ups
  land together. **Rail card reorder:** the cards-only right rail's stack
  order becomes user-authored — each card frame's header carries a drag
  GRIP (the block-row grip precedent: a small distinct handle, so the
  reorder gesture never conflicts with the header's block-drop gesture or
  the breadcrumb clicks). The grip registers the card with the ONE
  workspace drag session as a reorder source; a card drag runs its own
  session kind — no zone measuring, no drop line, no transient expands —
  with the overlay name chip + the target header's reorder edge (a line
  above/below, the pointer's half of the header) as the feedback. At drop
  the host reports { activeCard, targetCard, edge } to the App's
  `onRailCardReorder`; the App owns the stack and its device-local
  persistence — the recents-order precedent (`notees.sidebarCards`, the
  `recordRecent` shape: a validated localStorage list, no server
  counterpart, never an op), written by one effect on every open/close/
  reorder, with ids the current workspace doesn't know filtered on
  connect. The header drop stays exactly the append-as-last-child code
  path — a block dragged onto a grip-bearing header still lands as the
  card node's last child (one new suite pins both gestures side by side).
  **The hover preview → NodeView swap:** `NodeHoverPreview`'s bespoke
  card (icon/title/excerpt/backlink-count) is deleted; the card now
  renders the shared `NodeView` in its `preview` mode — the real chrome
  and the real read-only rendering (the title row, the body capped at the
  first level), with the write machinery stepped aside on the preview
  surface: no corner menu (already), and now no banner/cover affordances,
  no properties list, no aliases/tags editors, no icon picker, no header
  context menu, no whiteboard lazy-authoring, no block multi-selection —
  plus two seam completions the swap surfaced: the page header's title row
  and block targets' `ReferenceSubtree` accept read-only (a click
  navigates, never edits — the trampoline contract), threaded from
  NodeView's `preview` prop. The behavior contract is unchanged: the same
  dwell/grace state machine, the same dismissal layer, the same
  pin-to-floating-editor promotion, the broken-mention fallback, the
  backlink count + Pin footer (now under the real view). Docs: `usage.md`
  (the preview card + the rail paragraphs) and `ux.md` (the right-rail
  paragraph, stale since the cards-only restructure) re-homed.
  **Verification:** `npx tsc --noEmit` clean for the touched surface; the
  three suites green — workspace-dnd 12 (the rail reorder suite: before/
  after reports, the reorder-edge indicator, the self-drop no-op, the
  append drop intact), rail-card-order 9 (the pure move + the
  device-local persistence round-trip), node-hover-preview 19 (the real
  chrome, the read-only title/body navigation, the block target's
  read-only focused-block chrome, pin → floating editor). The full-suite
  run at this commit also shows the in-flight hosted-views/filter work
  area red (section-views, filter-layer, system-sections, node-aliases —
  that slice is mid-implementation; this change touches none of it).

- **feat(web,server,store): the alias read-path repointing — the final
  alias-program slice.** Every node-alias read now rides the
  `aliasedNodeId` wire field (`node.aliased_node_id`), retiring the
  property-based carrier (`aliasOf` self-heal, the `aliasOfTarget` edge
  read, the properties-panel special cases) entirely.
  **The universal redirect:** `resolveAliasOpen` repoints onto
  `client.resolveAlias` (the store's cycle-safe chain walker, exposed on
  both clients — WorkspaceClient + the WorkerClient read cache with the
  conservative content-global invalidation, alias chains are not ancestor
  relations) and moves INTO the App open funnels — `openPage` and
  `openInSidebar` resolve, so every navigation surface (breadcrumbs, the
  command palette, backlink/query result rows, graph clicks, mention
  clicks, hover previews, floating editors, sidebar rows) lands on the
  terminal through the single seam; browser deep links and back/forward
  stay raw (identity-level), and the component-level wrappers dissolve
  into plain funnel calls. **Backlinks roll-up:** a new recursive store
  read `Store.aliasNodesOf` (reverse-walk over the column — every live
  node whose alias-terminal is M, chains included; the materialized
  resolved-target column stays the recorded later optimization) drives
  the linked-references `kind: "alias"` union AND the unlinked-references
  exclusion (a source linking an alias is already linked by alias).
  **Graph exclusion:** alias nodes are not vertices; edges incident to an
  alias render incident to the terminal and repointed parallels merge
  into one weighted edge; the local-scope anchor steps through to the
  terminal's neighborhood. **Server `/resolve`** folds node aliases to
  the terminal via the same walker (the `aliasOfTarget` loop retires); the
  REST `PATCH /objects/:id` body schema gains the three wire node fields
  too — it predated them (the web writes via the op log, so the gap only
  surfaced when the `/resolve` test drove the field over HTTP; the OpenAPI
  body schema follows).
  **Links keep the alias uuid** — authoring never rewrites; resolution
  happens at navigation (pinned by a test). **The aliases UI:** the main
  page's title row gains an **Aliases · N** button — the list popover
  names every alias with a NAVIGATE button that opens the alias's OWN
  view (the one deliberate bypass, via the new raw `openPageAt` funnel),
  and ADD writes THE SELECTED node's `aliasedNodeId` (the backward write
  — the picker filters already-aliased nodes and the main itself, the
  page guard validates the pick); the alias's own view carries ONE
  pseudo-property row — a node-typed **Aliased node** entry over the
  field itself, re-pointable and clearable from the alias side, rendered
  by the properties table and the properties sidebar alike.
  **Verification:** the store suites pin `aliasNodesOf` (direct + chain,
  live-only, self-excluded) and the graph exclusion (repointing, merged
  parallels, chain collapse, the local anchor); the web suite re-seeds
  the alias world onto the wire field — the roll-up (alias + chain +
  additive own-view), the redirect seam, links-keeping-the-alias-uuid,
  the unlinked exclusion, the banner, the guard, and the new UI end to
  end (list, NAVIGATE bypass, the backward ADD write with the filter, the
  pseudo-row's re-point + clear + the page gate); the server suite pins
  the `/resolve` fold over the field; the full gate green — **2,678 tests
  across 175 files** (protocol 301, domain 72, export 219, store 437,
  sync 25, query 175, server 204, web 1,245).

- **feat(web): the page banner — the `bannerAssetId` wire field's UI
  half.** A full-width collapsible banner ABOVE the header, inside the
  page card and spanning the content width; the cover card stays in the
  header row — banner and cover coexist. The banner reads the
  `bannerAssetId` node field straight off the ClientNode (the store's
  `banner_asset_id` column, the wire-fields slice's read projection) and
  writes through `object.update` — the client surface gains all three wire
  fields (`coverAssetId` / `bannerAssetId` / `aliasedNodeId`) on
  `UpdateObjectInput`, payload-mapped alongside icon/color (the worker RPC
  rides the same input through, no handler change). Collapsed to a slim
  full-width strip by default under the per-page device-local pref (the
  cover-collapse precedent: `pageBannerCollapsed.<pageId>`); expanding
  shows the fixed-height cover-fit image (the existing banner sizing
  token) or the dashed Add affordance — the AssetUploadModal with an
  image-only accept list, the landed asset node's id written to the field
  plus its asset class (explicit ops, every client converges). A banner
  landing while the strip is collapsed expands it (the cover precedent —
  the new image is the feedback); the mount is excluded, so the pref
  governs the first view. Hover reveals Collapse / Change / Remove (Remove
  clears the field present-null; the asset stays). The page context menu
  gains **Add banner** / **Change banner** — labeled by the current field
  value — riding the same host-owned modal as the empty affordance, so
  both entry points are one flow. Whiteboard pages and embedded renders
  host no banner (the cover gating precedent). **Verification:** a new
  page-banner suite pins the field round-trip (set/clear + the asset
  class), collapsed-by-default, expand → image, the per-page pref
  surviving a remount (a second page stays collapsed), the empty → upload
  → field flow with the image-only accept asserted on the file input, the
  context-menu entry and its Change label once set, and the
  whiteboard/embedded gating; the full gate green — **2,668 tests across
  175 files** (protocol 301, domain 72, export 219, store 433, sync 25,
  query 175, server 204, web 1,239).

- **feat(web): the `asset` property type's dedicated row chrome.** The
  type (the attachments schema leads it) leaves the generic object row
  behind: the row renders the linked assets as a LIST — the thumbnail
  (image bytes through the session cache; a kind icon otherwise), the
  `node_asset` original name (click downloads), and a per-item remove —
  with TWO authoring buttons: **Upload** opens the AssetUploadModal
  directly (its CAS flow creates the asset node; the property value links
  it at the next free slot) and **Link** opens the node picker scoped to
  asset-classed nodes with create disabled (the type IS the filter — a
  picker-level create could mint a non-asset, so the row offers none).
  Multi rows keep both buttons at the list's bottom; a single-value row
  renders them only while empty — replacement goes through clearing
  first. Broken targets render the dashed raw-id row (the broken-mention
  policy), never a silent void. The row renders everywhere property rows
  render (the properties table and the compact/sidebar surfaces share the
  grouped-row switch). **The upload modal grows three capabilities the
  chrome leans on:** an `accept` prop narrowing the selectable set (the
  MIME / `type/*` / `.ext` grammar), clipboard-paste capture while open
  (pick, drop, or paste ride one selection path), and client-side gates
  mirroring the server — the accept list and the media (50MB) / document
  (100MB) size caps — rejecting with a named error before anything leaves
  the machine. **Verification:** the asset-attachments suite re-seeds the
  attachments schema at its current wire shape (type `asset`, the filter
  implicit in the type) and pins the new chrome end to end — the empty
  Upload/Link buttons (no generic Add pill), the asset-scoped no-create
  picker (filtering + search + the pick writing the value), the upload
  setting the value to the fresh asset node (multipart POST + API key
  headers intact), paste filling the modal, the accept gate rejecting
  before any upload, the failed-upload error path, the multi list with the
  buttons at the bottom + thumbnail rendering, the single clear-first
  flow, item removal rewriting the list; the full gate green (2,668 tests
  across 175 files — totals above).

- **feat(protocol,store,domain): the `asset` property type — attachments
  leads the type out of `object`.** Owner ruling (M38): an asset-typed value
  is a node reference whose target must carry the ASSET class — the type IS
  the filter. **Protocol:** `propertySchema.create`'s strict type enum gains
  `"asset"`; the domain `SystemPropertySpec` union keeps pace and the seeded
  `attachments` spec (…0011) drops its now-redundant explicit
  targetClassFilter. **Fixture gate 23→24:** `property-asset-type.json`
  exercises the type through create plus a coexisting update (type rides
  create only — `propertySchema.update` deliberately carries none), with a
  strict-schema pin rejecting a bogus type. **Store:** the validation
  machinery treats `asset` as the node-ref family — `{nodeId}` shape with
  legacy bare-uuid normalization, target existence, and the IMPLICIT
  asset-class filter (explicit filters on asset schemas are ignored);
  node-typed defaults stay unsupported. **Migration:**
  `scripts/migrate-attachments-asset-type.mts` (the sibling-script
  conventions: scratch-store plan, protocol-validated envelopes, dry-run
  default) retypes live attachments rows through the `propertySchema.create`
  UPSERT — the only wire path that can change a type — carrying the stored
  row's name/scope/multi/flags verbatim (rename-safe, display/readonly/
  hideWhenEmpty preserved) while the explicit filter column retires; values
  are shape-compatible and ride untouched. Idempotent: a second run plans
  nothing. `SCHEMA.md` ("Sources as containers", PB2/PG6/PC2) updated; the
  UI half (Upload/Link buttons, the multi list) is a separate later task;
  **the GTK/Flutter ports are a separate follow-up in the clients repo** (a
  strict-enum additive — pre-batch clients reject the retype envelope, so
  the live migration run gates on them). **Verification:** the store suite
  gains an M38 block (fixture replay, implicit-filter accept/reject, the
  no-defaults rule, the upsert retype preserving values + flags) and a new
  web suite drives the migration core over the sql.js adapter; the full
  gate green — `pnpm -r --workspace-concurrency=1 build`, `pnpm typecheck`,
  `pnpm test`: **2,654 tests across 175 files** (protocol 301, domain 72,
  export 219, store 433, sync 25, query 175, server 204, web 1,225).

- **feat(protocol,store,web,domain): the seeded `class` meta class is
  retired — its members become real classes.** Owner ruling: `class` (…0001)
  withdraws from the seed manifest (the UUID never reuses, the cover-class
  comment precedent), and nodes bound to it BECOME classes. **The conversion
  capability (the (a) investigation: no wire path existed — `class.create`
  upserted the registry row but `INSERT OR IGNORE` never flipped `is_class`,
  leaving an inconsistent half-state; `object.update` has no `isClass`
  key):** `class.create` on an EXISTING node now declares it a class — the
  applier flips `is_class`, cuts a parented node to a root (parent edge +
  child-order row drop), clears the render bit, and the registry adopts the
  node's title; a payload `contentAst` still wins LWW, and absent fields
  PRESERVE on re-declaration (the upsert used to wipe icon/color with null —
  fixed, pinned). **No payload keys changed** — the schema always accepted
  the id, so this is applier semantics, documented as the deviation from
  "additive payload change"; the fixture gate applies anyway:
  **gate 22→23** with `class-convert.json` (parentless + parented
  conversions, re-declaration no-op, fresh declaration) and a store block
  asserting the derived state. **Seeds:** `SYSTEM_CLASS_UUIDS` / icons /
  display names / `SEEDED_SYSTEM_CLASSES` / the F1 always-on list lose the
  `class` entry; the `has-template` spec loses its `bindTo` (the server seed
  now emits it at global scope automatically). **The has-template
  relocation:** the family hosts on NO class — `templateFamily.ts` authors
  the schema at global scope with no binding and no class-class self-heal;
  the TemplatesSection/listClassTemplateBindings read path is unchanged
  (authored values surface through the effective-properties read with or
  without a binding — the new location IS the honest location). The other
  class-class consumers follow: `classRemoval` (journal-chain only),
  `dateChipCandidates` (date-chain exclusions only). **Migration:**
  `scripts/migrate-retire-class-class.mts` converts every bound node
  (bare-id `class.create` + `class.unassign`), retires the (class-class,
  has-template) binding row, re-scopes the schema to global through the
  create-upsert (carrying the stored row verbatim), and trashes the emptied
  class-class node (recoverable — the migrate-cover-to-asset precedent);
  idempotent, dangling memberships skipped, verified by a fresh-scratch
  replay. **The GTK/Flutter alignment is a separate follow-up in the clients
  repo** — class identity is the lockstep gate, stated in the script
  docstring, `WIRE.md`, `migrations.md`, and `releases.md`. Same-pass
  `SCHEMA.md` (the seed manifest, "Node structure", Templates). **Verification:**
  the store conversion block (both adapters), the updated template-family /
  calendar suites, the new migration web suite (4 tests), and the domain
  pins (spec shape, withdrawn …0001) all green; the full gate green
  (2,654 tests across 175 files — totals in the newest entry).

- **feat(store): write-time alias-cycle validation + the `resolveAlias`
  chain walker (M12).** The follow-on scoped in with the wire fields: an
  `object.update {aliasedNodeId}` that would close an alias cycle now fails
  loud AT THE APPLIER and is never applied — the extends-DAG precedent for
  structural invariants. The would-be chain N → T → T's target → … is walked
  before the write; a revisit of any visited node fails (`CycleError`) — the
  1-edge self-alias included — while clearing (null) skips the check and a
  stale-HLC write is dropped by the row LWW before any check. The read
  helper `Store.resolveAlias(nodeId)` walks a chain to its terminal,
  cycle-safe by construction (a revisit yields the starting id unchanged — a
  cyclic alias is no alias, the SCHEMA.md navigation ruling) with a 32-link
  depth cap. **The alias read-path repointing (`aliasOfTarget` usages, the
  universal redirect, backlinks roll-up, graph exclusion) is deliberately
  NOT this task — recorded as the next follow-on** in `SCHEMA.md` "Node
  aliases". **Verification:** a new store block on both adapters (chain set/
  resolve, self + indirect + 2-cycle rejections with nothing applied, clear
  re-opens the chain, stale-write drop, the direct-row cycle walk, the depth
  cap); the full gate green (2,654 tests across 175 files — totals in the
  newest entry).

- **feat(protocol,store,query,export): the wire node fields —
  `coverAssetId` / `bannerAssetId` / `aliasedNodeId` on `object.update`,
  superseding the retired cover/banner/aliasOf property
  assertions.** Owner ruling (the
  node-fields boundary, the icon/color precedent): platform-fixed node
  fundamentals are wire node fields, never class-bound properties.
  **Protocol:** `object.update` gains the three optional nullable fields
  (presence writes, present-null clears); `object.create` carries none.
  **Fixture gate 21→22:** `object-wire-fields.json` exercises set + clear of
  all three through `object.update`; the exact-list assertion and a semantic
  pin (non-uuid rejected; the fields rejected on `object.create`) join the
  protocol suite. **Store:** `SCHEMA_VERSION` 15→v16 — the node table gains
  `cover_asset_id` / `banner_asset_id` / `aliased_node_id` (guarded
  idempotent ALTER for existing databases); the `object.update` applier maps
  the fields (absence preserves, null clears, row LWW like icon/color) with
  no referential validation — alias-chain acyclicity and asset existence are
  read/client-layer concerns. **Query:** the AST/compiler gain the
  `coverAsset` / `bannerAsset` / `aliasedNode` predicates (eq/neq/exists
  compiling into the node-table columns; "unset" reads `not exists` under
  SQL NULL semantics). **Export:** the JSON archive node record carries the
  three fields, always present, null when unset (envelope version stays 1 —
  additive; format comment records the note). **Migration:**
  `scripts/migrate-cover-banner-alias.mts` (the `migrate-system-names`
  precedent: scratch-store plan, protocol-validated envelopes,
  `RelayStorage.ingest`, dry-run default) appends per carrier node one
  `object.update` (the latest visible assertion's target — `{nodeId}`
  canonical, bare uuid defensive, v1 `{hash}` cover data resolved through
  the CAS `node_asset` table) plus a `property.unset` per visible row
  (element remove for element-authored rows, slot unset for the legacy
  positional rows whose deterministic id is not a uuid); unresolvable values
  are skipped untouched for a fixed re-run. **Alias semantics (resolveAlias
  chains, write-time cycle validation, the universal redirect, backlinks
  roll-up, graph exclusion) are follow-on slices — this ships fields +
  appliers + fixtures + migration only;** `SCHEMA.md` ("Node structure",
  "Node aliases"), `WIRE.md`, `migrations.md`, `releases.md` (the current-wire
  line + batch table), `architecture.md` (the schema-version lines and the
  boundary rule's honest carve-out), and `development.md` (the fixture table)
  updated in the same pass. **The GTK/Flutter alignment is a separate
  follow-up in the clients repo** — the new keys are additive on a strict
  payload, so a pre-batch client rejects them and the live migration run
  gates on the ports (the lockstep law; the script's docstring states it).
  **Verification:** the full gate green — `pnpm -r
  --workspace-concurrency=1 build`, `pnpm typecheck`, `pnpm test`: 2,598
  tests across 174 files (protocol 279, domain 72, export 219, store 407,
  sync 25, query 175, server 204, web 1,217); the migration core is pinned by
  a new web suite (plan shapes, v1-hash resolution, element vs slot unsets,
  idempotence, the validate-before-insert gate) run over the sql.js adapter.

- **fix(web): system-class deployment self-heals binding rows past the
  seed-spec fallback.** The pre-existing defeat: `deploySystemClass`'s
  "already bound?" check read `getClassBindings`, which read-synthesizes the
  designed system seeds for system classes — so a workspace that had a system
  class node but no `class_property` registry rows (offline-first devices,
  pre-seed workspaces) looked fully configured through the ClassView while
  the registry-only effective-properties read (store `effective.ts`) saw
  nothing, and the deploy authored no rows at all. The binding steps
  (the spec family and the `SYSTEM_EXTRA_CLASS_BINDINGS` rows) now check the
  registry only via a new honest read, `getRegistryBindings` (own
  `class_property` rows, no extends inheritance, no fallback synthesis —
  exposed on `WorkspaceClient`, `WorkerClient`, and the worker RPC), and
  sequences continue after the own rows exactly like the server seed's
  per-class counter; the birthday class-local `eventDate` row is no longer
  masked by the inheritance visible once the event parent is deployed. The
  fallback read itself is untouched — the meetingFamily/birthday present
  gates and the calendar chip eligibility walk deliberately rely on it and
  keep working. The shared binding-row mapping is factored into
  `mapClassBindingRow` (no behavior change for `getClassBindings`).
  **Verification:** new web suite `system-class-deploy-bindings.test.ts`
  (4 tests: the pre-ruling workspace self-heals to registry rows with the
  authored values becoming bound, re-deploy is a no-op; the birthday
  class-local row materializes past inheritance; the event-root fallback
  reliance stays fallback-only after the ensure; deploy composes with the
  birthday ensure); the existing meeting/task/template-family and
  class-create-modal suites unchanged and green; the full gate green
  (2,598 tests, totals above).

- **feat(web): one workspace drag session — the host hoists every surface's
  drag, and the rail cards' headers become append-drop targets.** The
  per-surface drag context is gone: a single workspace host
  (`useWorkspaceDnd.tsx` — the `WorkspaceDndHost` provider + the
  `useWorkspaceDnd` session hook) owns the dnd-kit context, the sensors, the
  drop indicator context, the overlay name chip, and the transient
  move-error banner. In App it wraps the floating-editor host (which wraps
  the regions), so the main content card, the right rail's workspace cards,
  and the floating editor windows — they portal, but stay inside the host's
  React subtree — all join the SAME drag session. Every mounted editing
  surface registers its drag facts with the host as a zone (the measured
  root, the live positions getter, the client — `PageView` registers;
  embedded renders, rail cards, and floating windows render PageView, so
  they join automatically): at drag start the host measures every zone once
  and merges the per-zone valid-location sets (`mergeZoneCandidates` — each
  candidate tagged with its zone), pointer moves project onto the merged set
  (the proximity snap model, the muted source row, and the hierarchy-end
  disambiguation unchanged), and drops resolve against the zone under the
  pointer. Cross-zone drops are always MOVE (re-parent) — never copy/link.
  The machinery loses the DnD half (no sensors/handlers/drop state — it
  keeps the outliner, selection, find/replace, and fold chords); block rows
  are draggable only inside a workspace editing surface (the drag scope
  PageView provides — the context-presence law, now explicit). Card frames
  register their header as a droppable: dropping on a rail card's header
  moves the block as the LAST CHILD of the card's node — one code path with
  a child drop on that node — and the header renders its distinct
  active-drop state while it is the target. A collapsed card under
  drag-hover transiently expands to reveal the drop position and
  re-collapses at drag end (drag-scoped — the session holds the temporary
  set; the card's own collapse state never mutates). The cards also pass
  `globalShortcuts: false` down — the find/replace and fold chords are
  main-surface-only (they were leaking one document listener per card).
  `npx tsc --noEmit` in apps/web clean; full web suite green (the block-dnd
  suite renders inside the host now; the new workspace-dnd suite covers the
  merge helper, the header append, the transient expand, the cross-zone
  move, and the chords gate — its afterEach settles past dnd-kit's 50ms
  post-drop click suppression).

- **fix(web): the LinkEditModal is node-only — URL mode removed; external
  links navigate and are authored directly.** Owner ruling: the modal edits
  NODE links (and typed-link verbs) only. The mode toggle is Page/Block
  (verb still arrives from the typed-link flow, no toggle); the URL field,
  its state, the `external` target kind, and `writeExternalLink` are
  deleted. External links now behave like the plain hyperlinks they render
  as: a read-mode click navigates (PageView's delegated click handler and
  its `linkOpenerRef` are gone — no path opens the link editor for an
  `external_link` token), and the editor's slash "Add URL" command composes
  the `external_link` token directly at the caret through the edit-apply
  splice (a URL-looking query becomes the token; anything else falls back
  to plain prose — markdown `[label](url)` / raw-URL pasting remain the
  label-carrying paths). The node-link context menu's "Edit link…" is now
  structurally node-only too: it renders only when the target token is a
  mention (an external token never offers Edit; Remove/Delete stay). Tests:
  the modal suites open through a mention's Edit link… (the honest seam) and
  assert the Page/Block mode set; a read-mode external-link click asserts
  no modal opens; the slash flow asserts direct token authoring (plus the
  non-URL fallback); the context-menu suite gains the no-Edit-on-external
  case. Verified: `npx tsc --noEmit` in apps/web clean; the full web suite
  green.

- **fix(web): four editor-chrome corrections — external links are plain
  hyperlinks, the remaining mention renderers wire the full title, the
  link-edit modal consolidates to one anchored node picker, and sidebar rows
  track renames live.** Owner ruling: an external link reads as a hyperlink,
  never a pill — the read-mode `external_link` render swaps the
  `nt-external-link` chip class for `nt-hyperlink` (underline + link color
  only; no background/border/radius), and PageView's delegated read-mode
  click handling follows the new class (the link-edit/remove flows are
  unchanged; edit mode still shows the raw markdown). The full-title ruling's
  remaining call sites are wired: `BlockRow` (body rows and the page-title
  projection) and the sidebar favorites/recents row labels now pass
  `resolveFullTitle` next to `resolveName`, so mentions render the complete
  title there too (dense chrome — breadcrumbs — stays capped). The
  LinkEditModal's target section is ONE control now: a kit SelectTrigger
  showing the current selection whose click anchors the NodeSelector
  dropdown (portaled), a pick replacing the selection in place — the old
  pair (a display row plus an always-expanded embedded search) is gone; the
  verb mode's schema picker, the broken-link heal row, and the Esc/backdrop
  dismissal (kit Modal overlay stack + the shared popup-dismissal layer) are
  untouched. The sidebar subscribes to client notifications so a rename
  re-renders favorites/recents rows with the new name (regression test:
  rename a recents node, the row label updates). Verified: `npx tsc
  --noEmit` in apps/web clean; the web suites green (external-link class
  assertions, the modal's one-control picker flow, the live-name
  regression, and the retarget/label/broken-link flows).

- **fix(web): creating a node from the editor's @ picker always lands the
  mention — the create completion splices from a capture snapshot.** The
  picker's create row starts an ASYNC create (the promise-based default
  create, or the class-aware QuickCreateModal), and the created node can
  arrive after the popup already closed (Escape / outside press / blur while
  the create is in flight). `commitNodePick` read the live capture state and
  no-op'd, leaving the bare "@query" text in the block. The editor now keeps
  the last-open capture in a ref (the `/template` flow's `templateStageRef`
  idiom — only non-null captures refresh it, so the snapshot survives the
  close re-render) and completes the mention from the snapshot when the
  capture is gone. Cancellation/abandon is unchanged: the modal's Cancel
  authors nothing and the trigger char stays plain text with focus back on
  the block (the `closeNodePicker` contract); multi-select paths and plain
  picks are untouched. `packages/protocol/SCHEMA.md` and the
  `BlockTextEditor` header doc carry the description. Verified: `npx tsc
  --noEmit` in apps/web clean; the capture suite (18 tests, incl. a gated
  completion-after-dismissal case and the modal cancel case) plus the full
  web suite green.

- **feat(web,server): the web link extends the source class.** Owner ruling:
  a bookmarked page is a cited web source. `SYSTEM_CLASS_EXTENDS` gains
  `weblink: ["source"]` — weblink inherits the source bibliographic bindings
  (unset fields stay hidden; effective binding resolution is own-first, so
  weblink's own `url` binding wins over any inherited one — pinned by a
  two-writer test) and the sources-family feature toggle now archives
  weblinks with the family (weblink left the always-on list; the
  `systemClassAncestors` gating cascade covered by domain + web tests).
  Empty workspaces receive the edge from the server seed (generic
  extends-map emission); live workspaces materialize it idempotently through
  `ensureWeblinkExtendsSource` (the declaration-first meetingFamily
  precedent, delegation to `deploySystemClass` — re-runs are no-ops). The
  GTK/Flutter seed-convergence follow-up (non-blocking, no lockstep) now
  also covers the weblink→source extends constant. `packages/protocol/SCHEMA.md`
  (seed manifest, citations family, feature map) and
  `docs/developers/architecture.md` updated. Verified: the domain suite
  (72 tests) and the web suites (class-create-modal, properties-panel,
  protocol-batch gating) green; `npx tsc --noEmit` in apps/web clean.

- **feat(web): node links and mention chips render the COMPLETE title.**
  Owner ruling: a link must read as the page's whole title, never a
  truncation. `deriveDisplayName` keeps the 80-char cap for dense chrome
  (breadcrumbs, pickers, sidebars); the domain gains `fullTitleOf` — the
  same title-is-content derivation without the slice, date-node formatting
  intact — and `InlineTokens` mention labels (chips and linked mentions)
  prefer a new `resolveFullTitle` prop, falling back to the capped
  `resolveName` (callers not wired yet keep the old form; a token's custom
  `displayText` always wins). `fullTitleFromClient`/`fullTitleForSettings`
  mirror the displayName pair in `dateDisplay.ts`; the direct call sites
  this pass wires are EmbedView, WhiteboardCanvas, and the presentation
  deck. `packages/protocol/SCHEMA.md` (name-derivation bullet) and
  `docs/developers/architecture.md` updated. Verified: new domain tests
  (uncapped/full/date branch) and web tests (>80-char mention renders
  complete; breadcrumbs keep the capped-and-clipped form) green.

- **feat(web): the page title is a bullet-less block row — full editor powers
  in the header; a page's own content may carry link/mention tokens.** Owner
  ruling: the bespoke single-purpose title editor is replaced by the shared
  row machinery — `BlockRow` gains `variant="title"` (bullet-less, chrome-less:
  no grip/drag, collapse, property/backlink/tags chrome, children, or row
  context menu; the content wrapper is `nt-title-content`, never
  `.nt-block-content`, so body-row selectors never match the header row) and
  `BlockTextEditor` gains the matching title contract: plain Enter flushes and
  leaves edit mode (never splits, never creates a body block), Backspace/Delete
  are in-text-only (an empty title never deletes the page), no task cycle on
  Ctrl/Cmd+Enter; every other power (marks, @/#/+ captures, slash commands, the
  link modal, node-link clipboard, atomic pills) is unchanged. Display mode
  renders the content's inline tokens — external links open the link modal,
  mentions open the target — and the header title keeps the page-heading
  landmark. The store's `object.update` content path no longer flattens rich
  tokens for main-presenting nodes (classes stay text-only; create-as-main and
  block→page promotion remain the lossy, warned boundaries), so authored
  link/mention tokens in a title persist; display-name derivation still
  flattens to text — labels, breadcrumbs, and export titles are untouched.
  Day pages keep the static date header, embedded feeds keep the static title
  link, class pages keep the icon button + title row, focus mode unchanged.
  `ui/TitleEditor.tsx` deleted. Docs in the same pass: `SCHEMA.md`
  (title-is-content ruling), `AGENTS.md`, `docs/developers/architecture.md`,
  `docs/ux.md`. Client lockstep note: the GTK/Flutter appliers still flatten on
  the update path — the rich-title relaxation reaches them with the next
  lockstep batch (their fixtures and wire are unaffected). Verified: store
  suite green (401), `npx tsc --noEmit` in apps/web clean, full web suite
  green (120 files / 1204 tests).

- **fix(web): the link-edit modal composes the kit primitives — the crushed,
  overlapping mode-tab row is gone.** The modal shipped its own unscoped
  copies of the kit chrome classes (`.modal-backdrop`, `.modal`, `.btn`,
  `.selection-button` and parts) for its hand-rolled shell, and the kit's
  higher-specificity `.selection-button--sm` sizing (26px icon squares,
  icon-only by design) beat the modal's label-carrying tab buttons once the
  kit stylesheet landed in the bundle — the Page/Block/URL labels piled on
  top of each other at the top of the modal while the form below stacked
  bare. The shell now composes the kit `Modal` (backdrop, header/footer,
  Esc through the overlay stack, focus trap), the mode toggle composes the
  kit `SelectionButton` (icon tabs with tooltips and aria-labels; the field
  label beneath already names the active mode), and every action composes
  the kit `Button`; Enter still saves from anywhere inside, the embedded
  node picker keeps owning its own Enter/Escape, and the broken-link heal
  and verb create-and-bind rows are unchanged. LinkEditModal.css keeps only
  the namespaced field styles — its global copies are deleted, so kit
  buttons and selection controls elsewhere render from the kit stylesheet
  alone. A structural regression test pins the tab row, the field label,
  and the input as distinct, ordered, non-nested elements (not a pixel
  assertion), plus Esc/backdrop dismissal through the kit layer. Verified:
  `npx tsc --noEmit` in apps/web clean; `editor-popups` + `modals-overlays`
  (40 tests) and the link-modal-adjacent suites (`broken-link-create`,
  `verb-create-bind`, `node-link-gestures`, `popup-dismissal`, `pickers`,
  `template-gallery` — 97 tests) green; visual check of URL/Page/verb
  states in a headless browser harness shows a clean tab row over clearly
  separated labelled fields.

- **fix(web): sidebar popups take the shared dismissal layer; Favorites and
  Recents rows render their titles as read-only block content.** The footer's
  account popup (avatar/email + Sign out) ignored every dismissal gesture —
  the reported bug; it now composes `usePopupDismissal` (outside pointer-down +
  Escape, the profile trigger declared as an anchor so pressing it toggles
  instead of dismissing, presses inside the popup never dismiss; the popup
  root owns Escape from its own interior). The workspace switcher's
  hand-rolled outside-click effect is replaced by the same house hook with
  the trigger as anchor. The Favorites/Recents row context menu already
  dismissed correctly through the kit ContextMenu (capture-phase outside
  press + the overlay stack's Escape) — audited, now pinned by tests. Row
  labels drop the bespoke string render and compose the shared read-only
  `InlineTokens` machinery, exactly like a read-only block row: mention chips
  get the link UI (click opens the target through the alias resolution,
  right-click opens the node-link menu), the row keeps its star toggle, class
  flag, active highlight, and keyboard navigation, and the row body becomes a
  `div[role=button]` (the NodePill idiom) so the label's links are real
  buttons; Shift+click peeks the node in the right sidebar, mirroring the
  block bullet's shift idiom. `docs/usage.md` carries the user-facing
  description. Verified: `npx tsc --noEmit` in apps/web clean; the sidebar
  menu + settings-modals suites (46 tests) and the full web suite green
  (119 files / 1190 tests).

- **fix(web): the boot screen never silently re-routes; a Sync tab in User
  Settings; uploads clear the web proxy.** Owner rulings: a failed connect
  now shows the error plus an explicit "Try `<origin>` instead" suggestion —
  nothing probes or connects anywhere without a click (the silent same-host
  fallback is gone from the account AND the API-key flows). User Settings
  gains a Sync tab: the current sync server with reachability, "Disconnect &
  forget this server" (confirmed), and "Connect to a different server". The
  web nginx proxy also honors the sync server's body ceiling (128 MB —
  asset uploads died at nginx's 1 MB default with HTTP 413). Full web suite
  green (118 files / 1200+ tests), deployed via the compose build flow.

- **feat(web): the boot screen never silently re-routes — the same-host guess
  becomes an explicit suggestion; User Settings gains a Sync tab.** Owner
  ruling: a failed probe no longer auto-retries the same-origin guess. The
  error + hint stay, and a "Try \<origin\> instead" button rendered under the
  boot form is the only path to the guess — clicking it sets the field and
  probes explicitly. The probe path is extracted into a shared
  `connectTo(url)` used by the boot form and the new settings Sync tab, which
  shows the configured sync server with its reachability, offers "Connect to
  a different server", and "Disconnect & forget this server" (kit
  ConfirmationModal — it signs the user out and clears the stored server URL,
  session token, and API key). The auto-retry's now-dead boot note is removed.
  Verified: `npx tsc --noEmit` in apps/web clean; `settings-modals` +
  `app-smoke` (45 tests) and the App-rendering suites (136 tests) all green.

- **feat(web): the drag-session interaction model — the muted source row and
  the proximity-snapped drop line.** The outliner's drag feedback stops
  reshaping the page. The dragged row no longer translates with the pointer:
  it stays in place and renders muted (`.nt-block--drag-source` on the row
  root, token-only opacity plus a surface tint — no layout change), and the
  floating DragOverlay keeps only the small name chip as the preview. The
  live hit-testing gives way to a proximity snap model: at drag start the
  machinery measures the visible rows once and builds the valid-location set
  (`dropCandidatesOf` — for every visible row except the dragged subtree, a
  sibling above/below pair anchored at the row's divider at the row depth's
  gutter x, plus a child candidate anchored at the row's center at the
  child-offset x), and each pointer move projects the pointer onto the
  nearest anchor within a 24px y band (`nearestCandidate`, x distance breaks
  ties) — far from every anchor, no indicator renders. The hierarchy-end gap
  below an expanded block's last child disambiguates across three nearby
  candidates by x band: a sibling-after-parent at the parent's depth, a
  sibling-after-last-child at the child's depth, and the child slot at the
  child-offset x. The child intent's indicator bar now renders at that
  child-offset position. The line stays the indicator: `resolveMove` /
  `executeMove` / zone semantics are untouched, the event-driven path still
  resolves keyboard drags and end-of-drop guard refusals (the own-subtree
  banner included). `npx tsc --noEmit` clean; full web suite green (1221
  tests).

- **feat(web): the collection create-button flag, the fullscreen whiteboard
  container, and the graph view's reference chrome — the main-content
  restructure's view-layer recoveries.** (a) The reusable collection
  contract gains the create affordance: `showAddButton` + `onAdd` (+
  `addLabel`) on `NodeCollectionProps`, rendered as a kit button in the
  collection's empty state (the kit EmptyState's action slot) and in the
  view toolbar where one exists — only when the flag AND the callback are
  set AND the surface context allows it. Enabled in exactly two places:
  the Child pages section (renders on the main surface even when empty;
  "Add child page" creates a present-as-main child of the host page and
  opens it — the section's row-click behavior; embedded feeds stay
  read-only and hide a childless section) and the Classed nodes section
  ("Add member" in the toolbar and the empty state creates a node classed
  with the class — visible on an empty database). The `Section` primitive
  gains the opt-in `renderWhenEmpty` for containers owning their empty
  state. (b) A whiteboard page on the main surface renders the spatial
  canvas as the content card's sole content — the page chrome (the
  panelled columns, nodeview top bar, header, footer) steps aside and the
  canvas fills the card edge to edge (`.nt-page--whiteboard`; the card
  frame stays, the canvas's own border/radius/margin go). Embedded feed
  entries and in-block boards keep the bounded in-flow canvas. (c) The
  graph hub renders edge-to-edge in the content card (`.nt-graph-surface`)
  and the graph chrome re-presents to the reference graph UI: the settings
  toolbar composes from the kit (ghost icon tools, the icon-radio mode
  selectors, boolean switches, the kit search field; the edge-family chips
  stay the rendering register), the local neighborhood rides a labeled
  depth slider, and the empty surfaces carry the reference wording —
  "Nothing to graph yet" for the empty workspace, the levels hint for an
  empty neighborhood, the filtered-out state with a Reset filters
  affordance (back to the shipped defaults) on the full surface; an empty
  display renders instead of the stage, so no renderer initializes on a
  graph with nothing to draw. The WebGL renderer, physics engine, minimap,
  local-graph mode, and settings persistence are unchanged. `npx tsc
  --noEmit` clean; full web suite green (1215 tests).

## 2026-10-06

- **chore(ops): the edge's https port defaults to 8443 — :443 is not Notees's.**
  The tailnet URL is `https://<host>.<tailnet>.ts.net:8443` (name-based certs
  work on any port); `NOTEES_EDGE_HTTP` remaps it. Verified on the fleet host.
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

- **chore(web): the restructure branch meets the scrub law — era references
  removed from comments and test titles.** The branch's new files predated
  the tree-wide scrub, carrying plan-era citations, amendment and slice
  labels, and product-generation references into comments and test titles.
  All rewritten to stand alone (46 files, zero logic changes); genuine
  version identifiers (the OFL license, the wire/protocol versions, code
  ids) untouched. Transient internal-doc pointers dropped from the
  changelog and runbooks per the standing rule. Full web suite green
  (1206 tests), tsc clean.

- **refactor(web): S7a of the main-content restructure — the context column,
  the cards-only rail, Comments (M19), Activity's relocation (M18), the
  preview seam (M15).** The panelled main layout is now THREE columns —
  NodeView · properties · context. The context column (`.nt-page-context`)
  hosts, top-down: LocalGraphCard, TocSection, the Activity section, and the
  new Comments section; each panel column keeps its own device-local
  collapse, toggled from the nodeview top bar (now a toggle pair), and the
  `layout` prop stays BINARY — per-column device prefs
  (`pageSidePanelCollapsed` / `pageContextPanelCollapsed`) replace the
  recorded "third state" option (registered choice). **The references dedupe
  check (the S7 precondition):** the rail's ReferencesSection and the page's
  own Backlinks tab both rendered `getLinkedReferences` — the SAME data —
  verdict: the rail's ReferencesSection is DELETED
  (`components/sidebarSections.tsx` keeps TocSection only); the Backlinks tab
  stays the one home in the SectionStack, where the tab/filter machinery
  lands later. One home, no duplication. **M18:** `SystemSections`'s
  `withActivity` prop + branch die; ActivityLogSection renders in the
  context column (its useSectionData lazy contract rides along).
  **M19:** `components/CommentsSection.tsx` — the v1 model restored:
  comments are direct children classed `comment` (the seeded system class);
  NodeViewSection chrome ("Comments" + direct-child count), hidden when
  empty; the v1 quick-add/reply composer pair (a child block classed comment
  + the text as its content — title-is-content); rows open the comment node;
  each row carries Reply/Delete (the v1 pair); children nest in the thread
  (any child blocks, v1's recursion). Lazy per the section contract via
  useSectionData. **M15/M17:** `ui/SidebarNodeCard.tsx` is DELETED — replaced
  by `components/NodeCardFrame.tsx`, the generic `nt-sidebar-card` frame
  (breadcrumbs header + collapse/open-in-main/close; collapse is
  session-local — reorder/dismiss gestures are a registered follow-up)
  rendering NodeView (compact, no corner menu); App's rail hosts the frame
  stack exclusively. `NodeView` gains `preview?: boolean` — no corner menu,
  no global listeners, a read-only body capped at the first level
  (`maxDepth` 1, outline), no section stack; nothing renders it yet —
  swapping NodeHoverPreview's bespoke card for the seam is the registered
  follow-up. Embedded/journal/calendar surfaces, focus mode, and the class
  variant render NO context column (main-surface chrome only). jsdom test
  setup stubs `HTMLCanvasElement.getContext` → null quietly (the context
  column mounts a graph card with every page view; the graph's WebGL-missing
  path already rendered its honest empty state — the stub silences jsdom's
  per-call "Not implemented" scream). Tree-text assertions in seven existing
  suites scope to `.nt-block-tree` / their section (the TOC legitimately
  echoes short one-line blocks — the rail-era design, now in the column).
  Docs: `usage.md` + `ux.md` re-home the context widgets. **Verification:**
  the full apps/web suite green (121 files / 1206 tests — comments-section 6,
  context-column 8 new; the ReferencesSection rail test dies with the
  component per the dedupe verdict); `tsc --noEmit` clean in apps/web; the
  layout-probe selectors (`.nt-node-topbar` and children, `.nt-page-body`,
  `.nt-page-side-panel`, `.nt-nodeview-body`) unchanged.
- **feat(web): text-property rows render as locked outline collections.**
  A text property's values are node-backed carrier blocks; the row's
  bespoke mini-outliner renderer is replaced by the shared dispatcher —
  one `NodeCollection` per row, viewMode pinned to the outline mode (no
  switcher), `tree` + `editable`, each carrier one root item rendered
  through the `BlockRow` machinery. Each root row keeps its own
  per-carrier outliner context (carrier-scoped positions and collapse,
  bullet click opens the node), and the row keeps the standalone
  renderer's client subscription, so editing, navigation, and the
  carrier Enter semantics (multi registers the sibling as the next
  value; single nests a child) are unchanged. The dead-carrier-EMPTY
  cell and the legacy scalar input fallback stay as-is; the panel and
  the compact layouts both consume the row through the properties
  table, so one change covers both. Gates green: the four property/
  metadata/table web suites (48 tests) + `tsc --noEmit` clean for the

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
