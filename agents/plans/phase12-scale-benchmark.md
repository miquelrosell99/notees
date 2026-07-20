# Phase 12 Track B3 — Scale Testing Benchmark Report

**Date:** 2026-07-20
**Environment:** Local development container, Intel x86_64, in-memory SQLite (backend), sql.js in-memory (frontend)
**Test runner:** pytest 9.1.0, vitest 4.1.7

## Summary

This report documents the first scale/stress benchmark pass for the Notees operation-log core. Tests live in:

- `tests/core/stress/` — backend relay, WorkspaceStore, and convergence stress tests.
- `frontend/src/core/__tests__/stress/` — client-side WorkspaceStore and SyncEngine stress tests.

The suite is deterministic and CI-friendly: the default operation count is **2,000** for most tests and **4 clients × 200 ops** for convergence bursts. Larger counts can be run locally via environment variables:

```bash
# Backend
NOTEES_STRESS_OPS=10000 NOTEES_STRESS_BURST_OPS=500 NOTEES_STRESS_CLIENTS=8 \
  uv run pytest tests/core/stress -q --no-cov --confcutdir=tests/core

# Frontend
NOTEES_STRESS_OPS=5000 NOTEES_STRESS_BURST_OPS=500 NOTEES_STRESS_CLIENTS=8 \
  cd frontend && npm run test:run -- src/core/__tests__/stress/
```

## Backend Results

Run with `NOTEES_STRESS_OPS=10000 NOTEES_STRESS_BURST_OPS=500 NOTEES_STRESS_CLIENTS=8`.

| Test | Metric | Result | Bound |
|---|---|---|---|
| `test_replay_time_from_empty` | Replay 10k ops from HLC zero | **0.326 s** | < 5.5 s |
| `test_replay_time_with_snapshot` | Replay 10k ops with mid-log snapshot | **0.177 s** | < 4.1 s |
| `test_sync_is_idempotent_at_scale` | Triple-sync 1k ops + properties | passes | — |
| `test_compaction_reduces_operation_count` | Compact 1k ops, restore from snapshot | passes | — |
| `test_catch_up_from_hlc_zero` | Relay catch-up 10k ops | **0.058 s** | < 5.5 s |
| `test_catch_up_with_delta` | Relay catch-up delta 500 ops | **0.050 s** | < 1.75 s |
| `test_store_catch_up_from_empty` | WorkspaceStore catch-up 1k ops | **0.047 s** | < 1.5 s |
| `test_relay_size_per_operation` | SQLite storage for 10k ops | **379.7 B/op** | < 2.5 KB/op |
| `test_operation_size_estimate_matches_db` | Ciphertext+iv sum is meaningful | passes | — |
| `test_derived_state_size_after_replay` | Derived DB overhead per node | **536.6 B/node** | < 3 KB/node |
| `test_burst_then_converge` | 8 clients × 500 ops converge | **6.180 s** | < 15 s |

### Backend observations

- **Replay scales linearly and is well within CI bounds.** A mid-log snapshot cuts replay time roughly in half for 10k ops.
- **Relay catch-up is very fast** because the SQLite adapter filters and sorts on indexed HLC columns.
- **Storage overhead is modest:** ~380 B per encrypted `node.create` operation in SQLite, and ~540 B per node in the derived database.
- **Compaction works:** creating a snapshot before compaction lets fresh readers restore full derived state after old envelopes are pruned.
- **Multi-client convergence is correct but is the slowest test at scale** because each client encrypts/decrypts every operation. Bounds are generous to stay green under CI contention.

## Frontend Results

Run with `NOTEES_STRESS_OPS=5000 NOTEES_STRESS_BURST_OPS=500 NOTEES_STRESS_CLIENTS=8`.

| Test | Metric | Result | Bound |
|---|---|---|---|
| `applies thousands of node.create operations` | Apply 5k ops | **942 ms** | < 5.25 s |
| `restores from snapshot and replays newer operations` | Snapshot restore mid-log | **9.5 ms** | < 5.25 s |
| `exports a database whose size scales predictably` | Export size for 5k ops | **936 B/op** | < 5 KB/op |
| `compacts old operations and keeps derived state intact` | Compact 1k ops | passes | — |
| `catches up a client that is N operations behind` | SyncEngine catch-up 5k ops | **1.089 s** | < 10.5 s |
| `converges multiple clients after a burst of operations` | 8 clients × 500 ops | **7.015 s** | < 22 s |

### Frontend observations

- **Client-side apply is fast** for simple `node.create` ops (~0.2 ms/op in isolation).
- **Snapshot restore is essentially instant** because it deserializes the full SQLite database.
- **Exported database size is ~1 KB/op**, higher than the backend relay because the client operation log stores unencrypted JSON payloads plus CRDT/state tables.
- **Catch-up overhead is dominated by WebCrypto encrypt/decrypt** in the sync loop; still under 1.1 s for 5k ops.
- **Burst convergence is slower than backend** due to the same crypto cost, but all clients converge to identical node sets.

## Running the tests

```bash
# Backend stress suite (must use --confcutdir=tests/core because the parent
# tests/conftest.py currently fails to import app.main due to an unrelated
# pre-existing import error in app/features/shares/router.py)
uv run pytest tests/core/stress -q --no-cov --confcutdir=tests/core

# Frontend stress suite
cd frontend && npm run test:run -- src/core/__tests__/stress/

# Full frontend suite
cd frontend && npm run test:run

# Unit tests (no DB required)
uv run pytest tests/unit -m unit --no-cov -q
```

## Known limitations / next steps

1. **Backend tests use in-memory SQLite.** Production PostgreSQL numbers will differ, especially for catch-up pagination and concurrent writes.
2. **Frontend tests use sql.js in-memory, not IndexedDB.** Real browser IndexedDB persistence adds serialization/deserialization overhead.
3. **Crypto dominates sync cost.** A future optimization could batch encrypt/decrypt operations or amortize sync watermark writes.
4. **No concurrent writer contention tested yet.** The burst test uses sequential per-client pushes; overlapping async pushes would be a useful next stress scenario.
5. **Parent conftest import blocker.** `uv run pytest tests/core -q --no-cov` is currently blocked by a `NameError` in `app/features/shares/router.py` (`get_node_id_resolver` is undefined). This is unrelated to the stress tests and must be resolved in Track A1.
