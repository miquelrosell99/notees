/**
 * graph-view tests: the display-shaping contract (settings filters,
 * semantic sparsification, edge LOD masks), the registry slot, the
 * component's honest WebGL-2-missing fallback (jsdom has no GL — the real
 * canvas path is exercised in the browser, the port boundary per the
 * renderer/engine unit suites), the reference empty surfaces (nothing to
 * graph yet / the filtered-out state with its reset / the local depth
 * hint), the kit LoadingScreen projection state, the kit-composed settings
 * toolbar, the right rail (Selection + Colors sections, chip openers,
 * search-to-select, local-scope omission, groups-only painting with the
 * one-time legacy-DSL and class-colors migrations), and the once-per-mount
 * camera fit on the first engine frame (against a stubbed renderer — the
 * port boundary).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen, fireEvent, within } from "@testing-library/react";

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

/** The renderer stubs' instances for the camera-fit spec (hoisted so the
 *  vi.doMock factory can close over them). */
const glStub = vi.hoisted(() => ({
  instances: [] as Array<{ cameras: Array<{ x: number; y: number; zoom: number }> }>,
}));

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
  return { kind, source, target, weight, evidence, createdAt: null };
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

  it("applyGraphSettings filters classes, journal levels, system pages, families, and scope", async () => {
    const { SYSTEM_CLASS_UUIDS } = await import("@notees/domain");
    const node = (id: string, extra: Partial<GraphTopology["nodes"][number]> = {}) => ({
      id,
      isClass: false,
      parentId: null,
      classIds: [],
      color: null,
      icon: null,
      createdAt: "2026-10-13T00:00:00.000Z",
      contentSize: 0,
      mass: 1,
      ...extra,
    });
    const topology: GraphTopology = {
      nodes: [
        node("page"),
        node("cls", { isClass: true }),
        node("day", { classIds: [SYSTEM_CLASS_UUIDS.day] }),
        node("month", { classIds: [SYSTEM_CLASS_UUIDS.month] }),
        node("inbox", { id: "00000000-0000-0000-0002-000000000002" }),
        node("out"),
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

    // The journal levels toggle independently; the system pages toggle
    // hides the seeded Inbox.
    const withDays = applyGraphSettings(topology, { ...DEFAULT_GRAPH_SETTINGS, journalDay: true });
    expect(withDays.nodes.some((n) => n.id === "day")).toBe(true);
    expect(withDays.nodes.some((n) => n.id === "month")).toBe(false);

    const withMonths = applyGraphSettings(topology, { ...DEFAULT_GRAPH_SETTINGS, journalMonth: true });
    expect(withMonths.nodes.some((n) => n.id === "month")).toBe(true);

    const noSystem = applyGraphSettings(topology, { ...DEFAULT_GRAPH_SETTINGS, showSystemPages: false });
    expect(noSystem.nodes.some((n) => n.id === "inbox")).toBe(false);

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
    expect(screen.getByRole("button", { name: "Graph settings" })).toBeTruthy();
    expect(document.querySelector(".nt-graph__canvas")).toBeNull();
    // The control dock is canvas-bound: no canvas, no dock.
    expect(document.querySelector(".nt-graph__dock")).toBeNull();
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
      // The rail (and the Colors chip) are full-surface chrome: the local
      // card keeps them out, like the other full-surface overlays.
      expect(screen.queryByRole("button", { name: "Colors" })).toBeNull();
      expect(document.querySelector(".nt-graph__rail")).toBeNull();
    } finally {
      window.localStorage.clear();
    }
  });

  it("the chrome composes from the kit: the Visibility eye, the settings popover with the preset dropdown, the bottom mode bar with the time-lapse toggle, the rail toggle chips", async () => {
    window.localStorage.clear();
    // The stable filtered-out state: toolbar + empty surface, no canvas
    // mount (so the jsdom WebGL fallback can't replace the chrome). The
    // bottom-left control dock and the time-lapse strip are canvas-bound
    // (the dock's recenter/zoom/focus operate on the renderer) — the port
    // boundary per the renderer/engine unit suites.
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({ showOrphans: false }),
    );
    try {
      const client = await seedClient();
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);

      await screen.findByText("All nodes hidden by filters");

      // The bar is the quiet canvas register: the eye, the counts, the
      // Colors chip (the rail toggle)…
      const visibility = screen.getByRole("button", { name: "Visibility" });
      expect(visibility.className).toContain("btn");
      expect(visibility.className).toContain("btn--ghost");
      expect(screen.getByText(/nodes · .* edges/)).toBeTruthy();
      const colorsChip = screen.getByRole("button", { name: "Colors" });
      expect(colorsChip.className).toContain("chip");
      // …the retired top-bar search field stays retired (search-to-select
      // lives in the rail's Selection section)…
      expect(screen.queryByRole("textbox", { name: "Find node" })).toBeNull();
      // …and the rail rests closed.
      expect(screen.queryByLabelText("Graph rail")).toBeNull();

      // The layout mode rides the bottom mode bar (the v1 register), now
      // with the time-lapse toggle beside it…
      expect(screen.getByRole("radio", { name: "Force" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "Circle" })).toBeTruthy();
      const timeLapse = screen.getByRole("button", { name: "Time lapse" });
      expect(timeLapse.className).toContain("btn--ghost");
      expect(timeLapse.getAttribute("aria-pressed")).toBe("false");

      // The Visibility popover carries what-to-draw: families, orphans,
      // classes, the journal visibility levels.
      fireEvent.click(screen.getByRole("button", { name: "Visibility" }));
      expect(await screen.findByRole("switch", { name: "Class nodes" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Orphans" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Day pages" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Month pages" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Year pages" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "System pages" })).toBeTruthy();
      // The family toggles are kit Chips (pressed pills).
      const mentionsChip = screen.getByRole("button", { name: "Mentions" });
      expect(mentionsChip.className).toContain("chip");
      expect(mentionsChip.getAttribute("aria-pressed")).toBe("true");

      // The settings popover (the kit ButtonWithPanel) carries physics +
      // sizing: the preset is a named dropdown, the register is toggles.
      fireEvent.click(screen.getByRole("button", { name: "Graph settings" }));
      expect(await screen.findByRole("button", { name: "Physics preset" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Simulation" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Central gravity" })).toBeTruthy();
      expect(screen.getByRole("switch", { name: "Mass accumulation" })).toBeTruthy();
    } finally {
      window.localStorage.clear();
    }
  });

  it("the right rail: the Colors chip opens the rail onto the Colors section; the Selected chip opens the Selection section; search-to-select rides the shared NodeSelector; the rail is local-scope-only chrome; open state persists per device", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({ showOrphans: false }),
    );
    try {
      const client = await seedClient();
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);
      await screen.findByText("All nodes hidden by filters");

      // The Colors chip opens the rail with the Colors section expanded…
      // (scoped to the toolbar: the rail's section header shares the name).
      const toolbar = screen.getByRole("toolbar", { name: "Graph settings" });
      const colorsChip = () => within(toolbar).getByRole("button", { name: "Colors" });
      fireEvent.click(colorsChip());
      const rail = await screen.findByLabelText("Graph rail");
      expect(rail.className).toContain("nt-graph__rail");
      const colorsHeader = within(rail).getByRole("button", { name: "Colors" });
      expect(colorsHeader.getAttribute("aria-expanded")).toBe("true");
      // Groups only since the owner ruling (2026-10-13): the retired
      // class-colors block is gone, the query builder stays.
      expect(within(rail).queryByText("Class colors")).toBeNull();
      expect(within(rail).getByText("Query groups")).toBeTruthy();
      // …the Selection section rests collapsed beside it.
      const selectionHeader = within(rail).getByRole("button", { name: /Selection/ });
      expect(selectionHeader.getAttribute("aria-expanded")).toBe("false");
      // The rail is a flex sibling of the stage: the root carries the
      // rail-open modifier (the toolbar's right edge pulls in).
      expect(document.querySelector(".nt-graph--rail-open")).toBeTruthy();

      // The open state persists per device (the debounced prefs write).
      await vi.waitFor(() => {
        const persisted = JSON.parse(
          window.localStorage.getItem("notees.settings.graphPrefs.full")!,
        ) as { railOpen?: boolean };
        expect(persisted.railOpen).toBe(true);
      });

      // Clicking the active section's chip again closes the rail.
      fireEvent.click(colorsChip());
      expect(screen.queryByLabelText("Graph rail")).toBeNull();

      // Search-to-select: reopen onto Selection, type in the shared
      // NodeSelector (no create — picking adds to the selection, the
      // topology never changes), pick the row.
      fireEvent.click(colorsChip());
      const rail2 = await screen.findByLabelText("Graph rail");
      fireEvent.click(within(rail2).getByRole("button", { name: /Selection/ }));
      const search = within(rail2).getByRole("textbox", { name: "Search to select…" });
      fireEvent.change(search, { target: { value: "Lon" } });
      fireEvent.click(await within(rail2).findByRole("button", { name: "Lonely" }));

      // The Selected · N chip appears as count + opener; with its section
      // already active the chip is the close toggle — collapse first, then
      // the chip opens the rail onto the Selection section (and scrolls to
      // it)…
      const selectedChip = await screen.findByRole("button", { name: "Selected · 1" });
      expect(selectedChip.className).toContain("chip");
      fireEvent.click(within(rail2).getByRole("button", { name: /Selection/ }));
      expect(
        within(rail2).getByRole("button", { name: /Selection/ }).getAttribute("aria-expanded"),
      ).toBe("false");
      fireEvent.click(selectedChip);
      const railAgain = await screen.findByLabelText("Graph rail");
      expect(
        within(railAgain).getByRole("button", { name: /Selection/ }).getAttribute("aria-expanded"),
      ).toBe("true");
      // …the reorderable selected list is re-homed here, with the honest
      // empty state gone and the remove/clear affordances present.
      expect(within(railAgain).getByText("Lonely")).toBeTruthy();
      expect(within(railAgain).getByRole("button", { name: "Remove Lonely" })).toBeTruthy();
      expect(within(railAgain).getByRole("button", { name: "Clear selection" })).toBeTruthy();
    } finally {
      window.localStorage.clear();
    }
  });

  it("the Selection section's empty state is honest and the search never creates", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({ showOrphans: false, railOpen: true }),
    );
    try {
      const client = await seedClient();
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);
      await screen.findByText("All nodes hidden by filters");

      // The rail opens from the persisted state; both sections rest
      // collapsed, so the empty selection list is not visible yet.
      const rail = await screen.findByLabelText("Graph rail");
      fireEvent.click(within(rail).getByRole("button", { name: /Selection/ }));
      expect(await within(rail).findByText("No nodes selected")).toBeTruthy();
      expect(
        within(rail).getByText("Search above or click nodes in the graph."),
      ).toBeTruthy();

      // A query without a match shows the picker's honest empty state —
      // no create row (search-to-select never writes the graph).
      const search = within(rail).getByRole("textbox", { name: "Search to select…" });
      fireEvent.change(search, { target: { value: "No such node" } });
      expect(await within(rail).findByText("No matches found")).toBeTruthy();
      expect(within(rail).queryByRole("button", { name: /Create/ })).toBeNull();
    } finally {
      window.localStorage.clear();
    }
  });

  it("legacy text-DSL color groups migrate to ASTs in place at load", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({
        showOrphans: false,
        colorGroupsOn: true,
        colorGroups: [
          { id: "g1", label: "Books", color: "sky", query: "class:books" },
          { id: "g2", label: "Broken", color: "mint", query: "class:nope-not-a-class" },
        ],
      }),
    );
    try {
      const client = await seedClient();
      await client.createClass("books");
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);
      await screen.findByText("All nodes hidden by filters");

      // The one-time migration re-persists the groups as ASTs: the good
      // row gains `ast` and loses `query`; the unresolvable row stays,
      // marked erroneous (ast null + the parse error) — never silently
      // dropped.
      await vi.waitFor(() => {
        const persisted = JSON.parse(
          window.localStorage.getItem("notees.settings.graphPrefs.full")!,
        ) as {
          colorGroups: Array<Record<string, unknown>>;
        };
        expect(persisted.colorGroups[0]!.ast).toBeDefined();
        expect(persisted.colorGroups[0]!.query).toBeUndefined();
        expect(persisted.colorGroups[1]!.ast).toBeNull();
        expect(typeof persisted.colorGroups[1]!.error).toBe("string");
      });
    } finally {
      window.localStorage.clear();
    }
  });

  it("the retired class-color list migrates one-time into query groups appended after the existing groups", async () => {
    window.localStorage.clear();
    const client = await seedClient();
    const classId = await client.createClass("books");
    window.localStorage.setItem(
      "notees.settings.graphPrefs.full",
      JSON.stringify({
        showOrphans: false,
        classColors: [{ classId, color: "sky" }],
        colorGroups: [
          {
            id: "g1",
            label: "Existing",
            color: "mint",
            ast: { type: "group", logic: "and", children: [] },
          },
        ],
      }),
    );
    try {
      await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Lonely" }] });
      render(<GraphView client={client} />);
      await screen.findByText("All nodes hidden by filters");

      // Each class-color entry becomes a class-matching color group AFTER
      // the existing groups; the retired list clears in the same write.
      await vi.waitFor(() => {
        const persisted = JSON.parse(
          window.localStorage.getItem("notees.settings.graphPrefs.full")!,
        ) as {
          classColors: unknown[];
          colorGroups: Array<{
            label: string;
            color: string;
            ast: { type: string; children: Array<{ type: string; classId?: string }> } | null;
          }>;
        };
        expect(persisted.classColors).toEqual([]);
        expect(persisted.colorGroups).toHaveLength(2);
        expect(persisted.colorGroups[0]!.label).toBe("Existing");
        const migrated = persisted.colorGroups[1]!;
        expect(migrated.color).toBe("sky");
        expect(migrated.label).toBe("books"); // the class's display name
        expect(migrated.ast).not.toBeNull();
        expect(migrated.ast!.children).toEqual([{ type: "class", classId }]);
      });
    } finally {
      window.localStorage.clear();
    }
  });

  it("renders the kit LoadingScreen (inline) while the topology projects", async () => {
    window.localStorage.clear();
    const client = await seedClient();
    render(<GraphView client={client} />);
    // First paint: display === null — the inline kit LoadingScreen owns the
    // wrapper (role=status carrying the projection label), not an EmptyState.
    expect(screen.getByText("Projecting the workspace topology…")).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Projecting the workspace topology…" }),
    ).toBeTruthy();
    expect(
      document.querySelector(".nt-graph--loading .loading-screen--inline"),
    ).toBeTruthy();
    // The topology lands and the honest empty surface steps in.
    expect(await screen.findByText("Nothing to graph yet")).toBeTruthy();
  });

  it("the opening camera is fitted once, on the first engine frame (owner 2026-10-13)", async () => {
    window.localStorage.clear();
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Alpha" }] });
    const pageB = await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Beta" }] });
    await client.createObject({
      parentId: pageA,
      contentAst: [{ type: "mention", targetNodeId: pageB, text: "Beta" }],
    });
    // The real canvas path is a browser concern (the port boundary): stub
    // the renderer so the stage mounts in jsdom. The stub's fitToCanvas
    // returns a distinctive camera; the loop must apply it on the first
    // frame (the force path never fitted the opening camera — the "blank
    // while loading" fix).
    vi.resetModules();
    vi.doMock("../src/ui/views/graph/renderer/webglRenderer.js", () => ({
      GraphWebGLRenderer: class StubRenderer {
        cameras: Array<{ x: number; y: number; zoom: number }> = [];
        constructor() {
          glStub.instances.push(this);
        }
        init(): void {}
        destroy(): void {}
        resize(): void {}
        setNodeVisuals(): void {}
        setNodeTimes(): void {}
        setEdges(): void {}
        setTimeLapse(): void {}
        setSelectedNodes(): void {}
        setHoveredNode(): void {}
        setHoveredEdge(): void {}
        setHoverNeighborhood(): void {}
        setEdgeMask(): void {}
        setCamera(x: number, y: number, zoom: number): void {
          this.cameras.push({ x, y, zoom });
        }
        updatePositions(): void {}
        overridePosition(): void {}
        render(): void {}
        fitToCanvas(): { x: number; y: number; zoom: number } {
          return { x: 111, y: 222, zoom: 0.42 };
        }
        worldToScreen(wx: number, wy: number): { x: number; y: number } {
          return { x: wx, y: wy };
        }
        screenToWorld(px: number, py: number): { x: number; y: number } {
          return { x: px, y: py };
        }
        pickNode(): string | null {
          return null;
        }
        pickEdge(): number {
          return -1;
        }
        get nodePositions(): Float32Array {
          return new Float32Array(0);
        }
        get nodeOrder(): string[] {
          return [];
        }
      },
    }));
    try {
      const { GraphView: GraphViewWithStub } = await import("../src/ui/views/graph/GraphView.js");
      render(<GraphViewWithStub client={client} />);
      await vi.waitFor(() => {
        const instance = glStub.instances.at(-1)!;
        expect(
          instance.cameras.some((c) => c.x === 111 && c.y === 222 && c.zoom === 0.42),
        ).toBe(true);
      });
    } finally {
      glStub.instances.length = 0;
      // Per-file test isolation contains the doMock registry; resetModules
      // keeps the module registry clean for anything imported afterwards.
      vi.resetModules();
    }
  });
});
