/**
 * SyncDetailsModal: the sync indicator's details surface. Renders
 * the status snapshot, lists the conflict history (node display name,
 * classified label, timestamps), and the Resync action drives one push+pull
 * cycle through the client.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type {
  ConflictHistoryEntry,
  SyncStatusSnapshot,
} from "../src/core/workspace-client.js";
import { SyncDetailsModal } from "../src/ui/components/modals/SyncDetailsModal.js";
import type { AnyClient } from "../src/ui/components/Sidebar.js";

const SNAPSHOT: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 3,
  failed: 1,
  quarantined: 0,
  parked: 0,
  realtime: true,
  cursorSeq: 42,
};

function makeClient(overrides: {
  conflicts?: ConflictHistoryEntry[];
  sync?: () => Promise<void>;
} = {}): AnyClient {
  const conflicts = overrides.conflicts ?? [];
  return {
    conflictHistory: () => Promise.resolve(conflicts),
    sync: overrides.sync ?? (() => Promise.resolve()),
    subscribe: () => () => {},
    getNode: () => undefined,
    getDisplayName: (id: string) => `Node ${id}`,
  } as unknown as AnyClient;
}

describe("SyncDetailsModal", () => {
  it("shows the status snapshot and backlog", () => {
    render(
      <SyncDetailsModal client={makeClient()} snapshot={SNAPSHOT} isOpen onClose={() => {}} />,
    );
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.getByText(/realtime/)).toBeTruthy();
    expect(screen.getByText("3 pending · 1 failed")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("No conflicts")).toBeTruthy();
  });

  it("lists conflicts with the classified label and the node display name", async () => {
    const conflicts: ConflictHistoryEntry[] = [
      {
        at: 1_800_000_000_000,
        nodeId: "n1",
        conflictType: "property_conflict",
        localEnvelopeIds: ["e1"],
        remoteEnvelopeIds: ["e2", "e3"],
      },
    ];
    render(
      <SyncDetailsModal
        client={makeClient({ conflicts })}
        snapshot={SNAPSHOT}
        isOpen
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Node n1")).toBeTruthy();
    expect(screen.getByText("Property set vs unset")).toBeTruthy();
    expect(screen.getByText(/1 local \/ 2 remote ops/)).toBeTruthy();
  });

  it("resync runs one push+pull cycle through the client", async () => {
    const sync = vi.fn(() => Promise.resolve());
    render(
      <SyncDetailsModal
        client={makeClient({ sync })}
        snapshot={SNAPSHOT}
        isOpen
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Resync now"));
    expect(sync).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Resyncing…")).toBeTruthy();
  });

  it("surfaces a resync failure", async () => {
    const sync = vi.fn(() => Promise.reject(new Error("relay unreachable")));
    render(
      <SyncDetailsModal
        client={makeClient({ sync })}
        snapshot={SNAPSHOT}
        isOpen
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Resync now"));
    expect(await screen.findByText("relay unreachable")).toBeTruthy();
  });
});
