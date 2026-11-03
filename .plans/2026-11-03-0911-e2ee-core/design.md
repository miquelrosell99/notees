# E2EE core — design spec

Date: 2026-11-03. Status: approved design (section-by-section with the owner), pending written-spec review.

## Context and intent

Notees is local-first: the op log is the only authority, every store is a derived projection. The hosted-sync monetization program (hosted relay at `notees.rosellramos.es` + Stripe, Tauri deferred) requires the privacy claim to be real before strangers' notes land on our server. Today the relay reads everything: envelopes are validated, persisted, applied to the server-side derived store, and served via search/query/shares.

**Intent (owner-approved):** ship end-to-end encryption as core infrastructure, *encrypted-only* (no plaintext mode), so the hosted offering can truthfully say "we cannot read your notes". Self-hosting stays free, first-class, and billing-agnostic forever.

**Program direction (recorded, designed later):** E2EE core → hosted web + public relay (paid hosted, free self-host; Stripe commission-only; 14-day trial) → web split → (deferred) Tauri. Each phase gets its own design + plan cycle. The parked-decision un-park condition for Tauri (a concrete non-Linux desktop requirement) is noted but not acted on here.

## Goals

- Every envelope payload is AES-256-GCM ciphertext everywhere except in client memory: the wire, the relay store, the durable client op log, CAS assets.
- The server reduces to: auth, relay (ingest/ordering/compaction/snapshots — metadata only), opaque asset blobs, share publishing + viewer, coordination state, health/ops. No content API.
- Public shares keep working via key-in-URL-fragment decryption (Standard Notes / Proton Drive pattern).
- House laws hold: fixture gate + GTK/Flutter lockstep, one-time in-place migration pattern, docs-part-of-change, changelog-as-record.

## Non-goals (this phase)

- Billing, signup policy, quotas, landing page (hosted-launch phase).
- Web repo split, Tauri client (later phases).
- Multi-account workspace sharing (the key hierarchy leaves room for it; no UI).
- Password recovery / recovery codes. **Lost password = lost history.** Documented loudly.
- E2EE of the local derived store (it stays plaintext by design — see threat model).

## Decisions already made (owner, 2026-11-03)

| Question | Decision |
|---|---|
| E2EE scope | Encrypted-only; every workspace encrypted, no plaintext mode |
| Public shares | Key-in-fragment: encrypted artifact + viewer, key in URL `#fragment` |
| Self-host | Hard constraint: billing is deployment-level; clients never know about Stripe; self-hosted instances unchanged (env-gated signup) |
| Monetization | Paid hosted + free self-host; Stripe; ~14-day trial; no perpetual free tier |
| Workflow rules | Evaluation moves client-side (against each client's local derived store) |

## Threat model / plaintext surface

**Defended against:** the relay operator, hosted-server breach, subpoena, network observer. None of them can read note content, titles (title-is-content means titles are inside payloads), property values, or asset bytes.

**Plaintext by design** (relay's minimum — verified that compaction/snapshots need no payload content): envelope id, workspace id, actor/device, client, HLC (physical/logical), timestamp, protocol version, op type, `affectedNodeIds`, sizes/timing. This leaks structural metadata ("a property changed on node X at time T") — acceptable, standard for E2EE sync, stated here and in user-facing docs.

**Device honesty:** the local derived store (OPFS SQLite) is plaintext because queries compile against it. The claim is precise: *the server and the wire never see content; anyone with your unlocked device can*. User docs must say this plainly.

**Existing groundwork (verified in code):**

- `packages/protocol/src/envelope.ts` — the `{"$e": {iv, ct}}` slot is schema-reserved since envelope v2; unit-tested but **not fixture-gated** (this spec adds the fixture).
- `apps/server/src/auth.ts:42-49,304-349` — Standard-Notes-style KDF record: scrypt (N=131072, r=8, p=1) password-derived wrap key, AES-256-GCM-wrapped 256-bit master key (`iv ‖ tag ‖ ct`, base64url), `keyVerifier = HMAC-SHA256(key, "notees-key-check")`. Rides in `POST /setup`, `POST /auth/signup`, `POST /auth/login` responses (login backfills via `ensureKdfRecord`). No client consumes it yet.
- Relay already passes `$e` through: payload validation skipped (`apps/server/src/validate.ts:31-47`), server-side derived store skips encrypted envelopes (`workspace-store.ts:192,293`).
- Envelope factory, appliers, seed inputs all live in client-consumable packages; seeding (`apps/server/src/seed.ts`) takes every input from `@notees/domain`.

## Design

### 1. Key hierarchy & custody

- **Account master key** — 256-bit random; server stores only salt/params/wrapped key/verifier. Client unwraps at login; the unwrapped key never leaves the client. Password change = rewrap under a new scrypt record; history untouched.
- **Per-workspace keys** — 256-bit random per workspace, wrapped by the master key (AES-256-GCM); wrapped-key record stored server-side (new table). Workspace rotation = rewrap. Future sharing re-wraps the workspace key for another account.
- **Envelope encryption** — AES-256-GCM with the workspace key; random 96-bit IV per envelope; GCM additional authenticated data = envelope id + workspace id (ciphertext cannot be transplanted across envelopes).
- WebCrypto throughout; keys are non-extractable `CryptoKey`s in memory only, cleared at logout. New device = login → fetch wrapped workspace keys → unwrap.

### 2. Encryption boundary

- Every locally-authored envelope payload becomes `$e` **before** entering the durable op log (`local_op_log`) or the wire; decryption happens after receive/replay, before apply. Derived stores see plaintext only.
- Net effect: relay DB, wire, and durable client logs hold ciphertext; only client memory and the (documented, plaintext) derived store ever hold content.

### 3. Server changes (slimming)

**Retires** (content API — the server store goes blind by design): object CRUD routes, `/search`, `/query`, backlinks, effective-properties, merge planning, server-side `export.zip`, node location. Audit `apps/web` for any remaining server-read path and move it local (the client already compiles QueryAST to local SQLite via `packages/query`).

**Moves client-side:**
- *System-class seeding* — `buildSeedEnvelopes` re-homed into a client-consumable module; first boot authors seeds locally (client envelope factory, `client: "seed"`), applies them, and they drain to the relay like any offline work. Server-side `ensureSeeded` retires; an empty workspace is fine server-side.
- *Workflow rules* — evaluation moves into each client: on each applied envelope, evaluate the workspace's rules against the local derived store; run audit stays local. Server-side probe evaluation retires.
- *Per-user prefs / coordination state* — wrapped as a master-key-encrypted blob server-side instead of plaintext rows.

**Keeps:** auth (as-is), relay ingest/ordering/compaction/snapshots (metadata-only — verified), CAS asset blobs (opaque; see §5), share publishing + viewer (§4), health/ops, plugin-manifest registry (manifests are not user content; keep plaintext).

### 4. Public shares — key-in-fragment

- Publishing (client-side): render the shared subtree to a self-contained static artifact (`@notees/export`), encrypt with a fresh random share key (AES-256-GCM), upload ciphertext; server stores `{token, ciphertext}` — a dumb blob host.
- URL: `https://<host>/s/<token>#<key>`. The fragment never reaches any server. `GET /s/:token` serves a minimal static viewer that decrypts locally and injects the artifact. Recipients need no account. Revoke = delete ciphertext (token rotation optional).
- The server-rendered share path (`routes-shares.ts` + `share-render.ts`) retires; existing shares are re-published or dropped at migration time.

### 5. Assets (CAS)

- Asset bytes encrypted client-side (AES-256-GCM, workspace key, per-asset IV) before CAS upload; server stores opaque blob + plaintext content-type/size.
- Key material (iv) rides in the asset's create-envelope payload — which is itself encrypted; no parallel key system.

### 6. Migration & rollout

- **No hosted users at launch** — the hosted offering opens only after this ships, so there is no user-data migration path to build. Encrypted-only from the first hosted signup.
- **Existing self-hosted workspaces** (the operator's, today): `scripts/migrate-e2ee.mts` in the established pattern — key material via env/stdin; rewrites stored envelopes to `$e` in place (fresh HLCs, same one-time-rewrite law as prior migrations), prunes derived stores, re-encrypts CAS blobs; clients re-sync and unwrap keys at next login.
- **Rollout order:** protocol fixture + TS crypto → server slimming → web client crypto + client-side seeding → migrate operator workspaces → GTK/Flutter lockstep → verify on the self-host (`pnpm test` gate green throughout; deploy per operations skill).

### 7. Lockstep & fixture gate

- New fixture(s) in `packages/protocol/fixtures/`: encrypted-payload envelopes exercising every applier path — live apply, replay, compaction with mixed plaintext/ciphertext segments — with decryption keys included in the fixture.
- TS reference (WebCrypto) first; GTK (`cryptography`) and Flutter (Dart AES-GCM) port key-custody + envelope crypto. Per house law the slice is not done until all three replay the fixtures byte-identically. This is the largest lockstep lift since the client split — the accepted cost of the encrypted-only decision.

## Verification

- `pnpm test` green (fixture gate included); new fixture replays byte-identical on TS/GTK/Flutter.
- Self-host smoke: fresh device syncs an encrypted workspace; server DB inspected to contain zero plaintext payloads; share publish → fragment-key view in a logged-out browser; migration script converts the operator's workspaces and all clients converge.
- Docs in the same pass: `SCHEMA.md`/WIRE.md E2EE sections (replace "designed, not shipped"), architecture.md corrections (incl. the stale discrepancy #6 re: durable op log — `local_op_log` shipped), user-facing privacy/E2EE page (incl. lost-password warning + device-honesty statement), `CHANGELOG.md` entry.

## Open questions (to resolve during planning, not blockers)

- Exact quota/enforcement mechanics for the hosted phase (separate spec).
- Whether `op_type` joins the plaintext-minimum set permanently or moves inside the ciphertext later (metadata-leak reduction; defer).
- Recovery codes (defer until first real lost-password incident demands a policy).
