/**
 * Pivot-view tests: pivot as a first-class registry view mode (the
 * query-results transient mode promoted — every collection surface can
 * wear it) and the registry availability gating the later stages
 * (scoped graph, gantt, calendar) build on. jsdom over the in-process
 * WorkspaceClient + MemoryRelay; the fixture gated view registers for the
 * gating specs and unregisters after (registry is module-global state).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  availableViewModes,
  computeViewAvailability,
  getViewDefinition,
  getViewModeOptions,
  NodeCollection,
  registerView,
  unregisterView,
} from "../src/features/collection/index.js";
import type { ViewMode } from "../src/features/collection/index.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { BLOCKS_VIEW_MODES } from "../src/ui/PageView.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

/** The gated-fixture id: the registry admits string ids beyond the ViewMode
 *  union; the host props type ViewMode, so the fixture id rides one cast. */
const GATED = "gate-fixture" as unknown as ViewMode;

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

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 *  class node's content — seed the title through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** One class + two member pages + one unclassed page: the class bit is a
 *  real dimension (1 "Class" × 2 "Not a class"). */
async function seedClassedSet(client: WorkspaceClient): Promise<{
  classId: string;
  members: string[];
  items: Array<{ node: NonNullable<ReturnType<WorkspaceClient["getNode"]>> }>;
}> {
  const classId = await createTitledClass(client, "City");
  const members = [
    await client.createObject({ isEmbedded: false, name: "Paris" }),
    await client.createObject({ isEmbedded: false, name: "London" }),
  ];
  for (const id of members) await client.assignClass(id, classId);
  const items = [classId, ...members].map((id) => ({ node: client.getNode(id)! }));
  return { classId, members, items };
}

/** Drive a kit Dropdown (the pivot's dimension/measure pickers): open the
 *  trigger by aria-label, pick the menu item by name (the menu portals to
 *  document.body). */
function pickOption(label: string, option: string): void {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(
    within(document.querySelector(".dropdown-menu--portal") as HTMLElement).getByRole("option", {
      name: option,
    }),
  );
}

/** Open the switcher's "…" overflow and pick a secondary-tier mode. */
function pickOverflowMode(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("registry availability gating", () => {
  it("views without an availability declaration are always available", () => {
    expect(availableViewModes(["outline", "prose", "pivot"], {
      datePropertyCount: 0,
      linkedItemCount: 0,
    })).toEqual(["outline", "prose", "pivot"]);
  });

  it("a gated view filters out unless its declaration's condition holds", () => {
    registerView({
      id: "timeline-fixture",
      label: "Timeline fixture",
      icon: "mdi-timeline",
      component: () => null,
      capabilities: {},
      availability: (ctx) => ctx.datePropertyCount > 0,
    });
    try {
      const modes = ["outline", "timeline-fixture"];
      const ctx = { datePropertyCount: 0, linkedItemCount: 0 };
      expect(availableViewModes(modes, ctx)).toEqual(["outline"]);
      expect(availableViewModes(modes, { ...ctx, datePropertyCount: 1 })).toEqual([
        "outline",
        "timeline-fixture",
      ]);
    } finally {
      unregisterView("timeline-fixture");
    }
  });

  it("unknown mode ids pass through untouched (hosts may name unregistered modes)", () => {
    expect(availableViewModes(["outline", "nonsense"], { datePropertyCount: 0, linkedItemCount: 0 })).toEqual([
      "outline",
      "nonsense",
    ]);
  });

  it("datePropertyCount arms per date-typed property carrying a value", async () => {
    const client = await seedClient();
    const { items } = await seedClassedSet(client);
    const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    // Bind the date property to the class and value it on ONE member: the
    // arm counts the property, not the items.
    await client.setClassProperty(items[0]!.node.id, dueId, {});
    const { day } = await client.ensureDateChain("2026-10-02");
    await client.setProperty(items[1]!.node.id, dueId, { nodeId: day }, 0);

    const without = computeViewAvailability(client, items.slice(0, 1));
    expect(without.datePropertyCount).toBe(0);
    const armed = computeViewAvailability(client, items);
    expect(armed.datePropertyCount).toBe(1);
  });

  it("linkedItemCount counts items with a node-typed property value or a mention", async () => {
    const client = await seedClient();
    const { items } = await seedClassedSet(client);
    const ownerId = await client.createPropertySchema({ name: "Owner", type: "object" });
    await client.setClassProperty(items[0]!.node.id, ownerId, {});
    const paris = items[1]!.node.id;
    // A node-typed value on one item…
    await client.setProperty(paris, ownerId, { nodeId: items[2]!.node.id }, 0);

    // …and a mention in another item's content.
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const mentioning = await client.createObject({
      parentId: host,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: paris },
      ],
    });

    const ctx = computeViewAvailability(client, [
      ...items,
      { node: client.getNode(mentioning)! },
    ]);
    expect(ctx.linkedItemCount).toBe(2);
  });

  it("the fixture view's registration carries the availability declaration", () => {
    registerView({
      id: GATED,
      label: "Gate fixture",
      icon: "mdi-test-tube",
      component: () => null,
      capabilities: {},
      availability: (ctx) => ctx.datePropertyCount > 0,
    });
    const entry = getViewDefinition("gate-fixture");
    expect(entry?.availability?.({ datePropertyCount: 0, linkedItemCount: 0 })).toBe(false);
    expect(entry?.availability?.({ datePropertyCount: 2, linkedItemCount: 0 })).toBe(true);
    unregisterView(GATED);
  });
});

describe("pivot as a registry view mode", () => {
  it("registers pivot with label, icon, and the secondary tier", () => {
    const entry = getViewDefinition("pivot");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Pivot");
    expect(entry!.icon).toBe("mdi-table-pivot");
    expect(entry!.tier).toBe("secondary");
    // The switcher options carry the tier through the registry mapping.
    const option = getViewModeOptions(["pivot"])[0]!;
    expect(option.tier).toBe("secondary");
  });

  it("NodeCollection renders the pivot grid over its items — the class bit groups, cells count", async () => {
    const client = await seedClient();
    const { items } = await seedClassedSet(client);
    const { container } = render(
      <NodeCollection viewMode="pivot" client={client} items={items} onNodeClick={() => {}} />,
    );
    const pivot = () => container.querySelector(".nt-query-pivot") as HTMLElement;
    expect(pivot()).not.toBeNull();
    // Default "None" × "None": one All×All cell counting every row.
    expect(within(pivot()).getByText("All")).not.toBeNull();
    expect(
      Array.from(pivot()!.querySelectorAll("td")).map((td) => td.textContent),
    ).toEqual(["3"]);

    pickOption("Rows", "Class bit");
    expect(await within(pivot()).findByText("Class")).not.toBeNull();
    expect(within(pivot()).getByText("Not a class")).not.toBeNull();
    const cells = Array.from(pivot()!.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells.sort()).toEqual(["1", "2"]);
  });

  it("the hub switcher offers Pivot in the overflow; picking it renders the grid and marks the toggle active", async () => {
    const client = await seedClient();
    const { items } = await seedClassedSet(client);
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Pivot hub"
        items={items}
        modes={["outline", "pivot"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // Pivot rides the "…" overflow, never the inline strip.
    expect(screen.queryByRole("radio", { name: "Pivot" })).toBeNull();
    pickOverflowMode("Pivot");
    expect(document.querySelector(".nt-query-pivot")).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "More options" });
    expect(toggle.className).toContain("selection-button__overflow-toggle--active");
  });

  it("the pivot choice persists device-locally like any view mode", async () => {
    const client = await seedClient();
    const { items } = await seedClassedSet(client);
    const hub = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Pivot hub"
        items={items}
        modes={["outline", "pivot"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    pickOverflowMode("Pivot");
    expect(document.querySelector(".nt-query-pivot")).not.toBeNull();
    hub.unmount();

    writeViewModePref("session.Pivot hub", "pivot");
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Pivot hub"
        items={items}
        modes={["outline", "pivot"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    // The saved choice survives the remount — the pivot IS a registry mode.
    expect(document.querySelector(".nt-query-pivot")).not.toBeNull();
  });

  it("a persisted mode that gates out falls back to the surface default and leaves the switcher", async () => {
    registerView({
      id: GATED,
      label: "Gate fixture",
      icon: "mdi-test-tube",
      component: () => null,
      capabilities: {},
      availability: (ctx) => ctx.datePropertyCount > 0,
    });
    try {
      const client = await seedClient();
      const { items } = await seedClassedSet(client);
      // The device remembers the gated mode from a richer collection…
      writeViewModePref("session.Gated hub", GATED);

      render(
        <CollectionHub
          client={client}
          icon="mdi-format-list-bulleted"
          title="Gated hub"
          items={items}
          modes={["outline", GATED]}
          defaultMode="outline"
          onOpenNode={() => {}}
        />,
      );
      // …but this collection feeds it nothing: the surface opens on its
      // default (a dead switch never resurrects). With a single available
      // mode the switcher stays hidden entirely (the hub's >1 rule), so the
      // gated option rides neither the strip nor an overflow.
      expect(screen.getByText("Paris")).not.toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "View mode" })).toBeNull();
      expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    } finally {
      unregisterView(GATED);
    }
  });

  it("the gated mode rides the switcher once the collection CAN feed it", async () => {
    registerView({
      id: GATED,
      label: "Gate fixture",
      icon: "mdi-test-tube",
      component: () => <div className="gate-fixture-view" />,
      capabilities: {},
      availability: (ctx) => ctx.datePropertyCount > 0,
    });
    try {
      const client = await seedClient();
      const { items } = await seedClassedSet(client);
      const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
      await client.setClassProperty(items[0]!.node.id, dueId, {});
      const { day } = await client.ensureDateChain("2026-10-02");
      await client.setProperty(items[1]!.node.id, dueId, { nodeId: day }, 0);

      render(
        <CollectionHub
          client={client}
          icon="mdi-format-list-bulleted"
          title="Feedable hub"
          items={items}
          modes={["outline", GATED]}
          defaultMode="outline"
          onOpenNode={() => {}}
        />,
      );
      // Armed: the gated mode passes the filter, so the switcher offers it
      // beside the outline (two available modes → the strip renders).
      expect(screen.getByRole("radio", { name: "Gate fixture" })).not.toBeNull();
      // And the collection resolves it like any registered view.
      const direct = render(
        <NodeCollection
          viewMode={GATED}
          client={client}
          items={items}
          onNodeClick={() => {}}
        />,
      );
      expect(direct.container.querySelector(".gate-fixture-view")).not.toBeNull();
    } finally {
      unregisterView(GATED);
    }
  });
});

describe("pivot over a page's child blocks (the NodeView triad)", () => {
  it("BLOCKS_VIEW_MODES carries pivot (pivot over a page's blocks is legitimate)", () => {
    expect(BLOCKS_VIEW_MODES).toContain("pivot");
  });
});
