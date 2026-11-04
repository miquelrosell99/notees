# E2EE core — Plan 08: key-in-fragment public shares

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Public page shares become client-encrypted artifacts with the decryption key in the URL `#fragment` (Standard Notes / Proton Drive pattern, spec §4): publishing renders the shared subtree to a self-contained HTML artifact, seals it with a fresh random share key, and stores only the ciphertext server-side; `GET /s/:token` serves a minimal viewer that decrypts locally with the fragment key. The server never sees the key or the content. Legacy plaintext shares keep serving until re-published.

**Architecture:** Server: a `share_artifact` column (or new table) holds `{ciphertext}` sealed as `iv‖tag‖ct` (self-contained blob — the viewer needs only the key); `GET /s/:token` embeds the ciphertext (base64) in a static, dependency-free viewer page (inline script, WebCrypto AES-GCM, decrypt → `document.write`/`innerHTML` injection into a sandboxed container). Publish/revoke are authenticated workspace-member routes (the web client calls them). Legacy rows (no artifact) keep the existing server-rendered path untouched. Web client: the share dialog renders the subtree via `@notees/export`'s HTML serializer, seals with a random 256-bit key, POSTs, and presents `https://<host>/s/<token>#<key>` with a copy affordance that preserves the fragment; re-publish replaces the artifact.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` §4.

## Global Constraints

- The key NEVER reaches the server: fragment-only client-side, the publish route carries only ciphertext, the viewer reads `location.hash`.
- Viewer is one request, zero build dependencies, no external scripts/styles (a share must render on anyone's browser, forever).
- Legacy shares (rows without an artifact) keep serving server-rendered until re-published; revoke works for both.
- Sealed artifact format: random 12-byte IV, blob `iv(12)‖tag(16)‖ct`, b64u when embedded in the viewer — one format, documented in the viewer module header.
- House laws: OpenAPI inventory, changelog, docs (api.md shares section, architecture §4 status), per-file staging, `pnpm test` green.

## Review Focus

1. The fragment key never appears in any request (network-level: publish body, viewer page source contains ciphertext but the DECRYPTION key is absent by construction).
2. The viewer renders the artifact only after successful GCM auth (tampered artifact ⇒ clear error page, no partial render).
3. Revoked/missing tokens behave as today (404).
4. Legacy rows unaffected.
5. The copy affordance preserves the `#key` (a copied link WITHOUT the fragment must warn — it would open an undecryptable share).

---

### Task 1: server — artifact column + viewer + publish/revoke routes
Additive `share_artifact TEXT` column (guarded ALTER) on the share table; member-authenticated `PUT /api/shares/:token/artifact` (body `{ciphertext}` zod-validated, max 5 MiB) + `DELETE` existing revoke untouched; `GET /s/:token`: if the row has an artifact, serve the viewer page with the ciphertext embedded; else the existing render path. The viewer: inline JS, WebCrypto, format `iv‖tag‖ct`, error surface for auth failure. Tests: publish round-trip (ciphertext stored verbatim), viewer HTML contains the ciphertext but never the key, legacy row serves the old render, revoke 404s both.

### Task 2: web client — publish flow + dialog
Share dialog: render subtree to a self-contained HTML artifact (the existing server-render used `@notees/export` — reuse the same serializer client-side), seal with `crypto.getRandomValues(32)`, POST the artifact, build the `#key` URL (b64u key), copy button copies the full URL WITH the fragment; copying without the fragment (or a "link only" mode) shows a warning that the share is undecryptable without the key. Re-publish replaces. Tests: the publish payload is ciphertext-only; the URL construction pins the fragment; the warning fires.

### Task 3: gate + changelog + docs
`pnpm test` exit 0; api.md shares section; architecture.md §4 status (shipped: key-in-fragment); CHANGELOG.

## Self-review record
- Single-repo plan (server + web); one implementer, one reviewer, one final review.
- Sibling clients don't create shares today — GTK/Flutter share CONSUMPTION (opening a key-in-fragment URL in a browser works natively; in-app consumption is future debt, recorded in the changelog, not built here).
