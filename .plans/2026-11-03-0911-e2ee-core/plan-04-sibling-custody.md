# E2EE core — Plan 04: sibling custody (GTK + Flutter decrypt/encrypt at sync) + web unlock UX + locked-sync semantics

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Make all three clients full custody citizens: GTK and Flutter derive the master key at login, ensure workspace keys, decrypt before apply, encrypt at push, seal snapshots; the web gains the unlock re-prompt so a reloaded session can re-derive the master key without a full sign-out; and all three share one locked-sync semantic (skip `$e` with a warning, never error-loop).

**Architecture:** Ports of the plan-01 `crypto.ts` custody half (scrypt KDF record, master/workspace key wrap, encrypt envelope/snapshot-bytes) into GTK's `crypto.py` (cryptography lib — scrypt + AESGCM both present) and Flutter's `payload_crypto.dart` (+ `pointycastle` for Scrypt — package:cryptography has none). Sync boundary mirrors the TS reference: decrypt before validate/apply at the single remote-apply chokepoint; encrypt a COPY at push (outbox + local echo stay plaintext). Locked workspaces: no key ⇒ remote `$e` envelopes are skipped with a warning (cursor still advances), local writes stay plaintext — identical across all three.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §1, §2.

## Global Constraints

- The wire and fixtures are untouched — this is runtime behavior convergence, not a wire change (plan 03 closed the fixture debt). KDF-record interop is pinned by test VECTORS (fixed salt/iv/master bytes + expected wrapped record + verifier), ported per repo — NOT new corpus files (corpus loaders treat every JSON as an envelope fixture).
- scrypt params are fixed: N=131072, r=8, p=1, dkLen=32 — byte-compat with the server record (`apps/server/src/auth.ts:324-349`) is the contract (plan 01's TS golden vector is the reference).
- Outbox/mirror/local-echo stay plaintext; only the wire gets ciphertext. Snapshot blobs seal/decrypt at the engine boundary when a key is present.
- Locked semantic (all three): no key + `$e` envelope ⇒ skip + counted warning, cursor advances, sync stays green; plaintext envelopes still apply.
- Keys are memory-only in every client; never persisted (GTK has no keyring — memory-only is the accepted pattern, same as web).
- Gates: main `pnpm test`; GTK `uv sync && uv run pytest && uv run ruff check && uv run mypy src` (+ deliberate live-e2e run); Flutter `flutter pub get` + both patch scripts + `flutter analyze` + `flutter test`.
- Changelog per repo convention; per-file staging; other sessions' files untouchable.

## Review Focus

1. **Interop vectors**: each repo's KDF test proves its scrypt+wrap opens the SAME record bytes the server/TS produces (fixed-vector equality, not just round-trip).
2. **Encrypt-a-copy**: outbox rows, local echo, and mirror application must never see the sealed envelope.
3. **Locked skip**: with no key, a batch of mixed plaintext + `$e` envelopes applies the plaintext, skips the `$e`, advances the cursor, syncs green — pinned in all three.
4. **Wrong-password surface**: GTK/Flutter login with a kdf record that doesn't open ⇒ login-level error, not a silent unencrypted session.
5. **First-write-wins**: sibling PUT 409 ⇒ re-GET + adopt (plan 02 semantics — no split keys).

---

### Main repo (web)

**W0 — locked-sync semantics (the gap both surveys found).** Today a keyless engine pulling a keyed workspace hits the store's `$e` validation reject and error-loops. Fix: in `packages/sync` (or the store's remote validation path — the cheapest correct seam), when NO crypto provider is installed, `$e` envelopes are skipped with a counted log warning instead of throwing; cursor advances. When a provider IS installed, decryption failure still throws (real corruption). Tests: mixed batch keyless ⇒ plaintext applied + `$e` skipped + green; with key ⇒ decrypt path unchanged. Commit `fix(sync): skip encrypted envelopes when unlocked (no more error-loop)`.

**W1 — locked-state plumbing + banner.** Thread "keyed-but-locked" from `resolveWorkspaceKey` (`apps/web/src/ui/app/store-connection.ts:60-93`) through `ConnectOutcome` → `useWorkspaceConnection` → a new `EncryptedLockedBanner` ui-kit component (sibling of `InProcessStoreBanner`, one element per file, co-located CSS, token-only) rendered from `AppOverlays.tsx:55` — states the consequence (writes are plaintext) + an unlock affordance.

**W2 — unlock flow.** Modal (ui-kit patterns) asking for the account password (email shown from `user.email`, available via boot `fetchMe`); on submit: `login(email, password)` (`auth-api.ts:111` — returns fresh kdf), `deriveMasterKey(password, response.kdf)` (existing), then re-open the workspace connection so the engine gets the provider. Surface `account_locked` (429, retry-after) distinctly. Wrong password shows the form error (lockout counter is server-side). Tests at the App level (pattern from `auth-custody-flow.test.tsx`).

**W3 — changelog + docs.** Both W0-W2 under one `2026-11-03` entry (or a new dated section per format); architecture.md: locked semantics + unlock flow replace the "console-only fast-follow" paragraph.

### GTK track (/root/projects/notees-gtk)

**G1 — crypto custody half.** Extend `src/notees_gtk/core/protocol/crypto.py`: `b64u_encode`, `scrypt` KDF (cryptography `Scrypt`), `create_kdf_record`/`unwrap_master_key` (verifier over the DERIVED key, HMAC-SHA256 "notees-key-check", fail-fast), `generate/wrap/unwrap_workspace_key` (`iv‖tag‖ct` b64u — opposite order of the payload slot, documented), `encrypt_payload`/`encrypt_envelope`, `encrypt_bytes`/`decrypt_bytes`. Tests: the plan-01 golden vector ported (fixed salt/iv/master ⇒ exact wrapped-record + verifier strings) + round-trips + wrong-password verifier failure.

**G2 — key routes.** `NoteesClient.fetch_workspace_key` / `store_workspace_key` (copy `list_workspaces`/`patch_prefs` patterns, `client.py:248-285`); 409 ⇒ adopt winner. Tests on the `_router` MockTransport harness.

**G3 — engine boundary.** `SyncEngine` constructor `crypto=` + `set_crypto` (sync — `cryptography` is sync); decrypt in `_apply_guarded` (`core/sync/engine.py:262-268`) before `store.apply_remote`; encrypt a COPY in `push()` before `client.submit_batch` (:136-174) — outbox rows + the mirror's self-apply (:164-172) stay plaintext; snapshot download decrypt at `:392-393` (and seal before the future upload path); locked skip per Global Constraints. Engine tests on the `FakeRelayClient` harness: wire ciphertext + plaintext mirror; locked mixed batch; round-trip two-device convergence.

**G4 — custody wiring.** Login (`ui/login.py:128-147`): thread `(kdf, password)` through `work()` → `_on_logged_in` → a session-scoped in-memory key holder on the window (never into `ClientConfig`/config.json); wrong password at the verifier ⇒ login-page error. `_on_workspace_selected` (`window.py:414-435`): fetch-or-ensure workspace key → engine crypto. Key-only (API-key) configs: custody unavailable — workspaces stay keyless (the server keyless-seed shim still serves them); document.

**G5 — gate + changelog + live-e2e.** Full gate; run `tests/test_live_server_e2e.py` deliberately (SKILL.md:71-77); CHANGELOG entry.

### Flutter track (/root/projects/notees-flutter)

**F1 — pointycastle Scrypt.** `flutter pub add pointycastle`; verify the `Scrypt` API in the pinned version; wrapper in the crypto module. (Ruling: dependency over vendoring — mature pure-Dart, no native code.)

**F2 — custody half of `payload_crypto.dart`.** `b64uEncode`, scrypt KDF record (create/unwrap + verifier), workspace key wrap/unwrap, `encryptPayload`/`encryptEnvelope`/`encryptBytes`/`decryptBytes` — mirroring `crypto.ts`. Same golden vector as G1 (exact-string equality) + round-trips.

**F3 — key routes.** `relay_client.dart`-style GET/PUT on the Dio client; 409 ⇒ adopt winner; tests with the fake-Dio pattern.

**F4 — sync boundary.** Decrypt in `_applyServerEnvelopes` (`lib/domain/services/sync_v2_service.dart:571-602`) before `RelayAppliers.apply`; encrypt a COPY in `flush()` before `_relay.pushBatch` (:333) — outbox row + `_applyLocalAndRecord` (:404) stay plaintext; locked skip per Global Constraints (skip inside `_applyServerEnvelopes` when no key, counted warning); snapshot shortcut path sealed/decrypted symmetrically if present. Tests: fake-Dio sync suites + two-device convergence.

**F5 — auth wiring.** `auth_repository._handleTokenResponse` (:163-176): consume `kdf` → in-memory master holder (Provider-scoped; never secure_storage — same threat model as web's memory-only); login wrong-password verifier error surfaces on the form. Workspace open: fetch-or-ensure key → SyncV2Service crypto setter.

**F6 — gate + changelog.** Full Flutter gate; CHANGELOG entry.

## Post-plan operator action (not code)

Flip `NOTEES_E2EE=on` in the deployment and run the history-migration script (next plan) for existing workspaces.

## Self-review record

- The locked-skip semantic (W0 + G3 + F4) is the plan's spine — all three clients must converge on it; the plan-03 fixture gate is unaffected (runtime behavior, not wire).
- Type/shape consistency: `EnvelopeCrypto`-equivalent surface per repo (encrypt/decrypt envelope + snapshot bytes); KDF record shape = server's; workspace key = b64u `iv‖tag‖ct`.
- Review Focus: pinned in W0/G3/F4 (locked skip), G1/F2 (interop vectors), G3/F4 (encrypt-a-copy), G4/F5 (wrong-password), G2/F3 (409 adopt).
