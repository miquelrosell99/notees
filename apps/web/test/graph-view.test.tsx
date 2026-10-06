/**
 * graph-view tests: the display-shaping contract (settings filters,
 * semantic sparsification, edge LOD masks), the registry slot, and the
 * component's honest WebGL-2-missing fallback (jsdom has no GL — the real
 * canvas path is exercised in the browser, the port boundary per the
 * renderer/engine unit suites).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";

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
    await client.createObject({ presentAsMain: true, contentAst: [{ type: "text", text: "Alpha" }] });
    render(<GraphView client={client} items={[]} />);
    expect(await screen.findByText("WebGL 2 required")).toBeTruthy();
  });
});
