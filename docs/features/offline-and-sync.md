# Offline work and sync

Notees is local-first: reads always answer from the device-local store and writes persist there, syncing when a connection comes back — offline is the default state of the world, not an error state. This page covers the boot-time outage behavior, the backend-down ladder, and the sync state surfaces. The engine underneath (outbox, catch-up, the relay protocol) is [api.md](../api.md)'s relay paragraph and [packages/protocol/WIRE.md](../../packages/protocol/WIRE.md).

## An outage is not a sign-out

When the remembered server does not answer on load, the app keeps the credential and opens the remembered workspace from its local copy — the sync banner reports "working locally until it recovers" and edits catch up when the server returns. Every workspace stays listed while offline: the switcher and the manager fall back to the device-local registry under an explicit offline caption — workspaces with a synced copy on the device open normally; the ones without stay visible but muted with a cloud-off marker (they need one online open to land a copy here). Server-side actions (create, rename, delete, export) wait for recovery. Only a rejected credential (an expired session or revoked key) lands back on the sign-in screen; clearing site data or **Disconnect & forget** is what forgets the server. The boot screen never re-routes on its own: when an address does not answer, the error explains, and a "Try … instead" button offers the same-origin guess — clicking it is the only path there.

## The backend-down ladder

When the sync backend goes unreachable mid-session, the app escalates one explicit rung at a time:

1. **Banner** — "Backend unreachable — working locally until it recovers." Dismissible; the app keeps working off the local projection of your data.
2. **Lock** — dismissing the banner while the backend is still down swaps to a full-screen lock, because past the grace period new edits would only pile into this browser's storage, invisible to your other devices. The lock carries the escape hatch — **Continue anyway** — beside an honest statement of what continued local work risks: the local-only backlog is lost if this site's data is cleared before sync resumes, and if the same content changes elsewhere in the meantime, the conflict resolves by last-writer-wins, not by what you meant.
3. **Persistent banner** — escaping the lock returns to the shell under a non-dismissible banner until the backend recovers, so a degraded session can never look clean.

Recovery resets the ladder: the next outage starts again at the dismissible banner.

## The sync dot is a door, not a lamp

The dot (idle / syncing / backlog / error) rides the **profile avatar's corner** in the sidebar foot (owner 2026-10-19 — it left the top bar, which stays navigation chrome only; the badge states: green idle, blue pulsing syncing, amber backlog, red error). The badge is the at-a-glance state, and the door is the account popup's **Sync** entry (its caption names the live state — "up to date", "N waiting", "error"): it opens the details panel with the engine state, the pending/failed/quarantined/parked backlog counts, the server seq, and the last error — plus two actions on the same surface. **Resync now** forces one push-then-pull cycle against the relay (the same cycle the automatic path runs, on demand). **Conflicts** lists the semantic conflicts this session has seen (concurrent moves, edit-vs-delete, class and property clashes — the CRDT merge stays authoritative; the list is the "the log picked a winner, but you should know" record), newest first with the node's name, the clash type, and both sides' op counts.

## Settings → Sync

The settings page's **Sync** section (deep-linkable at `/settings/sync`) shows the configured sync server (with reachability), offers **Connect to a different server**, and **Disconnect & forget this server** (confirmed — it signs you out and clears the remembered server and credentials on this device).

## Offline preferences and state

What survives offline and what doesn't is a deliberate partition: favorites, recents, and custom section views are per-user prefs-channel state — offline, reads answer from the device-local cache and writes persist there, syncing on the next connection; custom views are read-only offline ([feature-status.md](../feature-status.md)). Device state — view modes, folds, stretched sets, the right-rail stack — is never an op and never synced ([pages.md](pages.md#page-chrome--what-sticks-and-where), [outliner.md](outliner.md)); semantic state lives only in the operation log ([philosophy.md](../philosophy.md#semantic-state-vs-device-state)).
