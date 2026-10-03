/**
 * Metadata pickers (ported popup controls) — web level, jsdom over the
 * in-process WorkspaceClient:
 *
 *  - the "Add class" pill popup is the ported node-selector picker: it lists
 *    classes, filters by search text, picks assign (class.add), and the
 *    "Create" row creates + assigns a new class;
 *  - right-clicking a class pill opens the color-swatch menu; a swatch writes
 *    object.update color, and the "No color" entry is a no-op (the protocol
 *    has no null color);
 *  - select schemas WITH options render the ported options control (pills +
 *    picker writing option ids); select schemas WITHOUT options keep the
 *    minimal text editor;
 *  - boolean schemas render the checkbox toggle writing true/false;
 *  - the object picker's search/create rows find and create pages (created
 *    pages carry the schema's target classes).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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
  await act(async () => {});
}

/** Expand the page's "Properties N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 * class node's content (the upsert's LWW update loses against the row its own
 * INSERT wrote). object.update's later-HLC path does persist — seed titles
 * through it; remove once the applier is fixed. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createClass(title);
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

describe("metadata pickers (ported popups)", () => {
  it("the class picker lists classes, filters, picks, and creates", async () => {
    const client = await seedClient();
    const fictionId = await createTitledClass(client, "Fiction");
    const poetryId = await createTitledClass(client, "Poetry");
    const pageId = await client.createObject({ presentAsMain: true, name: "Book" });
    await client.assignClass(pageId, poetryId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The assigned class renders as a pill; the "Add class" pill opens the picker.
    expect(screen.getByRole("button", { name: "Remove class Poetry" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add class" }));

    // Both remaining classes list; the search input narrows.
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    expect(within(dialog).getByText("Fiction")).not.toBeNull();
    expect(within(dialog).queryByText("Poetry")).toBeNull(); // already assigned
    fireEvent.change(within(dialog).getByLabelText("Search classes"), { target: { value: "fic" } });
    expect(within(dialog).getByText("Fiction")).not.toBeNull();
    expect(within(dialog).queryByText("No matches found")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Search classes"), { target: { value: "zz" } });
    // No class matches: the create row is the no-match affordance (legacy
    // ResultsList behavior — the create option replaces the empty state).
    expect(within(dialog).getByText('Create "zz"')).not.toBeNull();

    // Pick Fiction → assigned; the pill renders and the picker closes.
    fireEvent.change(within(dialog).getByLabelText("Search classes"), { target: { value: "fic" } });
    fireEvent.click(within(dialog).getByText("Fiction"));
    await flushWrites();
    const classIds = client.getNode(pageId)?.classIds ?? [];
    expect(classIds).toHaveLength(2);
    expect(classIds).toEqual(expect.arrayContaining([poetryId, fictionId]));
    expect(screen.getByRole("button", { name: "Remove class Fiction" })).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();
    expect(container.querySelectorAll(".nt-classes-row .pill:not(.pill--add)").length).toBe(2);

    // The "Create" row creates a class and assigns it.
    fireEvent.click(screen.getByRole("button", { name: "Add class" }));
    fireEvent.change(screen.getByLabelText("Search classes"), { target: { value: "Essays" } });
    fireEvent.click(screen.getByText('Create "Essays"'));
    await flushWrites();
    const essays = client.listClasses().find((c) => deriveDisplayName(c) === "Essays");
    expect(essays).not.toBeUndefined();
    expect(client.getNode(pageId)?.classIds).toContain(essays!.id);
  });

  it("right-clicking a class pill opens the node menu; Change color leads to the swatches", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Genre");
    const pageId = await client.createObject({ presentAsMain: true, name: "Book" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);

    const pill = screen.getByRole("button", { name: "Remove class Genre" }).closest(".pill")!;
    fireEvent.contextMenu(pill);
    fireEvent.click(screen.getByRole("menuitem", { name: /change color/i }));

    const swatchGroup = screen.getByRole("group", { name: "Color options" });
    const swatches = swatchGroup.querySelectorAll(".context-menu-color-swatch");
    expect(swatches.length).toBe(11); // no-color + 10 preset colors
    fireEvent.click(swatches[1]!); // red
    await flushWrites();
    expect(client.getNode(classId)?.color).toBe("red");
  });

  it("select schemas with options render the options control writing option ids", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "status",
      type: "select",
      options: [
        { id: "opt-1", label: "Backlog" },
        { id: "opt-2", label: "Doing" },
      ],
    });
    const classId = await client.createClass("Task");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // Unvalued: the Empty cell opens the options picker.
    const row = screen.getByText("status").closest(".nt-property-select") as HTMLElement;
    fireEvent.click(within(row).getByText("Empty"));
    fireEvent.click(within(row).getByText("Doing"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "opt-2", source: "authored" }),
    ]);

    // The pill renders with the option label; its remove affordance unsets.
    // (The row re-mounts when the value lands, so re-query the live row.)
    const rowAfter = screen.getByText("status").closest(".nt-property-select") as HTMLElement;
    expect(within(rowAfter).getByText("Doing")).not.toBeNull();
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Remove Doing" }));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([]);
  });

  it("boolean schemas render the checkbox toggle writing true/false", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "archived", type: "boolean" });
    const classId = await client.createClass("Record");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "File" });
    await client.assignClass(pageId, classId);

    // Unvalued: the unchecked toggle writes true. (Each assertion renders
    // fresh — jsdom's synthetic checkbox click only registers the first
    // toggle on a mounted controlled input.)
    const first = render(<PageView client={client} pageId={pageId} />);
    expandProperties();
    const firstRow = screen.getByText("archived").closest(".nt-property-boolean") as HTMLElement;
    fireEvent.click(within(firstRow).getByLabelText("Property archived"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: true, source: "authored" }),
    ]);
    first.unmount();

    // Seeded true: the checked toggle writes false.
    await client.setProperty(pageId, schemaId, true, 0);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();
    const row = screen.getByText("archived").closest(".nt-property-boolean") as HTMLElement;
    const toggle = within(row).getByLabelText("Property archived") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: false, source: "authored" }),
    ]);
  });

  it("the object picker offers a create row; the created page carries the target class", async () => {
    const client = await seedClient();
    const personClass = await client.createClass("person");
    const mentorSchema = await client.createPropertySchema({
      name: "mentor",
      type: "object",
      targetClassFilter: [personClass],
    });
    const teamClass = await client.createClass("Team");
    await client.setClassProperty(teamClass, mentorSchema, { sequence: 0 });
    const teamId = await client.createObject({ presentAsMain: true, name: "Crew" });
    await client.assignClass(teamId, teamClass);
    render(<PageView client={client} pageId={teamId} />);
    expandProperties();

    const row = screen.getByText("mentor").closest(".nt-property-object") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Search mentor"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByText('Create "Ada"'));
    await flushWrites();

    // The created page is person-classed and linked at the property slot.
    const ada = client.listPages().find((n) => deriveDisplayName(n) === "Ada");
    expect(ada).not.toBeUndefined();
    expect(ada!.classIds).toContain(personClass);
    expect(client.getEffectiveProperties(teamId)).toEqual([
      expect.objectContaining({
        propertySchemaId: mentorSchema,
        value: { nodeId: ada!.id },
        source: "authored",
      }),
    ]);
  });
});
