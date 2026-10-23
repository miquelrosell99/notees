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

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { ClientNode } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { IconPickerPopup } from "../src/features/icon-picker/IconPickerPopup.js";
import { NodeResultItem } from "../src/features/pickers/NodeResultItem.js";
import { NodeSelector } from "../src/features/pickers/NodeSelector.js";
import { createNodesWithClasses } from "../src/features/templates/createNodesWithClasses.js";

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

/** Expand the page's "Properties" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties/ });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Book" });
    await client.assignClass(pageId, poetryId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The assigned class renders as a pill; the "Add class" pill opens the picker.
    expect(screen.getByRole("button", { name: "Remove class Poetry" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add class" }));

    // Both remaining classes list; the compact search input narrows.
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    const search = within(dialog).getByLabelText("Search classes");
    expect(search.closest(".search-field")).toHaveClass("search-field--sm");
    expect(within(dialog).getByText("Fiction")).not.toBeNull();
    expect(within(dialog).queryByText("Poetry")).toBeNull(); // already assigned
    fireEvent.change(search, { target: { value: "fic" } });
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

  it("an already-assigned class resurfaces on an exact query; Ctrl+Enter closes idempotently (no create-class modal)", async () => {
    const client = await seedClient();
    const poetryId = await createTitledClass(client, "Poetry");
    const pageId = await client.createObject({ isEmbedded: false, name: "Book" });
    await client.assignClass(pageId, poetryId);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    fireEvent.click(screen.getByRole("button", { name: "Add class" }));
    const dialog = screen.getByRole("dialog", { name: "Select node" });

    // Browsing keeps the assigned class hidden (the candidate set is the
    // UNASSIGNED pool)…
    expect(within(dialog).queryByText("Poetry")).toBeNull();

    // …but an exact search for it resurfaces the row, checkmark-marked —
    // picking it acknowledges the already-set state instead of dead-ending
    // into the create row (which routes to the create-class modal).
    fireEvent.change(within(dialog).getByLabelText("Search classes"), { target: { value: "Poetry" } });
    const row = within(dialog).getByText("Poetry").closest(".node-result-item")!;
    expect(row.querySelector(".node-result-item__check")).not.toBeNull();

    fireEvent.keyDown(within(dialog).getByLabelText("Search classes"), { key: "Enter", ctrlKey: true });
    await flushWrites();

    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New class" })).toBeNull();
    expect(client.getNode(pageId)?.classIds).toEqual([poetryId]); // no duplicate write
    expect(container.querySelectorAll(".nt-classes-row .pill:not(.pill--add)").length).toBe(1);
  });

  it("right-clicking a class pill opens the node menu; Change color leads to the swatches", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Genre");
    const pageId = await client.createObject({ isEmbedded: false, name: "Book" });
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
    await client.setClassProperty(classId, schemaId, {});
    const pageId = await client.createObject({ isEmbedded: false, name: "Ship it" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // Unvalued: the Empty cell opens the options picker.
    const row = screen.getByText("status").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    fireEvent.click(within(row).getByText("Empty"));
    // The picker rides in a body portal — query the screen.
    fireEvent.click(screen.getByText("Doing"));
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
    await client.setClassProperty(classId, schemaId, {});
    const pageId = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(pageId, classId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // Unvalued: the Empty cell opens the options picker; each pick appends
    // to the array value (the multi_select control, previously undispatched).
    const row = screen.getByText("genres").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    fireEvent.click(within(row).getByText("Empty"));
    fireEvent.click(screen.getByText("Fiction"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: ["g1"], source: "authored" }),
    ]);

    // The pill shows the label; the multi "+" affordance picks a second option.
    const rowAfter = screen.getByText("genres").closest(".nt-props-sidebar__prop, .nt-property-select") as HTMLElement;
    expect(within(rowAfter).getByText("Fiction")).not.toBeNull();
    fireEvent.click(within(rowAfter).getByRole("button", { name: "Add option" }));
    fireEvent.click(screen.getByText("Mystery"));
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Linked" });
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
    await client.setClassProperty(classId, schemaId, {});
    const pageId = await client.createObject({ isEmbedded: false, name: "File" });
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
    const toggle = within(row).getByRole("checkbox", { name: "Property archived" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
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
    await client.setClassProperty(teamClass, mentorSchema, {});
    const teamId = await client.createObject({ isEmbedded: false, name: "Crew" });
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
    // 2026-10-09; the value is PLAIN TEXT since 2026-10-20 — like a select
    // option or a date value, never a pill chip): the selected node's name
    // rides the content area directly — never the node's subtree — and the
    // clear affordance unsets the slot.
    const rowAfter = screen.getByText("mentor").closest(".nt-props-sidebar__prop, .nt-property-object") as HTMLElement;
    const content = rowAfter.querySelector(".nt-property-select__content");
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain("Ada");
    expect(rowAfter.querySelector(".nt-property-select .pill")).toBeNull();
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
    await client.setClassProperty(filmClass, castSchema, {});
    const filmId = await client.createObject({ isEmbedded: false, name: "Arrival" });
    await client.assignClass(filmId, filmClass);
    // Amy carries her OWN color; Bob is person-classed (the write-time filter)
    // but uncolored — the neutral pill.
    const amyId = await client.createObject({ isEmbedded: false, name: "Amy", classIds: [personClass] });
    await client.updateObject(amyId, { color: "red" });
    const bobId = await client.createObject({ isEmbedded: false, name: "Bob", classIds: [personClass] });
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

describe("NodeSelector empty-query recents (owner 2026-10-19)", () => {
  it("opens to the recently used nodes (MRU order + caption); typing replaces them with search hits", async () => {
    const client = await seedClient();
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
    const gamma = await client.createObject({ isEmbedded: false, name: "Gamma" });
    // MRU order: Gamma most recent, then Beta (Alpha never opened).
    localStorage.setItem("notees.recents", JSON.stringify([gamma, beta]));
    render(
      <NodeSelector client={client} trigger="inline" searchPlaceholder="Search pages" onAdd={() => {}} />,
    );

    expect(screen.getByText("Recently used")).not.toBeNull();
    const dialogRows = document.querySelector(".node-selector__options")!;
    const names = [...dialogRows.querySelectorAll(".node-result-item")].map((el) => el.textContent);
    expect(names[0]).toContain("Gamma");
    expect(names[1]).toContain("Beta");
    expect(names.join(" ")).not.toContain("Alpha");

    // The first keystroke replaces the recents with search hits.
    fireEvent.change(screen.getByLabelText("Search pages"), { target: { value: "alp" } });
    expect(screen.queryByText("Recently used")).toBeNull();
    expect(screen.getByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Gamma")).toBeNull();
  });

  it("no recents keeps the honest empty state; class-scoped pickers keep their member listing", async () => {
    const client = await seedClient();
    const cls = await createTitledClass(client, "Fiction");
    const member = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(member, cls);
    render(
      <NodeSelector client={client} trigger="inline" searchPlaceholder="Search pages" onAdd={() => {}} />,
    );
    expect(screen.getByText("Start typing to search")).not.toBeNull();
    expect(screen.queryByText("Recently used")).toBeNull();

    // A class-scoped picker lists members on the empty query (unchanged).
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="pages"
        classFilters={[cls]}
        searchPlaceholder="Search members"
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText("Novel")).not.toBeNull();
    expect(screen.queryByText("Recently used")).toBeNull();
  });

  it("blocks-mode recents only list inline blocks, never pages", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Host page" });
    const block = await client.createObject({ isEmbedded: true, name: "Inline bit", parentId: page });
    localStorage.setItem("notees.recents", JSON.stringify([page, block]));
    render(
      <NodeSelector client={client} trigger="inline" searchMode="blocks" searchPlaceholder="Search blocks" onAdd={() => {}} />,
    );
    // The embedded block qualifies (its containing page rides as the row
    // crumb); the page recent itself is filtered out — one row only.
    expect(screen.getByText("Recently used")).not.toBeNull();
    const rows = document.querySelectorAll(".node-result-item");
    expect(rows.length).toBe(1);
    expect(within(rows[0] as HTMLElement).getByText("Inline bit")).not.toBeNull();
  });

  it("the classes picker is unaffected (lists classes, no recents caption)", async () => {
    const client = await seedClient();
    await createTitledClass(client, "Fiction");
    const page = await client.createObject({ isEmbedded: false, name: "Alpha" });
    localStorage.setItem("notees.recents", JSON.stringify([page]));
    render(
      <NodeSelector client={client} trigger="inline" searchMode="classes" searchPlaceholder="Search classes" onAdd={() => {}} />,
    );
    expect(screen.getByText("Fiction")).not.toBeNull();
    expect(screen.queryByText("Recently used")).toBeNull();
  });
});

describe("New-node class picker", () => {
  it("an empty class list creates one standalone class-less page", async () => {
    const client = await seedClient();
    const opened: string[] = [];
    createNodesWithClasses(client, [], (id) => {
      opened.push(id);
    });
    await flushWrites();

    expect(opened).toHaveLength(1);
    const page = client.getNode(opened[0]!);
    expect(page).not.toBeUndefined();
    expect(page!.isEmbedded).toBe(false);
    expect(page!.classIds).toEqual([]);
  });

  it("the empty-query option renders before the classes and picks No class", async () => {
    const client = await seedClient();
    await createTitledClass(client, "Fiction");
    const onPick = vi.fn();
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="classes"
        searchPlaceholder="Search classes"
        emptyQueryOption={{ label: "No class", onPick }}
        onAdd={() => {}}
      />,
    );

    const rows = document.querySelectorAll(".node-result-item");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("No class")).not.toBeNull();
    expect(within(rows[1] as HTMLElement).getByText("Fiction")).not.toBeNull();
    fireEvent.click(rows[0]!);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("typing hides No class so Enter keeps answering the class query", async () => {
    const client = await seedClient();
    await createTitledClass(client, "Fiction");
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="classes"
        searchPlaceholder="Search classes"
        emptyQueryOption={{ label: "No class", onPick: vi.fn() }}
        onAdd={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search classes"), { target: { value: "Fic" } });
    expect(screen.queryByText("No class")).toBeNull();
    expect(screen.getByText("Fiction")).not.toBeNull();
  });

  it("Enter on the empty picker picks No class", async () => {
    const client = await seedClient();
    await createTitledClass(client, "Fiction");
    const onPick = vi.fn();
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="classes"
        searchPlaceholder="Search classes"
        emptyQueryOption={{ label: "No class", onPick }}
        onAdd={() => {}}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText("Search classes"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown from No class reaches the first class", async () => {
    const client = await seedClient();
    const fictionId = await createTitledClass(client, "Fiction");
    const onAdd = vi.fn();
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="classes"
        searchPlaceholder="Search classes"
        emptyQueryOption={{ label: "No class", onPick: vi.fn() }}
        onAdd={onAdd}
      />,
    );
    const search = screen.getByLabelText("Search classes");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ id: fictionId });
  });
});

describe("NodeSelector noCreate", () => {
  it("search-without-match shows the honest empty state instead of a create row", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Existing" });
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
    await client.createObject({ isEmbedded: false, name: "Existing" });
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

describe("NodeSelector year create row", () => {
  it('a bare year outside the date window labels the create row \'Create year "…"\'; in-window years and non-years stay generic', async () => {
    const client = await seedClient();
    render(<NodeSelector client={client} trigger="inline" searchMode="all" onAdd={() => {}} />);
    const search = screen.getByLabelText("Search...");

    // 1711 is not a date-node year (the window is 1900..2200), but it is a
    // year: the create row reads as a year page, not a numbered page.
    fireEvent.change(search, { target: { value: "1711" } });
    expect(await screen.findByText('Create year "1711"')).not.toBeNull();

    // Inside the window the date suggestion row owns the year affordance —
    // the plain create row stays generic.
    fireEvent.change(search, { target: { value: "2026" } });
    expect(screen.queryByText('Create year "2026"')).toBeNull();
    expect(screen.getByText('Create "2026"')).not.toBeNull();

    // Not a bare year: the generic label.
    fireEvent.change(search, { target: { value: "17117" } });
    expect(screen.queryByText(/^Create year/)).toBeNull();
    expect(screen.getByText('Create "17117"')).not.toBeNull();
  });
});

describe("date-chain class lock (SCHEMA.md 'Datetime')", () => {
  it("a date page renders the Classes row read-only — no Add-class pill (the system-class pill is non-removable already)", async () => {
    const client = await seedClient();
    const chain = await client.ensureDateChain("2026-09-27");
    const { container, unmount } = render(<PageView client={client} pageId={chain.day} />);

    // The day class pill renders; the Add-class affordance does not.
    expect(container.querySelectorAll(".nt-classes-row .pill:not(.pill--add)").length).toBe(1);
    expect(screen.queryByRole("button", { name: "Add class" })).toBeNull();
    unmount();

    // An ordinary page still offers Add class (the lock keys on the date id).
    const pageId = await client.createObject({ isEmbedded: false, name: "Ordinary" });
    render(<PageView client={client} pageId={pageId} />);
    expect(screen.getByRole("button", { name: "Add class" })).not.toBeNull();
  });
});

describe("NodeResultItem fresh-title reads", () => {
  /** A pooled row as the structure-classed listings hand it over (only the
   *  fields the row render touches are populated). */
  function pooledNode(id: string, title: string): ClientNode {
    return {
      id,
      isClass: false,
      isEmbedded: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      contentAst: [{ type: "text", text: title }],
      icon: null,
    } as unknown as ClientNode;
  }

  it("derives the row label and tooltip from the fresh per-node read, not the pooled row", () => {
    const pooled = pooledNode("node-1", "Stale title");
    const fresh = pooledNode("node-1", "Fresh title");
    render(<NodeResultItem node={pooled} client={{ getNode: () => fresh }} onClick={() => {}} />);

    expect(screen.getByText("Fresh title")).not.toBeNull();
    expect(screen.queryByText("Stale title")).toBeNull();
    // The hover tooltip rides the SAME fresh title.
    expect(screen.getByTitle("Fresh title")).not.toBeNull();
  });

  it("falls back to the pooled row when the fresh read misses (an archived node)", () => {
    const pooled = pooledNode("node-1", "Pooled title");
    render(
      <NodeResultItem node={pooled} client={{ getNode: () => undefined }} onClick={() => {}} />,
    );
    expect(screen.getByText("Pooled title")).not.toBeNull();
  });

  it("pseudo-rows ({ name }) render unchanged, no client read", () => {
    render(<NodeResultItem node={{ name: "Create row" }} onClick={() => {}} />);
    expect(screen.getByText("Create row")).not.toBeNull();
  });
});
