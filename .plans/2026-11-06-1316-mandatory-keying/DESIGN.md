# Mandatory workspace keying — E2EE as a requirement

2026-11-06 · Status: proposed (design approved in session; awaiting spec review)

## Intent

Today keying a workspace is optional: plaintext workspaces are the default,
and a keyed workspace is something a user opts into. That is backwards for a
privacy-first, self-hosted product whose threat model includes the host
itself (VPS compromise, stolen backups, a curious operator). **Keying becomes
a requirement**: no new workspace is ever created unkeyed, every existing
plaintext workspace is nudged — persistently and honestly — toward keying,
and the entire dev-ops surface (migrations, verification, the smoke,
backups, health checks) works with keyed workspaces **out of the box**.

What this does NOT promise: history that was written plaintext can never be
made private — the operation log is immutable, so keying seals writes from
the keying moment forward. The requirement is enforced where it is
meaningful (nothing new is ever plaintext) and honest where it is not (old
plaintext is labeled, never silently treated as protected).

## Decisions (agreed in session)

1. **Scope**: new workspaces MUST be keyed (server-enforced); existing
   plaintext workspaces keep working but carry a persistent warning plus a
   one-click **Key this workspace** action. No hard deadline / no
   refusal-to-serve in this slice — a grace-period escalation is a possible
   follow-up. Rationale: the immutable log makes retroactive privacy
   impossible, so a deadline buys future-writes protection at the cost of
   breaking upgrades for other self-hosters; the owner fleet's real
   workspaces are already keyed.
2. **Dev-ops contract (the load-bearing addition)**: all developer/operator
   operations work with keyed workspaces out of the box, **including
   migrations**. Since the server cannot read sealed content, this is
   expressed as an explicit contract, not an aspiration (below).

## Enforcement (server — the guarantee)

- Workspace creation requires a key bundle. The creating client generates a
  workspace key (random), wraps it under the account master key (the
  existing password-custody machinery — plan-02 of the E2EE core; **no new
  crypto**), and uploads the wrapped key row WITH the create request.
- The server rejects creation without a valid key bundle — **422** whose body
  names the missing bundle (not a bare 404; creation is not the key-existence
  probe the custody routes 404-gate). Rejection is enforced in the workspace
  creation route, before any log/state is minted.
- **Escape hatch**: `NOTEES_REQUIRE_KEYED=1` (default ON). Off restores the
  legacy unkeyed creation path for dev/test fleets. Self-hosted operators own
  their threat model; the repo ships the requirement ON.
- **Fixtures**: the seeded demo workspaces (the `1111…` and
  `4b7d1a00-…-0099` ids the smoke and test harnesses use) are exempted at the
  gate by an explicit allowlist constant — the server must never hold keys,
  so it cannot key them at seed time. Keying fixtures at first client open is
  a future test-harness improvement, recorded as follow-up.
- Client-side-only enforcement is explicitly rejected as the sole mechanism
  (any old client bypasses it); clients complement the gate.

## Creation UX

- **Password session**: keying is invisible — the create flow derives/uploads
  the wrap as part of creation, before the workspace opens.
- **API-key-only session**: no password path exists, so creation fails with
  the established directional copy ("Sign in with your email and password to
  create a workspace") — the same register as the Unlock modal's
  apiKeySession branch. The unlock/modal copy is the precedent; no new prose
  register.
- **Offline/bootstrap**: a local-only workspace created in the browser
  without a server must also key at creation (the client already has the
  custody slot locally; the wrap uploads on first sync). Unkeyed local
  creation is removed from the BootForm path.

## Existing plaintext workspaces

- A persistent, dismissible-per-session banner: "This workspace is not
  encrypted — new content is readable on the server." (Dismissal never
  persists across reloads; the warning is a standing fact, not a nag.)
- **Key this workspace** action: generate the workspace key, wrap it under
  the account master key, PUT the key row (existing custody route), write
  the E2EE slot envelope — keying rides the log like everything else. From
  that sequence number, writes seal (existing engine behavior).
- History stays plaintext; the banner copy says so honestly after keying
  ("New content is encrypted. Content written before keying is not.") until
  the (impossible) day history re-sealing exists — it never does; the copy
  stays.
- Keyed workspaces see none of this chrome.

## The keyed-workspace dev-ops contract

Server-side tooling reads only what the server's plaintext projection
contains; keyed content is sealed by design. "Works out of the box" is
therefore defined as a contract with four clauses:

1. **Never choke, never lie.** Every operator tool (migrate scripts,
   `verify-migration.mts`, health checks, the smoke) runs against keyed
   workspaces without crashing, and every one REPORTS the sealed boundary
   when it matters — the counts are printed/returned, never silent. (The
   2026-11-06 repeat-migration fix — `buildScratchStore` skipping sealed
   snapshots and counting skipped encrypted/pending envelopes — is the
   reference implementation of this clause.)
2. **One shared scratch builder.** The sealed-gate scratch-store logic is
   extracted from the per-script copies into `scripts/lib/scratch-store.ts`;
   every `scripts/migrate-*.mts` adopts it (mechanical; the per-script
   drift — exactly the NOTADB crash — is what this prevents).
3. **Migrations declare their content need.** Each migration carries a
   declared class: `scaffolding` (reads no node content — schema/binding/
   seed work; converges plaintext-visible state and is FULLY effective on
   keyed workspaces) or `content` (reads/moves node content — e.g. the
   meeting-date retirement). A `content`-class migration run server-side
   against a keyed workspace must REFUSE with a loud, specific message
   ("this migration reads node content; run it through a keyed client") —
   never plan a partial move over the visible minority. Running `content`
   migrations keyed-side (a keyed CLI executor that plans against its
   unsealed local store and appends sealed envelopes) is **out of scope for
   this slice** and recorded as follow-up; the refusal contract lands now so
   nothing silently half-migrates in the meantime.
4. **Verification surfaces the boundary.** `verify-migration.mts` reports,
   per workspace, plaintext-applied vs sealed-invisible counts (via the
   server's convergence surface — no side-channel sqlite probes, per the
   2026-11-02 ruling), so an operator can see that a keyed workspace's
   scaffolding converged and its sealed content was untouched by design.

Backups need no change (borgmatic copies bytes; sealed bytes back up
identically). The post-deploy smoke already drives the unlock flow
(proven green on the keyed live workspace 2026-11-06); it stays the gate.

## Compatibility

- Web client and CLI already handle keys; GTK/Flutter adopt enforcement at
  their vendor bumps (lockstep note in the changelog; no fixture-gated wire
  change — creation is an API-route contract, not a new op).
- Older clients can still OPEN existing plaintext workspaces; they cannot
  CREATE new ones (server gate). Their error surfaces the directional copy.

## Errors

- Creation without a bundle: 4xx naming the missing bundle; the hatch off →
  legacy success (test-pinned both ways).
- Keyed workspace + `content`-class migration server-side: hard refusal with
  the class and the remedy named; exit non-zero; nothing appended.
- Key-this-workspace failures: wrong password (form error), lockout (429
  copy), anything else names itself — the Unlock modal's error register.

## Testing

- Server (fixture-gated): creation without bundle rejected (shape pinned);
  with bundle creates + key row readable by the owner; hatch off → legacy;
  fixture allowlist exempts only the listed ids; `content`-class refusal on
  a keyed workspace; shared scratch builder replays a sealed-snapshot
  workspace (the repeat-migration rehearsal pin is the template).
- Web: creation flow derives/uploads the wrap (key row visible via the
  custody surface); API-key session sees the directional copy; banner +
  key-this-workspace pins (keying writes the slot envelope; new writes
  seal); post-keying honest copy.
- Dev-ops: `verify-migration` pinned to report sealed-invisible counts;
  `verify-min` stays green on the keyed live workspace.
- Docs: `docs/developers/deployment.md` (the requirement, the hatch, the
  fixture exemption), SCHEMA.md/E2EE section as needed, the migrate-script
  header contract (content-class declaration), CHANGELOG entries per slice.

## Slices

1. **Core gate** (`notees-sync`): creation requires the bundle; the env
   hatch; the fixture allowlist; fixture-gated server tests; deployment.md.
2. **Dev-ops contract** (`notees-sync`): shared `scripts/lib/scratch-store.ts`;
   migrations adopt it; the content-class declaration + refusal;
   `verify-migration` sealed-count reporting.
3. **Web** (`notees-web`): creation keying (password + API-key paths),
   offline bootstrap keying, banner + key-this-workspace, docs, vendor bump.

Slices 1–2 land together before 3 ships (the web client is the creating
surface; the CLI consumes workspaces and adopts display/adoption changes at
its next release).

## Out of scope (recorded follow-ups)

- Hard grace-period escalation for unkeyed workspaces (read-only until
  keyed).
- The keyed client-side `content`-migration executor.
- Keying the seeded fixtures at first open (test-harness custody work).
- Key rotation and re-keying.
- Re-sealing history (impossible under the immutable log — permanently out).
