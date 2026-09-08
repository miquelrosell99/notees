# Plan — Sync Hardening v1.1

Agreed 2026-09-08 after a full sync assessment (backend relay, frontend engine, protocol spec, history).

## Verdict

Do **not** rewrite the sync architecture. The foundation (immutable op log, server-assigned `seq` cursors, HLC as causality metadata, snapshots + compaction, idempotent batched push) is the same family as Linear/Replicache/PowerSync and is viable. The risks are concentrated in security, realtime delivery, client durability, and a few correctness edges. Do **not** migrate to PowerSync/ElectricSQL/Automerge — that trades away local-first properties to solve problems targeted fixes address.

## Hard invariants (adopt these as acceptance criteria)

1. **Identity**: every relay operation derives actor identity from authenticated credentials, never from caller-supplied headers. Share-token authorization is fully separate from workspace authorization.
2. **Replay equivalence**: applying the same valid op set in any permitted arrival order, followed by replay, must produce the same derived state. Protected by a regression fixture built from the known 121k-op production log failure (`skills/notees/references/gotchas.md:109-111`).
3. **WS is an acceleration path, not a second consistency model**: a dropped socket is indistinguishable from a delayed socket; the seq cursor remains the only authoritative recovery mechanism. Order: subscribe → capture latest seq → hello → stream ops *with seq* → reconnect from last applied seq.
4. **Single writer**: one SyncEngine / one SQLite writer per workspace origin (SharedWorker or Web-Locks-elected tab; other tabs proxy over BroadcastChannel).
5. **Honest encryption posture**: exactly one of (A) documented plaintext relay (TLS/Tailscale trust boundary) or (B) real client-side E2EE. The current third state — plaintext code, "encrypted relay" docs, vestigial key infrastructure — is not acceptable.

## Program

| Priority | Work | Key locations |
|---|---|---|
| ~~P0~~ ✅ | Remove `X-Actor-Id` fallback; require authenticated principal on every relay HTTP endpoint | done 2026-09-08 |
| ~~P0~~ ✅ | Deny-by-default anonymous snapshot via share token (removed entirely; members only) | done 2026-09-08 |
| ~~P0~~ ✅ | Quarantine/remove unused key-management surface (modules + `crypto.py` + tests deleted) | done 2026-09-08 |
| ~~P0~~ ✅ | Atomic snapshot creation with `up_to_seq` (`LOCK TABLE … SHARE ROW EXCLUSIVE` in one tx) | done 2026-09-08 |
| ~~P0~~ ✅ | Fix rate limiting: per-envelope batch charging; snapshot 60/min, stats 120/min, admin 30/min, WS 60/min | done 2026-09-08 |
| ~~P0~~ ✅ | Docs honesty: plaintext relay documented in SPEC/project-rules/architecture/backend.md; E2EE = Track C | done 2026-09-08 |
| P0/P1 | ~~Replay/order correctness: HLC guards on non-LWW appliers (`derived/node.ts:54-154`); 121k-op regression fixture; invariant #2 test~~ ✅ done 2026-09-08 (`1dfbcc33`): per-field `node_field_lww` guards (schema v18), per-element class membership LWW, convergent convert; replay-equivalence test in `nodeLww.test.ts` (the 121k production log itself is not in this environment — the invariant test protects the failure mode generically) | `frontend/src/core/derived/` |
| P1 | ~~Realtime backend: broadcast after commit in `receive_batch`; `seq` in WS `ops` frames; subscribe-before-hello~~ ✅ `fe93dd19`. ~~Track A client: web client connects with catch-up resume~~ ✅ `33d48691` (`core/relayWs.ts` + `SyncEngine.startRealtime`, frames buffered during pulls). **Remaining:** unify/retire the legacy collab layer (presence still rides the old `/api/ws/live` channel by design) | `app/relay/`, `frontend/src/core/relayWs.ts` |
| P1 | ~~Honest sync status: populate `pendingCount`/`failedCount`/`offline`; quarantined-op surfacing and recovery UX~~ ✅ done 2026-09-08 (`3a667469`): counts wired, indicator mounted in TopBar, quarantine off-by-one fixed (ops can actually quarantine now), Retry action | `syncStatusStore.ts`, `SyncStatusIndicator.tsx`, `sync.ts` |
| P1 | ~~Persistence flush on `pagehide`/`beforeunload` (mitigation until Track B)~~ ✅ done 2026-09-08 (`2cfe9101`): `flushPendingPersist` + one-shot ASAP flush + adapter listeners | `WorkspaceStoreClient.ts`, `workspaceStoreClientAdapter.ts` |
| P1 | ~~Server-restore recovery branch: park local un-synced ops instead of discarding~~ ✅ done 2026-09-08 (`d7fa1cc1`): `recovery_operation` table (schema v19), park-before-wipe at both wipe sites, `recoverParkedChanges` + UI recovery action | `frontend/src/core/sync.ts`, `store.ts` |
| Track B | ~~Single-writer client (Web Locks leader election + BroadcastChannel proxy)~~ ✅ `242da591` (leader runs the only worker/SyncEngine/realtime; followers proxy; takeover by reload). **Deferred:** wa-sqlite + OPFS incremental persistence replacing whole-DB `db.export()` dumps — needs dependency sign-off | `frontend/src/core/worker/tabLeadership.ts`, `tabRpc.ts` |
| P2 | ~~Batch permission checks~~ ✅ `57f04574` (one workspace-scoped check per batch). ~~Snapshot retention~~ ✅ `2d7915af` (keep newest 5, compaction-exempt). ~~Stream-apply catch-up~~ ✅ `67ef46aa` (per-page apply + cursor advance). **Deferred:** snapshot binary streaming (wire-contract change — needs client+SPEC coordinated change), Yjs delta payloads (payload-format change — pair with Track D) | `app/relay/service.py`, `storage.py`, `frontend/src/core/sync.ts` |
| Track C | E2EE: client-side payload/snapshot encryption, per-workspace AES-GCM key wrapped per member (X25519), passphrase recovery, rotation on member removal. Envelope-layer change; appliers untouched | `protocol/SPEC.md` §8, `frontend/src/core/crypto.ts` |
| Track D | Convergence-safe structure appliers (extend Yjs/CRDT semantics to child order etc.) — only when realtime multiplayer editing is a product goal | `frontend/src/core/derived/` |

## Sequencing

1. P0 security boundary + docs honesty (first milestone: defensible v1.1).
2. P0/P1 replay correctness + regression fixture.
3. P1 realtime + status honesty + recovery branch.
4. Track B client durability/multi-tab (major client-side investment).
5. P2 scale work as needed.
6. Track C when privacy positioning demands it; Track D opportunistically.

## End-state layers (agreed 2026-09-08 — "best implementation for this app")

The spine (op log + server seq + snapshots) and transport (WS acceleration, cursor recovery) are done. The remaining end-state work, in execution order:

| Layer | Work | Status |
|---|---|---|
| 3a — Merge semantics (collections) | Class membership OR-Set (`class_member_set`, schema v20, add-wins at equal HLC); derived-state v5 | ✅ `318209c8` |
| 3b — Merge semantics (structure) | Legacy positional child-order backfill (`node.create.index`/`node.move.newIndex`); replay structure-safe (closes 121k-op gotcha); derived-state v5 | ✅ `318209c8` |
| 4 — E2EE (Track C) | Client-side AES-GCM encryption of envelope payloads + snapshot blobs; per-workspace key wrapped with passphrase-derived KEK, blob stored server-side (`GET/PUT /api/relay/encryption-key`); encrypted envelopes carry protocolVersion 2; server skips payload validation for `$e`; SPEC §8 rewritten. **v1 limits documented:** passphrase = sharing mechanism (no per-member X25519 yet), rotation re-wraps only | ✅ `7feed0fd` |
| 2 — OPFS durability | wa-sqlite + OPFS, **single engine (no flag, no fallback pipeline)** ✅ `e438a79a`: worker always opens OPFS (memory VFS in tests), existing workspaces auto-convert via initialBytes seed + `verifyMigratedDatabase`; legacy export→IndexedDB pipeline deleted (persist worker, coalescing, pagehide flush, settings toggle) | ✅ done |

Execution order: 3a → 3b → 4 → 2 (no-dependency items first; OPFS last because it touches the layer everything sits on).

## Explicitly out of scope

- Replacing the op-log protocol or storage model.
- PowerSync / ElectricSQL / Automerge wholesale adoption.
- Flutter companion app changes (separate repo).
