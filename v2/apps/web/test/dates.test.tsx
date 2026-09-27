/**
 * Dates (SCHEMA.md "Dates") — web level, jsdom over the in-process
 * WorkspaceClient:
 *
 *  - client date writes create the year/month/day chain once (deterministic
 *    ids make re-creates no-ops) and link the node at the schema's precision;
 *  - year-precision values link the YEAR node;
 *  - date_range persists { start, end } refs with either side open;
 *  - a year node's backlink list includes the dated node (edge projection);
 *  - the panel's date row hosts the zoom picker: year→month→day commits the
 *    day ref, and the schema precision is the commit ceiling (a year
 *    precision commits the year even when zoomed into days);
 *  - dateQualified link qualifiers persist metadata.startDate/endDate and
 *    round-trip through the effective read model;
 *  - the Class View bindings editor edits precision (date schemas) and the
 *    qualified flag (node-typed schemas).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { chainNodeIds, SYSTEM_CLASS_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ClassView } from "../src/ui/ClassView.js";
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
    const pageId = await client.createObject({ nodeType: "page", name: "Note" });

    await client.setDateProperty(pageId, schemaId, "2026-09-27");
    const ids = chainNodeIds("2026-09-27");
    expect(dateNodeCount(client)).toBe(3);
    // v1 journal layout: year at the workspace root, month under year, day under month.
    expect(client.getNode(ids.year)?.parentId).toBeNull();
    expect(client.getNode(ids.month)?.parentId).toBe(ids.year);
    expect(client.getNode(ids.day)?.parentId).toBe(ids.month);
    expect(client.getNode(ids.day)?.name).toBe("20260927");
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
    const pageId = await client.createObject({ nodeType: "page", name: "Org" });

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
    const pageId = await client.createObject({ nodeType: "page", name: "Trip" });

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
    const pageId = await client.createObject({ nodeType: "page", name: "Note" });
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

  it("picker zoom year→month→day commits the day ref (day precision)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "date" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ nodeType: "page", name: "Note" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);

    // The unvalued date binding renders the add affordance; the picker opens
    // at the day grid (day precision).
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    expect(screen.getByRole("dialog", { name: "Date picker" })).not.toBeNull();

    // Up to the year grid via the breadcrumbs, then drill back down.
    fireEvent.click(screen.getByRole("button", { name: "September 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "2026" }));
    // Year cell click drills (coarser than the day ceiling)…
    fireEvent.click(screen.getByRole("button", { name: "2026" }));
    // …month cell click drills…
    fireEvent.click(screen.getByRole("button", { name: "September 2026" }));
    // …day cell click commits the day.
    fireEvent.click(screen.getByRole("button", { name: "2026-09-15" }));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-15").day,
    });
    // The chip renders the committed date.
    expect(screen.getByRole("button", { name: "Set published" }).textContent).toBe("2026-09-15");
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
    const pageId = await client.createObject({ nodeType: "page", name: "Org" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    // Year precision opens at the YEAR grid.
    // Drill into 2026 → months (view-only), drill into September → days
    // (view-only); selecting a day still commits at year granularity.
    fireEvent.click(screen.getByRole("button", { name: "Zoom into 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom into September 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "2026-09-15" }));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-15").year,
    });
    expect(dateNodeCount(client)).toBe(3); // chain created below the year anyway
  });

  it("date_range row: start/end pickers persist an open range", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "date_range" });
    const classId = await client.createClass("Trip");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ nodeType: "page", name: "Trip" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);

    // The unvalued range row's "+ Add" opens the picker for the START slot;
    // the end stays open.
    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));
    fireEvent.click(screen.getByRole("button", { name: "2026-10-01" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-10-01").day },
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
    const pageId = await client.createObject({ nodeType: "page", name: "Team" });
    const aliceId = await client.createObject({ nodeType: "page", name: "Alice" });
    await client.assignClass(pageId, classId);
    await client.setProperty(pageId, schemaId, { nodeId: aliceId }, 0);
    render(<PageView client={client} pageId={pageId} />);

    fireEvent.change(screen.getByLabelText("Alice start date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Alice end date"), {
      target: { value: "2026-12-31" },
    });
    await flushWrites();

    const row = client.getEffectiveProperties(pageId).find((r) => r.propertySchemaId === schemaId);
    expect(row?.metadata).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
  });

  it("Class View bindings editor: precision select (date) and qualified checkbox (object) write through", async () => {
    const client = await seedClient();
    const dateSchema = await client.createPropertySchema({ name: "published", type: "date" });
    const linkSchema = await client.createPropertySchema({ name: "member", type: "object" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, dateSchema, { sequence: 0 });
    await client.setClassProperty(classId, linkSchema, { sequence: 1 });
    render(<ClassView client={client} classId={classId} />);

    fireEvent.change(screen.getByLabelText("Date precision for published"), {
      target: { value: "year" },
    });
    await flushWrites();
    expect(
      client.listPropertySchemas().find((s) => s.id === dateSchema)?.datePrecision,
    ).toBe("year");

    fireEvent.click(screen.getByLabelText("Date qualified for member"));
    await flushWrites();
    expect(
      client.listPropertySchemas().find((s) => s.id === linkSchema)?.dateQualified,
    ).toBe(true);
  });
});
