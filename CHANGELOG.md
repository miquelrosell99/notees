# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-07

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
