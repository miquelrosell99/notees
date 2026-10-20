# Sharing

Sharing a page mints a link, not a copy: the public view renders the page's *live* subtree at request time, and revocation or trashing the page ends it immediately. Sharing is **read-only by design**: you mint an unguessable link, anyone holding it reads a static render of that one page — no account, no app, no write path. (Collaborative editing over shares is a different, parked feature; the public-read slice is what exists.) The HTTP endpoints are [api.md](../api.md)'s.

## Create

The node menu (context menu / page header / "…" button) → **Share…** → **Create link**. The modal shows the full URL with a **Copy** button; every link ever minted for the page lists there (newest first), each revocable on its own. **The link is the whole contract.** No viewer accounts, no permissions matrix — possession of the unguessable URL is the capability. The modal says so in one honest line ("Anyone with the link can read this page"), and the threat posture lives in the docs, not in scare chrome: no directory listing (unknown, revoked, and expired links answer the identical 404), optional expiry, immediate revocation.

## What the visitor gets

`GET /s/<token>` answers one self-contained HTML document: the page title, its block tree as nested lists, its properties — the same hardened projection the HTML export uses ([exporting.md](exporting.md)). No JavaScript, no external resource, a strict content-security-policy, `no-store` caching, and no referrer leakage; the link carries no hint of your workspace or other pages. The viewer gets a document, not the app — no app chrome, no write surface of any kind; a strict CSP, `no-store`, and a no-referrer policy ride along so the link leaks nothing (not even back to itself).

## The Shares hub and the manager

Every live link in the workspace also rides the **Shares** hub (the account popup → Shares, deep-linkable at `/shares`): the shared node's icon and name, the link, created/expiry stamps, **Copy**, **Open**, and the same inline-confirmed **Revoke**. The modal lists every link with **Copy** and **Revoke**; revocation takes effect immediately. **The manager is deliberately small.** Create → the URL appears with Copy; every live link lists with an inline two-step Revoke (never a bare danger click, never a confirm dialog for a reversible-in-spirit action — the row stays, dimmed, as history). No per-link analytics exist to show: the server does not track viewers, and the UI doesn't pretend otherwise.

## Revoke and expiry

Revocation is immediate: the next request on that link 404s. Trashing the page kills its links the same way. Minting may also set an `expiresAt` (API/CLI option) after which a link dies on its own.

## The threat model, honestly

Possession of the link IS the capability — treat a shared URL like a password: anyone it reaches can read the page until you revoke, and the server does not track viewers. There is no directory listing: tokens are 24 random bytes (base64url), and unknown, revoked, and expired links answer the *same* 404, so nothing can be enumerated or probed. Share state lives in the sync server's coordination database — it is deliberately NOT operation-log state (nothing about an expiry or a revocation belongs in the semantic graph every client converges on). Only the server's default workspace can be shared, and only its owner/admin (or the operator key) can mint, list, or revoke.

**What is parked.** The write-collaboration share variant (per-user shares, a Shares Inbox, edit access over a link) stays parked — the read-only public link is the whole sharing surface.

Headless: `POST /api/shares {nodeId, expiresAt?}` → `{share: {token, urlPath, …}}`, `GET /api/shares?nodeId=`, `DELETE /api/shares/:token` (see [api.md](../api.md)).
