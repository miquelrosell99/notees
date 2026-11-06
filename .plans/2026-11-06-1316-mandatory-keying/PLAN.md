# Mandatory workspace keying — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspace keying mandatory — the server rejects unkeyed workspace creation (422, env-hatched), the web keys every new workspace and offers one-click keying of existing ones, and the dev-ops surface (migrate scripts, verify-migration) works with keyed workspaces under an explicit contract.

**Architecture:** Slice 1 (notees-sync) adds the creation gate (`NOTEES_REQUIRE_KEYED`, bundle in the create payload, fixture allowlist). Slice 2 (notees-sync) lands the dev-ops contract: a shared scratch-store lib, per-migration content-class declarations with server-side refusal on keyed workspaces, and sealed-invisible reporting in verify-migration. Slice 3 (notees-web, after a vendor bump) wires creation keying, unconditional keying (the `NOTEES_E2EE` kill switch retires), offline key custody, and the not-encrypted banner + key-this-workspace action.

**Tech Stack:** TypeScript, pnpm 9, vitest, fastify (`app.inject` route tests), React 18, WebCrypto (existing custody machinery — NO new crypto).

**Spec:** `notees-sync/.plans/2026-11-06-1316-mandatory-keying/DESIGN.md` (read it first; it travels with this plan).

## Global Constraints

- Two repos: `/root/projects/notees-sync` (core+server, authority) and `/root/projects/notees-web` (client). Never edit `notees-web/vendor/notees`.
- Both MAIN CHECKOUTS are held dirty by a parallel session (sync: resolve-source*; web: AddSourceDialog etc.). Work in the repo's own worktrees (`git -C <repo> worktree add .worktrees/<slug> -b <slug> origin/main`); never stage or revert the parallel session's files; per-file staging only; Conventional Commits; never force-push; land fast-forward via `git push origin HEAD:main` from the worktree (the checkouts stay behind until the parallel session commits — parked, documented, not yours to fix).
- Gate commands: sync `pnpm test` (+ `pnpm -r --workspace-concurrency=1 build` after public API changes — vitest reads src, tsc reads dist); web `pnpm --filter @notees/web test`, `typecheck`, `build`, `node scripts/check-css-tokens.mjs`.
- CHANGELOG entries prepend under the current `## YYYY-MM-DD` heading, newest first; never reference `.plans/` from the tree; fleet-agnostic artifacts (no host names/IPs — `verify-migration.mts`'s existing personal-workspace literal defaults stay untouched, but no NEW ones).
- Fail-loud idiom; the house custody machinery (`packages/protocol/src/crypto.ts`: `generateWorkspaceKey`, `wrapWorkspaceKey`, `unwrapWorkspaceKey`, `createKdfRecord`) is reused verbatim — NO new crypto.
- Branch housekeeping owed: `origin/fix/sealed-scratch-migration` is fully merged into main — delete it in Task 4 (`git push origin :fix/sealed-scratch-migration`).

## Review Focus

The five conditions most likely to bite, each pinned to an owning task:

1. **API-key session tries to create a workspace** — no password path exists, so creation must fail with the directional copy, not a bare 422 or a broken half-created workspace (Task 1 server shape; Task 10 web surface).
2. **A `content`-class migration pointed at a keyed workspace** — it must REFUSE loudly before planning, never half-migrate the visible plaintext minority (Task 6).
3. **The web's `NOTEES_E2EE=off` deployments (the live fleet stack ships it OFF today)** — keying becomes unconditional, so a flag-off deployment must behave IDENTICALLY to flag-on (keying always) — the kill switch retires, not silently keeps plaintext (Task 10).
4. **Offline ("Work offline") bootstrap with no account at all** — the local store must still key at rest (device-local custody), and later sync must wrap+upload under a password session (Task 11).
5. **The 20+ server tests that POST `/api/workspaces` without a bundle** — they keep passing via the test-default hatch OFF; only the dedicated gate tests run it ON (Task 1).

---

## Slice 1 — The creation gate (notees-sync)

### Task 1: `NOTEES_REQUIRE_KEYED` + the creation gate

**Files:**
- Modify: `apps/server/src/config.ts` (`ServerConfig` :28-65, `loadConfig` :133-152, header env registry :1-20)
- Modify: `apps/server/src/routes-auth.ts` (create route :717-730, clone route :778-828, `createWorkspaceSchema` :149-151)
- Modify: `apps/server/src/auth.ts` (`createWorkspace` :673-681 — add the allowlist parameter)
- Test: `apps/server/test/keying-gate.test.ts` (new); `apps/server/test/helpers.ts` (`makeConfig` — hatch default for tests)

**Interfaces:**
- Consumes: existing custody surface — `workspace_key` table (`auth.ts:286-290`), `workspaceKeySchema` (`routes-auth.ts:158-160`), `putWorkspaceKey` (`auth.ts:1044-1062`).
- Produces (Tasks 2, 10 consume):
  - `ServerConfig.requireKeyed: boolean` (env `NOTEES_REQUIRE_KEYED`, `boolFromEnv(env, "NOTEES_REQUIRE_KEYED", true)` — DEFAULT ON).
  - `createWorkspaceSchema` gains `wrappedKey: z.string().min(1).max(4096).optional()` (same bounds as `workspaceKeySchema`).
  - `KEYING_EXEMPT_WORKSPACE_IDS: readonly string[]` in `apps/server/src/auth.ts` = `["11111111-2222-4333-8444-555555555555", "4b7d1a00-2222-4000-8000-0000000000099"]` (comment: the seeded demo fixtures; the server never holds keys, harnesses mint them via direct log ingest).
  - `keyingRequiredFor(config, workspaceId: string | null): boolean` — `config.requireKeyed && (workspaceId === null || !KEYING_EXEMPT_WORKSPACE_IDS.includes(workspaceId))`.
  - The gate: in `POST /workspaces`, after schema parse, if `keyingRequiredFor(config, null)` and `parsed.data.wrappedKey === undefined` → `throw new AppError(422, "keying_required", "workspace keying is required — create the workspace with a wrappedKey bundle (sign in with your email and password to create one)")`. With `wrappedKey` present: after `ctx.auth.createWorkspace` + `addMember`, `ctx.auth.putWorkspaceKey(id, parsed.data.wrappedKey)` in the same handler (the first-write-wins 409 cannot fire on a fresh row). The clone route gets the identical treatment (its new workspace may reuse nothing of the source's key — a fresh bundle or the 422).

- [ ] **Step 1: Write the failing tests** — `apps/server/test/keying-gate.test.ts`, following `workspace-key-routes.test.ts:23-31`'s `setupUser` + `app.inject` idiom:
  - hatch ON + no `wrappedKey` → 422, body `error: "keying_required"`, message contains "wrappedKey"; workspace NOT minted (assert via a follow-up `GET /api/workspaces` without the id or `auth.getWorkspaceKey(id) === undefined` — use the helpers' exported storage handle pattern from `workspace-key-routes.test.ts`).
  - hatch ON + `wrappedKey: "dGVzdA"` → 201 + `GET /api/workspaces` lists it `encrypted: true` + `GET /api/workspaces/:id/key` (same user) returns the wrap.
  - hatch OFF + no bundle → 201, `encrypted: false` (legacy preserved).
  - `keyingRequiredFor` unit pins: exempt id → false; random id → true (hatch ON); any id → false (hatch OFF).
  - Clone route: hatch ON + no bundle → 422; with bundle → 201 + key row present.
  - All existing suites stay green UNTOUCHED: `helpers.ts makeConfig` passes `NOTEES_REQUIRE_KEYED: "0"` in its default env (document why in a comment — the suite predates the gate).
- [ ] **Step 2: Run, verify red** — `pnpm --filter @notees/server test` (new file fails; expect the rest green).
- [ ] **Step 3: Implement** per the Interfaces block. `loadConfig` gets `requireKeyed: boolFromEnv(env, "NOTEES_REQUIRE_KEYED", true)`; the header registry + `ServerConfig` interface gain the entry.
- [ ] **Step 4: Run, verify green** — `pnpm --filter @notees/server test` (full suite).
- [ ] **Step 5: Commit** — `feat(server): workspace creation requires a key bundle — NOTEES_REQUIRE_KEYED gates it (default on)`

### Task 2: Deployment docs + slice-1 landing

- [ ] **Step 1:** `docs/developers/deployment.md`: rewrite the stale E2EE posture — the paragraph at :8-13 ("no E2EE… the server operator can read all workspace contents") and the bullet at :211-214 ("Designed, not present: E2EE") become the truth: E2EE shipped; **keying is required** (`NOTEES_REQUIRE_KEYED=1` default; `=0` restores legacy creation for dev/test fleets); the fixture-workspace exemption; the operator can never read keyed content (content reads 404); history written before keying stays plaintext (immutable log). Add `NOTEES_REQUIRE_KEYED` to the env table (:65-76).
- [ ] **Step 2:** CHANGELOG under `## 2026-11-06`, newest first: `**feat(server): workspace keying is mandatory …**` — why (privacy-first threat model includes the host), mechanism (config default-on + hatch, the 422 `keying_required` shape, bundle-in-create incl. the clone route, the fixture allowlist, test-hatch default), docs (deployment.md), verification (suite counts).
- [ ] **Step 3:** Gate: `pnpm test` from the worktree (sync 56/protocol/domain/store/query/export green per the recurrence baseline; the known pre-existing `packages/sync/test/snapshot-chunking.test.ts` typecheck red is another slice's area — record it, don't fix).
- [ ] **Step 4:** Land: push branch, `git push origin HEAD:main` (ff-only), confirm origin/main, remove worktree + branch. Redeploy the sync image per the ops skill: build from a clean origin/main clone context, backup relay.db with the server stopped, `docker compose up -d` from `/etc/periphery/stacks/notees`, healthz, and the post-deploy smoke with `NOTEES_ADMIN_EMAIL` exported (the 2026-11-06 recurrence deploy is the exact precedent).
- [ ] **Step 5:** Commit — `docs(deployment): keying is mandatory — NOTEES_REQUIRE_KEYED, the fixture exemption, the honest-history ruling`

## Slice 2 — The dev-ops contract (notees-sync)

### Task 3: The shared scratch-store lib

**Files:**
- Create: `scripts/lib/scratch-store.ts`
- Modify: `scripts/migrate-repeat-property.mts` (swap its local `buildScratchStore` for the lib)
- Housekeeping: delete the merged remote branch — `git push origin :fix/sealed-scratch-migration`

**Interfaces:**
- Consumes: the reference implementation — `scripts/migrate-repeat-property.mts:207-257` on main (the sealed gate + `isEncryptedPayload`/`StoreError` skips + the skip-count line), the `migrate-e2ee.mts:58-64` dependency-access idiom (deep-import better-sqlite3 through the server package, protocol via `src`).
- Produces (Tasks 4-5 consume):
  - `export interface ScratchCounts { encrypted: number; pending: number }`
  - `export function buildScratchStore(relay: RelayStorage, workspaceId: string, onSkip?: (counts: ScratchCounts) => void): Store` — byte-for-byte the reference semantics (sealed-snapshot gate `snapshot.sealed !== 1`; `isEncryptedPayload` skip; `StoreError` skip counted pending; anything else throws `tail apply failed at seq > N`); when skips occurred and `onSkip` is given, call it once with the counts (the caller prints the house line).
  - `export type MigrationContentClass = "scaffolding" | "content"`
  - `export function keyedWorkspaceIds(dataDir: string): Set<string>` — opens the AuthStorage `workspace_key` table read-only from `<dataDir>/relay.db` and returns the keyed set (the migrate scripts take `--data-dir`; the key table lives in the same relay.db).
  - `export function refuseIfContentOnKeyed(dataDir: string, workspaceId: string, contentClass: MigrationContentClass, scriptName: string): void` — throws `Error(`${scriptName}: "content"-class migration refuses to run server-side against keyed workspace ${workspaceId} — sealed content is invisible here; run it through a keyed client`)` when class is `"content"` and the workspace is keyed.

- [ ] **Step 1: Write the failing test** — `apps/server/test/scratch-store-lib.test.ts` (new): stage a tmp RelayStorage with (a) a plaintext workspace + envelopes, (b) a workspace with a sealed latest snapshot (garbage bytes, `sealed=1`) + plaintext tail — assert `buildScratchStore` plans-equivalent state for (a) and does NOT throw for (b) (rehearsal-shape, mirror the sealed pin in `migrate-repeat-property.test.ts`); assert `keyedWorkspaceIds` returns the ids after a `putWorkspaceKey`; assert `refuseIfContentOnKeyed` throws for content+keyed, is silent for scaffolding+keyed and content+unkeyed.
- [ ] **Step 2: Run, verify red.**
- [ ] **Step 3: Implement** `scripts/lib/scratch-store.ts` per the Interfaces block (the lib sits beside `scripts/lib/map-query-ast-v1-v2.ts`; the web repo's vendor-relative import path pattern must keep working — no breaking change to `scripts/lib/`'s existing export).
- [ ] **Step 4: Migrate `migrate-repeat-property.mts`** to the lib (delete its local copy, import, pass an `onSkip` that prints the existing line) — its rehearsal suite (`apps/server/test/migrate-repeat-property.test.ts`) stays green unmodified. Delete the merged remote branch.
- [ ] **Step 5: Run** — `pnpm --filter @notees/server test` green.
- [ ] **Step 6: Commit** — `feat(scripts): shared scratch-store lib — the sealed gate + content-class refusal for every migration`

### Task 4: Adopt the lib + declare classes across the migrate fleet

**Files:**
- Modify: all 33 remaining scripts with a local `buildScratchStore` (the explorer's list: 31 `migrate-*.mts` + `backfill-citekeys.mts` + `import-zotero-rdf.mts` + `repair-log-conformance.mts`)
- Test: each script's existing rehearsal/integration suite stays green (they are the pins)

**Interfaces:**
- Consumes: Task 3's lib; the content/scaffolding classification (explorer's draft, verified per script header): content-class = `migrate-authors-to-text`, `migrate-meeting-date-retirement`, `migrate-pmid-property` (mixed — the value-repoint arm makes it content), `migrate-zotero-full-alignment`, `migrate-url-type-to-text`, `migrate-url-source-binding`, `migrate-cover-banner-alias`, `migrate-cover-to-asset`, `migrate-color-tokens`, `migrate-retire-external-link`, `migrate-mention-custom-label`, `migrate-mention-texts`, `migrate-text-carriers`, `migrate-title-is-content`, `migrate-unified-datetime`, `migrate-date-pages-main`, `migrate-attachments-asset-type`, `backfill-citekeys`, `import-zotero-rdf`, `repair-log-conformance`; everything else scaffolding.
- Produces: each script exports `export const CONTENT_CLASS: MigrationContentClass = "<class>"` and calls `refuseIfContentOnKeyed(options.dataDir, workspaceId, CONTENT_CLASS, "<script name>")` in its per-workspace main loop BEFORE planning; local `buildScratchStore` copies deleted; `onSkip` prints the house line.

- [ ] **Step 1:** Batch-edit all 33 scripts (one focused pass, same-shape edits): swap the helper for the lib import, add the `CONTENT_CLASS` export (per the classification; when a script's header disagrees with the explorer's class, the header wins — note any reclassifications in the report), add the refusal call, keep each script's own skip-line wording via `onSkip`.
- [ ] **Step 2:** Add one refusal pin per content-class representative — extend `apps/server/test/scratch-store-lib.test.ts` with a spawned-script refusal test (shape: stage a keyed workspace via `putWorkspaceKey`, run `migrate-meeting-date-retirement.mts --data-dir … --workspace <id>` as a dry run, expect exit non-zero + the refusal message + ZERO envelopes appended).
- [ ] **Step 3: Run the full gate** — `pnpm test` (every script's suite replays its envelopes through the shared helper — the adoption is only safe if all suites stay green; the repeat rehearsal's sealed pin proves the gate end-to-end).
- [ ] **Step 4: Commit** — `feat(scripts): every migration rides the shared scratch builder and declares its content class`

### Task 5: verify-migration reports the sealed boundary

**Files:**
- Modify: `scripts/verify-migration.mts` (:184-191 the report block)

**Interfaces:**
- Consumes: `isEncryptedPayload` from `../packages/protocol/src/envelope.ts` (the script already reads the relay log read-only).
- Produces: the report line gains the sealed count — `PASS <id>: N/N envelopes applied (pending skips: P, sealed-invisible: S, handle lastSeq A/B)` where `S` = count of `isEncryptedPayload` envelopes in the device's filtered set for that workspace. PASS criteria unchanged (all applied + pending === 0; sealed-invisible is a REPORT, never a fail — a keyed workspace's sealed tail is invisible by design).

- [ ] **Step 1: Write the failing test** — extend the verify-migration test surface (find its existing test file under `apps/server/test/`, else pin via a staged tmp relay + a stubbed convergence endpoint like the existing pins): a device envelope set containing a sealed payload reports `sealed-invisible: 1` and still PASSes; a plaintext set reports `sealed-invisible: 0`.
- [ ] **Step 2: Run, verify red; implement; verify green** — `pnpm --filter @notees/server test`.
- [ ] **Step 3: Commit** — `feat(scripts): verify-migration reports sealed-invisible counts — the boundary is never silent`

### Task 6: Slice-2 landing

- [ ] **Step 1:** CHANGELOG slice entry (the contract: shared builder, class declarations + the refusal, verify reporting; why — keyed workspaces are the norm now, operator tooling must be honest about the boundary).
- [ ] **Step 2:** Gate `pnpm test` green; land ff to main; remove worktree + branch.
- [ ] **Step 3:** No redeploy needed (scripts are repo tooling, not the server image) — record that in the changelog.

## Slice 3 — The web client (notees-web, one branch/release train)

Worktree: `git -C /root/projects/notees-web worktree add .worktrees/keying -b keying origin/main` (main checkout is parallel-session-dirty; never touch it).

### Task 7: Vendor bump

- [ ] **Step 1:** After Task 6's push: `git -C vendor/notees fetch origin && git -C vendor/notees checkout origin/main` → `pnpm -r --filter "@notees/*" build` → `pnpm install`.
- [ ] **Step 2:** `pnpm --filter @notees/web test` — expect targeted failures only in tests this slice owns (none yet — the gate ships server-side; the web still sends `{name}` and the MemoryRelay harness doesn't enforce it). Green expected.
- [ ] **Step 3:** Commit — `chore(vendor): bump notees pin — the creation keying gate`.

### Task 8: Creation keying + the kill switch retires

**Files:**
- Modify: `apps/web/src/core/auth-api.ts` (`createWorkspace` :309-316)
- Modify: `apps/web/src/core/crypto-custody.ts` (a creation-time variant of `ensureWorkspaceKey`'s generate+wrap, reusing its 409-adoption logic)
- Modify: `apps/web/src/ui/app/store-connection.ts` (the `window.NOTEES_CONFIG?.e2ee !== "on"` gate at :101 — keying becomes unconditional)
- Modify: `apps/web/src/features/workspaces/WorkspacesView.tsx` (:150-165), `WorkspaceSwitcher.tsx` (:105-116), `features/import/flows/notees-dump.ts` (:275), `features/import/flows/markdown-workspace.ts` (:49) (all `createWorkspace` call sites)
- Test: `apps/web/test/settings-modals.test.tsx` (:643-656), `apps/web/test/e2ee-config-gate.test.ts` (rewritten matrix), new `apps/web/test/create-keying.test.tsx`

**Interfaces:**
- Consumes: `generateWorkspaceKey`/`wrapWorkspaceKey` (`@notees/protocol`), `currentMasterKey` (`crypto-custody.ts:134`), `ensureWorkspaceKey` (:146-198 — its generate+wrap+PUT 409-adoption arm is copied into the new creation path), the new server schema (`wrappedKey?`).
- Produces:
  - `createWorkspace(serverUrl, token, name?, wrappedKey?: string)` — passes `wrappedKey` through when defined.
  - `keyBundleForCreate(serverUrl, token): Promise<{ wrappedKey: string } | { directionalCopy: true }>` (in `crypto-custody.ts`): `currentMasterKey()` null → the directional arm; else `generateWorkspaceKey()` + `wrapWorkspaceKey(master, key)` + return the bundle. (The PUT happens in the create payload — no pre-flight PUT.)
  - The kill switch: `resolveWorkspaceKey` drops the `NOTEES_CONFIG.e2ee` gate entirely — keying is unconditional (the typed flag in `types/notees-config.d.ts` stays for compat but is ignored; a comment says so).

- [ ] **Step 1: Write the failing tests**:
  - `create-keying.test.tsx`: password session → `POST /api/workspaces` body contains `wrappedKey` (a b64u string); API-key session (no master) → creation surfaces the directional copy and NO create request fires; the 422 `keying_required` from a flag-off server… (n/a — hatch is server-side; skip); `resolveWorkspaceKey` matrix rewritten — flag absent/off/on all key identically (stub fetch: 404 → generate+wrap+PUT; offline still short-circuits to `key: undefined` pending Task 9).
  - `settings-modals.test.tsx:643-656` updated: the asserted body is now `{ name: "New plots", wrappedKey: <any string> }` via `expect.objectContaining`.
- [ ] **Step 2: Run, verify red.**
- [ ] **Step 3: Implement** per the Interfaces block. Call sites: every `createWorkspace` call first resolves `keyBundleForCreate`; on the directional arm the creation UI shows the modal copy ("Sign in with your email and password to create a workspace") — reuse `WorkspaceNameModal`'s error surface or a small inline error; the import flows propagate the directional error as their existing error channel.
- [ ] **Step 4: Run** — `pnpm --filter @notees/web test` + `typecheck` green; full suite once.
- [ ] **Step 5: Commit** — `feat(web): every new workspace is keyed at creation — the e2ee kill switch retires`

### Task 9: Offline bootstrap keys at rest

**Files:**
- Modify: `apps/web/src/core/master-key-storage.ts` (a workspace-key store beside the master-key record: DB `notees-custody`, store `workspaceKeys`, `{ id: <workspaceId>, key?|keyBytes? }` — the same Chromium-non-extractable / Firefox-bytes pattern)
- Modify: `apps/web/src/ui/app/store-connection.ts` (`resolveWorkspaceKey`'s offline short-circuit :102 — restore the local key from custody instead of `undefined`)
- Modify: `apps/web/src/core/workspace-client/client-sync.ts` (:52-58 — the offline connect threads the restored key into `keyCryptoProvider` like the online path)
- Modify: `apps/web/src/ui/app/useBootFlow.ts` (:144-172 — first offline open generates + persists the key when custody is empty)
- Test: extend `apps/web/test/e2ee-config-gate.test.ts` + a new offline-keying pin (offline connect with an empty custody generates a key; a second offline open restores the SAME key (content encrypted with it still opens); first password-session sync uploads the wrap — pin the PUT)

**Interfaces:**
- Consumes: Task 8's unconditional keying; `generateWorkspaceKey`/`wrapWorkspaceKey`; the master-key storage pattern.
- Produces: `getOfflineWorkspaceKey(workspaceId): Promise<CryptoKey | null>`, `persistOfflineWorkspaceKey(workspaceId, key)` in `master-key-storage.ts`; `resolveWorkspaceKey` offline arm returns `{ key: restored, locked: false }` (locked impossible — the key is device-local).

- [ ] **Step 1: Write the failing tests** (offline generate/restore/sync-upload pins; IndexedDB mock per `master-key-persistence.test.ts`'s idiom).
- [ ] **Step 2: Run, verify red; implement; verify green.**
- [ ] **Step 3: Commit** — `feat(web): offline workspaces key at rest — device-local custody, wrap uploads on first password sync`

### Task 10: The not-encrypted banner + key-this-workspace

**Files:**
- Create: `apps/web/src/components/ui/kit/NotEncryptedBanner.tsx` (+ `.css`, barrel) — the `InProcessStoreBanner.tsx` pattern (35 lines: `role="status"`, dismiss-per-session button)
- Modify: `apps/web/src/ui/app/AppOverlays.tsx` (:55 — render the banner when the ready shell's workspace is plaintext)
- Modify: `apps/web/src/ui/App.tsx` (the "Key this workspace" action — calls `ensureWorkspaceKey(serverUrl, credential, workspaceId, master)` then re-`connect`s so the engine seals from here on; API-key sessions get the directional copy)
- Test: new `apps/web/test/not-encrypted-banner.test.tsx` (banner on plaintext, absent on keyed, dismiss-per-session, the keying action calls ensureWorkspaceKey + reconnects, post-keying honest copy "New content is encrypted. Content written before keying is not.")

**Interfaces:**
- Consumes: `ensureWorkspaceKey` (:146-198 — exactly its lazy path, now user-invoked); the listing's `encrypted` flag / `fetchWorkspaceKey` 404 for the plaintext predicate.
- Produces: `NotEncryptedBanner` (kit, barrel-exported) with props `{ onKey: () => void; keyDisabled: boolean; keyDisabledHint?: string }`.

- [ ] **Step 1: Write the failing tests; verify red.**
- [ ] **Step 2: Implement** — banner in `AppOverlays` gated on `storeMode === "opfs" && workspaceIsPlaintext` (derived from the connection's key-resolution result, threaded via context/state in `useWorkspaceConnection`); the Key action flows through App like the unlock modal's `onSubmit` (master present → ensure + reconnect; absent → the directional copy in the banner).
- [ ] **Step 3: Run** — test + typecheck + `node scripts/check-css-tokens.mjs`.
- [ ] **Step 4: Commit** — `feat(web): not-encrypted banner + one-click key this workspace`

### Task 11: Docs, changelog, gates, landing

- [ ] **Step 1:** Web `docs/` sweep: any page describing workspace creation or E2EE (grep `getting-started.md`, `philosophy.md`, `features/` for "encrypt|E2EE|key") gets the mandatory-keying truth; the `NOTEES_E2EE` image flag's doc mentions become "retired — keying is unconditional".
- [ ] **Step 2:** Gates: full web test + typecheck + build + css-token gate.
- [ ] **Step 3:** CHANGELOG slice entry under `## 2026-11-06` (creation keying, kill-switch retirement, offline key custody, the banner/action; verification counts).
- [ ] **Step 4:** Land: rebase onto freshest origin/main, gates again, `git push origin HEAD:main` (ff-only), remove worktree + branch.
- [ ] **Step 5:** Redeploy the web image (clean-clone build → backup → `docker compose up -d` → healthz → verify-min with `NOTEES_ADMIN_EMAIL` exported). Note: the live stack's `NOTEES_E2EE` env becomes inert by design — no `.env` change needed (record it).

## Self-review record

- Spec coverage: enforcement → T1; hatch → T1 (+ deployment doc T2); fixtures → T1 allowlist; creation UX (password/API-key) → T8; offline bootstrap → T9; existing-workspace warning + key-this-workspace → T10; dev-ops contract clauses 1-2 → T3/T4; clause 3 (classes + refusal) → T4 (+ lib T3); clause 4 (verify reporting) → T5; compatibility/lockstep note → T2 changelog; errors → T1 422 shape, T4 refusal, T8 directional copy; testing → per-task; docs → T2/T11; slices → T1-2 / T3-6 / T7-11.
- Placeholder scan: clean — every step names files, shapes, and commands.
- Type consistency: `requireKeyed`, `keyingRequiredFor`, `KEYING_EXEMPT_WORKSPACE_IDS`, `buildScratchStore`/`ScratchCounts`/`MigrationContentClass`/`keyedWorkspaceIds`/`refuseIfContentOnKeyed`, `wrappedKey?`, `keyBundleForCreate`, `getOfflineWorkspaceKey`/`persistOfflineWorkspaceKey`, `NotEncryptedBanner` props — used identically across defining and consuming tasks.
- Review Focus: all five pinned — (1) T1 422 shape + T8 directional copy; (2) T4 refusal spawn test; (3) T8 kill-switch matrix rewrite; (4) T9 offline generate/restore/sync pins; (5) T1 test-hatch default.
