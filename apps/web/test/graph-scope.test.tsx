/**
 * Scoped-graph tests: the graph as a collection view mode. The registry
 * component receives the collection's items; the map's universe is those
 * items rolled up to the graph node set (the blocks-never-render law at
 * scope time — a block item maps to the page holding it) plus the edges
 * among them; the full workspace map (no items) is byte-identical to
 * before. Graph is availability-gated (linkedItemCount >= 1 — a link-less
 * collection offers no map). jsdom has no GPU backend: hosted specs assert
 * the honest renderer-failed / empty surfaces, never pixels (the port
 * boundary the graph-view spec already establishes).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen, fireEvent } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { GraphTopology } from "@notees/store";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  DEFAULT_GRAPH_SETTINGS,
  applyGraphSettings,
  rollupGraphScope,
} from "../src/features/collection/graph/filter.js";
import { getViewDefinition, NodeCollection } from "../src/features/collection/index.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  vi.restoreAllMocks();
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

// ── rollupGraphScope (the scope builder) ────────────────────────────────────

interface FakeNode {
  id: string;
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
}

function readerOf(nodes: FakeNode[]): {
  getNode(id: string): FakeNode | undefined;
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { getNode: (id) => byId.get(id) };
}

describe("rollupGraphScope — items roll up to the graph node set", () => {
  const PAGE: FakeNode = { id: "page", isClass: false, isEmbedded: false, parentId: null };
  const CLS: FakeNode = { id: "cls", isClass: true, isEmbedded: false, parentId: null };
  const SUBPAGE: FakeNode = { id: "sub", isClass: false, isEmbedded: false, parentId: "page" };
  const BLOCK: FakeNode = { id: "blk", isClass: false, isEmbedded: true, parentId: "page" };
  const NESTED: FakeNode = { id: "nest", isClass: false, isEmbedded: true, parentId: "blk" };
  const ORPHAN_BLOCK: FakeNode = { id: "orph", isClass: false, isEmbedded: true, parentId: null };

  it("pages and classes map to themselves; blocks roll up to the page holding them", () => {
    const scope = rollupGraphScope(readerOf([PAGE, CLS, SUBPAGE, BLOCK, NESTED]), [
      "page",
      "cls",
      "blk",
      "nest",
    ]);
    expect([...scope].sort()).toEqual(["cls", "page"]);
  });

  it("a parented main child is its own graph node (subpages render in the map)", () => {
    const scope = rollupGraphScope(readerOf([PAGE, SUBPAGE]), ["sub"]);
    expect([...scope]).toEqual(["sub"]);
  });

  it("a parentless block has no graph node to roll up to — it drops from the scope", () => {
    const scope = rollupGraphScope(readerOf([PAGE, ORPHAN_BLOCK]), ["orph", "page"]);
    expect([...scope]).toEqual(["page"]);
  });
});

// ── the scoped universe (edges among the scope only) ───────────────────────

describe("scoped universe — applyGraphSettings with a scope set", () => {
  const topology = (): GraphTopology => ({
    nodes: [
      { id: "a", isClass: false, parentId: null, classIds: [], color: null, icon: null, createdAt: "2026-01-01", contentSize: 0, mass: 1 },
      { id: "b", isClass: false, parentId: null, classIds: [], color: null, icon: null, createdAt: "2026-01-01", contentSize: 0, mass: 1 },
      { id: "c", isClass: false, parentId: null, classIds: [], color: null, icon: null, createdAt: "2026-01-01", contentSize: 0, mass: 1 },
    ],
    edges: [
      { source: "a", target: "b", kind: "mention", weight: 1, evidence: null, createdAt: null },
      { source: "b", target: "c", kind: "mention", weight: 1, evidence: null, createdAt: null },
    ],
  });

  it("keeps only the scoped nodes and the edges with both endpoints in scope — the out-of-scope edge DROPS (no dimmed external nodes)", () => {
    const display = applyGraphSettings(topology(), DEFAULT_GRAPH_SETTINGS, new Set(["a", "b"]));
    expect(display.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
    // a→b stays; b→c drops because c is outside the collection.
    expect(display.edges.map((edge) => `${edge.source}>${edge.target}`)).toEqual(["a>b"]);
  });

  it("no scope renders the full topology (the workspace path is unchanged)", () => {
    const display = applyGraphSettings(topology(), DEFAULT_GRAPH_SETTINGS);
    expect(display.nodes).toHaveLength(3);
    expect(display.edges).toHaveLength(2);
  });
});

// ── component-level seams ───────────────────────────────────────────────────

describe("graph as a collection view mode", () => {
  /** Two pages; the first mentions the second (a link the map can draw). */
  async function seedLinkedPair(client: WorkspaceClient): Promise<{
    source: string;
    target: string;
    items: Array<{ node: NonNullable<ReturnType<WorkspaceClient["getNode"]>> }>;
  }> {
    const target = await client.createObject({ isEmbedded: false, name: "Beta" });
    const source = await client.createObject({ isEmbedded: false, name: "Alpha " });
    await client.updateObject(source, {
      contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: target }],
    });
    return {
      source,
      target,
      items: [source, target].map((id) => ({ node: client.getNode(id)! })),
    };
  }

  it("the registry entry declares the linked-item availability gate", () => {
    const entry = getViewDefinition("graph");
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe("secondary");
    expect(entry!.availability?.({ datePropertyCount: 0, linkedItemCount: 0 })).toBe(false);
    expect(entry!.availability?.({ datePropertyCount: 0, linkedItemCount: 1 })).toBe(true);
  });

  it("a hosted graph never touches the browser tab title (the workspace surface owns it)", async () => {
    const client = await seedClient();
    const { items } = await seedLinkedPair(client);
    document.title = "Alpha - Notees";
    const { unmount } = render(
      <NodeCollection viewMode="graph" client={client} items={items} onNodeClick={() => {}} />,
    );
    expect(document.title).toBe("Alpha - Notees");
    unmount();
    expect(document.title).toBe("Alpha - Notees");
  });

  it("a hosted graph mounts the scoped stage — the renderer fails honestly on jsdom, the registry mode resolves", async () => {
    const client = await seedClient();
    const { items } = await seedLinkedPair(client);
    const { container } = render(
      <NodeCollection viewMode="graph" client={client} items={items} onNodeClick={() => {}} />,
    );
    expect(container.querySelector(".node-collection--graph")).not.toBeNull();
    // The scoped universe feeds the stage (two pages, one mention edge) —
    // jsdom has no GPU backend, so the honest fallback names the failure.
    expect(await screen.findByText("Graph renderer failed")).toBeTruthy();
  });

  it("the switcher offers Graph only when the collection carries links; the choice persists device-locally", async () => {
    const client = await seedClient();
    const unlinked = await client.createObject({ isEmbedded: false, name: "Plain" });
    const unlinkedItems = [{ node: client.getNode(unlinked)! }];

    const gated = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Graph hub"
        items={unlinkedItems}
        modes={["outline", "graph"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // Link-less: the gate drops graph — one available mode, no switcher.
    expect(screen.queryByRole("radiogroup", { name: "View mode" })).toBeNull();
    gated.unmount();

    const { items } = await seedLinkedPair(client);
    writeViewModePref("session.Graph hub", "graph");
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Graph hub"
        items={items}
        modes={["outline", "graph"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // Linked: graph is available AND the persisted choice survives the
    // sanitize (VIEW_MODES carries graph now) — the mode resolves and the
    // honest renderer-failed surface names it.
    expect(await screen.findByText("Graph renderer failed")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Graph" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByRole("menuitem", { name: "Graph" }).className).toContain(
      "selection-button__overflow-item--active",
    );
  });
});
