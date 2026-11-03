# E2EE core — Plan 03: fixture lockstep convergence (GTK + Flutter) + E2EE opt-in gate

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Close the lockstep debt from plan 01: both sibling clients (notees-gtk, notees-flutter) re-vendor the fixture corpus and converge on `envelope-encrypted.json` byte-identical (decrypt with the fixture key, validate opened payloads against their strict schemas, replay to identical derived state). Plus a main-repo kill switch so no workspace gets encrypted before siblings can decrypt at sync time.

**Architecture:** Both repos already shape-validate the `$e` slot and reject it at apply time. The lockstep work is: re-vendor the corpus, add a minimal decrypt module to each (GTK: `cryptography`; Flutter: already-present `package:cryptography`), teach the fixture gates the decrypt-and-validate branch, and decrypt crypto-carrying fixtures in the replay harnesses (test support only — runtime sync still rejects `$e`; sibling custody is plan 04). Apply-time rejection STAYS in both repos.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §7.

## Global Constraints

- Fixture bytes are byte-pinned in both repos — never edit; re-vendor by verbatim copy + verification (GTK: `diff -r` vs the monorepo checkout; Flutter: per-file `sha256sum`).
- The fixture `crypto` block: `workspaceKey` = b64u 32 bytes; AAD = `${envelope.id}.${envelope.workspaceId}`; slot `iv` = b64u 12-byte nonce; slot `ct` = b64u `tag(16) ‖ ct` (tag FIRST — differs from wrapped keys `iv‖tag‖ct`); plaintext = UTF-8 JSON.
- The apply-time `$e` rejection stays (siblings don't sync encrypted workspaces until plan 04 custody).
- GTK gate: `uv sync && uv run pytest && uv run ruff check && uv run mypy src`. Flutter gate: `flutter pub get && python3 scripts/patch_kgp_plugins.py && python3 scripts/patch_mdi_icons.py && flutter analyze && flutter test`.
- Each repo's CHANGELOG entry, per its own convention. Follow each repo's project skill laws.
- Main-repo gate after the kill switch: `pnpm test` green.

## Review Focus

1. The decrypted payload validates against the sibling's strict per-opType schema (not just "decrypts to something").
2. The tag-first `ct` layout — a port that assumes WebCrypto's ct‖tag fails the fixture; pin a wrong-layout negative test if cheap.
3. Auto-glob replay suites must include the encrypted fixture DECRYPTED (never apply a raw `$e` envelope).
4. Coverage lists (hardcoded fixture name lists in both repos) gain the file — no silently-skipped fixture.

---

### Task 0 (main repo): E2EE opt-in kill switch

**Files:** Modify `apps/web/src/types/notees-config.d.ts`, `apps/web/src/ui/app/store-connection.ts` (the keying call), the docker entrypoint config script (`apps/web/docker-entrypoint.d/50-notees-config.sh`), tests.

- [ ] The web client keys workspaces (calls `ensureWorkspaceKey`) ONLY when `window.NOTEES_CONFIG.e2ee === "on"`; default (absent/other) = off = today's keyless behavior. Config type + entrypoint passthrough (`NOTEES_E2EE` env → config.js field) mirroring `NOTEES_SERVER_URL` handling. Test: with the flag absent, open does NOT call the key route (keyless plaintext path preserved).
- [ ] `pnpm test` green; commit `feat(web): gate E2EE keying behind an opt-in config flag (default off until client lockstep converges)`; CHANGELOG line in the same commit (small).

### GTK track (/root/projects/notees-gtk)

**G1. Re-vendor the corpus.** Copy `/root/projects/notees/packages/protocol/fixtures/` → `tests/fixtures/wire/` (the corpus grew 48→49 + changed bytes); verify `diff -r` clean. Expect a RED gate (unknown fixture) — that's the TDD floor. No commit yet (land with G3's green gate, or commit the vendor separately per repo convention — the repo law says never hand-patch; a pure re-vendor commit is fine: `chore(tests): re-vendor wire fixture corpus`).

**G2. Crypto module.** `uv add cryptography`. New `src/notees_gtk/core/protocol/crypto.py`: `b64u_decode`, `decrypt_payload(workspace_key_bytes, aad, slot) -> dict`, `decrypt_envelope(key_bytes, envelope) -> envelope` (passthrough for plaintext payloads), with the tag-first ct layout (`tag = raw[:16]; ct = raw[16:]`) and AAD. Tests: fixture vector — decrypt `envelope-encrypted.json`'s envelopes with its `crypto.workspaceKey` and assert the opened payloads deep-equal the expected plaintexts (hardcode the two expected payloads in the test); negative: wrong AAD fails, tampered ct fails, a ct‖tag misread fails.

**G3. Fixture gate branch.** `tests/test_fixtures.py`: add `envelope-encrypted.json` to `WIRE_ENVELOPE_LIST_FIXTURES`; the strict-payload assertion gains the `$e` branch — slot shape, then `decrypt_envelope` with the fixture key, then `validate_payload(op_type, opened)`. `tests/test_payloads.py`: a case pinning that raw `$e` payloads are NOT schema-validated but opened payloads ARE.

**G4. Replay harness decryption.** `tests/test_store_fixtures.py` (and any other auto-glob consumer): when a fixture JSON carries `crypto`, decrypt each envelope before replay. `REPLAY_EXCLUDED` must NOT gain the file — it replays decrypted, joining the convergence/idempotence suites.

**G5. Gate + changelog.** Full gate (`uv sync && uv run pytest && uv run ruff check && uv run mypy src`) green; CHANGELOG entry per repo convention (mechanism, fixture count, test counts, lockstep context).

### Flutter track (/root/projects/notees-flutter)

**F1. Re-vendor the corpus.** Copy `/root/projects/notees/packages/protocol/fixtures/` → `test/fixtures/wire/`; verify per-file `sha256sum` against the monorepo checkout. Expect RED. Pure re-vendor commit per repo convention.

**F2. Crypto module.** No new dependency (`cryptography: ^2.8.1` already in pubspec). New `lib/domain/models/relay/payload_crypto.dart`: b64u helpers on top of `dart:convert` (`base64Url` + manual unpadded re-pad on decode), `decryptPayload(SecretKey, aad, slot)`, `decryptEnvelope(SecretKey, envelope)` passthrough — `package:cryptography` `AesGcm`: split slot ct into `mac = raw.sublist(0,16)`, `cipherText = raw.sublist(16)` (tag-first!), `AesGcm().decrypt(SecretBox(cipherText, nonce: iv, mac: Mac(mac)), aad: utf8.encode(aad))`. Tests mirror G2 (fixture vector, wrong-AAD, tamper, misread negative).

**F3. Fixture gate branch.** `test/fixtures_test.dart`: add to `envelopeListFixtures`; the `validatePayload` assertion gains the `$e` branch (decrypt + validate opened payload).

**F4. Replay harness decryption.** `test/fixture_replay_test.dart` auto-glob consumer: decrypt crypto-carrying fixtures before replay; `replayExcluded` unchanged (no exclusion).

**F5. Gate + changelog.** Full Flutter gate green (pub get + BOTH patch scripts + analyze + test); CHANGELOG per repo convention.

## Self-review record

- Scope: fixture lockstep only. Sibling runtime custody (decrypt in the sync path, key fetch/unwrap at login) is plan 04 — the kill switch (Task 0) is the safety seam until then.
- Type/shape consistency: both ports consume the same fixture contract documented in its comment; apply-time `$e` rejection preserved in both (verified as pre-existing behavior in the survey).
- Review Focus: pinned in G2/F2 (tag-first negative), G3/F3 (opened-payload schema), G4/F4 (decrypted replay), coverage lists (G3/F3).
