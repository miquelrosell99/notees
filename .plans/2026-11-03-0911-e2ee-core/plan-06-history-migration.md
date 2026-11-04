# E2EE core — Plan 06: history migration (seal existing logs + assets in place)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** `scripts/migrate-e2ee.mts` — the one-time operator migration that seals an existing deployment: every plaintext envelope payload in the relay log becomes `$e` (ids, HLC, and all metadata preserved — only the payload changes), every plaintext asset blob is sealed with a fresh IV (asset row iv/hash/size updated, file moved to the new content-hash path), a workspace key is created per workspace (wrapped under the account master key, `workspace_key` row inserted), and clients converge via a restoreEpoch bump.

**Architecture:** Direct-DB operator tool in the house migration-script pattern (read `scripts/migrate-is-embedded.mts` as the closest analog — a full log rewrite). The script authenticates with nothing but filesystem access + the account password (env `MIGRATE_E2EE_PASSWORD` or interactive prompt): it reads the user's kdf record from relay.db, derives the master key (verifier fail-fast), and for each member workspace generates a wrapped workspace key and rewrites envelopes/assets in place. Idempotent (skips `$e` envelopes and `iv`-carrying assets). A `--dry-run` reports counts; a `--verify` pass reopens the DB read-only, decrypts every `$e` envelope with the workspace key, and validates payloads against `payloadSchemaFor`, and reopens every sealed asset — proving the rewrite before clients are allowed back.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §6.

## Global Constraints

- Ruling (supersedes the spec's "fresh HLCs" generality): **ids, HLCs, timestamps, and all envelope metadata are preserved — only `payload` changes.** Nothing semantic moves; LWW/conflict outcomes are byte-identical.
- The wire is untouched (payloads become the reserved slot) — no fixture, no lockstep debt. The script's crypto MUST come from `@notees/protocol` (dev-condition: build dist first) so the layout is the shipped one.
- restoreEpoch bump = the existing wipe-resync mechanism: clients park unsent ops, wipe, re-pull. The operator runbook (script header + docs) requires: pause clients → run migration → flip `NOTEES_E2EE=on` → restart clients.
- Server-side derived workspace stores are pruned (they would skip `$e` and become content-empty anyway).
- House laws: fail-loud (abort on any envelope that fails to seal or validate), per-file staging, CHANGELOG entry, docs (the migrations runbook home — check `docs/developers/migrations.md`).

## Review Focus

1. Idempotence: re-running the script after a partial run seals only what remains (already-`$e` / already-`iv` rows skipped and counted).
2. The `--verify` pass actually decrypts+validates every sealed envelope and reopens every sealed asset — a green verify is the only allowed "done" signal.
3. Asset hash/path move is atomic-consistent (row update + file move ordering, crash-safety note).
4. Password handling: never echoed, never persisted; the derived master key lives only for the process.
5. `--dry-run` makes zero writes.

---

### Task 1: skeleton + custody read
Follow `scripts/migrate-is-embedded.mts`'s conventions (imports, DB open, arg style). Args: `--data-dir`, `--email`, `--dry-run`, `--verify`, optional `--workspace <id>`. Read the user row + kdf record; derive the master key from `MIGRATE_E2EE_PASSWORD`/prompt (reuse `unwrapMasterKey` from `@notees/protocol`). Fail loud on unknown email / missing kdf / verifier mismatch.

### Task 2: envelope sealing pass
Per member workspace (or the filtered one): ensure a `workspace_key` row (generate + `wrapWorkspaceKey` + INSERT; skip if present). Rewrite each envelope whose payload is not `$e`: `encryptEnvelope(wsKey, envelope)` — ids/HLC/metadata preserved, payload replaced. Count sealed/skipped/failed; abort on first failure (transactional per workspace where the house pattern allows).

### Task 3: asset sealing pass
Per asset row with `iv IS NULL`: read bytes from the hash-addressed path, `encryptAssetBytes`, compute the new content hash, move the file to the new hash path, update the row (hash/size/iv). `asset_ref` dedupe bookkeeping: note the drift in the report (or recompute if trivially safe).

### Task 4: convergence + verify
Bump restoreEpoch (the server mechanism for wipe-resync — find the API/row the server uses), prune server-side derived workspace stores, print the operator report. `--verify`: read-only pass decrypting every `$e` envelope (payload schema validation) and reopening every sealed asset; non-zero exit on any failure.

### Task 5: runbook + changelog
Script header runbook (pause clients → dry-run → migrate → verify → flip `NOTEES_E2EE=on` → restart clients; rollback = restore relay.db + assets from backup) + the migrations doc home + CHANGELOG entry.

## Self-review record
- Single-repo sequential plan — one implementer, one reviewer, one final review.
- The spec amendment (preserve HLCs) is recorded in Global Constraints.
