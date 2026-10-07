# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-07

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
