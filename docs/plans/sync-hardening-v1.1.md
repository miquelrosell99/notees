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
| P0/P1 | Replay/order correctness: HLC guards on non-LWW appliers (`derived/node.ts:54-154`); 121k-op regression fixture; invariant #2 test | `frontend/src/core/derived/` |
| P1 | Realtime: broadcast after commit in `receive_batch`; `seq` in WS `ops` frames; subscribe-before-hello; web client connects with catch-up resume; WS strictly an acceleration path | `app/relay/service.py:101-105`, `websocket.py:61-101`, `models.py:108` |
| P1 | Honest sync status: populate `pendingCount`/`failedCount`/`offline`; quarantined-op surfacing and recovery UX | `syncStatusStore.ts:55-56`, `store.ts:537-554` |
| P1 | Persistence flush on `pagehide`/`beforeunload` (mitigation until Track B) | `workspaceWorker.ts:151-156`, `main.tsx:55-67` |
| P1 | Server-restore recovery branch: park local un-synced ops instead of discarding (currently `console.warn` only) | `frontend/src/core/sync.ts:540-545` |
| Track B | Single-writer client (SharedWorker / Web Locks + BroadcastChannel) and wa-sqlite + OPFS incremental persistence, replacing whole-DB `db.export()` dumps | `frontend/src/core/persistence/`, `workspaceStoreClientAdapter.ts` |
| P2 | Batch permission checks (kill ~2 queries/envelope N+1); snapshot streaming (no base64-in-JSON); snapshot retention policy; stream-apply catch-up pages; Yjs delta updates instead of full-state payloads | `app/relay/service.py:90-99`, `router.py:331-333`, `frontend/src/core/sync.ts:355-392` |
| Track C | E2EE: client-side payload/snapshot encryption, per-workspace AES-GCM key wrapped per member (X25519), passphrase recovery, rotation on member removal. Envelope-layer change; appliers untouched | `protocol/SPEC.md` §8, `frontend/src/core/crypto.ts` |
| Track D | Convergence-safe structure appliers (extend Yjs/CRDT semantics to child order etc.) — only when realtime multiplayer editing is a product goal | `frontend/src/core/derived/` |

## Sequencing

1. P0 security boundary + docs honesty (first milestone: defensible v1.1).
2. P0/P1 replay correctness + regression fixture.
3. P1 realtime + status honesty + recovery branch.
4. Track B client durability/multi-tab (major client-side investment).
5. P2 scale work as needed.
6. Track C when privacy positioning demands it; Track D opportunistically.

## Explicitly out of scope

- Replacing the op-log protocol or storage model.
- PowerSync / ElectricSQL / Automerge wholesale adoption.
- Flutter companion app changes (separate repo).
