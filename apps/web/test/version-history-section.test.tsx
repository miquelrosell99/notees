/**
 * VersionHistorySection tests — the per-node op-log slice in the context
 * column. The section is lazy (collapsed = no fetch), lists the feed
 * newest-first with one-line summaries, expands content-bearing entries to
 * a read-only snapshot, and restores a snapshot by composing an ordinary
 * object.update (no wire change). The summary/snapshot helpers are pure and
 * covered directly.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { OperationFeedEntry } from "../src/core/workspace-client.js";
import {
  VersionHistorySection,
  describeHistoryEntry,
  historyEntrySnapshot,
} from "../src/ui/components/VersionHistorySection.js";

function entry(partial: Partial<OperationFeedEntry> & { seq: number }): OperationFeedEntry {
  return {
    opType: "object.update",
    payload: {},
    actorId: "0192a000-0000-7000-8000-0000000000aa",
    deviceId: "device-1",
    timestamp: "2026-10-14T10:00:00.000Z",
    hlc: { physical: 1720000000000, logical: 0 },
    ...partial,
  };
}

describe("describeHistoryEntry", () => {
  it("names every op family a node can receive", () => {
    expect(describeHistoryEntry(entry({ seq: 1, opType: "object.create" }))).toBe("Created");
    expect(
      describeHistoryEntry(
        entry({ seq: 2, opType: "object.update", payload: { objectId: "x", contentAst: [{ type: "text", text: "hi" }] } }),
      ),
    ).toBe("Edited content");
    expect(
      describeHistoryEntry(
        entry({ seq: 3, opType: "object.update", payload: { objectId: "x", contentDeltaB64: "AAAA" } }),
      ),
    ).toBe("Edited content");
    expect(
      describeHistoryEntry(
        entry({ seq: 4, opType: "object.update", payload: { objectId: "x", icon: "star", color: "sky" } }),
      ),
    ).toBe("Updated icon, color");
    expect(
      describeHistoryEntry(entry({ seq: 5, opType: "object.delete", payload: { objectId: "x" } })),
    ).toBe("Moved to trash");
    expect(
      describeHistoryEntry(
        entry({ seq: 6, opType: "object.delete", payload: { objectId: "x", permanent: true } }),
      ),
    ).toBe("Deleted permanently");
    expect(describeHistoryEntry(entry({ seq: 7, opType: "object.restore" }))).toBe(
      "Restored from trash",
    );
    expect(describeHistoryEntry(entry({ seq: 8, opType: "object.move" }))).toBe("Moved");
    expect(
      describeHistoryEntry(
        entry({ seq: 9, opType: "property.set", payload: { propertySchemaId: "s1" } }),
        "Status",
      ),
    ).toBe("Set Status");
    expect(
      describeHistoryEntry(entry({ seq: 10, opType: "property.unset", payload: { propertySchemaId: "s1" }})),
    ).toBe("Unset property");
    expect(describeHistoryEntry(entry({ seq: 11, opType: "frobnicate" }))).toBe("frobnicate");
  });
});

describe("historyEntrySnapshot", () => {
  it("returns the readable contentAst when the op carries one, null otherwise", () => {
    const ast = [{ type: "text", text: "hello" }];
    expect(
      historyEntrySnapshot(entry({ seq: 1, payload: { contentAst: ast } })),
    ).toEqual(ast);
    expect(historyEntrySnapshot(entry({ seq: 2, payload: { contentDeltaB64: "AAAA" } }))).toBeNull();
    expect(historyEntrySnapshot(entry({ seq: 3 }))).toBeNull();
  });
});

/** A minimal client stand-in with just the surface the section touches. */
interface StubClient {
  fetchNodeHistory: ReturnType<typeof vi.fn>;
  updateObject: (id: string, fields: { contentAst?: unknown }) => Promise<void>;
  listPropertySchemas: () => unknown[];
}

function stubClient(overrides: {
  feed: OperationFeedEntry[];
  updateObject?: (id: string, fields: { contentAst?: unknown }) => Promise<void>;
}): StubClient {
  return {
    fetchNodeHistory: vi.fn().mockResolvedValue(overrides.feed),
    updateObject:
      overrides.updateObject ?? vi.fn().mockResolvedValue(undefined),
    listPropertySchemas: () => [],
  };
}

describe("VersionHistorySection", () => {
  it("is lazy: collapsed renders nothing and never fetches; expanding loads the feed", async () => {
    const feed = [
      entry({ seq: 2, opType: "object.update", payload: { objectId: "n", contentAst: [{ type: "text", text: "v2" }] } }),
      entry({ seq: 1, opType: "object.create", payload: { objectId: "n", contentAst: [{ type: "text", text: "v1" }] } }),
    ];
    const client = stubClient({ feed });
    const { container } = render(
      <VersionHistorySection client={client as never} nodeId="n" />,
    );

    // Collapsed: no query (the normative lazy contract).
    expect(client.fetchNodeHistory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Version history/ }));
    expect(client.fetchNodeHistory).toHaveBeenCalledWith("n");

    // Newest-first: v2's edit above the creation row.
    const rows = await within(container.querySelector(".version-history") as HTMLElement).findAllByText(
      /Edited content|Created/,
    );
    expect(rows[0]?.textContent).toContain("Edited content");
    expect(rows[1]?.textContent).toContain("Created");
  });

  it("expands a content entry to its snapshot and restores via an ordinary object.update", async () => {
    const snapshot = [{ type: "text", text: "the old draft" }];
    const feed = [
      entry({ seq: 2, opType: "object.update", payload: { objectId: "n", contentAst: [{ type: "text", text: "current" }] } }),
      entry({ seq: 1, opType: "object.update", payload: { objectId: "n", contentAst: snapshot } }),
    ];
    const updateObject = vi.fn().mockResolvedValue(undefined);
    const client = stubClient({ feed, updateObject });
    render(<VersionHistorySection client={client as never} nodeId="n" />);
    fireEvent.click(screen.getByRole("button", { name: /Version history/ }));

    // The older version's snapshot is hidden until its row is expanded.
    expect(screen.queryByText("the old draft")).toBeNull();
    const toggles = await screen.findAllByRole("button", { name: /show snapshot/ });
    fireEvent.click(toggles[1]!);
    expect(screen.getByText("the old draft")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(updateObject).toHaveBeenCalledWith("n", { contentAst: snapshot });
  });

  it("says so when the feed is unreachable", async () => {
    const client = {
      fetchNodeHistory: vi.fn().mockRejectedValue(new Error("operations feed failed: HTTP 503")),
      updateObject: vi.fn(),
      listPropertySchemas: vi.fn().mockReturnValue([]),
    } as never;
    render(<VersionHistorySection client={client as never} nodeId="n" />);
    fireEvent.click(screen.getByRole("button", { name: /Version history/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Version history is unavailable: operations feed failed: HTTP 503",
    );
  });
});
