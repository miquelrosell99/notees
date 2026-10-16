/**
 * collectionSort tests (jsdom): the named sort modes behind the sort button
 * the list and cards views now carry (the table's mdi-sort control,
 * generalized — owner 2026-10-13).
 *
 * Two layers:
 *
 * - Pure comparator coverage (`collectionSort.ts`): the dates-first mode
 *   (date pages newest → oldest, then the rest A–Z — the Backlinks /
 *   Unlinked mentions default), alphabetical, edit-date (cards), the
 *   grouped rendering's group ordering, and the tree's per-level sort.
 *   Date ids ride the real deterministic chain (`chainNodeIds`) so
 *   `parseDateNodeId` acceptance is part of the fixture.
 *
 * - DOM wiring over a real WorkspaceClient (the extended-by-section
 *   harness): the grouped reference list opens dates-first (group order,
 *   asserted on `data-group-id` — label formats are settings-dependent),
 *   the child-page tree and the flat member list open A–Z, the table opens
 *   on Edited descending, and the sort button renders on the list/cards
 *   projections but stays off the editable surface.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { chainNodeIds } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient, type ClientNode } from "../src/core/workspace-client.js";
import { NodeCollection, groupByContainingPage } from "../src/ui/views/index.js";
import type { CollectionGroup, NodeCollectionItem } from "../src/ui/views/index.js";
import { OutlinerContext, useOutlinerValue } from "../src/ui/outliner-context.js";
import {
  compareGroupsByMode,
  compareItemsByEditDate,
  compareItemsByMode,
  dateSortKeyOf,
  sortTreeByMode,
} from "../src/ui/views/collectionSort.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

async function createTitledPage(client: WorkspaceClient, title: string, parentId: string | null = null): Promise<string> {
  const id = await client.createObject({ parentId, isEmbedded: false });
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

/** A comparator's full ordering as an id list. */
function orderOf(items: NodeCollectionItem[], compare: (a: NodeCollectionItem, b: NodeCollectionItem) => number): string[] {
  return [...items].sort(compare).map((item) => item.node.id);
}

function fakeNode(id: string, title: string, updatedAt: string | null = null): ClientNode {
  return {
    id,
    workspaceId: WS,
    isClass: false,
    isEmbedded: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: title }],
    icon: null,
    color: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    description: null,
    isActive: true,
    createdAt: null,
    updatedAt,
  } as ClientNode;
}

function item(id: string, title: string, updatedAt: string | null = null): NodeCollectionItem {
  return { node: fakeNode(id, title, updatedAt) };
}

/**
 * The read-only tree path renders BlockRows without hosting its own
 * OutlinerContext (the FlatRows precedent covers only the flat list) — in
 * the app it rides the enclosing NodeView's. The test wrapper provides the
 * same context the page view would.
 */
function WithOutliner({
  client,
  children,
}: {
  client: WorkspaceClient;
  children: React.ReactNode;
}) {
  const outliner = useOutlinerValue(client, "", { openNode: () => {}, openInSidebar: () => {} });
  return <OutlinerContext.Provider value={outliner}>{children}</OutlinerContext.Provider>;
}

describe("dateSortKeyOf", () => {
  it("maps each precision to a lexicographically coherent key and rejects non-date ids", () => {
    const { year, month, day } = chainNodeIds("2026-10-13");
    expect(dateSortKeyOf(year)).toBe("2026");
    expect(dateSortKeyOf(month)).toBe("2026-10");
    expect(dateSortKeyOf(day)).toBe("2026-10-13");
    expect(dateSortKeyOf("0192a000-0000-7000-8000-000000000099")).toBeNull();
    // The chain coheres under a plain compare: day after month after year.
    expect("2026-10-13" > "2026-10").toBe(true);
    expect("2026-10" > "2026").toBe(true);
  });
});

describe("compareItemsByMode", () => {
  it("dates-first: date pages newest → oldest, then the other pages A–Z", () => {
    const older = chainNodeIds("2025-01-02");
    const newer = chainNodeIds("2026-10-13");
    const month = chainNodeIds("2026-10-09");
    const items: NodeCollectionItem[] = [
      item("alpha-page", "Alpha"),
      item(older.day, "2025-01-02"),
      item("beta-page", "Beta"),
      item(newer.day, "2026-10-13"),
      item(month.month, "2026-10"),
    ];
    expect(orderOf(items, compareItemsByMode("dates-first"))).toEqual([
      newer.day,
      month.month,
      older.day,
      "alpha-page",
      "beta-page",
    ]);
  });

  it("alphabetical: by display name, Untitled last, id tiebreak", () => {
    const items: NodeCollectionItem[] = [
      item("id-b", "Beta"),
      item("id-u", ""),
      item("id-a", "Alpha"),
    ];
    expect(orderOf(items, compareItemsByMode("alphabetical"))).toEqual(["id-a", "id-b", "id-u"]);
  });
});

describe("compareItemsByEditDate", () => {
  it("orders by updatedAt newest first, nulls last, name on ties", () => {
    const items: NodeCollectionItem[] = [
      item("id-old", "Old", "2026-10-01T10:00:00.000Z"),
      item("id-null", "Null", null),
      item("id-new", "New", "2026-10-13T10:00:00.000Z"),
      item("id-tie-b", "Tie B", "2026-10-13T10:00:00.000Z"),
      item("id-tie-a", "Tie A", "2026-10-13T10:00:00.000Z"),
    ];
    // The three 2026-10-13 rows tie on updatedAt → the name tiebreak:
    // New < Tie A < Tie B, all before the older row; the null sinks last.
    expect(orderOf(items, compareItemsByEditDate())).toEqual([
      "id-new",
      "id-tie-a",
      "id-tie-b",
      "id-old",
      "id-null",
    ]);
  });
});

describe("compareGroupsByMode", () => {
  it("dates-first orders the groups by their key page; labels A–Z otherwise", () => {
    const older = chainNodeIds("2025-01-02");
    const newer = chainNodeIds("2026-10-13");
    const group = (id: string, label: string): CollectionGroup => ({ id, label, items: [] });
    const groups: CollectionGroup[] = [
      group("zeta-page", "Zeta"),
      group(older.day, "2025-01-02"),
      group("alpha-page", "Alpha"),
      group(newer.day, "2026-10-13"),
    ];
    const byDatesFirst = [...groups].sort(compareGroupsByMode("dates-first")).map((g) => g.id);
    expect(byDatesFirst).toEqual([newer.day, older.day, "alpha-page", "zeta-page"]);
    // Alphabetical rides the LABEL — the date labels start with digits, so
    // they sort ahead of the lettered pages.
    const byName = [...groups].sort(compareGroupsByMode("alphabetical")).map((g) => g.id);
    expect(byName).toEqual([older.day, newer.day, "alpha-page", "zeta-page"]);
  });
});

describe("sortTreeByMode", () => {
  it("sorts every sibling level and never mutates the input", () => {
    const tree: NodeCollectionItem[] = [
      {
        node: fakeNode("root-b", "Root B"),
        children: [item("b-2", "B two"), item("b-1", "B one")],
      },
      {
        node: fakeNode("root-a", "Root A"),
        children: [item("a-2", "A two"), item("a-1", "A one")],
      },
    ];
    const sorted = sortTreeByMode(tree, "alphabetical");
    expect(sorted.map((i) => i.node.id)).toEqual(["root-a", "root-b"]);
    expect(sorted[0]!.children!.map((i) => i.node.id)).toEqual(["a-1", "a-2"]);
    expect(sorted[1]!.children!.map((i) => i.node.id)).toEqual(["b-1", "b-2"]);
    // The input keeps its original order (new arrays all the way down).
    expect(tree.map((i) => i.node.id)).toEqual(["root-b", "root-a"]);
    expect(tree[0]!.children!.map((i) => i.node.id)).toEqual(["b-2", "b-1"]);
  });
});

describe("the sort button on the collection views", () => {
  it("grouped references open dates-first: newest date page, then older, then A–Z", async () => {
    const client = await seedClient();
    const older = await client.ensureDateChain("2025-01-02");
    const newer = await client.ensureDateChain("2026-10-13");
    const alphaId = await createTitledPage(client, "Alpha Page");
    // One referencing block per containing page; the group key rides the
    // meta (the getLinkedReferences shape), the block itself is irrelevant.
    const entries: NodeCollectionItem[] = [];
    for (const pageId of [alphaId, older.day, newer.day]) {
      const blockId = await client.createObject({ parentId: pageId });
      const node = client.getNode(blockId);
      if (node === undefined) throw new Error("seed block missing");
      entries.push({ node, meta: { containingPageId: pageId } });
    }
    const groups = groupByContainingPage(client, entries);
    const { container } = render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={entries}
        groups={groups}
        defaultSortMode="dates-first"
        emptyText="No references."
      />,
    );
    const groupIds = [...container.querySelectorAll("[data-group-id]")].map((el) =>
      el.getAttribute("data-group-id"),
    );
    expect(groupIds).toEqual([newer.day, older.day, alphaId]);
    // The sort button rides the toolbar with the dates-first vocabulary.
    const sortButton = screen.getByRole("button", { name: "Sort" });
    fireEvent.click(sortButton);
    expect(screen.getByText("Dates first")).not.toBeNull();
    expect(screen.getByText("Default order")).not.toBeNull();
  });

  it("a read-only tree (the Child pages shape) opens every sibling level A–Z", async () => {
    const client = await seedClient();
    const parentId = await createTitledPage(client, "Parent");
    const b = await createTitledPage(client, "Page B", parentId);
    const a = await createTitledPage(client, "Page A", parentId);
    const c = await createTitledPage(client, "Page C", parentId);
    const items: NodeCollectionItem[] = [b, a, c].map((id) => ({ node: client.getNode(id)! }));
    const { container } = render(
      <WithOutliner client={client}>
        <NodeCollection
          viewMode="outline"
          client={client}
          items={items}
          tree
          readOnly
          defaultSortMode="alphabetical"
          onNodeClick={() => {}}
        />
      </WithOutliner>,
    );
    const titles = [...container.querySelectorAll(".nt-block-content")].map((el) => el.textContent);
    expect(titles).toEqual(["Page A", "Page B", "Page C"]);
  });

  it("a flat list (the Classed nodes shape) opens A–Z", async () => {
    const client = await seedClient();
    const gamma = await createTitledPage(client, "Gamma");
    const alpha = await createTitledPage(client, "Alpha");
    const beta = await createTitledPage(client, "Beta");
    const items: NodeCollectionItem[] = [gamma, alpha, beta].map((id) => ({ node: client.getNode(id)! }));
    const { container } = render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={items}
        readOnly
        defaultSortMode="alphabetical"
        onNodeClick={() => {}}
      />,
    );
    const titles = [...container.querySelectorAll(".nt-block-content")].map((el) => el.textContent);
    expect(titles).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("the table rides the container's default sort (Edited descending) and carries the Edited column", async () => {
    const client = await seedClient();
    const one = await createTitledPage(client, "One");
    const two = await createTitledPage(client, "Two");
    const items: NodeCollectionItem[] = [one, two].map((id) => ({ node: client.getNode(id)! }));
    const { unmount } = render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={items}
        defaultSort={{ key: "edited", direction: "desc" }}
      />,
    );
    expect(screen.getByText("Edited")).not.toBeNull();
    const editedHeader = screen.getByText("Edited").closest("[aria-sort]");
    expect(editedHeader?.getAttribute("aria-sort")).toBe("descending");
    // Name carries no sort mark — the single default sort is Edited's.
    expect(screen.getByText("Name").closest("[aria-sort]")).toBeNull();
    unmount();

    // With no container default the table renders the container's row
    // order — no sort register at all (the hubs pass Edited-desc to get it).
    render(<NodeCollection viewMode="table" client={client} items={items} />);
    expect(document.querySelector("[aria-sort]")).toBeNull();
  });

  it("the cards grid carries the sort button with the Last edited vocabulary", async () => {
    const client = await seedClient();
    const one = await createTitledPage(client, "One");
    const two = await createTitledPage(client, "Two");
    const items: NodeCollectionItem[] = [one, two].map((id) => ({ node: client.getNode(id)! }));
    render(<NodeCollection viewMode="cards" client={client} items={items} onNodeClick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByText("Last edited")).not.toBeNull();
    expect(screen.getByText("Name A–Z")).not.toBeNull();
  });

  it("the editable list surface hides the sort button (the drag order is the order)", async () => {
    const client = await seedClient();
    const one = await createTitledPage(client, "One");
    const items: NodeCollectionItem[] = [one].map((id) => ({ node: client.getNode(id)! }));
    render(<NodeCollection viewMode="outline" client={client} items={items} editable />);
    expect(screen.queryByRole("button", { name: "Sort" })).toBeNull();
  });
});
