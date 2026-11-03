# E2EE core — Plan 05: CAS asset encryption

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Seal CAS asset bytes (covers, attachments) end-to-end: keyed clients encrypt before upload with a per-asset random IV stored as server-side asset metadata; downloads decrypt when the workspace key is available; keyless sessions keep today's honest plaintext fallback. No wire/protocol change (the IV stays out of the op log — no fixture-gate debt).

**Architecture:** The asset channel is separate from sync (`asset-transport.ts` — pure fetch on the main thread), and the custody cache already lives on the main thread, so asset crypto reuses it directly in both worker and in-process modes. Server: new nullable `asset.iv` column; upload gains multipart fields (`encrypted=1`, declared `mimeType`, `iv`) that skip magic-byte sniffing and store the declared type; `GET /assets/:id/info` and the upload response carry `iv`. Clients: small asset-byte helpers in the protocol crypto module (`iv` separate, blob = `tag‖ct`), encrypt-at-upload / decrypt-at-download keyed on `iv` presence + key availability. CAS dedupe keys on ciphertext hash (same sealed bytes re-uploaded still dedupe; identical plaintext from different uploads won't — accepted).

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §5.

## Global Constraints

- **No protocol/wire change** — `asset.attach` payload unchanged; the IV is server metadata, not op-log state. No fixture, no lockstep debt.
- Locked/keyless sessions are legal (mixed log): uploads without a key stay plaintext (`iv NULL`, sniffed as today); downloads of `iv`-carrying assets without a key show the existing honest-fallback chip (AssetView.tsx:11-15 precedent), never hard-fail.
- Server stores bytes only — no thumbnails/indexing exist, nothing else breaks with ciphertext; the server-side zip export emits ciphertext (plan 07 retires that route; noted).
- WebCrypto (`crypto.subtle`) for the helpers; ports use each repo's crypto conventions (GTK `cryptography`, Flutter `package:cryptography` — AES-GCM only, no scrypt needed here).
- Gates: main `pnpm test`; GTK `uv run pytest && uv run ruff check && uv run mypy src`; Flutter pub get + both patch scripts + `flutter analyze && flutter test`.
- Changelogs per repo; per-file staging.

## Review Focus

1. The IV is never required for correctness of anything except decryption — `iv NULL` rows behave exactly as today (round-trip).
2. Encrypted upload path: server skips sniffing ONLY when the client declares encrypted (a plaintext client can't smuggle a declared type past sniffing).
3. Decrypt failure with a key ⇒ honest error, never a corrupted render; no key + `iv` ⇒ fallback chip, never a throw.
4. Blob layout: stored bytes = `tag‖ct` (16-byte tag first) with the IV external — document in each module header (ports must match for cross-client asset sharing).

---

### Main repo

**M1 — protocol helpers + server asset.iv.**
- `packages/protocol/src/crypto.ts`: `encryptAssetBytes(workspaceKey, bytes): Promise<{ iv: Uint8Array; blob: Uint8Array }>` (random 12-byte IV; blob = `tag‖ct`) + `decryptAssetBytes(workspaceKey, iv, blob): Promise<Uint8Array>`; tests round-trip + tamper/wrong-key failures.
- Server (`apps/server/src/relay-storage.ts` DDL + `assets.ts`): `ALTER TABLE asset ADD COLUMN iv TEXT` (additive migration in the DDL-execution pattern); `POST /assets` accepts multipart fields `encrypted` (presence), `mimeType` (declared), `iv` — when `encrypted`, skip sniffing, store declared mime + iv; response `{assetId, hash, mimeType, size, originalName, refs, iv}`. `GET /assets/:id/info` includes `iv`. `recordAsset` carries iv. Tests: encrypted upload round-trips iv + declared type; plaintext upload still sniffs + iv null; download unchanged.

**M2 — web client asset crypto.**
- `apps/web/src/core/workspace-client/asset-crypto.ts`: main-thread helper reading the custody cache (crypto-custody `currentMasterKey`/`ensureWorkspaceKey` are main-thread; `asset-transport.ts` never enters the worker) — `sealAssetIfKeyed(serverUrl, token, workspaceId, bytes)` and `openAssetIfSealed(workspaceId, iv, blob)` (resolve the raw key from the custody cache; keyless ⇒ passthrough).
- Upload call sites (`asset-transport.postAssetUpload` signature gains the sealed bytes + fields; coverProperty.ts:48-61, AssetUploadModal.tsx:188-212, quickCreate.ts:564, logseq-folder.ts:238 pass them) — encrypt when a key resolves, else today's path.
- Download path (`fetchAssetBlob` callers: getAssetDataUrl client-reads-props.ts:176-186, AssetView.tsx:52-77, renderPdf.tsx:109-120, exportSubtree.ts): when the asset `iv` is present, decrypt with the resolved key; no key ⇒ the AssetView honest-fallback chip (extend it to sealed assets); decrypt failure ⇒ the same chip with an error note, never a corrupted render.
- Tests: seal/open round-trip; keyless passthrough both directions; sealed asset without key ⇒ fallback (not throw); server M1 contract via the existing route-test patterns.

**M3 — gate + changelog** (`pnpm test` exit 0; CHANGELOG entry).

### GTK track (/root/projects/notees-gtk)

**K1 — asset-byte helpers** in `core/protocol/crypto.py` (`encrypt_asset_bytes`/`decrypt_asset_bytes`, tag-first blob, random 12-byte IV) + round-trip/tamper tests.

**K2 — server client methods + asset I/O.** `NoteesClient` gains the encrypted-upload fields (`post_asset` equivalent — map the GTK asset upload/download code first: find it with grep for `/assets`) and passes `iv`/declared mime; download path decrypts when the asset info carries an `iv` and a workspace key is installed, else honest fallback. Wire into the GTK asset upload/download UI paths the same keyless rules.

**K3 — gate + changelog.**

### Flutter track (/root/projects/notees-flutter)

**D1 — asset-byte helpers** (`payload_crypto.dart`-adjacent module, `AesGcm`, tag-first) + tests.

**D2 — asset I/O.** Map the Flutter asset upload/download code (grep `/assets` under lib/); encrypt at upload when the custody master + workspace key resolve, pass `encrypted`/`mimeType`/`iv` fields; decrypt at download when `iv` present; keyless ⇒ passthrough; sealed-without-key ⇒ the existing asset error/fallback UI, never a throw.

**D3 — gate + changelog.**

## Self-review record

- No wire change ⇒ the plan-03 fixture gate is untouched; cross-client asset sharing works because all three ports share the tag-first blob + external-IV contract (Review Focus 4).
- The migration script (plan 06) will rewrite existing `iv NULL` blobs using these helpers' layout.
