// @vitest-environment node
/**
 * The status-poll guard: `status()` builds a fresh SyncStatusSnapshot
 * object every call, so the 2s poll's setState must compare field-wise or the
 * whole app re-renders (and re-runs every render-time store read) on each
 * tick even when nothing changed.
 */

import { describe, expect, it } from "vitest";

import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";
import { syncStatusEqual } from "../src/ui/App.js";

const BASE: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

describe("syncStatusEqual", () => {
  it("treats field-identical snapshots as equal despite fresh object identity", () => {
    expect(syncStatusEqual(BASE, { ...BASE })).toBe(true);
  });

  it("flags any field change", () => {
    const cases: Array<[keyof SyncStatusSnapshot, unknown]> = [
      ["status", "syncing"],
      ["error", "boom"],
      ["pending", 1],
      ["failed", 1],
      ["quarantined", 1],
      ["parked", 1],
      ["realtime", true],
      ["cursorSeq", 42],
    ];
    for (const [field, value] of cases) {
      expect(syncStatusEqual(BASE, { ...BASE, [field]: value })).toBe(false);
    }
  });

  it("is symmetric", () => {
    const changed = { ...BASE, pending: 3 };
    expect(syncStatusEqual(changed, BASE)).toBe(false);
  });
});
