# Contracts — schema / config / identity impact

> Conclusion: one persisted client setting + one local-session shape + one IndexedDB store; no backend schema changes, no protocol version bump.

## Runtime config (Task 1)

- Persisted in `localStorage` key `notees.serverUrl` (string | absent).
  Read once at module init; `setServerUrl` persists and triggers
  re-initialization (full reload is acceptable and simplest).
- Resolution order: explicit setting → same-origin `/api` (current behavior).
  A static deployment with no setting = local mode.
- `ConnectionMode = 'local' | 'connected' | 'unreachable'`; `unreachable` keeps
  today's health-banner behavior, minus the full-screen lock in `local`.

## Local session (Task 2)

```ts
// authStore — persisted user shape extended, not replaced
{ uuid: string;        // generated UUIDv7
  email: 'local@local'; // sentinel, never sent anywhere
  name: 'Local user';
  isLocal: true }       // discriminator every gate checks
```

No token, no refresh scheduling, no `/auth/*` calls. `actorId` for the local
op log = the local uuid. `getActorId` paths that read "anonymous" must map
local sessions to this uuid, not anonymous.

## Local workspace (Task 3)

- Fixed well-known local workspace UUID per profile (stored alongside the
  session). Route `/:workspaceId/*` uses it directly.
- Seed = client-side emission of the same ops as `app/core/seed.py:94-177`:
  `class.create` for all `SYSTEM_CLASS_UUIDS`, then `node.create` Inbox page.
  Must produce the same derived state a server-seeded workspace would, so
  later adoption (Task 6) merges cleanly.

## Local assets (Task 5)

- New IndexedDB object store `assetBlobs` in the existing local DB
  (`notees-workspaces`, DB v3): key = asset hash (`assetHash` from the
  `asset.upload` op), value = raw bytes (`Uint8Array`; the MIME type comes from
  the derived `node_asset` row — bytes are stored instead of `Blob` because the
  structured clone used by fake-indexeddb in tests cannot clone jsdom Blobs;
  browsers treat them equivalently for this use).
- Node identity stays the byte reference (uuid → hash via the op payload), so
  content survives adoption unchanged; on connect, blobs upload to the server
  and URLs switch from object URLs to `/api/assets/{uuid}` transparently.
- `getAssetUrlAsync` in local mode returns `URL.createObjectURL(blob)`;
  revoked on unmount per existing `AssetImage` lifecycle.

## Adoption (Task 6)

`adoptServer(url)`:
1. Verify reachability + auth (user logs into the server account).
2. `POST /workspaces` → new server workspace UUID.
3. Replay the local op log through `POST /api/relay/batch` with envelope
   `workspaceId`/`actorId` remapped (ids regenerated per envelope; op ids kept
   — server dedupe is id-based and this is a fresh workspace).
4. Server seeds nothing for it (or its seed ops dedupe against ours — verify:
   class.create ops carry the same classIds, so id-dedupe will NOT collapse
   them; adoption must either skip the server seed or accept duplicate
   system-class ops with distinct op ids but identical class ids. **Pinned
   detail: verify server seeding behavior for API-created workspaces before
   implementing step 4; class.create applier is an upsert on class id, so
   duplicate ops are harmless — confirm with a test.**)
5. Switch stored workspace UUID + cursor (from 0), wipe nothing.

## What does NOT change

- `relay_envelope` schema, envelope wire format, `PROTOCOL_VERSION`,
  `WS_PROTOCOL_VERSION`, key management. The protocol needs no new features —
  that was the payoff of the seq-cursor work.
