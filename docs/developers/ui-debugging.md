# UI debugging — screenshot probes & visual diagnosis

How to SEE what the web client actually renders when a test can't tell you —
a color looks wrong, a control is mis-sized, a PDF layout reads badly. Two
toolchains, both already in the repo; this page is the map.

## Two paths

**The capture suite — `scripts/screenshots/run.sh`.** Boots THROWAWAY
notees-sync + notees-web containers (127.0.0.1:8477/8480 — never the live
stack), seeds a synthetic workspace through the object API, and captures the
standard screens in both color schemes into `docs/img/screenshots/<scheme>/`.
Use it for committed documentation artwork and baseline captures. It runs
against pinned `:2.0.0-m1` images by default; point `NOTEES_SYNC_IMAGE` /
`NOTEES_WEB_IMAGE` at locally-built tags to capture unreleased UI.

**Live probes — `scripts/screenshots/*-probe.mjs`.** Small playwright
scripts against the LOCAL production stack (`notees-sync` :8377,
`notees-web` :8378) — the real workspace, the real data, the current build.
Use them to reproduce a visual bug exactly as the owner sees it. Only
`probe-template.mjs` and `measure-probe.mjs` are durable; the rest are
throwaway diagnostics (copy the template, edit, run, delete).
`verify-min.mjs` is the post-deploy smoke, not a probe.

**Live measurement — `measure-probe.mjs`.** The durable answer to "the
padding/spacing looks wrong": it signs in (see Auth below), opens the test
workspace's day page, and dumps every chrome surface's bounding rect +
computed padding/margin/gap as JSON, with the recurring derived gaps
(top-bar→card, card→node-topbar, node-topbar→body, card→panel insets,
sidebar-footer→viewport) precomputed under `__gaps`. A screenshot lands at
`/tmp/measure-probe.jpg` (override `NOTEES_SHOT_PATH`). Extra selectors are
measured on demand:

```sh
cd scripts/screenshots
node measure-probe.mjs .nt-some-popup .nt-other-element
```

Ground the BEFORE numbers against the live stack first, then rebuild +
redeploy the web image and run it again for the AFTER — the JSON diff is the
verification (this is how the 2026-10-13 top-bar/sidebar padding slice was
measured and confirmed).

## The probe recipe

1. `cp scripts/screenshots/probe-template.mjs scripts/screenshots/__my-probe.mjs`
2. Edit the STEPS section. Usually: wait for `.nt-app`, settle, interact,
   screenshot to `/tmp`, dump computed styles.
3. Run it **from `scripts/screenshots/`** — playwright is a dependency of
   that folder only (`cd scripts/screenshots && node __my-probe.mjs`).
4. Read the screenshot (`/tmp/*.jpg`) and the dumped styles; iterate.
5. Delete the probe when done.

### Auth

The bootstrap localStorage pre-seed (`notees.serverUrl` — the `STORAGE_KEYS`
idiom from `capture.mjs`) only PRE-FILLS the connect form in the current
build; the template then drives the login flow (server URL → Continue →
email/password → "Your workspaces" picker → workspace card; the picker
heading is "Your workspaces", not "Choose a workspace"). The operator API
key (`config/notees/sync/api_key.txt`) is for object-API calls a probe may
need (fixtures, lookups), not for the UI login — account endpoints
(`listWorkspaces`, `fetchMe`, login) answer it **401**, so a localStorage
seed with it lands back on the connect screen. To skip the login flow
entirely, seed a session: `notees.sessionToken` with a valid `nt_` token +
`notees.workspaceId` with the test-workspace uuid auto-connects straight
into the app (the `layout-probe.mjs` idiom).

Where does a valid token come from in an unattended session?
`measure-probe.mjs` automates both paths (copy its `sessionFromLogin` /
`sessionFromDbMint` helpers):

1. `NOTEES_ADMIN_PASSWORD` (+ `NOTEES_ADMIN_EMAIL`) → the login API mints
   a real session (the `boot-probe.mjs` idiom).
2. Fallback: mint a temporary session row directly into the relay DB
   (`config/notees/sync/relay.db`): a random `nt_` token, only its sha256
   inserted into `session` for the oldest user row, deleted in a `finally`
   at exit. One row, scoped, 24h self-expiry even if a run dies. Resolve
   `better-sqlite3` from `packages/store` (createRequire anchored at
   `packages/store/package.json`) — it is not a dependency of
   `scripts/screenshots` and does not resolve from there. `NOTEES_RELAY_DB`
   overrides the DB path.

The gitignored ad-hoc probes carry the owner's credentials; never commit
credentials into anything durable.

### Rules

- **Read-only against the live workspace.** If a probe needs a fixture,
  create a clearly-named scratch node through the object API and trash it in
  a `finally` (`pill-select-probe.mjs` is the reference pattern).
- Hard timeouts on every wait; log console/page errors; exit non-zero on
  failure. Probes run unattended in agent sessions.
- Never point a probe at anything but the local stack. Credentials and
  workspace ids are read from the gitignored data dir, never hardcoded into
  anything committed.

## Throwaway-stack probes — custom fixtures + the running build

The capture suite's `run.sh` pins `:2.0.0-m1` images and wipes its runtime
dir. For "does the RUNNING build render X" — layout questions, seeded
fixtures you would never put in a live workspace, reproducing an owner
screenshot — boot the same throwaway pair against the **locally-built
images** and drive it with your own probe:

```sh
cd scripts/screenshots
docker network create notees-screenshots-net
# The web image's nginx hardcodes the sync upstream name "notees-sync" —
# the alias on the shared network is required.
docker run -d --name t-sync --rm --network notees-screenshots-net \
  --network-alias notees-sync -p 127.0.0.1:8477:8377 \
  -v "$PWD/.runtime-probe/data:/data" \
  -e NOTEES_CORS_ORIGIN=http://127.0.0.1:8480 \
  -e NOTEES_SIGNUP_ENABLED=true \
  ghcr.io/miquelrosell99/notees-sync          # the LOCAL build (compose-built)
docker run -d --name t-web --rm --network notees-screenshots-net \
  -p 127.0.0.1:8480:80 -e NOTEES_SERVER_URL=http://127.0.0.1:8477 \
  ghcr.io/miquelrosell99/notees-web           # the LOCAL build
# ... seed, probe with playwright, then docker rm -f both + network rm.
```

(Auth on a throwaway stack, and why the shims matter, below.) Seed fixtures
through the object API with the operator key (`api_key.txt` appears under
the bound data dir after boot) — writes are workspace-scoped by the
**`x-workspace-id` header** (absent → the server's default workspace).

**Throwaway auth differs from live auth** — there is no admin password and
NO user rows until someone signs up, so neither `sessionFromLogin` nor the
DB mint can run. Instead:

1. Boot the sync container with `NOTEES_SIGNUP_ENABLED=true`.
2. `POST /api/auth/signup` {email, password} then `POST /api/auth/login` →
   a real `nt_` session token. (The operator key still 401s account
   endpoints — the trap documented under Auth applies here too.)
3. **Claim the workspace with a write**: session READS require membership,
   and only the first session-authed WRITE auto-adopts an unclaimed
   workspace (`authorizeWorkspace`, `apps/server/src/routes-relay.ts` —
   reads 403 "not a member", writes claim). One trivial
   `POST /api/objects` with `Authorization: Bearer <token>` +
   `x-workspace-id` makes the user the owner; the UI session then reads
   everything.
4. The web app boots into the fixed test workspace
   (`c491595f-9f94-5ade-a620-e30ed063d8d2`) by default — seed there and
   seed `notees.workspaceId` with it.

**Shims are required** (the `capture.mjs` idiom — add as init scripts):
bind `window.fetch` (`Object.defineProperty(window, "fetch", …)` — the
sync transport captured it unbound) and neutralize
`StorageManager.prototype.getDirectory` (forces the in-process store, which
works against a server in headless playwright).

**Delete the probe when done** — ad-hoc probes are throwaway
(`pill-select-probe.mjs` is the durable reference for live-stack fixture
discipline; the same read-only/finally-trash rules apply to anything pointed
at a workspace with data in it, and the throwaway pair has none).

## Gotchas already paid for

- **Live measurement**: `node measure-probe.mjs` from `scripts/screenshots/`
  dumps chrome rects/paddings/gaps as JSON (see "Live measurement" above).
  The two auth paths (login-API vs temporary relay-DB session mint) and the
  401-on-operator-key trap are documented under Auth.
- **Theme**: seed `localStorage "notees.theme" = "dark" | "light"` in an
  init script before `goto` (the template does it). Otherwise the probe sees
  whatever the default is, not the theme the bug was reported in.
- **Settle waits**: after workspace open, wait ~10–12s for snapshot restore
  and sync settle before interacting; the UI lags behind the page load.
- **Kit components can be wrong, not your usage.** The export modal's
  page-size dropdown looked "blue" because the kit `SelectTrigger` is a bare
  `<button>` with no background reset — the fill was the BROWSER default
  button color (grey in headless, blue-tinted on the owner's platform). The
  computed-style dump in the template is how this class of bug is pinned;
  fix the kit, not the call site.
- **Dropdown widths**: the kit `.dropdown-container` is `width: 100%` and
  `.dropdown` is `flex: 1` — a Dropdown fills its parent by default.
  Constrain the CONTAINER at the call site (a `width: max-content` on
  `.dropdown` alone loses to `flex: 1`).
- **react-pdf in vitest/jsdom**: the real `pdf().toBlob()` render works and
  is the harness behind `export-pdf-real-render.test.tsx`; but `node:fs`
  writes are shimmed out ("not available in the browser"), streams must be
  inflated in memory (`node:zlib` + byte offsets — find `stream\n`, strip
  trailing `\r\n` before `endstream`), and array `style` props don't
  serialize onto custom elements in the react-dom tree (pre-compose styles
  in `StyleSheet.create`). For PDF byte-level assertions prefer package-side
  serializers over content-stream spelunking.
- **Reading an exported PDF back**: `pdftotext` if available, else inflate
  the streams as above; text in subsetted fonts may be hex-encoded per-run.
