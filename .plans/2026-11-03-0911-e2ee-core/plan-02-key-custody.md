# E2EE core — Plan 02: key custody + client-side seeding + enable

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Turn the plan-01 `EnvelopeCrypto` boundary ON for real workspaces: wrapped workspace keys with server storage, master-key custody in the web client, client-side system seeding, encrypted-by-default from first open.

**Architecture:** Server gains a `workspace_key` table + GET/PUT routes (wrapped key opaque to the server). The web client unwraps the account master key at login (the `kdf` record already rides in auth responses), ensures a wrapped workspace key exists at workspace open (fetch, or generate+wrap+store), passes the raw workspace key into the worker, and wires `keyCryptoProvider` into the SyncEngine. System-class seeding moves from server-only to a shared `@notees/domain` builder both sides stamp with their own factory; the server keeps seeding **keyless** workspaces only (the shim that keeps GTK/Flutter/CLI working — it never writes plaintext seeds into an encrypted workspace). Keyless/offline workspaces stay plaintext (passthrough) until the history-migration plan.

**Tech Stack:** TS everywhere; WebCrypto; existing server route/storage patterns.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` (§3 seeding move, §1 custody).

## Global Constraints

- Server never sees the master key or any unwrapped workspace key — it stores one opaque wrapped-key string per workspace.
- Mixed logs are legal (plan-01 `decryptEnvelope` passthrough): encrypted ops + legacy plaintext ops coexist until the migration plan rewrites history.
- The server seeds a workspace ONLY when it has no `workspace_key` row (compatibility shim; sibling clients rely on server seeding today).
- Offline workspaces (no server) get no keys and stay plaintext — documented.
- `pnpm test` green after every task; dev-condition rebuilds (`@notees/domain`, `@notees/protocol`, `@notees/sync`) before typechecking dependents.
- New server routes must appear in the OpenAPI inventory (app.ts `onRoute` + the inventory test) — docs are part of the change.
- Per-file staging; Conventional Commits; CHANGELOG entry in Task 9.
- Other sessions work in this repo — touch only your files.

## Review Focus

1. **Route authorization**: workspace-key GET/PUT must require an authenticated user WITH workspace membership (owner or member), never the operator-key bypass pattern for reads by strangers; keyless reads return 404 (not 403) to avoid leaking key existence.
2. **Wrong-password surface**: `unwrapMasterKey` throwing at the verifier must surface as a login error, not a silent custody skip.
3. **Seeding race**: two devices opening an empty keyed workspace concurrently must converge (seed ops idempotent by node id; `applied_envelope` dedupe by envelope id).
4. **Worker key lifetime**: raw workspace keys live only in the worker + main-thread memory; never localStorage; cleared on logout/workspace switch.
5. **Server seed shim**: a keyed workspace must NEVER receive server plaintext seeds — the gate is the `workspace_key` row, checked before `isEmpty`.

---

### Task 1: Server — `workspace_key` table + storage

**Files:**
- Modify: `apps/server/src/auth.ts` (DDL near `node_view` at `:250-261`; `AuthStorage` methods)

- [ ] Write failing test first in `apps/server/test/workspace-key.test.ts` (new): open AuthStorage on a temp relay.db, `putWorkspaceKey/getWorkspaceKey` round-trip; `getWorkspaceKey` returns undefined for unknown workspace; overwrite updates.
- [ ] Implement: DDL `CREATE TABLE IF NOT EXISTS workspace_key (workspace_id TEXT PRIMARY KEY, wrapped_key TEXT NOT NULL, updated_at INTEGER NOT NULL)` in the DDL string; storage methods `putWorkspaceKey(workspaceId, wrappedKey)` / `getWorkspaceKey(workspaceId): string | undefined` following the `user_prefs` pattern (`auth.ts:828-895`).
- [ ] `pnpm --filter @notees/server test` green; commit `feat(server): workspace_key storage`.

### Task 2: Server — GET/PUT workspace-key routes

**Files:**
- Modify: `apps/server/src/routes-auth.ts` (register near workspace routes `:566-625`), `apps/server/src/app.ts` if registration needs it
- Test: `apps/server/test/workspace-key-routes.test.ts` (new; follow existing route-test patterns)

**Interfaces:**
- Produces: `GET /api/workspaces/:id/key` → `{ wrappedKey: string }` (404 when no row OR not a member — same shape, see Review Focus 1); `PUT /api/workspaces/:id/key` body `{ wrappedKey: string }` → 204 (member-required; validate body with zod, max length 4096).

- [ ] RED: route tests — member GET after PUT round-trips; non-member GET 404; non-member PUT 403; unauthenticated 401; operator API key principal gets 403 on both (keys are user-custody, not operator).
- [ ] Implement following `requireAccount` + explicit `ctx.auth.membership(id, userId)` check (owner-only precedent `routes-auth.ts:590-595`); wrap key row creation in the same transaction pattern as workspace creation.
- [ ] Confirm the OpenAPI inventory test passes (route documented via the same manifest mechanism neighboring routes use — check how `PATCH /workspaces/:id` is declared and mirror it).
- [ ] Green; commit `feat(server): workspace-key routes (member-scoped, opaque wrapped keys)`.

### Task 3: Server — seed shim: only keyless workspaces get server seeds

**Files:**
- Modify: `apps/server/src/context.ts` (`ensureSeeded` `:209-236`)
- Test: `apps/server/test/seed-gate.test.ts` (new) or extend existing seed tests

- [ ] RED: a workspace WITH a `workspace_key` row stays empty after `ensureSeeded`; a keyless workspace seeds as today.
- [ ] Implement: at the top of `ensureSeeded`, `if (ctx.auth.getWorkspaceKey(workspaceId)) return;` — keyed workspaces are client-seeded only.
- [ ] Green; commit `feat(server): seed only keyless workspaces (encrypted workspaces are client-seeded)`.

### Task 4: Domain — shared system-seed envelope builder

**Files:**
- Create: `packages/domain/src/system-seed-envelopes.ts`
- Modify: `packages/domain/src/index.ts` (export), `apps/server/src/seed.ts` (refactor to consume it)

**Interfaces:**
- Produces:
```ts
export interface SeedStamp {
  (opType: string, payload: Record<string, unknown>, affectedNodeIds?: string[]): Envelope;
}
export function buildSystemSeedEnvelopes(stamp: SeedStamp): Envelope[];
```
- Consumes: all seed constants from `./seeds.js` (the exact list `apps/server/src/seed.ts:9-27` imports today).

- [ ] RED: parity test (server test or domain test): `buildSystemSeedEnvelopes` with a fixed stamp produces the SAME op sequence + payloads as today's `buildSeedEnvelopes` output minus envelope metadata (assert opTypes sequence and per-op payload deep-equality against a captured fixture of the current builder's output for a fixed workspaceId).
- [ ] Implement: move the envelope-construction loop bodies from `seed.ts:32-234` into the domain function, parameterized only by `stamp` (which supplies workspaceId/actor/device/hlc/client). `seed.ts` keeps its memoization/`ensureSeeded` shell and passes a factory-backed stamp (`client: "seed"`, `deviceId: "notees-server"`).
- [ ] `pnpm --filter @notees/domain build && pnpm --filter @notees/server test` green; commit `refactor(domain): shared system-seed envelope builder (server + client stamp their own)`.

### Task 5: Web — custody core module

**Files:**
- Create: `apps/web/src/core/crypto-custody.ts`
- Test: `apps/web/test/crypto-custody.test.ts` (new)

**Interfaces:**
- Produces:
```ts
export interface MasterKeyHandle { /* opaque; wraps CryptoKey */ }
export function deriveMasterKey(password: string, kdf: KdfRecordLike): Promise<MasterKeyHandle>; // throws on wrong password (verifier)
export function ensureWorkspaceKey(
  serverUrl: string, token: string, workspaceId: string, master: MasterKeyHandle,
): Promise<Uint8Array>; // raw 32-byte workspace key; fetch+unwrap, or generate+wrap+PUT
```
- Consumes: `unwrapMasterKey`, `generateWorkspaceKey`, `wrapWorkspaceKey`, `unwrapWorkspaceKey`, `exportWorkspaceKey` from `@notees/protocol`; the `request` helper pattern from `apps/web/src/core/auth-api.ts:66-94` (reuse `authApiRequest` or add two functions in auth-api.ts: `fetchWorkspaceKey`, `storeWorkspaceKey`).

- [ ] RED: with mocked fetch — GET 404 → generates key, PUTs wrapped (assert the PUT body is openable by `unwrapWorkspaceKey(master, wrapped)` in-test), returns raw; GET 200 → returns unwrapped raw equal to the wrapped one; PUT failure (403) throws with a clear error; wrong master key on GET 200 (unwrap throws OperationError) → throws "wrong master key for this workspace".
- [ ] Implement: module with an in-memory `Map<workspaceId, CryptoKey>` cache; master key held in a module-level single slot (one account per session).
- [ ] `pnpm --filter @notees/web test` green (rebuild protocol dist first); commit `feat(web): crypto custody — master-key derivation + workspace-key ensure`.

### Task 6: Web — login captures kdf; wrong password surfaces

**Files:**
- Modify: `apps/web/src/ui/app/useAuthFlow.ts` (`handleLogin:116`, `handleSetup:97`, `handleSignup:127` — all currently drop `response.kdf` at `:105-110,:120-121,:135-136`)
- Test: extend `apps/web/test/` auth-flow tests if they exist (check); otherwise a focused test on the custody wiring function.

- [ ] RED: a login whose `unwrapMasterKey` rejects surfaces the error on the form (not a silent proceed).
- [ ] Implement: at each auth submit, after session write: `await deriveMasterKey(password, response.kdf)`; store the handle in the custody module; on throw, surface message and abort entry. Logout/workspace-switch clears the handle + workspace key cache.
- [ ] Green; commit `feat(web): derive master key at login (wrong password fails loud)`.

### Task 7: Web — workspace key into the worker; SyncEngine crypto wiring

**Files:**
- Modify: `apps/web/src/ui/app/store-connection.ts` (`:48-110` — obtains key via `ensureWorkspaceKey` before connect; skips when offline), `apps/web/src/core/worker-client.ts` (`WorkerInitMessage` `:248-268`), `apps/web/src/worker/worker-core.ts` (`WorkerInitMessage` type `:85-98`, `handleMessage` dispatch `:1057`), `apps/web/src/core/workspace-client/types.ts` (`WorkspaceClientOptions:816+` add `workspaceKey?: Uint8Array`), `apps/web/src/core/workspace-client/client-sync.ts` (`bootstrapWorkspace:36` — pass `crypto: keyCryptoProvider(importedKey)` when a key is present), `apps/web/src/core/workspace-client/client-context.ts` (hold the imported CryptoKey)

- [ ] RED: a bootstrap with a workspace key constructs an engine whose push seals envelopes (assert via the sync-level pattern: after bootstrap with a mocked transport, outbox→wire envelopes are `$e`; without a key, plaintext). Place in `apps/web/test/` following existing worker/workspace-client test patterns.
- [ ] Implement: thread the raw key bytes main→worker through the init message (Uint8Array structured-clones fine); in the worker import via `importWorkspaceKey` and pass `keyCryptoProvider(key)` into the SyncEngine options at `client-sync.ts:36`; no key (offline/keyless) → no crypto (today's behavior).
- [ ] Green; commit `feat(web): wire workspace keys into the worker sync engine`.

### Task 8: Web — client-side seeding of empty keyed workspaces

**Files:**
- Modify: `apps/web/src/core/workspace-client/client-sync.ts` (after `engine.sync()` in `bootstrapWorkspace`, before final notify) or a new `client-seed.ts` next to it
- Test: `apps/web/test/client-seed.test.ts` (new)

- [ ] RED: bootstrapping an EMPTY store with a workspace key applies the system seeds (class count > 0, inbox page exists by `SYSTEM_PAGE_UUIDS.inbox`) and pushes them as `$e` envelopes; a NON-empty store is untouched; a keyless empty store is NOT seeded by the client (server shim's job).
- [ ] Implement: after bootstrap, `if (crypto && store is empty)` → `buildSystemSeedEnvelopes(stamp)` with stamp = client context's `buildEnvelope` + `client: "seed"` claim, apply each via `engine.enqueue` (local-first; push drains normally).
- [ ] Green; commit `feat(web): client-side system seeding for empty encrypted workspaces`.

### Task 9: Docs + changelog

- [ ] CHANGELOG entry (counts real): server workspace-key routes + seed shim, domain shared seed builder, web custody + worker wiring + client seeding. Note explicitly: keyless and offline workspaces stay plaintext until history migration; GTK/Flutter/CLI keep working via the server keyless-seed shim; lockstep debt unchanged (fixture already shipped).
- [ ] `docs/developers/architecture.md`: update the E2EE shipped/designed paragraph — custody now shipped (web), server seeding shim documented.
- [ ] Full `pnpm test` green; commit `docs: E2EE custody changelog + architecture status`.

## Self-review record

- Spec coverage: §1 custody (Tasks 1-2, 5-7), §3 seeding move (Tasks 3-4, 8), prefs-wrapping deliberately deferred (noted). Server slimming, migration script, shares, workflows: later plans.
- Type consistency: `ensureWorkspaceKey` returns `Uint8Array`; init message carries `Uint8Array`; worker imports via `importWorkspaceKey`; provider from `keyCryptoProvider` (plan-01 signatures).
- Review Focus: all five pinned across Tasks 2 (route auth), 5 (wrong master), 8 (race idempotence — seed node ids are fixed UUIDs, create is a no-op on existing id), 7 (key lifetime — init message only, cleared on logout), 3 (shim gate).
