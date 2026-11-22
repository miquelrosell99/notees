# Per-node sharing between users — proposal

Date: 2026-11-22. Status: **slices 1–4 SHIPPED 2026-11-22** (slice 1 + the server
half of slice 4 in the morning commit; slices 2–3 + the app-side hover gate in
the afternoon commit — see `CHANGELOG.md` 2026-11-22). Only the parked
confidential-sharing variants (§3.3: user keypairs / shadow workspaces)
remain. Scope: grants model, contamination hardening for links inside shared
renders, node attribution fields. Builds on `docs/features/sharing.md` (the
read-only public link slice) and the parked write-collaboration variant it
names.

## 1. What exists today (the baseline this proposal extends)

- **Public share links** (`GET /s/<token>`, `apps/server/src/routes-shares.ts`):
  token capability, read-only static HTML, owner/admin of the default
  workspace only, state in the server's coordination DB (deliberately not
  op-log state). Plan 08 added the sealed-artifact variant: the owner's client
  renders + seals the subtree, PUTs only ciphertext, the key rides in the
  link `#fragment` — the only sharing shape that survives mandatory workspace
  keying (`NOTEES_REQUIRE_KEYED`, default on).
- **Workspace membership** is the only between-user boundary
  (`workspace_member`, `apps/server/src/auth.ts:222`): all members sync the
  same op log with full read/write; the single role is `owner`; there are no
  per-node permissions.
- **Traceability** today = envelope v3's `actorId` + `deviceId` + HLC on every
  op (`packages/protocol/src/envelope.ts:48`); the only UI surface is the
  property history modal's actor uuid prefix.
- The `node` derived table (`packages/store/src/schema.ts:130`) carries **no
  attribution columns** — `created_by`/`created_at`/`updated_by`/`updated_at`
  do not exist as projections.

## 2. Grant model — per-node, subtree-inheriting, coordination state

New server coordination table (same ruling as shares: access control is not
semantic graph state and never joins the op log):

```
node_grant (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,            -- the grant root
  grantee_kind TEXT NOT NULL,       -- 'user' | 'email' | 'public'
  grantee_user_id TEXT,             -- kind='user'
  grantee_email TEXT,               -- kind='email' (pending until matched)
  role TEXT NOT NULL,               -- 'read' | 'edit'  (read-only DEFAULT)
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)
```

Design rulings:

- **Subtree inheritance is the whole contract.** A grant covers the entire
  descendant closure of `node_id` (embedded blocks AND standalone subpages —
  both are children; the render closure in `share-render.ts` already models
  the embedded arm). Children created later inside the closure are covered
  automatically, because coverage is a *read-time derivation over parentage*
  (the server holds the derived store), not a stored list. The motivating
  case — project node shared with edit → the whiteboard child is editable
  with zero extra grants — falls out for free.
- **Read is the default role.** Edit is an explicit choice at grant time.
  This also retroactively describes today's public links: a public link IS a
  `grantee_kind='public', role='read'` grant with a token capability instead
  of a user — the routes can migrate onto the grant table without a behavior
  change (kept as an implementation detail; token links stay the public UX).
- **`email` grantees** resolve lazily: the grant sits pending until an
  account with that email exists (signup is env-gated, default off — email
  grants are the natural pairing with turning it on for family). Revocable
  while pending. No invite tokens, no magic links in v1 — honest pending
  state beats fake invites.
- **Management surface**: the node's Share modal gains a people section
  (add by email/user, role picker defaulting to read, per-grant revoke) and
  the Shares hub (`/shares`) gains two lists: **Shared by me** and
  **Shared with me** (the parked "Shares Inbox" from
  `docs/features/sharing.md:25`).

## 3. The E2EE crux — what grants can and cannot promise

Mandatory keying changes what a grant can mean. Three enforcement levels,
stated honestly:

1. **View filtering (UX boundary)** — the app shows the grantee only grant
   roots and their closures ("Shared with me" opens the node with chrome
   bounded at the grant root: no parent breadcrumb above it, child navigation
   unbounded below). This is what the spouse case needs. It is *not* a
   confidentiality boundary: a member with the workspace key could in
   principle sync the whole log.

2. **Write-guarding (integrity boundary, best-effort under seal)** — the
   relay rejects ingest envelopes whose `affectedNodeIds`
   (`envelope.ts:57`, declared per op in `op-catalog.ts`, outside the
   sealable payload) step outside the writer's edit-grant closure. This
   works for sealed payloads — the relay can ACL-check what it cannot read —
   but it leans on clients populating `affectedNodeIds` faithfully; a
   malicious sealed envelope could under-report. **Ruling: v1 targets the
   trusted circle** (family/team on your own server). The limitation is
   written into the docs, not hidden. Truly adversarial grantees require the
   parked variant below.

3. **Confidential non-member sharing (parked, named)** — two honest routes,
   both out of v1: (a) user keypairs + per-grant re-encryption (the
   artifact pattern generalized from plan 08 — big new crypto surface), or
   (b) **shadow workspaces**: the granted subtree materializes in a separate
   workspace the grantee joins fully (real key isolation, real integrity),
   kept in step by a bidirectional mirror with attribution preserved.
   (b) is the recommended v2 if confidential sharing ever graduates from
   parked; it trades copy semantics for genuine isolation.

## 4. Link-contamination hardening

The leak today: `renderSharedNode`'s `nameOf`
(`apps/server/src/share-render.ts:55`) resolves the display name of **any**
active node in the store — a shared page's link to a private node embeds the
private node's *title* in the public document. In-app, `NodeHoverPreview`
loads the linked node's content on hover with no access notion.

Rulings:

- **Static renders (public link + sealed artifact)**: links whose target is
  outside the share closure render as **inert plain text** — no href, no
  title leak, no hover affordance. (Linking to a target that happens to have
  its own live public share is a future nicety, parked.)
- **App shared views**: the client learns its grant closures from a grants
  endpoint and gates hover preview through it — covered target → normal
  hover; uncovered → title-only chip with a "not shared with you" affordance,
  no content fetch. Same gate guards click-through. The owner viewing their
  own graph is untouched (full closure).
- Both ride one server-side primitive: `canView(user, nodeId)` /
  `canEdit(user, nodeId)` resolved against the derived store's parentage —
  the same primitive the write-guard uses.

## 5. Node attribution fields — created/edited by/at

Yes, and **no wire change is needed**: every envelope already carries
`actorId`, `timestamp`, and HLC; the fields are pure derived projections.

- Store: `node` gains `created_at`, `created_by`, `updated_at`,
  `updated_by` — written by the appliers (first create / latest touching op;
  moves and trash count as touches — the exact op set pinned in the slice).
  Derived-schema bump, wipe-rebuild converges every replica; no log
  migration.
- **The honest caveat**: `actorId` is a per-device UUID, not a user account.
  Resolving it to a human needs a registry: a coordination table
  `actor_claim(user_id, actor_id)` populated by the relay at first
  authenticated write from that actor. UI shows the resolved name when
  known, else the uuid prefix (today's behavior).
- Surface: the properties/metadata panel gains Created by / Created /
  Last edited by / Last edited rows.

## 6. Phasing

1. **Attribution** — store columns + applier writes + actor registry +
   metadata rows. Self-contained, no ACL, no wire change.
2. **Grant model + surfaces** — table, Share-modal people section, Shares
   hub inbox, closure-bounded shared view, `canView`/`canEdit` primitives.
3. **Edit grants + write-guard** — relay ingest check on
   `affectedNodeIds` coverage for restricted writers; trusted-circle
   limitation documented in `docs/features/sharing.md`.
4. **Contamination hardening** — closure-aware link rendering in both share
   paths + the app hover/click gate.
5. **Parked** — confidential non-member sharing (§3.3): user keypairs or
   shadow workspaces, whichever the owner picks when it graduates.

## 7. Open questions for the owner

- Subtree closure: embedded children + standalone subpages both, or
  embedded-only (the current share-render closure)? Recommendation: both —
  "children are shared" should not depend on the embedding flag.
- Edit grants: is trusted-circle (write-guard on `affectedNodeIds`) enough
  for the foreseeable fleet, or does confidential sharing need to graduate
  from parked now rather than later?
- Email grants: pair with enabling signup on the family server, or keep
  accounts operator-minted and grant by user only?
