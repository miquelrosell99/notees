/**
 * Dates (SCHEMA.md "Dates") — web level, jsdom over the in-process
 * WorkspaceClient:
 *
 *  - client date writes create the year/month/day chain once (deterministic
 *    ids make re-creates no-ops) and link the node at the schema's precision;
 *    every chain node carries presentAsMain (date pages are main nodes — a
 *    parented month/day must not render as an inline block);
 *  - year-precision values link the YEAR node;
 *  - date_range persists { start, end } refs with either side open;
 *  - a year node's backlink list includes the dated node (edge projection);
 *  - the panel's date row hosts the ported date-picker popup: a typed-date
 *    input with a parsed preview (Enter commits), a days/months/years
 *    drill-down, and a Today shortcut; the schema precision is the commit
 *    ceiling (a year-precision picker opens at the year grid and the data
 *    layer links the year node);
 *  - dateQualified link qualifiers persist metadata.startDate/endDate and
 *    round-trip through the effective read model;
 *  - the Class View bindings editor edits precision (date schemas) and the
 *    qualified flag (node-typed schemas).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { chainNodeIds, dayNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const DATE_CLASSES = [SYSTEM_CLASS_UUIDS.year, SYSTEM_CLASS_UUIDS.month, SYSTEM_CLASS_UUIDS.day];

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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** Expand the page's "Properties N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

function dateNodeCount(client: WorkspaceClient): number {
  return client
    .listPages()
    .filter((node) => node.classIds.some((id) => DATE_CLASSES.includes(id as (typeof DATE_CLASSES)[number])))
    .length;
}

function valueOf(client: WorkspaceClient, pageId: string, schemaId: string): unknown {
  return client.getEffectiveProperties(pageId).find((row) => row.propertySchemaId === schemaId)?.value;
}

describe("dates (SCHEMA.md)", () => {
  it("setDateProperty creates the chain once; a second set (same or nearby date) adds nothing", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "date" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });

    await client.setDateProperty(pageId, schemaId, "2026-09-27");
    const ids = chainNodeIds("2026-09-27");
    expect(dateNodeCount(client)).toBe(3);
    // Journal layout: year at the workspace root, month under year, day under month.
    expect(client.getNode(ids.year)?.parentId).toBeNull();
    expect(client.getNode(ids.month)?.parentId).toBe(ids.year);
    expect(client.getNode(ids.day)?.parentId).toBe(ids.month);
    // Date pages are main nodes: every chain node carries the render bit, so
    // a parented month/day renders with document chrome (and never lands in
    // the node picker's Blocks scope).
    expect(client.getNode(ids.year)?.presentAsMain).toBe(true);
    expect(client.getNode(ids.month)?.presentAsMain).toBe(true);
    expect(client.getNode(ids.day)?.presentAsMain).toBe(true);
    // Title-is-content: the day node's compact label lives in its content.
    expect(client.getNode(ids.day)?.contentAst).toEqual([{ type: "text", text: "20260927" }]);
    // The value links the day node; edges project (year backlinks below).
    expect(valueOf(client, pageId, schemaId)).toEqual({ nodeId: ids.day });

    // Editing the same date re-creates nothing (deterministic ids).
    await client.setDateProperty(pageId, schemaId, "2026-09-27");
    expect(dateNodeCount(client)).toBe(3);

    // A different day in the same month creates only that day node.
    await client.setDateProperty(pageId, schemaId, "2026-09-28");
    expect(dateNodeCount(client)).toBe(4);
    expect(valueOf(client, pageId, schemaId)).toEqual({ nodeId: chainNodeIds("2026-09-28").day });
  });

  it("a year-precision property links the YEAR node", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "founded",
      type: "date",
      datePrecision: "year",
    });
    const pageId = await client.createObject({ presentAsMain: true, name: "Org" });

    await client.setDateProperty(pageId, schemaId, "2026-09-27");
    const ids = chainNodeIds("2026-09-27");
    expect(valueOf(client, pageId, schemaId)).toEqual({ nodeId: ids.year });
    // The chain still exists below the year node.
    expect(client.getNode(ids.month)?.parentId).toBe(ids.year);
    expect(client.getNode(ids.day)?.parentId).toBe(ids.month);
  });

  it("date_range persists { start, end } refs; either end open keeps an open range", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "date_range" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    // Open start.
    await client.setDateRangeProperty(pageId, schemaId, null, "2026-10-05");
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: null,
      end: { nodeId: chainNodeIds("2026-10-05").day },
    });

    // Set the start too; the open end stays open.
    await client.setDateRangeProperty(pageId, schemaId, "2026-09-27", null);
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: null,
    });

    // Close both.
    await client.setDateRangeProperty(pageId, schemaId, "2026-09-27", "2026-10-05");
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: { nodeId: chainNodeIds("2026-10-05").day },
    });
  });

  it("a year node's backlinks list the dated node (edge projection)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "date" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.setDateProperty(pageId, schemaId, "2026-09-27");
    const ids = chainNodeIds("2026-09-27");

    const yearBacklinks = client.getBacklinks(ids.year);
    expect(yearBacklinks).toEqual([
      expect.objectContaining({ sourceId: pageId, type: "property", verb: schemaId }),
    ]);
    expect(client.getBacklinks(ids.day)).toEqual([
      expect.objectContaining({ sourceId: pageId, type: "property", verb: schemaId }),
    ]);
    expect(client.getBacklinkCount(ids.year)).toBe(1);
  });

  it("picker drill-down commits the day ref (day precision)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "date" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The unvalued date binding renders the add affordance; the popup opens
    // at the day grid (day precision). (Scoped to the date row — every page
    // also carries the unvalued "Alias of" system row since issue #7.)
    const row = screen.getByText("published").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    expect(screen.getByRole("dialog", { name: "Date picker" })).not.toBeNull();

    // The typed-date input parses with a preview and commits on Enter.
    fireEvent.change(screen.getByLabelText("Type a date"), { target: { value: "2026-02-14" } });
    expect(screen.getByText("↵ February 14, 2026")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Type a date"), { key: "Enter" });
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-02-14").day,
    });
    // The chip renders the committed date.
    expect(screen.getByRole("button", { name: "Set published" }).textContent).toBe("2026-02-14");

    // Editing the existing pill reopens the popup on the value's month;
    // the zoom selector drills out and back, then a day click overwrites
    // the same slot.
    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    fireEvent.click(screen.getByRole("radio", { name: "Show years" }));
    fireEvent.click(screen.getByRole("radio", { name: "Show days" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("14"));
    await flushWrites();

    // No-op re-pick of the same day still resolves to the same ref.
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-02-14").day,
    });
  });

  it("the schema precision is the commit ceiling: a year-precision picker commits the year", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "founded",
      type: "date",
      datePrecision: "year",
    });
    const classId = await client.createClass("Org");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Org" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const foundedRow = screen.getByText("founded").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(foundedRow).getByRole("button", { name: "Add" }));
    // Year precision opens at the YEAR grid; clicking a year resolves the
    // canonical ISO and the data layer links the YEAR node at the schema's
    // precision (the commit ceiling).
    fireEvent.click(screen.getByRole("button", { name: "2026" }));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-01-01").year,
    });
    expect(dateNodeCount(client)).toBe(3); // chain created below the year anyway
  });

  it("date_range row: start/end pickers persist an open range", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "date_range" });
    const classId = await client.createClass("Trip");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The unvalued range row's "Add" pill opens the picker for the START slot;
    // the end stays open. The picker opens on TODAY's month, so the expected
    // value is computed from the current year/month (day cells are queried by
    // their text — the aria-label is locale-dependent).
    const now = new Date();
    const expectedIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-28`;
    const spanRow = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(spanRow).getByRole("button", { name: "Add" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("28"));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds(expectedIso).day },
      end: null,
    });

    // Clear the start → fully open range.
    fireEvent.click(screen.getByRole("button", { name: "Clear start for span" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({ start: null, end: null });
  });

  it("link qualifiers persist metadata.startDate/endDate through the effective read model", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "member",
      type: "object",
      dateQualified: true,
    });
    const classId = await client.createClass("Team");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Team" });
    const aliceId = await client.createObject({ presentAsMain: true, name: "Alice" });
    await client.assignClass(pageId, classId);
    await client.setProperty(pageId, schemaId, { nodeId: aliceId }, 0);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The qualifier slots ride the shared zoom-picker control
    // (no native date inputs). The picker opens on TODAY's month, so the
    // expected values are computed from the current year/month.
    const now = new Date();
    const expected = (day: string) =>
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${day}`;
    fireEvent.click(screen.getByRole("button", { name: "Alice start date" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("10"));
    fireEvent.click(screen.getByRole("button", { name: "Alice end date" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("20"));
    await flushWrites();

    const row = client.getEffectiveProperties(pageId).find((r) => r.propertySchemaId === schemaId);
    // PC6: the panel still writes legacy ISO strings, and the applier
    // normalizes them on write to deterministic day-node refs — the canonical
    // date-node-backed qualifier shape.
    expect(row?.metadata).toEqual({
      startDate: { nodeId: dayNodeId(expected("10")) },
      endDate: { nodeId: dayNodeId(expected("20")) },
    });

    // The slot's clear affordance drops the qualifier (the link survives).
    fireEvent.click(screen.getByRole("button", { name: "Alice start date (clear)" }));
    await flushWrites();
    const cleared = client.getEffectiveProperties(pageId).find((r) => r.propertySchemaId === schemaId);
    expect(cleared?.metadata).toEqual({ endDate: { nodeId: dayNodeId(expected("20")) } });
  });

  it("Class View property definitions: precision select (date) and qualified checkbox (object) write through", async () => {
    const client = await seedClient();
    const dateSchema = await client.createPropertySchema({ name: "published", type: "date" });
    const linkSchema = await client.createPropertySchema({ name: "member", type: "object" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, dateSchema, { sequence: 0 });
    await client.setClassProperty(classId, linkSchema, { sequence: 1 });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Non-empty schema: expand the section, then each row's config panel.
    fireEvent.click(screen.getByRole("button", { name: /class properties/i }));
    await flushWrites();

    fireEvent.click(screen.getByRole("button", { name: "Configure published" }));
    fireEvent.change(screen.getByLabelText("Date precision for published"), {
      target: { value: "year" },
    });
    await flushWrites();
    expect(
      client.listPropertySchemas().find((s) => s.id === dateSchema)?.datePrecision,
    ).toBe("year");

    fireEvent.click(screen.getByRole("button", { name: "Configure member" }));
    fireEvent.click(screen.getByLabelText("Date qualified"));
    await flushWrites();
    expect(
      client.listPropertySchemas().find((s) => s.id === linkSchema)?.dateQualified,
    ).toBe(true);
  });
});
