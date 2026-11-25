/**
 * Multi-level sort tests (2026-11-25): the shared sorting.ts model (field
 * values — select option order, datetime days, numbers; the stable
 * multi-level comparator with empty-sinks-last), the SortFieldsPanel popup
 * (levels in priority order, direction toggle, reorder, the add-row
 * search), and the outline/cards integration (a picked sort latches over
 * the container default; Reset returns; grouping keeps semantic group
 * order with the sort applying within groups).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeCollection } from "../src/features/collection/index.js";
import {
  availableSortFields,
  compareBySortSpecs,
  sortValueOf,
  type SortFieldSpec,
} from "../src/features/collection/sorting.js";
import type { NodeCollectionItem } from "../src/features/collection/types.js";

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

const OPT_LOW = "00000000-0000-0000-0005-0000000000d1";
const OPT_HIGH = "00000000-0000-0000-0005-0000000000d2";
const OPT_URGENT = "00000000-0000-0000-0005-0000000000d3";

/** A priority select (Low/High/Urgent) + three carriers and one empty. */
async function seedPrioritySet(client: WorkspaceClient): Promise<{
  schemaId: string;
  alpha: string;
  beta: string;
  gamma: string;
  empty: string;
}> {
  const schemaId = await client.createPropertySchema({
    name: "Priority",
    type: "select",
    options: [
      { id: OPT_LOW, label: "Low" },
      { id: OPT_HIGH, label: "High" },
      { id: OPT_URGENT, label: "Urgent" },
    ],
  });
  const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
  const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
  const gamma = await client.createObject({ isEmbedded: false, name: "Gamma" });
  const empty = await client.createObject({ isEmbedded: false, name: "Delta" });
  await client.setProperty(alpha, schemaId, OPT_URGENT, 0);
  await client.setProperty(beta, schemaId, OPT_LOW, 0);
  await client.setProperty(gamma, schemaId, OPT_HIGH, 0);
  return { schemaId, alpha, beta, gamma, empty };
}

async function itemsOf(client: WorkspaceClient, ids: string[]): Promise<NodeCollectionItem[]> {
  return ids.map((id) => ({ node: client.getNode(id)! }));
}

describe("sortValueOf", () => {
  it("select resolves to the OPTION INDEX (schema order), datetime to the day, number numeric", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedPrioritySet(client);
    const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    const effortId = await client.createPropertySchema({ name: "Effort", type: "number" });
    await client.setProperty(alpha, dueId, { nodeId: (await client.ensureDateChain("2026-11-25")).day }, 0);
    await client.setProperty(alpha, effortId, 7, 0);
    const item = (await itemsOf(client, [alpha]))[0]!;
    expect(sortValueOf(client, item, { kind: "property", schemaId })).toBe(2); // Urgent = index 2
    expect(sortValueOf(client, item, { kind: "property", schemaId: dueId })).toBe("2026-11-25");
    expect(sortValueOf(client, item, { kind: "property", schemaId: effortId })).toBe(7);
    expect(sortValueOf(client, item, { kind: "name" })).toBe("Alpha");
  });

  it("availableSortFields lists the pseudo fields + carried non-text schemas (never text)", async () => {
    const client = await seedClient();
    const { schemaId, alpha } = await seedPrioritySet(client);
    const textId = await client.createPropertySchema({ name: "Note", type: "text" });
    await client.setProperty(alpha, textId, "carrier", 0);
    const fields = availableSortFields(client, await itemsOf(client, [alpha]));
    expect(fields.slice(0, 5).map((option) => option.label)).toEqual([
      "Name",
      "Page",
      "Parent",
      "Created",
      "Edited",
    ]);
    expect(fields.some((option) => option.field.kind === "property" && option.field.schemaId === schemaId)).toBe(true);
    expect(fields.some((option) => option.field.kind === "property" && option.field.schemaId === textId)).toBe(false);
  });
});

describe("compareBySortSpecs", () => {
  it("levels apply in priority order; empty values sink last regardless of direction", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma, empty } = await seedPrioritySet(client);
    // Same priority twice: the second level (name) breaks the tie.
    const delta = await client.createObject({ isEmbedded: false, name: "Aardvark" });
    await client.setProperty(delta, schemaId, OPT_LOW, 0);
    const items = await itemsOf(client, [alpha, beta, gamma, empty, delta]);
    const specs: SortFieldSpec[] = [
      { field: { kind: "property", schemaId }, direction: "desc" },
      { field: { kind: "name" }, direction: "asc" },
    ];
    const sorted = [...items].sort((a, b) => compareBySortSpecs(client, specs, a, b));
    // Urgent (Alpha) → High (Gamma) → Low tie broken by name (Aardvark
    // before Beta) → the valueless Delta sinks last.
    expect(sorted.map((item) => item.node.id)).toEqual([alpha, gamma, delta, beta, empty]);
  });
});

describe("the outline's multi-level sort", () => {
  it("picking two fields sorts by priority order; Reset returns the container default", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma, empty } = await seedPrioritySet(client);
    const items = await itemsOf(client, [alpha, beta, gamma, empty]);
    const { container } = render(
      <NodeCollection viewMode="outline" client={client} items={items} readOnly onNodeClick={() => {}} />,
    );
    const titles = () =>
      [...container.querySelectorAll(".outline-flat > li .nt-block-content")].map((el) => el.textContent);
    // The container default (position): the input order.
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    // The add-row search filters the fields.
    fireEvent.change(screen.getByRole("textbox", { name: "Search sort fields" }), {
      target: { value: "prio" },
    });
    expect(screen.queryByRole("button", { name: "+ Name" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Priority" }));
    // Priority ascending = option order (Low, High, Urgent), empty last.
    expect(titles()).toEqual(["Beta", "Gamma", "Alpha", "Delta"]);
    // Toggle to descending: Urgent first.
    fireEvent.click(screen.getByRole("button", { name: "Priority: ascending — toggle" }));
    expect(titles()).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
    // Add Name as the second level, then move it ABOVE Priority: name leads.
    fireEvent.click(screen.getByRole("button", { name: "+ Name" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Name up" }));
    expect(titles()).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    // Reset returns the container default.
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });

  it("grouping keeps the semantic group order; the sort applies WITHIN each group", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma, empty } = await seedPrioritySet(client);
    const items = await itemsOf(client, [gamma, alpha, beta, empty]);
    const { container } = render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={items}
        readOnly
        groupBy={{ kind: "property", schemaId }}
        onNodeClick={() => {}}
      />,
    );
    const groupNames = () =>
      [...container.querySelectorAll(".outline-group__name")].map((el) => el.textContent);
    // Groups ride the option order regardless of the sort; the valueless
    // item trails in the no-value group.
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Name" }));
    expect(groupNames()).toEqual(["Low", "High", "Urgent", "No Priority"]);
    expect(
      within(container.querySelector('[data-group-id$=":__none__"]') as HTMLElement).getByText("Delta"),
    ).toBeDefined();
  });
});

describe("the cards' multi-level sort", () => {
  it("the popup sorts the flat grid by the picked fields", async () => {
    const client = await seedClient();
    const { schemaId, alpha, beta, gamma, empty } = await seedPrioritySet(client);
    const items = await itemsOf(client, [alpha, beta, gamma, empty]);
    render(<NodeCollection viewMode="cards" client={client} items={items} onNodeClick={() => {}} />);
    const cardTitles = () =>
      [...document.querySelectorAll(".node-card .nt-title-content")].map((el) => el.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Priority" }));
    fireEvent.click(screen.getByRole("button", { name: "Priority: ascending — toggle" }));
    expect(cardTitles().slice(0, 3)).toEqual(["Alpha", "Gamma", "Beta"]);
  });
});
