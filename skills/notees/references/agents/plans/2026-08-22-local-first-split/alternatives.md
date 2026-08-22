# Alternatives — local-first split

> Conclusion: Option A (local profile inside the existing client, server as optional sync target) wins; it reuses the local-first runtime we already trust and adds no second product to maintain.

## Option A — Local profile in the existing client (chosen)

The web client gains a "no server" mode: synthetic local identity + implicit
local workspace, all data in the existing sql.js/IndexedDB stack, sync engine
pointed at a configurable server URL or disabled. Adding a server later
attaches sync to the existing local state (seq cursor from 0, dedupe-safe).

- Pros: one codebase, one runtime; the op log + outbox + seq-cursor design was
  built for exactly this; the "connect later" path is a sync problem we
  already solved, not a migration problem.
- Cons: auth store and route guards need a third state (local session);
  capability gating must be systematic or serverless UI leaks broken features;
  local assets need a real store (IndexedDB blobs), not just degradation.

## Option B — Separate "lite" client build

A second Vite build (or feature-flagged bundle) that strips server features
at compile time and ships as its own artifact.

- Pros: clean separation; smaller bundle; impossible to leak server UI.
- Cons: two build variants to test forever; every feature flag branch doubles;
  upgrading from lite → full is a reinstall, not a setting; the bundle isn't
  the hard part anyway — the runtime coupling (auth, assets, workspaces) is.

## Option C — Server-side "embedded local mode"

Keep requiring the backend container, but add a zero-config embedded mode
(SQLite/defaults) so "client-only" really means "tiny local server".

- Pros: zero frontend changes; auth/assets/shares all keep working locally.
- Cons: this isn't client-only at all — users still deploy and patch a server;
  it dodges the actual goal (runs anywhere, even as a static PWA / installed
  Flutter app, with sync as an optional add-on); doubles down on the server as
  the center of the product, which contradicts the local-first direction.

## Rejected detail options

- **Degrade assets to broken-image placeholders in local mode** — rejected:
  notes apps live on embedded media; silent data loss of meaning. Local blob
  storage is required for the mode to be honest.
- **Merge local identity into a server account on first connect** — deferred,
  not rejected: v1 attaches sync by replaying the local op log into a new
  server workspace (see `contracts.md`); account merging is a later product
  decision with real UX edge cases (two devices, same account, both local
  first).
