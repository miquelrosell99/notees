/**
 * restore-epoch bumps void the workspace's snapshots (rows + files) — a
 * bumped epoch means the log no longer matches the checkpoints (the
 * repair's whole point), and a stale image kept in place would be
 * re-restored after every client wipe (the 2026-11-24 poisoned-checkpoint
 * lineage: bump alone left the stale image being served, and the
 * wipe+restore cycle re-poisoned every client).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RelayStorage } from "../src/relay-storage.js";

describe("bumpRestoreEpoch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("deletes the workspace's snapshot rows and files; other workspaces untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-relay-epoch-"));
    dirs.push(dir);
    const relay = new RelayStorage(join(dir, "relay.db"), join(dir, "snapshots"));
    const WS_A = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
    const WS_B = "c491595f-9f94-4d1f-8f4a-0d0c8a3a1b44";
    const SNAP_A1 = "01920000-0000-7000-8000-0000000000f1";
    const SNAP_A2 = "01920000-0000-7000-8000-0000000000f2";
    const SNAP_B = "01920000-0000-7000-8000-0000000000f3";
    relay.saveSnapshot(WS_A, SNAP_A1, { physical: 1, logical: 0 }, 10, Buffer.from("a"));
    relay.saveSnapshot(WS_A, SNAP_A2, { physical: 2, logical: 0 }, 20, Buffer.from("b"));
    relay.saveSnapshot(WS_B, SNAP_B, { physical: 3, logical: 0 }, 30, Buffer.from("c"));
    expect(relay.latestSnapshot(WS_A)?.id).toBe(SNAP_A2);

    expect(relay.bumpRestoreEpoch(WS_A)).toBe(1);

    expect(relay.latestSnapshot(WS_A)).toBeNull();
    expect(relay.latestSnapshot(WS_B)?.id).toBe(SNAP_B);
    expect(existsSync(join(dir, "snapshots", `${SNAP_A1}.db`))).toBe(false);
    expect(existsSync(join(dir, "snapshots", `${SNAP_A2}.db`))).toBe(false);
    expect(existsSync(join(dir, "snapshots", `${SNAP_B}.db`))).toBe(true);
    relay.close();
  });
});
