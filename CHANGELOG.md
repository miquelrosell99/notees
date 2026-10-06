# Changelog

The record of shipped work for Notees. One entry per shipped slice, newest
first. This file — not `AGENTS.md`, not the runbooks — is where history goes;
those stay static guidance. Before implementing a change, skim this file for
recent related work. Anything before 2026-10-06 lives in git history: the
retired implementation plan and design stack are recoverable from commits
predating this file.

## 2026-10-06

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
- **refactor(web): S3a of the main-content restructure — the page machinery
  moves behind `usePageMachinery`.** Outliner construction, the selection
  surface, find/replace (state, shortcut listener, prose docs), the
  external-link delegation + LinkEditModal opener, the DnD wiring, and the
  fold chords — everything PageView wired by hand — moves to
  `ui/usePageMachinery.ts` and returns one bag the component consumes; the
  JSX that hosts it stays. New `globalShortcuts` option (default true;
  embedded implies false) prefigures the workspace-card surfaces. Pure move:
  typecheck clean, 102 machinery-adjacent tests green. The drag half hoists
  to the workspace host in S6. Design:
  `.plans/2026-10-06-1352-main-content-restructure/`.
- **refactor(web): S1 of the main-content restructure — the NodeView shell
  extraction.** `ui/NodeView.tsx` (the mode dispatcher + chrome-right
  cluster builder + the new `embedded` surface prop) and
  `ui/SidebarNodeCard.tsx` extracted from App.tsx; App re-exports NodeView
  for the view-routing tests. FloatingEditor windows now render the shared
  NodeView (`embedded`) instead of their own copy of the render cascade —
  the dispatch existed twice (App + FloatingEditor) since the v1 port; one
  copy remains. Pure move, no behavior change: typecheck clean, full web
  suite green (1175 tests). Design + the registered deviation
  (SidebarNodeCard deletion rides S7):
  `.plans/2026-10-06-1352-main-content-restructure/`.
