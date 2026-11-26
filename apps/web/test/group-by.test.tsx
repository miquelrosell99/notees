/**
 * Group-by tests: the generic group-by engine (groupsForSpec — every
 * property type except text + the pseudo-axes, select option order with
 * empty groups dropping by default with the board's keepEmpty arm, date
 * zooms), the picker's search + zoom submenu,
 * the grouped table (one table per group), and the per-surface persistence.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { NodeCollection } from "../src/features/collection/index.js";
import { GroupByPicker } from "../src/features/collection/GroupByPicker.js";
import {
  groupsForSpec,
  groupByAxes,
  groupBySpecKey,
  isoWeekOf,
  parseGroupBySpec,
  zoomBucketOf,
  type GroupBySpec,
} from "../src/features/collection/grouping.js";
import { readDeviceSetting } from "../src/features/settings/deviceSettings.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()!.close();
  localStorage.clear();
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

const OPT_A = "00000000-0000-0000-0005-0000000000a1";
const OPT_B = "00000000-0000-0000-0005-0000000000b2";
const OPT_C = "00000000-0000-0000-0005-0000000000c3";

/** A select schema (Backlog/Doing/Reviewing) + three carriers and one empty. */
async function seedSelectSet(client: WorkspaceClient, multi = false): Promise<{
  schemaId: string;
  alpha: string;
  beta: string;
  gamma: string;
  empty: string;
}> {
  const schemaId = await client.createPropertySchema({
    name: "Status",
    type: "select",
    multi,
    options: [
      { id: OPT_A, label: "Backlog" },
      { id: OPT_B, label: "Doing" },
      { id: OPT_C, label: "Reviewing" },
    ],
  });
  const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
  const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
  const gamma = await client.createObject({ isEmbedded: false, name: "Gamma" });
  const empty = await client.createObject({ isEmbedded: false, name: "Empty" });
  await client.setProperty(alpha, schemaId, OPT_A, 0);
  await client.setProperty(beta, schemaId, OPT_B, 0);
  await client.setProperty(gamma, schemaId, OPT_A, 0);
  return { schemaId, alpha, beta, gamma, empty };
}

async function itemsOf(client: WorkspaceClient, ids: string[]) {
  return ids.map((id) => ({ node: client.getNode(id)! }));
}

describe("groupsForSpec: select", () => {
  it("orders groups by the option order, trails the no-value group — empty options drop unless the surface keeps them", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma, empty } = await seedSelectSet(client);
    const items = await itemsOf(client, [alpha, beta, gamma, empty]);
    // The default: an empty option owns NO group (the 2026-11-26 ruling —
    // the section-scoped surfaces drowned in dead headers).
    const groups = groupsForSpec(client, items, { kind: "property", schemaId });
    expect(groups.map((group) => group.label)).toEqual(["Backlog", "Doing", "No Status"]);
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([alpha, gamma]);
    expect(groups[1]!.items.map((item) => item.node.id)).toEqual([beta]);
    expect(groups[2]!.items.map((item) => item.node.id)).toEqual([empty]);
    // keepEmpty (the cards board: its empty columns are the drop targets) —
    // every option keeps its group even at 0.
    const kept = groupsForSpec(client, items, { kind: "property", schemaId }, { keepEmpty: true });
    expect(kept.map((group) => group.label)).toEqual(["Backlog", "Doing", "Reviewing", "No Status"]);
    expect(kept[2]!.items).toEqual([]);
  });

  it("multi-membership: a multi-select item rides EVERY group it has a value for", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedSelectSet(client, true);
    // Multi-value = one row per (schema, idx) — never an array value.
    await client.setProperty(alpha, schemaId, OPT_B, 1);
    const groups = groupsForSpec(client, await itemsOf(client, [alpha]), { kind: "property", schemaId });
    // The empty Reviewing group drops; alpha rides every group it values.
    expect(groups.map((group) => group.label)).toEqual(["Backlog", "Doing"]);
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([alpha]);
    expect(groups[1]!.items.map((item) => item.node.id)).toEqual([alpha]);
  });
});

describe("groupsForSpec: scalar types", () => {
  it("boolean: True/False always shown, the valueless in the trailing group", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Flag", type: "boolean" });
    const yes = await client.createObject({ isEmbedded: false, name: "Yes" });
    const no = await client.createObject({ isEmbedded: false, name: "No" });
    const unset = await client.createObject({ isEmbedded: false, name: "Unset" });
    await client.setProperty(yes, schemaId, true, 0);
    await client.setProperty(no, schemaId, false, 0);
    const groups = groupsForSpec(client, await itemsOf(client, [yes, no, unset]), {
      kind: "property",
      schemaId,
    });
    expect(groups.map((group) => group.label)).toEqual(["True", "False", "No Flag"]);
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([yes]);
    expect(groups[1]!.items.map((item) => item.node.id)).toEqual([no]);
    expect(groups[2]!.items.map((item) => item.node.id)).toEqual([unset]);
  });

  it("number: one group per value, numeric order", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Effort", type: "number" });
    const a = await client.createObject({ isEmbedded: false, name: "A" });
    const b = await client.createObject({ isEmbedded: false, name: "B" });
    const c = await client.createObject({ isEmbedded: false, name: "C" });
    await client.setProperty(a, schemaId, 10, 0);
    await client.setProperty(b, schemaId, 2, 0);
    await client.setProperty(c, schemaId, 2, 0);
    const groups = groupsForSpec(client, await itemsOf(client, [a, b, c]), { kind: "property", schemaId });
    expect(groups.map((group) => group.label)).toEqual(["2", "10"]);
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([b, c]);
  });

  it("email: one group per exact value, alphabetical", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Mail", type: "email" });
    const a = await client.createObject({ isEmbedded: false, name: "A" });
    const b = await client.createObject({ isEmbedded: false, name: "B" });
    await client.setProperty(a, schemaId, "zoe@example.com", 0);
    await client.setProperty(b, schemaId, "amy@example.com", 0);
    const groups = groupsForSpec(client, await itemsOf(client, [a, b]), { kind: "property", schemaId });
    expect(groups.map((group) => group.label)).toEqual(["amy@example.com", "zoe@example.com"]);
  });

  it("object (node reference): one group per referenced node, alphabetical by its title", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Owner", type: "object" });
    const zed = await client.createObject({ isEmbedded: false, name: "Zed" });
    const amy = await client.createObject({ isEmbedded: false, name: "Amy" });
    const a = await client.createObject({ isEmbedded: false, name: "A" });
    const b = await client.createObject({ isEmbedded: false, name: "B" });
    await client.setProperty(a, schemaId, { nodeId: zed }, 0);
    await client.setProperty(b, schemaId, { nodeId: amy }, 0);
    const groups = groupsForSpec(client, await itemsOf(client, [a, b]), { kind: "property", schemaId });
    expect(groups.map((group) => group.label)).toEqual(["Amy", "Zed"]);
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([b]);
  });
});

describe("groupsForSpec: datetime + the zoom", () => {
  async function seedDated(client: WorkspaceClient): Promise<{ schemaId: string; a: string; b: string }> {
    const schemaId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    const a = await client.createObject({ isEmbedded: false, name: "A" });
    const b = await client.createObject({ isEmbedded: false, name: "B" });
    const dayA = (await client.ensureDateChain("2026-11-25")).day;
    const dayB = (await client.ensureDateChain("2026-12-01")).day;
    await client.setProperty(a, schemaId, { nodeId: dayA }, 0);
    await client.setProperty(b, schemaId, { nodeId: dayB }, 0);
    return { schemaId, a, b };
  }

  it("buckets by the zoom level, chronological", async () => {
    const client = await seedClient();
    const { schemaId, a, b } = await seedDated(client);
    const items = await itemsOf(client, [a, b]);
    const byMonth = groupsForSpec(client, items, { kind: "property", schemaId, zoom: "month" });
    expect(byMonth.map((group) => group.label)).toEqual(["2026-11", "2026-12"]);
    const byDay = groupsForSpec(client, items, { kind: "property", schemaId, zoom: "day" });
    expect(byDay.map((group) => group.label)).toEqual(["2026-11-25", "2026-12-01"]);
    const byYear = groupsForSpec(client, items, { kind: "property", schemaId, zoom: "year" });
    expect(byYear.map((group) => group.label)).toEqual(["2026"]);
    expect(byYear[0]!.items.map((item) => item.node.id)).toEqual([a, b]);
    const byWeek = groupsForSpec(client, items, { kind: "property", schemaId, zoom: "week" });
    expect(byWeek.map((group) => group.label)).toEqual(["Week 48, 2026", "Week 49, 2026"]);
  });

  it("the created pseudo-axis buckets node timestamps at the zoom", async () => {
    const client = await seedClient();
    const a = await client.createObject({ isEmbedded: false, name: "A" });
    const groups = groupsForSpec(client, await itemsOf(client, [a]), { kind: "created", zoom: "year" });
    expect(groups.length).toBe(1);
    expect(groups[0]!.label).toBe(String(new Date().getFullYear()));
    expect(groups[0]!.items.map((item) => item.node.id)).toEqual([a]);
  });

  it("isoWeekOf follows the Thursday rule (year boundaries)", () => {
    expect(isoWeekOf("2026-11-25")).toEqual({ week: 48, weekYear: 2026 });
    // 2025-12-29 (Monday) belongs to ISO week 1 OF 2026.
    expect(isoWeekOf("2025-12-29")).toEqual({ week: 1, weekYear: 2026 });
  });

  it("zoomBucketOf labels ride the user's date format", () => {
    expect(zoomBucketOf("2026-11-25", "year")).toEqual({ key: "2026", label: "2026" });
    expect(zoomBucketOf("2026-11-25", "month")).toEqual({ key: "202611", label: "2026-11" });
    expect(zoomBucketOf("2026-11-25", "day")).toEqual({ key: "20261125", label: "2026-11-25" });
    expect(zoomBucketOf("2026-11-25", "week")).toEqual({ key: "2026-W48", label: "Week 48, 2026" });
  });
});

describe("groupsForSpec: the structural pseudo-axes", () => {
  it("page groups by the containing page; parent by the immediate parent", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Host page" });
    const block = await client.createObject({
      parentId: page,
      contentAst: [{ type: "text", text: "a block" }],
    });
    const standalone = await client.createObject({ isEmbedded: false, name: "Standalone" });
    const items = await itemsOf(client, [block, standalone]);
    const byPage = groupsForSpec(client, items, { kind: "page" });
    expect(byPage.map((group) => group.label)).toEqual(["Host page", "Standalone"]);
    const byParent = groupsForSpec(client, items, { kind: "parent" });
    expect(byParent.map((group) => group.label)).toEqual(["Host page", "No parent"]);
  });

  it("class and tag are multi-membership axes", async () => {
    const client = await seedClient();
    const classA = await client.createClass("Alpha class");
    const classB = await client.createClass("Beta class");
    const tag = await client.createObject({ isEmbedded: false, name: "urgent" });
    const node = await client.createObject({ isEmbedded: false, name: "Carrier" });
    await client.assignClass(node, classA);
    await client.assignClass(node, classB);
    await client.assignTag(node, tag);
    const items = await itemsOf(client, [node]);
    const byClass = groupsForSpec(client, items, { kind: "class" });
    expect(byClass.map((group) => group.label)).toEqual(["Alpha class", "Beta class"]);
    const byTag = groupsForSpec(client, items, { kind: "tag" });
    expect(byTag.map((group) => group.label)).toEqual(["urgent"]);
  });
});

describe("the spec model", () => {
  it("parseGroupBySpec round-trips every axis and rejects garbage", () => {
    const specs: GroupBySpec[] = [
      { kind: "property", schemaId: "abc" },
      { kind: "property", schemaId: "abc", zoom: "week" },
      { kind: "page" },
      { kind: "parent" },
      { kind: "tag" },
      { kind: "class" },
      { kind: "created", zoom: "day" },
      { kind: "edited" },
    ];
    for (const spec of specs) expect(parseGroupBySpec(spec)).toEqual(spec);
    expect(parseGroupBySpec(null)).toBeNull();
    expect(parseGroupBySpec("page")).toBeNull();
    expect(parseGroupBySpec({ kind: "property" })).toBeNull();
    expect(parseGroupBySpec({ kind: "created", zoom: "hour" })).toBeNull();
    expect(parseGroupBySpec({ kind: "nope" })).toBeNull();
  });

  it("groupBySpecKey is stable per axis + zoom", () => {
    expect(groupBySpecKey(null)).toBe("none");
    expect(groupBySpecKey({ kind: "property", schemaId: "abc" })).toBe("property:abc:");
    expect(groupBySpecKey({ kind: "property", schemaId: "abc", zoom: "day" })).toBe("property:abc:day");
    expect(groupBySpecKey({ kind: "created", zoom: "month" })).toBe("created:month");
  });

  it("groupByAxes lists the pseudo-axes plus the item set's groupable schemas (never text)", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedSelectSet(client);
    const textId = await client.createPropertySchema({ name: "Note", type: "text" });
    await client.setProperty(alpha, textId, "carrier", 0);
    const axes = groupByAxes(client, await itemsOf(client, [alpha]));
    expect(axes.slice(0, 6).map((axis) => axis.label)).toEqual([
      "Page",
      "Parent",
      "Tag",
      "Class",
      "Created",
      "Edited",
    ]);
    expect(axes.some((axis) => axis.spec.kind === "property" && axis.spec.schemaId === schemaId)).toBe(true);
    // Text is the one ungroupable type.
    expect(axes.some((axis) => axis.spec.kind === "property" && axis.spec.schemaId === textId)).toBe(false);
  });
});

describe("the grouped table view", () => {
  it("renders ONE TABLE PER GROUP — empty options render nothing at all", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma } = await seedSelectSet(client);
    render(
      <NodeCollection
        viewMode="table"
        client={client}
        items={await itemsOf(client, [alpha, beta, gamma])}
        groupBy={{ kind: "property", schemaId }}
        tableColumns={[{ id: "name", kind: "name", label: "Name", sortable: true }]}
        onNodeClick={() => {}}
      />,
    );
    // Two non-empty groups → two tables; the empty option renders no
    // chrome at all (the 2026-11-26 ruling — no dead headers).
    expect(screen.getAllByRole("table").length).toBe(2);
    const groupNames = [...document.querySelectorAll(".nt-table-group__name")].map((el) => el.textContent);
    expect(groupNames).toEqual(["Backlog", "Doing"]);
    expect(
      [...document.querySelectorAll(".nt-table-group")].some((section) =>
        section.textContent?.includes("Reviewing"),
      ),
    ).toBe(false);
    // Each row rides its option's table.
    const backlog = [...document.querySelectorAll(".nt-table-group")].find((section) =>
      section.textContent?.includes("Backlog"),
    ) as HTMLElement;
    expect(within(backlog).getByText("Alpha")).not.toBeNull();
    expect(within(backlog).getByText("Gamma")).not.toBeNull();
    expect(within(backlog).queryByText("Beta")).toBeNull();
  });
});

describe("the Group by picker", () => {
  it("searches the axes by name and picks a date axis WITH its zoom from the submenu", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedSelectSet(client);
    const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    await client.setProperty(alpha, dueId, { nodeId: (await client.ensureDateChain("2026-11-25")).day }, 0);
    const picked: Array<GroupBySpec | null> = [];
    render(
      <GroupByPicker
        client={client}
        items={await itemsOf(client, [alpha])}
        value={null}
        onChange={(spec) => picked.push(spec)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    // The search box filters the axis list by name.
    fireEvent.change(screen.getByRole("textbox", { name: "Search group-by properties" }), {
      target: { value: "due" },
    });
    expect(screen.queryByRole("button", { name: "Status" })).toBeNull();
    const dueRow = screen.getByRole("button", { name: "Due" });
    expect(dueRow).not.toBeNull();
    // The zoom submenu offers the four period options; picking one selects
    // the axis AT that zoom.
    fireEvent.click(screen.getByRole("button", { name: "Choose the Due grouping zoom" }));
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(picked).toEqual([{ kind: "property", schemaId: dueId, zoom: "week" }]);
  });

  it("picking a plain axis selects it; None clears", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedSelectSet(client);
    const picked: Array<GroupBySpec | null> = [];
    render(
      <GroupByPicker
        client={client}
        items={await itemsOf(client, [alpha])}
        value={{ kind: "property", schemaId }}
        onChange={(spec) => picked.push(spec)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    fireEvent.click(screen.getByRole("button", { name: "Page" }));
    expect(picked).toEqual([{ kind: "page" }]);
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(picked[1]).toBeNull();
  });
});

describe("the hub group-by persistence", () => {
  it("the picker's choice persists device-locally per hub; None stores the sentinel", async () => {
    const client = await seedClient();
    const { alpha } = await seedSelectSet(client);
    render(
      <CollectionHub
        client={client}
        title="Persist hub"
        items={[{ node: client.getNode(alpha)! }]}
        modes={["outline", "table"]}
        defaultMode="outline"
        persistKey="test.persist-hub"
        onOpenNode={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    fireEvent.click(screen.getByRole("button", { name: "Created" }));
    // A date axis picks WITH its default zoom (month).
    expect(readDeviceSetting("groupBy.test.persist-hub", null)).toEqual({ kind: "created", zoom: "month" });
    // The outline groups by the picked axis (the created year group).
    expect(document.querySelectorAll(".outline-group").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Group by" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(readDeviceSetting("groupBy.test.persist-hub", null)).toBe("none");
    expect(document.querySelectorAll(".outline-group").length).toBe(0);
  });
});
