# Keying follow-ups — design + plan

2026-11-06 · Status: approved-by-directive ("do the follow ups") — the follow-ups
listed at the close of the mandatory-keying plan.

## F1 — Custody-record cleanup (web, small)

`clearCryptoCustody` / workspace delete/forget leave `notees-custody` →
`workspaceKeys` records behind forever (T9 deferred minor). Add
`deleteOfflineWorkspaceKey(workspaceId)` to `master-key-storage.ts` and call
it from every workspace-removal surface: the WorkspacesView delete/forget
flow, the switcher's forget, sign-out's custody clear (ALL workspace-key
records — sign-out already clears the master key and the cache), and the
offline registry's removal. Pins: delete/forget removes the record (a
re-created workspace mints a fresh key); sign-out empties the store; a
missing record never throws.

## F2 — Offline→online adoption UX (web, medium)

TODAY: an offline-created workspace opened online against a server that
doesn't know it fails loud at the key check (accepted ruling). FOLLOW-UP:
detect the adoption case — online connect, key fetch 404 (server has no row),
local custody holds a device key for this id, local store has content — and
surface an offer instead of a bare refusal: "This workspace exists only on
this device. Publish it to the server?" Confirming POSTs `/workspaces` with
`{ name, wrappedKey }` where the wrap is of the EXISTING custody key
(publish-not-mint, the T9 invariant), then reconnects normally (the outbox
backlog drains sealed). API-key sessions and non-secure contexts get their
established directional copies; declining keeps the offline-only state.
Pins: adoption publishes the existing key's wrap (unwrap-verified), a second
adoption attempt is a no-op (server now answers 200), decline changes
nothing.

## F3 — The keyed client-side content-migration executor (architectural)

The refusal contract (T4) blocks content-class migrations server-side on
keyed workspaces; this is the companion that makes them RUN.

Design: **split each content-class migration into a pure core + a CLI
wrapper.** The core (`scripts/lib/migrations/<name>.ts`) is node-dep-free:
`(store: Store) => plan`, `isPending(store)`, envelope builders via the
protocol's `newEnvelope` — importable by the web client through the vendor
pin. The existing `.mts` wrapper keeps its CLI shape by delegating planning
to the core (the rehearsal suites stay the pins). **Web runner:** a
Migrations surface (settings → the workspace's advanced section) lists the
pending content-class migrations for the open workspace
(`isPending(localStore)`), each with a Run action: plan against the local
UNSEALED store, author envelopes with the client's actor/device, commit
through the normal client write path — the sync engine seals and pushes them
(keyed workspaces), so no new crypto or wire change exists. A dry-run shows
the plan's report (moves/conflicts) before committing. Refusal stays
server-side; the runner is the keyed-side remedy the refusal message names.

Scope: the 14 content-class migrations with store-planning cores (the
scaffolding-class ones never needed this). One migration (meeting-date
retirement) ships end-to-end first as the proving pattern; the rest follow
the same mechanical extraction.

## F4 — The fixture-keying follow-up (ruling: vacuous)

"Key the seeded fixtures at first open" assumed client-side fixtures cross
the keyed predicate — they don't: the predicate is the server's AuthStorage
`workspace_key` row; web test fixtures ride `MemoryTransport` (no HTTP, no
predicate), and the server-side fixtures are minted by direct log ingest
(never through the gated route). There is nothing real to key. The allowlist
stays as the harness future-proofing it was designed as; this follow-up
closes as a documented ruling with a comment tightened in `auth.ts`.

## E — Grace-period escalation (NOT in this wave)

Read-only-until-keyed reverses the user's earlier scope choice (no deadline);
it needs their explicit go. Everything is designed for it (the banner, the
keying action, the config hatch pattern) so it's a small slice when wanted.

## Execution

- Wave 1 (web, one branch): F1 + F2 (independent surfaces, one reviewer
  wave), F4's auth.ts comment rides F1's branch? No — F4 is sync-side; it
  rides as a docs/comment commit in the same sync worktree but lands with
  F3's sync half.
- Wave 2: F3 — sync cores extraction + web runner (one branch each repo,
  landing together).
- Gates per repo law; landings ff-only; the live web redeploys after each
  wave; sync slice 1 of F3 is tooling-only (no server redeploy).
