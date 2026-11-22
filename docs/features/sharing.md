# Sharing

Sharing a page mints a link, not a copy: the public view renders the page's *live* subtree at request time, and revocation or trashing the page ends it immediately. Public sharing is **read-only by design**: you mint an unguessable link, anyone holding it reads a static render of that one page — no account, no app, no write path. Sharing **with people** is the other half: per-node grants give a workspace member read or edit access to a node and its whole subtree (below). The HTTP endpoints are [api.md](../api.md)'s.

## Create

The node menu (context menu / page header / "…" button) → **Share…** → **Create link**. The modal shows the full URL with a **Copy** button; every link ever minted for the page lists there (newest first), each revocable on its own. **The link is the whole contract.** No viewer accounts, no permissions matrix — possession of the unguessable URL is the capability. The modal says so in one honest line ("Anyone with the link can read this page"), and the threat posture lives in the docs, not in scare chrome: no directory listing (unknown, revoked, and expired links answer the identical 404), optional expiry, immediate revocation.

## What the visitor gets

`GET /s/<token>` answers one self-contained HTML document: the page title, its block tree as nested lists, its properties — the same hardened projection the HTML export uses ([exporting.md](exporting.md)). No JavaScript, no external resource, a strict content-security-policy, `no-store` caching, and no referrer leakage; the link carries no hint of your workspace or other pages. The viewer gets a document, not the app — no app chrome, no write surface of any kind; a strict CSP, `no-store`, and a no-referrer policy ride along so the link leaks nothing (not even back to itself).

**References to nodes outside the shared subtree are redacted.** A mention, class link, or relation value pointing at anything that is not a descendant of the shared node renders as the neutral "not shared" label — never the target's title, never its raw uuid — in both render paths (the server render and the plan-08 sealed artifact, whose export passes the same gate). A link to a node inside the subtree (including standalone subpages, which the single-file render does not otherwise include) resolves normally. This closes the title-leak a shared page's link into a private node used to be.

## The Shares hub and the manager

Every live link in the workspace also rides the **Shares** hub (the account popup → Shares, deep-linkable at `/shares`): the shared node's icon and name, the link, created/expiry stamps, **Copy**, **Open**, and the same inline-confirmed **Revoke**. The modal lists every link with **Copy** and **Revoke**; revocation takes effect immediately. **The manager is deliberately small.** Create → the URL appears with Copy; every live link lists with an inline two-step Revoke (never a bare danger click, never a confirm dialog for a reversible-in-spirit action — the row stays, dimmed, as history). No per-link analytics exist to show: the server does not track viewers, and the UI doesn't pretend otherwise.

## Sharing with people — per-node grants (trusted-circle v1)

The Share dialog's **People with access** section grants a workspace member **read or edit** access to one node and **everything under it** — coverage is the grant root's whole descendant closure, derived at read time over parentage, so children created later are covered automatically (share a project node and the whiteboard child inside it is shared with zero extra grants). **Read is the default role**; edit is an explicit choice. The grantee needs an account on this server: the owner demotes her membership to role **"member"** (restricted) via the workspace's member settings, and an email that matches no account yet rides as a **pending** grant — it starts working the moment someone registers with that email (no invite tokens).

Two enforcement levels, stated honestly:

- **Write is a real boundary.** The relay rejects a restricted member's ingest whose envelopes' `affectedNodeIds` step outside her edit-grant closures (403) — this holds even for sealed payloads, because the affected ids travel outside the seal. It leans on clients declaring `affectedNodeIds` faithfully, and a sealed create's brand-new id has no row yet (its placement is client-trusted) — the model targets family/team on your own server, not adversarial grantees.
- **View is a UX boundary.** A restricted member holds the workspace key (the op log is the sync boundary), so hiding is not confidentiality: the app shows her the **Shares hub's "Shared with me"** list, gates hover previews of out-of-closure nodes to an honest "not shared with you" chip, and the server stops her WRITES outside the closures. Confidential sharing for non-members stays parked (user keypairs / shadow workspaces — the proposal's §3.3).

Grants are coordination state, not op-log state (the prefs/shares ruling), and manage like shares: the Share dialog lists them per node with per-grant Revoke; revocation drops the grant from the write-guard and every inbox immediately.

Headless: `POST /api/grants {nodeId, granteeUserId? | granteeEmail?, role?}` → `{grant}`, `GET /api/grants?nodeId=`, `DELETE /api/grants/:id`, `GET /api/grants/inbox` (the Shares Inbox), `PUT /api/workspaces/:id/members/:userId {role: "owner" | "member"}` (the restricted-role seam). See [api.md](../api.md).

## Revoke and expiry

Revocation is immediate: the next request on that link 404s. Trashing the page kills its links the same way. Minting may also set an `expiresAt` (API/CLI option) after which a link dies on its own.

## The threat model, honestly

Possession of the link IS the capability — treat a shared URL like a password: anyone it reaches can read the page until you revoke, and the server does not track viewers. There is no directory listing: tokens are 24 random bytes (base64url), and unknown, revoked, and expired links answer the *same* 404, so nothing can be enumerated or probed. Share state lives in the sync server's coordination database — it is deliberately NOT operation-log state (nothing about an expiry or a revocation belongs in the semantic graph every client converges on). Only the server's default workspace can be shared, and only its owner/admin (or the operator key) can mint, list, or revoke.

**What is parked.** Confidential sharing for non-members (per-user keypairs re-encrypting subtrees, or shadow workspaces — the proposal's §3.3) stays parked — grants today ride workspace membership, and the trusted-circle limits are written into the section above. Collaborative editing over public links stays parked with it: the public link is read-only, people grants are the write path.

Headless: `POST /api/shares {nodeId, expiresAt?}` → `{share: {token, urlPath, …}}`, `GET /api/shares?nodeId=`, `DELETE /api/shares/:token` (see [api.md](../api.md)).
