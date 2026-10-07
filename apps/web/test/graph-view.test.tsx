/**
 * graph-view tests: the display-shaping contract (settings filters,
 * semantic sparsification, edge LOD masks), the registry slot, the
 * component's honest WebGL-2-missing fallback (jsdom has no GL — the real
 * canvas path is exercised in the browser, the port boundary per the
 * renderer/engine unit suites), the reference empty surfaces (nothing to
 * graph yet / the filtered-out state with its reset / the local depth
 * hint), and the kit-composed settings toolbar.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen, fireEvent } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import type { GraphEdge, GraphTopology } from "@notees/store";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { GraphView } from "../src/ui/views/graph/GraphView.js";
import {
  DEFAULT_GRAPH_SETTINGS,
  applyGraphSettings,
  edgeMaskForZoom,
  sparsifySemantic,
} from "../src/ui/views/graph/filter.js";
import { LINK_TYPE_IDS } from "../src/ui/views/graph/filter.js";
import { getViewDefinition } from "../src/ui/views/index.js";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

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

function edge(kind: GraphEdge["kind"], source: string, target: string, weight = 1, evidence: string[] | null = null): GraphEdge {
  return { kind, source, target, weight, evidence };
}

describe("graph display shaping", () => {
  it("sparsifies semantic edges: top-K per node, min weight, symmetric keep", () => {
    const edges = [
      edge("semantic", "a", "b", 5),
      edge("semantic", "a", "c", 4),
      edge("semantic", "a", "d", 3),
      edge("semantic", "b", "c", 2),
      edge("semantic", "b", "d", 1),
      edge("semantic", "c", "d", 1),
      edge("mention", "a", "b", 9), // structural never sparsified here
    ];
    const kept = sparsifySemantic(edges, 2, 2);
    const keys = kept.map((e) => `${e.source}-${e.target}`).sort();
    // minWeight 2 cuts the weight-1 edges; per-node top-2 keeps a-b/a-c (a),
    // a-b/b-c (b), a-c (c) — and the symmetric keep preserves a-d because d's
    // own top-K lists it (a node's best link never dies asymmetrically).
    expect(keys).toEqual(["a-b", "a-c", "a-d", "b-c"]);
  });

  it("applyGraphSettings filters classes, journal, families, and scope", async () => {
    const { SYSTEM_CLASS_UUIDS } = await import("@notees/domain");
    const topology: GraphTopology = {
      nodes: [
        { id: "page", isClass: false, parentId: null, classIds: [], color: null, icon: null },
        { id: "cls", isClass: true, parentId: null, classIds: [], color: null, icon: null },
        {
          id: "day",
          isClass: false,
          parentId: null,
          classIds: [SYSTEM_CLASS_UUIDS.day],
          color: null,
          icon: null,
        },
        { id: "out", isClass: false, parentId: null, classIds: [], color: null, icon: null },
      ],
      edges: [
        edge("mention", "page", "cls"),
        edge("mention", "page", "out"),
        edge("semantic", "page", "out", 2),
      ],
    };
    const scoped = applyGraphSettings(topology, DEFAULT_GRAPH_SETTINGS, new Set(["page", "cls", "day"]));
    expect(scoped.nodes.map((n) => n.id).sort()).toEqual(["cls", "page"]);
    expect(scoped.edges.every((e) => e.kind !== "semantic" || e.target !== "out")).toBe(true);

    const noClasses = applyGraphSettings(topology, { ...DEFAULT_GRAPH_SETTINGS, showClasses: false });
    expect(noClasses.nodes.some((n) => n.id === "cls")).toBe(false);

    const withJournal = applyGraphSettings(topology, { ...DEFAULT_GRAPH_SETTINGS, showJournal: true });
    expect(withJournal.nodes.some((n) => n.id === "day")).toBe(true);

    const noSemantic = applyGraphSettings(topology, {
      ...DEFAULT_GRAPH_SETTINGS,
      families: { ...DEFAULT_GRAPH_SETTINGS.families, semantic: false },
    });
    expect(noSemantic.edges.every((e) => e.kind !== "semantic")).toBe(true);
  });

  it("edge LOD masks follow the original zoom thresholds", () => {
    expect(edgeMaskForZoom(0.2) & (1 << LINK_TYPE_IDS.mention)).toBe(0);
    expect(edgeMaskForZoom(0.4) & (1 << LINK_TYPE_IDS.mention)).not.toBe(0);
    expect(edgeMaskForZoom(0.4) & (1 << LINK_TYPE_IDS.property)).toBe(0);
    expect(edgeMaskForZoom(0.8) & (1 << LINK_TYPE_IDS.property)).not.toBe(0);
    expect(edgeMaskForZoom(0.8) & (1 << LINK_TYPE_IDS.semantic)).toBe(0);
    expect(edgeMaskForZoom(1.2) & (1 << LINK_TYPE_IDS.semantic)).not.toBe(0);
    expect(edgeMaskForZoom(0.1) & (1 << LINK_TYPE_IDS.parent)).not.toBe(0);
  });
});

describe("GraphView component", () => {
  it("registers the graph view mode", () => {
    const entry = getViewDefinition("graph");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Graph");
  });

  it("renders the honest WebGL 2 fallback when GL is unavailable", async () => {
    const client = await seedClient();
    // A live display (two connected nodes) mounts the stage — the renderer
    // init then fails honestly on jsdom's missing GL.
    const pageA = await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Alpha" }] });
    const pageB = await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Beta" }] });
    await client.createObject({
      parentId: pageA,
      contentAst: [{ type: "mention", targetNodeId: pageB, text: "Beta" }],
    });
    render(<GraphView client={client} />);
    expect(await screen.findByText("WebGL 2 required")).toBeTruthy();
  });

  it("renders 'Nothing to graph yet' on an empty workspace — no canvas mounts", async () => {
    const client = await seedClient();
    render(<GraphView client={client} />);

    // The reference empty surface, and the settings toolbar stays.
    expect(await screen.findByText("Nothing to graph yet")).toBeTruthy();
    expect(screen.getByText("Add pages and blocks to see how they connect.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recenter" })).toBeTruthy();
    expect(document.querySelector(".nt-graph__canvas")).toBeNull();
  });

  it("renders the filtered-out empty state with the reset affordance on the full surface", async () => {
    window.localStorage.clear();
    // A lone page with the orphan filter off (a device pref): the topology
    // is non-empty, but every node is hidden.
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({ showOrphans: false }),
    );
    try {
      const client = await seedClient();
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });

      render(<GraphView client={client} />);

      expect(await screen.findByText("All nodes hidden by filters")).toBeTruthy();
      expect(
        screen.getByText("Adjust visibility filters or reset them to see the graph."),
      ).toBeTruthy();

      // The reset returns the filters to the shipped defaults (orphans
      // visible): the lone page appears and the empty surface steps aside
      // (the jsdom WebGL fallback replaces it — the canvas path is a
      // browser concern).
      fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
      await screen.findByText("WebGL 2 required", {}, { timeout: 3000 }).catch(() => {});
      expect(screen.queryByText("All nodes hidden by filters")).toBeNull();
    } finally {
      window.localStorage.clear();
    }
  });

  it("the local graph names the depth on an empty neighborhood", async () => {
    window.localStorage.clear();
    // Orphans off (a device pref): the lone anchor hides, leaving the
    // neighborhood honestly empty.
    window.localStorage.setItem(
      "notees.settings.graphPrefs.local",
      JSON.stringify({ showOrphans: false }),
    );
    try {
      const client = await seedClient();
      const anchor = await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Anchor" }] });
      render(
        <GraphView client={client} local={{ anchorId: anchor, depth: 2, onDepthChange: () => {} }} />,
      );

      expect(
        await screen.findByText("No connected nodes within 2 levels"),
      ).toBeTruthy();
      expect(screen.getByText("Try increasing the levels to see more connections.")).toBeTruthy();
    } finally {
      window.localStorage.clear();
    }
  });

  it("the settings toolbar composes from the kit: ghost icon tools, the icon-radio mode selector, boolean switches, the search field", async () => {
    window.localStorage.clear();
    // The stable filtered-out state: toolbar + empty surface, no canvas
    // mount (so the jsdom WebGL fallback can't replace the chrome).
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({ showOrphans: false }),
    );
    try {
      const client = await seedClient();
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);

      await screen.findByText("All nodes hidden by filters");

      // The icon tools are kit buttons (the ghost idiom)…
      const recenter = screen.getByRole("button", { name: "Recenter" });
      expect(recenter.className).toContain("btn");
      expect(recenter.className).toContain("btn--ghost");
      expect(screen.getByRole("button", { name: "Pause layout" })).toBeTruthy();
      // …the layout selector is the icon-radio SelectionButton…
      expect(screen.getByRole("radio", { name: "Force" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Circle" })).toBeTruthy();
      // …the physics preset rides its own icon-radio selector…
      expect(screen.getByRole("radio", { name: "Sparse" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Clustered" })).toBeTruthy();
      // …the visibility toggles are kit switches…
      expect(screen.getByRole("switch", { name: "Class nodes" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Journal" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Orphans" })).toBeTruthy();
      // …and the search field is the kit SearchField.
      expect(screen.getByRole("textbox", { name: "Find node" })).toBeTruthy();
    } finally {
      window.localStorage.clear();
    }
  });
});
