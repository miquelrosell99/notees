# API 3.0.0 — targeted security audit (AG11)

Date: 2026-10-04 · Scope: the v3.0.0 HTTP API surface (`apps/server`) — the AG5 agent-safety batch (idempotency replay, `baseRevision`, the operations feed), the AG3 scoped-key machinery, the AB3 create-conflict semantics, and the error taxonomy — plus the store's new apply-time validation (PG6) where it surfaces through the API. Posture: targeted pass per the owner's AG11 scope decision (single-user self-host; auth + the machine surface + key handling), evidence-based, findings ranked. Benchmark cautionary tale stays SiYuan's 2026 kernel CVEs (§34.33); the load-bearing mitigation remains the parameterized QueryAST compiler (no string-concatenated SQL anywhere in the query path — grep-verified, `packages/query/src/compiler.ts`).

Method: read-through of `apps/server/src/{app,auth,scopes,idempotency,errors,routes-meta,routes-objects,routes-auth,context,relay-storage,workspace-store}.ts` + `packages/store/src/{appliers,property-values}.ts`, the developer-api/error-taxonomy/openapi-coverage specs, and one live-data probe of the deployed derived store. No dynamic exploitation was performed (single-user self-host; the threat model is a leaked key / a mis-scoped agent / a future exposed instance).

## Verdict

No Critical/High findings on the targeted surface. The 2026-10-03/04 batches shipped a coherent agent-safety story: every failure answers in the pinned taxonomy, scoped keys fail closed on the relay surface, the operations feed enforces read auth before the cursor moves, and the new PG6 validation fails loud as 422 instead of persisting garbage. Findings below are Medium-and-lower hardening items, all recorded with recommended dispositions; none blocks the owner-plus-agents consumer model.

## Findings (ranked)

### M1 — Per-user API keys are not workspace-bound (Medium, design decision recorded)

`authorizeWorkspace` (`apps/server/src/routes-relay.ts:86-93`) returns immediately for `principal.kind === "apikey"`: an API key — operator or per-user, scoped or not — can address ANY workspace via `X-Workspace-Id`, including the `GET /api/operations` feed and every object read. Sessions are membership-gated; keys are not. For the current single-user deployment this is moot (one principal owns every workspace, and the operator key is deliberately unrestricted), but the AG3 scoped-key story ("read-only agent key") implies a future where a key leaking means cross-workspace read exposure. **Recommendation:** when external consumers arrive (AG1), bind per-user keys to the workspace list of their creator at issuance (or add a `workspaces` claim) and check it in `authorizeWorkspace`; until then, document the property on `POST /api-keys` — the OpenAPI `x-api-key-scopes` text should state that keys are fleet-wide.

### M2 — Idempotency/rate-limit stores have no background sweeper (Low)

Both `IdempotencyStore.prune()` (`apps/server/src/idempotency.ts:70`) and the rate limiter's (`rate-limit.ts:34`) are prune-on-read and invoked from tests only; no `setInterval` exists anywhere in `apps/server/src`. Expired records linger past their 24h TTL until their exact key is looked up again — unbounded slow growth on a long-lived process (bounded in practice by request volume; ~a few hundred bytes per record). **Recommendation:** a one-line hourly `setInterval(prune)` beside the store construction in `context.ts` (or an unref'd timer in `server.ts`); cosmetic for a self-host, cheap insurance.

### M3 — PG6 validation messages echo schema internals (Low)

The new apply-time validation surfaces schema types/ids and filter classes in 422 messages (`property.set: value target <uuid> does not carry any of the schema's allowed classes`, `schema <uuid> is single-value`, `property.set: value references node <uuid>, which does not exist` — `packages/store/src/property-values.ts`). Two of these (`does not exist` / `single-value`) double as existence oracles for guessed UUIDs. All are authenticated-only, and the same oracles exist elsewhere (GET /objects/:id is 404-vs-200 on any id; AB3's new 409-vs-201 on create is the same oracle one step earlier — recorded with the AB3 pin). **Recommendation:** none required for the single-user model; if keys are ever issued to third parties, redact ids from client-facing validation text (log the full message server-side).

### L4 — Operations feed: workspace existence is revealed to members only (Informational, verified correct)

`GET /api/operations` (`apps/server/src/routes-meta.ts:60-82`): schema-validated query → `resolvePrincipal` (401 on bad credentials) → `authorizeWorkspace(…, "read")` (non-membership 404s via the session path; keys ride M1) → `scopeAllows(…, "objects.read")` (403 `scope_denied`) → only then `ctx.relay.catchUp`. The relay log is never written through this route, cursor semantics match catch-up, and the feed's read membership matches the object reads. The default-workspace fallback (`workspaceId ?? ctx.defaultWorkspace`) behaves exactly like the rest of the surface. No finding; recorded because the feed is the most sensitive read (full history incl. content payloads).

### L5 — Error taxonomy discipline holds (Informational, verified)

`ERROR_TAXONOMY` (`apps/server/src/errors.ts:57-76`) + the drift-scanning spec (`test/error-taxonomy.test.ts`) keep code ↔ status ↔ OpenAPI `x-error-codes` honest; `internal` is the only handler-fallback code and the handler logs server-side while answering a generic body (`app.ts:127-128`). Aliases (400/416 for `validation_failed`) are pinned, not emergent. PG6's rejections reuse `validation_failed` (422) via the existing `StoreError` mapping (`app.ts:117-120`) — no taxonomy drift introduced by this batch. AB3's new pre-submit 409 uses the pre-existing `conflict` code (no new code → no taxonomy change; the developer-api spec pins the semantics).

### L6 — Idempotency replay semantics (Informational, verified)

`apps/server/src/idempotency.ts`: replay requires the caller's credentials (hooks run after auth + scope checks), keys are namespaced per (workspace, sha256(credential), key) so one principal's key never replays another's response, only 2xx is captured (errors re-execute — messages reflect current state), key reuse with a different request fails 409 `idempotency_replay`, multipart is excluded (CAS hash dedup is the honest story there). Documented single-process/in-memory tradeoff (restart clears the window) matches the rate limiters' accepted posture. No finding.

## Register cross-checks

§34.33 AG11 row (this audit closes it) · the AG3/AG5 rows ship what this audit reviewed · AB3's 409 pre-check reviewed under M3/L5 · the parameterized-`/query` mitigation predates and stands (AC2, §34.33.1) · `.audits/README.md` scope (internal, evidence-based) respected. Follow-ups registered: M1 (key→workspace binding at AG1 time), M2 (sweeper timer), M3 (message redaction if keys ever leave the owner).
