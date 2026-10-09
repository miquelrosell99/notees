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
 *    pages carry the schema's target classes); a single-value node property
 *    renders the selection dropdown — the selected node shows as a read-only
 *    block row with a clear affordance — while multi-value pills ride the
 *    shared NodePill element tinted with the linked node's effective color.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { IconPickerPopup } from "../src/ui/components/IconPickerPopup.js";
import { NodeSelector } from "../src/ui/components/pickers/NodeSelector.js";

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

    // The "Create" row routes through the class-creation modal (#14): the
    // typed query carries in as the blank mode's name, and creating there
    // creates the class and assigns it like any pick.
    fireEvent.click(screen.getByRole("button", { name: "Add class" }));
    fireEvent.change(screen.getByLabelText("Search classes"), { target: { value: "Essays" } });
    fireEvent.click(screen.getByText('Create "Essays"'));
    const createDialog = screen.getByRole("dialog", { name: "New class" });
    expect(within(createDialog).getByLabelText("Name")).toHaveValue("Essays");
    fireEvent.click(within(createDialog).getByRole("button", { name: /create class/i }));
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
    const row = screen.getByText("status").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    fireEvent.click(within(row).getByText("Empty"));
    fireEvent.click(within(row).getByText("Doing"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "opt-2", source: "authored" }),
    ]);

    // The pill renders with the option label; its remove affordance unsets.
    // (The row re-mounts when the value lands, so re-query the live row.)
    const rowAfter = screen.getByText("status").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    expect(within(rowAfter).getByText("Doing")).not.toBeNull();
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Remove Doing" }));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([]);
  });

  it("multi_select schemas route to the selection control and write arrays", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({
      name: "genres",
      type: "multi_select",
      options: [
        { id: "g1", label: "Fiction" },
        { id: "g2", label: "Mystery" },
      ],
    });
    const classId = await createTitledClass(client, "Shelf");
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Novel" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // Unvalued: the Empty cell opens the options picker; each pick appends
    // to the array value (the multi_select control, previously undispatched).
    const row = screen.getByText("genres").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    fireEvent.click(within(row).getByText("Empty"));
    fireEvent.click(within(row).getByText("Fiction"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: ["g1"], source: "authored" }),
    ]);

    // The pill shows the label; the multi "+" affordance picks a second option.
    const rowAfter = screen.getByText("genres").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    expect(within(rowAfter).getByText("Fiction")).not.toBeNull();
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Add option" }));
    fireEvent.click(within(rowAfter).getByText("Mystery"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: ["g1", "g2"], source: "authored" }),
    ]);

    // Removing one option keeps the other (multi semantics).
    const rowFinal = screen.getByText("genres").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    fireEvent.click(within(rowFinal).getByRole("button", { name: "Remove Fiction" }));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: ["g2"], source: "authored" }),
    ]);
  });

  it("url/email scalars keep the text editor and gain a link affordance", async () => {
    const client = await seedClient();
    const urlSchema = await client.createPropertySchema({ name: "homepage", type: "url" });
    const emailSchema = await client.createPropertySchema({ name: "contact", type: "email" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Linked" });
    await client.setProperty(pageId, urlSchema, "https://example.org", 0);
    await client.setProperty(pageId, emailSchema, "hi@example.org", 0);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const link = screen.getByRole("link", { name: "Open homepage" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.org/");
    expect(link.target).toBe("_blank");
    const mail = screen.getByRole("link", { name: "Open contact" }) as HTMLAnchorElement;
    expect(mail.href).toBe("mailto:hi@example.org");
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
    const firstRow = screen.getByText("archived").closest(".nt-props-sidebar__prop, .nt-property-boolean") as HTMLElement;
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
    const row = screen.getByText("archived").closest(".nt-props-sidebar__prop, .nt-property-boolean") as HTMLElement;
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

    // The single-value binding renders the "Select" placeholder trigger;
    // clicking it opens the picker (create row included).
    const row = screen.getByText("mentor").closest(".nt-props-sidebar__prop, .nt-property-object") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Set mentor" }));
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

    // The single-value cell renders the selection dropdown (owner
    // 2026-10-09): the selected node rides the content area as ONE compact
    // pill — never the node's subtree — and the clear affordance unsets the
    // slot.
    const rowAfter = screen.getByText("mentor").closest(".nt-props-sidebar__prop, .nt-property-object") as HTMLElement;
    const pill = rowAfter.querySelector(".nt-property-select .pill");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Ada");
    expect(rowAfter.querySelector(".nt-property-select .nt-refblock-tree")).toBeNull();
    expect(within(rowAfter).getByText("Ada")).not.toBeNull();
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Clear mentor" }));
    await flushWrites();
    expect(client.getEffectiveProperties(teamId)).toEqual([]);
  });

  it("multi-value node property pills ride the shared NodePill element, tinted with the linked node's effective color", async () => {
    const client = await seedClient();
    const personClass = await createTitledClass(client, "person");
    const castSchema = await client.createPropertySchema({
      name: "cast",
      type: "object",
      multi: true,
      targetClassFilter: [personClass],
    });
    const filmClass = await client.createClass("Film");
    await client.setClassProperty(filmClass, castSchema, { sequence: 0 });
    const filmId = await client.createObject({ presentAsMain: true, name: "Arrival" });
    await client.assignClass(filmId, filmClass);
    // Amy carries her OWN color; Bob is person-classed (the write-time filter)
    // but uncolored — the neutral pill.
    const amyId = await client.createObject({ presentAsMain: true, name: "Amy", classIds: [personClass] });
    await client.updateObject(amyId, { color: "red" });
    const bobId = await client.createObject({ presentAsMain: true, name: "Bob", classIds: [personClass] });
    await client.setProperty(filmId, castSchema, { nodeId: amyId }, 0);
    await client.setProperty(filmId, castSchema, { nodeId: bobId }, 1);

    const { container } = render(<PageView client={client} pageId={filmId} />);
    expandProperties();
    const pills = container.querySelectorAll<HTMLElement>(".nt-property-object .pill:not(.pill--add)");
    expect(pills.length).toBe(2);
    const amyPill = [...pills].find((pill) => pill.textContent?.includes("Amy"))!;
    const bobPill = [...pills].find((pill) => pill.textContent?.includes("Bob"))!;
    // The linked node's effective color tints the pill surface (the same
    // NodePill element the classes list renders); the uncolored node keeps
    // the neutral pill.
    expect(amyPill.style.background).not.toBe("");
    expect(bobPill.style.background).toBe("");
  });
});

describe("icon picker color section", () => {
  it("the section stays hidden when no onColorChange is provided", async () => {
    const client = await seedClient();
    render(
      <IconPickerPopup value="" onSelect={() => {}} onClose={() => {}} anchorEl={null} />,
    );
    expect(screen.getByRole("dialog", { name: "Icon picker" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Icon color" })).toBeNull();
  });

  it("with onColorChange the header swatch opens the palette; a swatch emits its token", async () => {
    const client = await seedClient();
    const colors: Array<string | null> = [];
    render(
      <IconPickerPopup
        value=""
        onSelect={() => {}}
        onClose={() => {}}
        anchorEl={null}
        color="red"
        onColorChange={(color) => colors.push(color)}
      />,
    );
    // The icon popup stays open (the picker's presses don't dismiss it)…
    fireEvent.click(screen.getByRole("button", { name: "Icon color" }));
    const picker = screen.getByRole("dialog", { name: "Color picker" });
    fireEvent.click(within(picker).getByRole("button", { name: "Blue" }));
    expect(colors).toEqual(["blue"]);
    expect(screen.getByRole("dialog", { name: "Icon picker" })).not.toBeNull();
  });

  it("the no-color entry emits null", async () => {
    const client = await seedClient();
    const colors: Array<string | null> = [];
    render(
      <IconPickerPopup
        value=""
        onSelect={() => {}}
        onClose={() => {}}
        anchorEl={null}
        color="sky"
        onColorChange={(color) => colors.push(color)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Icon color" }));
    const picker = screen.getByRole("dialog", { name: "Color picker" });
    fireEvent.click(within(picker).getByRole("button", { name: "Remove color" }));
    expect(colors).toEqual([null]);
  });
});

describe("NodeSelector noCreate", () => {
  it("search-without-match shows the honest empty state instead of a create row", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Existing" });
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        noCreate
        searchPlaceholder="Search pages"
        onAdd={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "zz" } });
    expect(screen.getByText("No matches found")).not.toBeNull();
    expect(screen.queryByText('Create "zz"')).toBeNull();
  });

  it("the default keeps the create-from-query affordance", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Existing" });
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchPlaceholder="Search pages"
        onAdd={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "zz" } });
    expect(screen.getByText('Create "zz"')).not.toBeNull();
  });
});
