/**
 * Owner-ruling batch 2026-10-04 — web level (jsdom over the in-process
 * WorkspaceClient):
 *
 *  - PB1 broken-target rendering: a node-typed value whose target was
 *    deleted keeps the value and renders the raw id in a dashed
 *    pill--broken chip (the broken-mention policy);
 *  - PG10 aliases: ensureAliasProperty authors the seeded schema
 *    idempotently, alias values resolve by name (resolveNodeByName), and
 *    unlinked references match alias text as name-equivalents;
 *  - PG16 option colors: a select option's §34.43 color tints the pill in
 *    the selection control, and the settings modal carries a per-option
 *    ColorButton dot;
 *  - PG3 conversion: the settings modal's Convert… runs the blessed
 *    delete+recreate flow — mappable values copy, unmappable values list
 *    and require the drop confirmation, bindings re-point, the old schema
 *    soft-deletes;
 *  - PG13 history: the context-menu "Value history…" opens the modal,
 *    honestly degraded to the device-local note when the operations feed
 *    is unreachable (the jsdom client has no REST config).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { aliasValuesOf, ensureAliasProperty } from "../src/ui/components/aliasProperty.js";
import { convertValueForType } from "../src/ui/components/PropertyConvertModal.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

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
  const { act } = await import("@testing-library/react");
  await act(async () => {});
}

function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

describe("PB1: broken-target rendering (keep-value + render-broken)", () => {
  it("a deleted target renders the raw id in a pill--broken chip; the value survives", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "ref", type: "object" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const target = await client.createObject({ presentAsMain: true, name: "Doomed" });
    await client.setProperty(owner, schemaId, { nodeId: target }, 0);
    await client.deleteObject(target, { permanent: true });

    const { container } = render(<PageView client={client} pageId={owner} />);
    expandProperties();
    await flushWrites();
    // The value row survives…
    const broken = container.querySelector(".pill--broken");
    expect(broken).not.toBeNull();
    // …and renders the raw id honestly (the broken-mention policy).
    expect(broken!.textContent).toContain(target);
    expect(broken!.getAttribute("title")).toContain("Broken reference");
  });
});

describe("PG10: aliases (seeded schema + name-equivalence)", () => {
  it("ensureAliasProperty authors the seeded schema idempotently at global scope", async () => {
    const client = await seedClient();
    expect(client.listPropertySchemas().some((s) => s.id === SYSTEM_PROPERTY_UUIDS.alias)).toBe(false);
    await ensureAliasProperty(client);
    const schema = client.listPropertySchemas().find((s) => s.id === SYSTEM_PROPERTY_UUIDS.alias);
    expect(schema).toMatchObject({ id: SYSTEM_PROPERTY_UUIDS.alias, name: "alias", type: "text", multi: true, scope: "global" });
    await ensureAliasProperty(client);
    expect(client.listPropertySchemas().filter((s) => s.id === SYSTEM_PROPERTY_UUIDS.alias)).toHaveLength(1);
  });

  it("alias values are name-equivalents in resolve and unlinked references", async () => {
    const client = await seedClient();
    await ensureAliasProperty(client);
    const page = await client.createObject({ presentAsMain: true, name: "The Republic" });
    await client.setProperty(page, SYSTEM_PROPERTY_UUIDS.alias, "Politeia", 0);
    // Name resolution: exact case-insensitive alias hit.
    expect(client.resolveNodeByName("politeia")).toBe(page);
    expect(client.resolveNodeByName("the republic")).toBe(page);
    // Unlinked references: literal alias text in another page surfaces the
    // mention candidate (minus the page itself).
    const mentioner = await client.createObject({ presentAsMain: true, name: "Mentioner" });
    const block = await client.createObject({
      parentId: mentioner,
      contentAst: [{ type: "text", text: "I read Politeia yesterday" }],
    });
    const unlinked = client.getUnlinkedReferences(page).map((entry) => entry.source.id);
    expect(unlinked).toContain(block);
    expect(aliasValuesOf(client, page)).toEqual(["Politeia"]);
  });
});

describe("PG16: select option colors", () => {
  it("an option's color tints the selection pill and shows a dot in the picker", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "State",
      type: "select",
      options: [
        { id: "opt-1", label: "Open", color: "sky" },
        { id: "opt-2", label: "Shut" },
      ],
    });
    const page = await client.createObject({ presentAsMain: true, name: "Ticket" });
    await client.setProperty(page, schemaId, "opt-1", 0);

    const { container } = render(<PageView client={client} pageId={page} />);
    expandProperties();
    await flushWrites();
    const pill = container.querySelector(".nt-property-select .pill") as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.style.background).toContain("--color-preset-sky");
    // The uncolored option renders no tint.
    await client.setProperty(page, schemaId, "opt-2", 0);
    await flushWrites();
    const plain = container.querySelector(".nt-property-select .pill") as HTMLElement;
    expect(plain.style.background).toBe("");
  });

  it("the settings modal carries a per-option ColorButton dot", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "State",
      type: "select",
      options: [{ id: "opt-1", label: "Open" }],
    });
    const page = await client.createObject({ presentAsMain: true, name: "Ticket" });
    await client.setProperty(page, schemaId, "opt-1", 0);

    render(<PageView client={client} pageId={page} />);
    expandProperties();
    await flushWrites();
    // Click the property label → settings modal (the sibling modals hand-roll
    // their headers, so the dialog carries no accessible name — query the
    // heading text).
    fireEvent.click(screen.getByText("State"));
    await flushWrites();
    await screen.findByText("Property settings");
    const dialog = document.querySelector(".nt-property-settings") as HTMLElement;
    expect(within(dialog).getByRole("button", { name: "Color for Open" })).not.toBeNull();
  });
});

describe("PG3: conversion via blessed delete+recreate", () => {
  it("convertValueForType maps same shapes and lists the rest", () => {
    expect(convertValueForType("abc", "text", "url", null)).toEqual({ ok: true, value: "abc" });
    expect(convertValueForType(42, "number", "text", null)).toEqual({ ok: true, value: "42" });
    expect(convertValueForType("1757427533728", "text", "number", null)).toEqual({ ok: true, value: 1757427533728 });
    expect(convertValueForType({ nodeId: "n1" }, "object", "date", null)).toEqual({ ok: true, value: { nodeId: "n1" } });
    expect(convertValueForType({ nodeId: "n1" }, "object", "text", null).ok).toBe(false);
    expect(convertValueForType(true, "boolean", "url", null).ok).toBe(false);
    expect(convertValueForType("opt-1", "select", "select", [{ id: "opt-1", label: "One" }])).toEqual({ ok: true, value: "opt-1" });
    expect(convertValueForType("opt-9", "select", "select", [{ id: "opt-1", label: "One" }]).ok).toBe(false);
  });

  it("the modal flow copies mappable values, lists the dropped ones, rebinds, deletes", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Score", type: "number" });
    const classId = await client.createClass("Graded");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Graded" }] });
    await client.setClassProperty(classId, schemaId, { sequence: 2 });
    const page = await client.createObject({ presentAsMain: true, name: "Exam", classIds: [classId] });
    await client.setProperty(page, schemaId, 10, 0);
    const other = await client.createObject({ presentAsMain: true, name: "Essay" });
    await client.setProperty(other, schemaId, 7, 0);

    render(<PageView client={client} pageId={page} />);
    expandProperties();
    await flushWrites();
    fireEvent.click(screen.getByText("Score"));
    await screen.findByText("Property settings");
    const dialog = document.querySelector(".nt-property-settings") as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Convert…" }));
    await screen.findByText('Convert “Score”');
    const convert = document.querySelector(".nt-property-convert") as HTMLElement;
    // Choose text: both numbers map to strings — nothing dropped.
    fireEvent.change(within(convert).getByRole("combobox", { name: "New property type" }), {
      target: { value: "text" },
    });
    await flushWrites();
    expect(within(convert).getByText(/will copy to the new schema/)).not.toBeNull();
    fireEvent.click(within(convert).getByRole("button", { name: "Convert" }));
    await flushWrites();

    // The old schema soft-deleted; a new text schema carries the values.
    const schemas = client.listPropertySchemas();
    expect(schemas.find((s) => s.id === schemaId)).toBeUndefined();
    const created = schemas.find((s) => s.name === "Score" && s.type === "text");
    expect(created).toBeDefined();
    const rows = client
      .getEffectiveProperties(page)
      .filter((row) => row.propertySchemaId === created!.id && row.source === "authored");
    expect(rows.map((row) => row.value)).toEqual(["10"]);
    // The class binding re-pointed at the new schema.
    expect(
      client.getClassBindings(classId).some((b) => b.propertySchemaId === created!.id && b.sequence === 2),
    ).toBe(true);
    expect(client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)).toBe(false);
    // The second node's value copied too.
    expect(
      client.getEffectiveProperties(other).find((row) => row.propertySchemaId === created!.id)?.value,
    ).toBe("7");
  });

  it("unmappable values require the drop confirmation", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Link", type: "object" });
    const page = await client.createObject({ presentAsMain: true, name: "Holder" });
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    await client.setProperty(page, schemaId, { nodeId: target }, 0);

    render(<PageView client={client} pageId={page} />);
    expandProperties();
    await flushWrites();
    fireEvent.click(screen.getByText("Link"));
    await screen.findByText("Property settings");
    const dialog = document.querySelector(".nt-property-settings") as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "Convert…" }));
    await screen.findByText('Convert “Link”');
    const convert = document.querySelector(".nt-property-convert") as HTMLElement;
    fireEvent.change(within(convert).getByRole("combobox", { name: "New property type" }), {
      target: { value: "number" },
    });
    await flushWrites();
    // The linked value cannot map — listed, and the Convert button stays
    // disabled until the checkbox confirms the drop.
    expect(within(convert).getByText(/cannot be converted and will be/)).not.toBeNull();
    const convertButton = within(convert).getByRole("button", { name: "Convert" }) as HTMLButtonElement;
    expect(convertButton.disabled).toBe(true);
    fireEvent.click(within(convert).getByRole("checkbox", { name: "Confirm dropping unmappable values" }));
    await flushWrites();
    expect((within(convert).getByRole("button", { name: "Convert" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("PG13: value-history modal", () => {
  it("opens from the property context menu and degrades honestly without the feed", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Note", type: "text" });
    const page = await client.createObject({ presentAsMain: true, name: "Journal" });
    await client.setProperty(page, schemaId, "first", 0);

    const { container } = render(<PageView client={client} pageId={page} />);
    expandProperties();
    await flushWrites();
    // Right-click the property label → context menu → Value history….
    const label = container.querySelector(".nt-property-name") as HTMLElement;
    fireEvent.contextMenu(label);
    await flushWrites();
    fireEvent.click(await screen.findByText("Value history…"));
    const history = await screen.findByText("Value history — Note");
    expect(history).not.toBeNull();
    const historyDialog = document.querySelector(".nt-property-history") as HTMLElement;
    // The jsdom client has no REST config → the feed is unreachable → the
    // honest device-local note, never a silent empty state.
    expect(within(historyDialog).getByRole("alert").textContent).toContain("History is unavailable");
  });
});
