# Write-echo latency: read-your-writes worker ack + pending-echo row overlay

## Problem

Every local write (exit-edit flush, Enter split, ghost create) reaches the UI
through: write RPC → worker apply → **50 ms trailing notify coalesce** →
`changed` message → macrotask → **second `multiRead` round-trip** →
`startTransition` render. Guaranteed ~80–150 ms of visible staleness idle,
seconds under worker load (persist export, sync bursts, tree re-serve). The
read-mode swap at exit-edit renders the stale cache by construction
(fire-and-forget flush). Typing/block manipulation is the app's core loop;
the owner ruled this must feel synchronous.

Prior perf slices optimized throughput of this loop (one-CTE tree serve,
notification scoping, stamp ledger, invalidation metadata) — the structural
latency was never addressed.

## Design (owner-approved direction: technically best, not cheapest)

### 1. Write-through ack (worker-core.ts)

The worker already keeps `servedStamps` (last-served revision stamp per cache
key — the `READ_UNCHANGED` delta ledger). On a local-write RPC:

- `invoke` wrapper captures the notify revision before/after the method
  (WorkerCore's existing `client.subscribe` callback tracks it; WorkspaceClient
  notifies synchronously inside `enqueueLocal`).
- If the revision advanced (a real apply happened): extract `notifyPending`
  (cancel its coalesce timer — the ack IS the notification), walk
  `servedStamps`, recompute `readStamp` per served key, and for every key
  whose stamp moved, read the fresh value + `noteServed`.
- The RPC response gains `ack: { change, refreshed: [key, value][] }`.
- Exclusions (keep the coalesced path): `syncOnce`, `push`, `pull`,
  `bootstrapWorkspace`, `applyBatch` (remote/import bulk applies), plus all
  read methods by construction (revision never advances).
- Soundness: the worker thread serializes messages — no apply can interleave
  between the write and the stamp walk (the multiRead precedent).

### 2. Proxy applies the ack before resolving (worker-client.ts)

- `handleMessage`: a response carrying `ack` first writes `refreshed` into
  the cache, sets `lastChange`, notifies subscribers **synchronously**
  (urgent — this render is the user's own gesture feedback; `startTransition`
  stays for the coalesced sync path), then resolves the pending call.
- Awaiting a write then reading = fresh (read-your-writes). Fire-and-forget
  writes converge in one round trip with zero artificial delay.
- The coalesced `changed` path is untouched for sync/remote applies.

### 3. Pending-echo overlay (BlockRow / BlockTextEditor)

The ack lands ~1 RPC after exit-edit; the swap happens at t=0. To never show
a stale frame:

- `onExitEdit` gains the editor's committed AST (`committedRef.current`
  post-flush).
- `BlockRow` holds it as `echoOverride` and renders it in read mode while
  set; clears when the tree echo deep-equals it, when a change naming the
  node delivers a different value (remote LWW win), or on unmount.
- Creates (Enter split sibling, ghost) need no overlay — the ack refreshes
  the page-tree key, so the new row mounts at write resolution.

## Explicitly not doing

- No main-thread overlay store (duplicates store + appliers on the UI
  thread; the worker boundary is what keeps typing smooth at page scale).
- No sync-path changes.
- No wire/protocol/fixture changes (the worker RPC is app-internal).

## Verification

- worker-core specs: write RPC response carries `ack.refreshed` with the
  moved keys; servedStamps updated (follow-up multiRead → READ_UNCHANGED);
  pending notify folded (no double emission); excluded methods unchanged.
- worker-client specs: ack applies cache before the write promise resolves;
  subscribers notified synchronously; structural ack refreshes only moved
  keys.
- BlockRow/editor spec: exit-edit renders the committed content immediately
  (red before — renders the stale prop), clears on echo, clears on remote
  conflict value.
- Dev-pair verification: exit-edit / Enter / ghost on a large page show no
  stale frame; measure before/after.

## Gate + landing

Scoped gate (web typecheck + touched suites), full gate pre-landing, changelog
entry, developer-runbook touch (worker data-path description), land via
rebase + ff-merge, redeploy web image + verify-min smoke.
