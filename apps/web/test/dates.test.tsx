/**
 * Datetime (SCHEMA.md "Datetime" — the unified date property type) — web
 * level, jsdom over the in-process WorkspaceClient:
 *
 *  - client datetime writes create the year/month/day chain once
 *    (deterministic ids make re-creates no-ops) and link the node at the
 *    schema's precision; every chain node carries presentAsMain (date pages
 *    are main nodes — a parented month/day must not render as an inline
 *    block);
 *  - year-precision values link the YEAR node;
 *  - ranges persist { start, end } of slots with either side open; a slot
 *    MAY carry a wall-clock time (full-day = no time, the default) — a time
 *    requires day precision on BOTH the schema ceiling and the slot's ref
 *    (the write path fails loud otherwise);
 *  - a timed point round-trips through the write path and renders its time
 *    in the panel pill and the TableView cell; a range with a timed end
 *    renders `start → end HH:MM`;
 *  - a year node's backlink list includes the dated node (edge projection);
 *  - the panel's datetime row (and the TableView date cell) open the
 *    canonical date-picker popup: a natural-language date field ("today",
 *    "Feb 14", "next week" — plus an optional wall-clock time, "tomorrow
 *    14:30") with a parsed preview, a month day-grid under a month ⌄ / year ⌄
 *    dropdown header with ‹ › navigation (the days/months/years zoom grids
 *    stay), a Suggestions column (relative dates, the current date checked),
 *    an All-day switch (on by default; off reveals the 24h time input),
 *    a Range switch (off collapses a range to the point, start kept and end
 *    dropped), a Repeat row (day precision), and Remove; the schema
 *    precision is the commit ceiling (a year-precision picker opens at the
 *    year grid and hides the time chrome; the data layer links the year
 *    node);
 *  - dateQualified link qualifiers persist metadata.startDate/endDate and
 *    round-trip through the effective read model;
 *  - the Class View bindings editor edits precision (datetime schemas) and
 *    the qualified flag (node-typed schemas).
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

/** Expand the page's "Metadata N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Metadata / });
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

describe("datetime (SCHEMA.md)", () => {
  it("a point write creates the chain once; a second set (same or nearby date) adds nothing", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });

    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
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
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
    expect(dateNodeCount(client)).toBe(3);

    // A different day in the same month creates only that day node.
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-28" });
    expect(dateNodeCount(client)).toBe(4);
    expect(valueOf(client, pageId, schemaId)).toEqual({ nodeId: chainNodeIds("2026-09-28").day });
  });

  it("a year-precision property links the YEAR node", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "founded",
      type: "datetime",
      datePrecision: "year",
    });
    const pageId = await client.createObject({ presentAsMain: true, name: "Org" });

    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
    const ids = chainNodeIds("2026-09-27");
    expect(valueOf(client, pageId, schemaId)).toEqual({ nodeId: ids.year });
    // The chain still exists below the year node.
    expect(client.getNode(ids.month)?.parentId).toBe(ids.year);
    expect(client.getNode(ids.day)?.parentId).toBe(ids.month);
  });

  it("a range persists { start, end } slots; either end open keeps an open range", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "datetime" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    // Open start.
    await client.setDatetimeProperty(pageId, schemaId, {
      start: null,
      end: { iso: "2026-10-05" },
    });
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: null,
      end: { nodeId: chainNodeIds("2026-10-05").day },
    });

    // Set the start too; the open end stays open.
    await client.setDatetimeProperty(pageId, schemaId, {
      start: { iso: "2026-09-27" },
      end: null,
    });
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: null,
    });

    // Close both.
    await client.setDatetimeProperty(pageId, schemaId, {
      start: { iso: "2026-09-27" },
      end: { iso: "2026-10-05" },
    });
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: { nodeId: chainNodeIds("2026-10-05").day },
    });
  });

  it("a timed point round-trips the wall-clock time; time requires day precision (fail loud)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });

    // The timed slot rides the value beside the day-node anchor.
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27", time: "09:30" });
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-27").day,
      time: "09:30",
    });

    // A year-precision schema has no wall-clock time — the write fails loud.
    const yearSchema = await client.createPropertySchema({
      name: "founded",
      type: "datetime",
      datePrecision: "year",
    });
    await expect(
      client.setDatetimeProperty(pageId, yearSchema, { iso: "2026-09-27", time: "09:30" }),
    ).rejects.toThrow(/day precision/);
  });

  it("a year node's backlinks list the dated node (edge projection)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
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
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The unvalued single-value binding renders the "Select" placeholder
    // trigger; clicking it opens the popup at the day grid (day precision).
    // (Scoped to the date row — every page also carries the unvalued "Alias
    // of" system row since issue #7.)
    const row = screen.getByText("published").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Set published" }));
    expect(screen.getByRole("dialog", { name: "Date picker" })).not.toBeNull();

    // The typed-date input parses with a preview and commits on Enter.
    fireEvent.change(screen.getByLabelText("Type a date"), { target: { value: "2026-02-14" } });
    expect(screen.getByText("↵ February 14, 2026")).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Type a date"), { key: "Enter" });
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-02-14").day,
    });
    // The dropdown's content area renders the committed date's display name.
    expect(
      within(screen.getByRole("button", { name: "Set published" })).getByText("2026-02-14"),
    ).not.toBeNull();

    // Editing the existing value reopens the popup on the value's month;
    // the header carries the month ⌄ / year ⌄ dropdowns (the zoom
    // affordance): the month dropdown drills to the months grid, the year
    // dropdown to the years window — navigation only, nothing commits.
    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    let dialog = screen.getByRole("dialog", { name: "Date picker" });
    expect(
      within(dialog).getByRole("button", { name: "Choose month" }).textContent,
    ).toContain("February");
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose month" }));
    expect(within(dialog).getByRole("button", { name: "February" })).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose year" }));
    expect(within(dialog).getByRole("button", { name: "2024" })).not.toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });

    // A day click overwrites the same slot (no-op re-pick of the same day
    // still resolves to the same ref).
    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByText("14"));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-02-14").day,
    });
  });

  it("a timed point renders its time in the panel pill (the slot formatter)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27", time: "09:30" });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The single-value dropdown's content shows the settings-aware date
    // label with the wall-clock time appended.
    expect(
      within(screen.getByRole("button", { name: "Set published" })).getByText("2026-09-27 09:30"),
    ).not.toBeNull();
  });

  it("a range with a timed end renders `start → end HH:MM` on one pill; the popup opens with Range on", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "span",
      type: "datetime",
      multi: true,
    });
    const classId = await client.createClass("Trip");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, {
      start: { iso: "2026-09-27" },
      end: { iso: "2026-10-05", time: "18:45" },
    });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The range rides ONE pill (the value formatter): the start's
    // settings-aware date label, the arrow, the end with its wall-clock
    // time appended (the slot formatter).
    const spanRow = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    const pill = within(spanRow).getByRole("button", { name: "Set span" });
    expect(pill.textContent).toBe("2026-09-27 → 2026-10-05 18:45");

    // The pill opens the canonical popup with the Range switch reflecting
    // the stored union and the end slot showing its date.
    fireEvent.click(pill);
    const dialog = screen.getByRole("dialog", { name: "Date picker" });
    expect(
      within(dialog).getByRole("switch", { name: "Range" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(dialog).getByRole("button", { name: "End date" }).textContent).toBe(
      "2026-10-05",
    );
  });

  it("the popup's Range switch reveals the end slot; turning it off collapses to the point", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "datetime" });
    const classId = await client.createClass("Trip");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, {
      start: { iso: "2026-09-27" },
      end: null,
    });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The open range renders `start → …` on one pill.
    const spanRow = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    expect(within(spanRow).getByRole("button", { name: "Set span" }).textContent).toBe(
      "2026-09-27 → …",
    );

    // Range ON (the stored shape): focusing the end slot and picking a day
    // in the shared grid commits BOTH sides (the full union, one write).
    fireEvent.click(within(spanRow).getByRole("button", { name: "Set span" }));
    let dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByRole("button", { name: "End date" }));
    fireEvent.click(within(dialog).getByText("28"));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: { nodeId: chainNodeIds("2026-09-28").day },
    });

    // Range OFF collapses to the point — start kept, end dropped, silently.
    const spanRowAfter = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(spanRowAfter).getByRole("button", { name: "Set span" }));
    dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Range" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-27").day,
    });
  });

  it("turning Range on over a point commits a two-sided range (the end starts as the start's copy)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "span", type: "datetime" });
    const classId = await client.createClass("Trip");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const spanRow = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(spanRow).getByRole("button", { name: "Set span" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Range" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      start: { nodeId: chainNodeIds("2026-09-27").day },
      end: { nodeId: chainNodeIds("2026-09-27").day },
    });
    // The pill now renders the range (fresh lookup — the pill re-renders
    // when the value's shape changes).
    const spanRowAfter = screen.getByText("span").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    expect(within(spanRowAfter).getByRole("button", { name: "Set span" }).textContent).toBe(
      "2026-09-27 → 2026-09-27",
    );
  });

  it("the schema precision is the commit ceiling: a year-precision picker commits the year", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "founded",
      type: "datetime",
      datePrecision: "year",
    });
    const classId = await client.createClass("Org");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Org" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const foundedRow = screen.getByText("founded").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    // The single-value binding's "Select" trigger opens the popup; year
    // precision opens at the YEAR grid; clicking a year resolves the
    // canonical ISO and the data layer links the YEAR node at the schema's
    // precision (the commit ceiling).
    fireEvent.click(within(foundedRow).getByRole("button", { name: "Set founded" }));
    fireEvent.click(screen.getByRole("button", { name: "2026" }));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-01-01").year,
    });
    expect(dateNodeCount(client)).toBe(3); // chain created below the year anyway
  });

  it("a suggestion click commits the relative date; the row matching the current date carries the ✓", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // The empty single-value trigger opens the popup; Tomorrow commits the
    // relative day (local clock) as a full-day point.
    const row = screen.getByText("published").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Set published" }));
    let dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Tomorrow" }));
    await flushWrites();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds(tomorrowIso).day,
    });

    // Reopen: the suggestion row matching the edited value's current date
    // carries the ✓. (Fresh lookups — the row re-renders when the value
    // lands, detaching the pre-commit elements.)
    const rowAfter = screen.getByText("published").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Set published" }));
    dialog = screen.getByRole("dialog", { name: "Date picker" });
    expect(dialog.querySelector(".date-picker-suggestion--active")?.textContent).toBe(
      "Tomorrow",
    );
  });

  it("All-day off reveals the time input and commits a timed value; back on drops the time", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });

    // All-day ON by default (full-day = no time): no time input renders.
    expect(
      within(dialog).getByRole("switch", { name: "All-day" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(dialog).queryByLabelText("Time")).toBeNull();

    // OFF commits a default time (the popup stays open) and reveals the
    // 24h HH:MM input…
    fireEvent.click(within(dialog).getByRole("switch", { name: "All-day" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-27").day,
      time: "09:00",
    });
    expect(within(dialog).getByLabelText("Time")).not.toBeNull();

    // …typing a valid HH:MM commits it live…
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "14:30" } });
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-27").day,
      time: "14:30",
    });

    // …and the pill renders the slot formatter's `date HH:MM`.
    expect(screen.getByRole("button", { name: "Set published" }).textContent).toBe(
      "2026-09-27 14:30",
    );

    // All-day back ON drops the time (full-day again).
    fireEvent.click(within(dialog).getByRole("switch", { name: "All-day" }));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-09-27").day,
    });
  });

  it("the text field parses a wall-clock time: \"tomorrow 14:30\" commits a timed value", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.change(screen.getByLabelText("Type a date"), {
      target: { value: "tomorrow 14:30" },
    });
    expect(screen.getByText(/↵ .+ 14:30/)).not.toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Type a date"), { key: "Enter" });
    await flushWrites();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds(tomorrowIso).day,
      time: "14:30",
    });
  });

  it("a precision ceiling hides the time UI (year precision lands on the year grid, no All-day switch)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "founded",
      type: "datetime",
      datePrecision: "year",
    });
    const classId = await client.createClass("Org");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Org" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const foundedRow = screen.getByText("founded").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    fireEvent.click(within(foundedRow).getByRole("button", { name: "Set founded" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });

    // The year grid is the landing view; the all-day/time chrome stays
    // hidden (a year has no wall-clock time).
    expect(within(dialog).getByRole("button", { name: "2026" })).not.toBeNull();
    expect(within(dialog).queryByRole("switch", { name: "All-day" })).toBeNull();
    expect(within(dialog).queryByLabelText("Time")).toBeNull();
  });

  it("the popup's Repeat row authors the recurrence rule (metadata.repeat)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    const classId = await client.createClass("Event");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Review" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-10-11" });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    fireEvent.click(screen.getByRole("button", { name: "Set When" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });
    // The Repeat row rides the popup beside the switches.
    fireEvent.click(within(dialog).getByText("Does not repeat"));
    fireEvent.click(await screen.findByText("Weekly"));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-10-11").day,
    });
    expect(
      client.getEffectiveProperties(pageId).find((row) => row.propertySchemaId === schemaId)
        ?.metadata?.repeat,
    ).toBe("weekly");
  });

  it("the popup's Remove unsets a single-value row (the cell empties)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "published", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-09-27" });
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    fireEvent.click(screen.getByRole("button", { name: "Set published" }));
    const dialog = screen.getByRole("dialog", { name: "Date picker" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await flushWrites();

    expect(valueOf(client, pageId, schemaId)).toBeUndefined();
    // The row reads empty again (the "Select" placeholder returns).
    const row = screen.getByText("published").closest<HTMLElement>(".nt-props-sidebar__prop, li")!;
    expect(within(row).getByText("Select")).not.toBeNull();
  });

  it("the TableView datetime cell renders a timed point and re-picks through the canonical popup", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "When", type: "datetime" });
    const classId = await client.createClass("Dated");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Note" });
    await client.assignClass(pageId, classId);
    await client.setDatetimeProperty(pageId, schemaId, { iso: "2026-10-02", time: "14:15" });
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The classed-nodes section defaults to the table; the cell shows the
    // settings-aware label with the time appended. (The column header is a
    // same-named sort button — the cell is the second match.)
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }
    const cell = screen.getAllByRole("button", { name: "When" })[1]!;
    expect(cell.textContent).toBe("2026-10-02 14:15");

    // Re-picking through the popup's day grid keeps the slot's time (the
    // value is timed — All-day rides OFF in the popup).
    fireEvent.click(cell);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("5"));
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-10-05").day,
      time: "14:15",
    });

    // All-day ON (from the same popup) drops the time — full-day again.
    fireEvent.click(cell);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Date picker" })).getByRole("switch", {
        name: "All-day",
      }),
    );
    await flushWrites();
    expect(valueOf(client, pageId, schemaId)).toEqual({
      nodeId: chainNodeIds("2026-10-05").day,
    });
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

  it("Class View property definitions: precision select (datetime) and qualified checkbox (object) write through", async () => {
    const client = await seedClient();
    const dateSchema = await client.createPropertySchema({ name: "published", type: "datetime" });
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
