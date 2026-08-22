# Rollout — build order, parallelization, verification

> Conclusion: tasks 1→2→3 are strictly sequential (each unblocks the next); 4 and 5 parallelize after 3; 6 and 7 are independent tail work. Every phase lands green on the branch.

## Build order

```
T1 server config ──► T2 local session ──► T3 client seed ──► T4 gating ─┐
                                            │               T5 assets ──┤
                                            └──────────────► T6 adoption │
T7 packaging (can start after T1; final e2e needs T2+T3) ◄───────────────┘
```

- **T1→T2→T3 sequential**: each consumes the previous task's interface
  (`prd.md` Task Breakdown). Do not parallelize — the boot chain is one code
  path.
- **T4 ∥ T5**: different files (nav/settings vs assets). Separate subagents OK.
- **T6**: after T3 (needs the seed + adoption semantics); backend smoke via
  the dev stack.
- **T7**: Dockerfile.web can be written any time after T1 (needs the config
  mechanism to exist to be meaningful); its acceptance e2e needs T2+T3.

## Failure-mode decisions (from plan-feature Decision Completeness)

- **Server configured but down at boot** → `unreachable`: keep current banner,
  but NO full-screen lock and NO blocking workspace open — the local store is
  authoritative anyway, so open locally and sync in background with the
  existing outbox retry. This changes `workspaceStoreAdapter.ts` init behavior
  for connected mode too: `syncEngine.initialize()` failure must degrade to
  offline-open instead of the error overlay.
- **Server URL cleared while ops are queued** → outbox persists; re-adding the
  same URL resumes; adding a *different* URL triggers adoption flow (T6), never
  silent cross-server pushes.
- **IndexedDB quota/blocked** → same handling as today's persistence failures
  (existing `storagePersistence` path); local mode adds no new failure class.

## Verification strategy

- Per task: the acceptance command in `prd.md`.
- Per merge point (after T3, after T5, after T6, after T7): full
  `npm run lint` + `npx vitest run` + backend `pytest` (backend should be
  untouched — any backend red means someone crossed a boundary).
- New e2e: `frontend/e2e/local-mode.spec.ts` — boots with all `/api/**` routes
  aborted, creates a page, reloads, asserts content; asserts zero `/api/*`
  requests (R2); asserts Inbox visible (R3-seed).
- Existing e2e suite (`frontend/e2e/`) must pass unchanged against the dev
  stack (R3).

## Rollback

All work is additive on `feat/local-first-split`; all-in-one deployment is the
untouched default. Rollback = merge nothing. The only shared-file risk is the
boot chain (`AppRoutes.tsx`) and `workspaceStoreAdapter.ts` — both covered by
existing e2e + unit tests in connected mode.
