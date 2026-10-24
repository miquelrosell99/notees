/**
 * Class View tests: a class page IS a page — render-cascade view
 * resolution (class → the page view
 * with the class variant data, the main-content restructure), the
 * page chrome (title; the shared header icon button is the single
 * icon+color entry — no curated class icon button, no color dot), the
 * extends corner pills (class.setExtends m2m, class-only picker), the
 * classed-nodes instances section (expanded by default), the property-
 * definitions section, and the child-blocks body + child-pages system
 * section. jsdom environment over the in-process WorkspaceClient +
 * MemoryRelay.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_DISPLAY_NAMES, SYSTEM_PROPERTY_SPECS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/App.js";
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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 * class node's content — upsertClassNode's INSERT writes the row with the
 * envelope's own HLC and the following LWW UPDATE requires a strictly greater
 * HLC, so the title write always loses. object.update takes the later-HLC
 * path and does persist. Seed the title through it; remove once fixed. */
async function createTitledClass(client: WorkspaceClient, title: string, id?: string): Promise<string> {
  const classId =
    id !== undefined ? await client.createClass(title, { id }) : await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

describe("Class View", () => {
  it("resolves views by node type: class → Class View, page → Page View", async () => {
    const client = await seedClient();
    const classId = await client.createClass("source");
    const pageId = await client.createObject({ isEmbedded: false, name: "A Page" });

    const classRender = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    // Class chrome: the extends corner's class-only add affordance and the
    // Class properties section — and the page body tree is present (a
    // class page is a page).
    expect(screen.getByRole("button", { name: "Add class extension" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /class properties/i })).not.toBeNull();
    expect(classRender.container.querySelector(".nt-class")).not.toBeNull();
    // The page body chrome: an empty class offers the first-block affordance
    // (the ghost row, aria-label "Add block").
    expect(screen.getByRole("button", { name: /add block/i })).not.toBeNull();
    classRender.unmount();

    render(<NodeView client={client} nodeId={pageId} onOpenNode={() => {}} />);
    expect(screen.getByRole("heading", { name: "A Page" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /class properties/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add class extension" })).toBeNull();
  });

  it("commits the edited class name through the header title row", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "agent");
    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    const content = container.querySelector<HTMLElement>(".nt-title-content");
    if (content === null) throw new Error("title content missing");
    expect(content.textContent).toBe("agent");

    fireEvent.click(content);
    const editor = content.querySelector<HTMLElement>(".nt-block-text")!;
    editor.textContent = "Contributor";
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: "Enter" });
    await flushWrites();
    // Title-is-content: the rename committed as the class's text content.
    expect(deriveDisplayName(client.getNode(classId)!)).toBe("Contributor");
  });

  it("adds an extends parent via the class-only picker: store update + pill", async () => {
    const client = await seedClient();
    const childId = await createTitledClass(client, "person");
    const parentId = await createTitledClass(client, "agent");
    render(<NodeView client={client} nodeId={childId} onOpenNode={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Add class extension" }));
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.click(within(dialog).getByText("agent"));
    await flushWrites();

    expect(client.getClassParents(childId)).toEqual([parentId]);
    // The parent renders as a corner pill linking to its Class View.
    expect(screen.getByRole("button", { name: "agent" })).not.toBeNull();
  });

  it("removes an extends parent via the pill's remove button", async () => {
    const client = await seedClient();
    const childId = await createTitledClass(client, "person");
    const parentId = await createTitledClass(client, "agent");
    await client.setClassExtends(childId, [parentId]);
    render(<NodeView client={client} nodeId={childId} onOpenNode={() => {}} />);

    expect(screen.getByRole("button", { name: "agent" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove extension agent" }));
    await flushWrites();

    expect(client.getClassParents(childId)).toEqual([]);
    expect(screen.queryByRole("button", { name: "agent" })).toBeNull();
  });

  it("refuses a cycle-creating extends write loud in the store (render assumes a DAG — no cycle banner)", async () => {
    const client = await seedClient();
    const aId = await createTitledClass(client, "alpha");
    const bId = await createTitledClass(client, "beta");
    await client.setClassExtends(aId, [bId]);
    render(<NodeView client={client} nodeId={bId} onOpenNode={() => {}} />);

    // Picking alpha as beta's parent would close the cycle b → a → b. The
    // store's operation-level DAG check (the applier's CycleError) refuses
    // the write; the view renders NO cycle banner (that chrome was deleted —
    // the rejection lands in the console).
    fireEvent.click(screen.getByRole("button", { name: "Add class extension" }));
    const dialog = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.click(within(dialog).getByText("alpha"));
    await flushWrites();

    expect(client.getClassParents(bId)).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the extends corner read-only for a system class (the system-extends lock)", async () => {
    const client = await seedClient();
    // A class AT the fixed system seed UUID — its extends mapping is frozen
    // seeded platform structure (SCHEMA.md "Class properties"), so the corner
    // advertises no edits the applier would reject (SystemExtendsLockError).
    const meetingId = await createTitledClass(client, "meeting", SYSTEM_CLASS_UUIDS.meeting);
    render(<NodeView client={client} nodeId={meetingId} onOpenNode={() => {}} />);

    expect(screen.queryByRole("button", { name: "Add class extension" })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove extension/i })).toBeNull();
  });

  it("lists classed nodes without expansion (the section defaults to expanded)", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const pageId = await client.createObject({ isEmbedded: false, name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    const membersSpy = vi.spyOn(client, "getClassMembers");
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The member set resolves for the header's section chrome (no header
    // count anywhere, owner ruling 2026-10-21 — the count rides the hosted
    // tab bar's active-tab badge).
    expect(screen.getByRole("button", { name: /classed nodes/i })).not.toBeNull();
    expect(membersSpy).toHaveBeenCalledWith(classId);
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
  });

  it("lists a classed node and navigates to its page", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const pageId = await client.createObject({ isEmbedded: false, name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    const onOpenNode = vi.fn();
    render(<NodeView client={client} nodeId={classId} onOpenNode={onOpenNode} />);

    // Owner refinement: the name cell click EDITS (inline); the open-arrow
    // navigates.
    const openArrow = screen.getByRole("button", { name: "Open Ada Lovelace" });
    fireEvent.click(openArrow);
    expect(onOpenNode).toHaveBeenCalledWith(pageId);
  });

  it("removes a member via the row's × (class.unassign) in outline mode", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "agent");
    const pageId = await client.createObject({ isEmbedded: false, name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Table is the section default (owner rule): the member renders as a
    // table row, and the unassign action lives in the outline mode. Two
    // view toolbars render on a class page (body + classed nodes) — scope
    // the mode switch to the classed-nodes section.
    expect(screen.getByRole("table")).not.toBeNull();
    // The name cell is the node's title block row (owner 2026-10-21) — a
    // div, not a button; the row's text is the anchor.
    expect(within(screen.getByRole("table")).getByText("Ada Lovelace")).not.toBeNull();

    const classedNodesSection = screen
      .getByRole("button", { name: /classed nodes/i })
      .closest("section")!;
    fireEvent.click(within(classedNodesSection).getByRole("radio", { name: "Outline" }));
    await flushWrites();

    // The × is labeled "Remove <member> from <class>"; match the stable prefix.
    fireEvent.click(screen.getByRole("button", { name: /^Remove Ada Lovelace from / }));
    await flushWrites();

    // class.unassign: the membership pair is tombstoned, class_ids recomputed.
    expect(client.getNode(pageId)?.classIds).toEqual([]);
    // The expanded section re-ran its query on the notification.
    expect(screen.getByText("No classed nodes.")).not.toBeNull();
  });

  it("the section header carries the create affordance: a node classed with this class", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "agent");
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // An empty database still renders the section chrome: the ONE "Add
    // member" button rides the section header's trailing action (owner
    // 2026-10-09 — it replaced the toolbar button and the collection's add
    // row).
    const classedNodesSection = screen
      .getByRole("button", { name: /classed nodes/i })
      .closest("section")!;
    const addButtons = within(classedNodesSection).getAllByRole("button", { name: "Add member" });
    expect(addButtons).toHaveLength(1);

    fireEvent.click(addButtons[0]!);
    await flushWrites();

    // The create composed the class assignment: the new node is a member
    // (object.create carried classIds — the section's member route), and
    // the expanded section's re-query renders it as a row.
    const members = client.getClassMembers(classId);
    expect(members).toHaveLength(1);
    expect(members[0]!.classIds).toContain(classId);
    expect(within(classedNodesSection).queryByText("No classed nodes.")).toBeNull();
  });

  it("renders the seeded property definitions in alphabetical order", async () => {
    const client = await seedClient();
    // The reserved system id makes the class a SYSTEM class: the seed-spec
    // fallback synthesizes the source family (read-side, id-keyed) with the
    // manifest's normal-wording names.
    const classId = await createTitledClass(client, "Source", SYSTEM_CLASS_UUIDS.source);
    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Non-empty schema collapses the section (invites setup, then stays out
    // of the way — parity with the page's "Metadata N").
    fireEvent.click(screen.getByRole("button", { name: /class properties/i }));
    await flushWrites();

    const names = [...container.querySelectorAll(".nt-propdef-name")].map(
      (el) => el.textContent,
    );
    // PURE ALPHABETICAL by property name (owner ruling 2026-10-21 — binding
    // sequence retired; the seeded class panel has no configurable order).
    // The source family panel shows ONLY the shared base (owner ruling
    // 2026-10-24): the bibliographic pool's type-specific fields are
    // `bind: false` — scoped to source but no binding row on the base — so
    // derive the expectation from the seed manifest filtering them out; the
    // test pins ORDER, not the family set.
    const expectedNames = (
      Object.entries(SYSTEM_PROPERTY_SPECS) as Array<
        [keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES, (typeof SYSTEM_PROPERTY_SPECS)[keyof typeof SYSTEM_PROPERTY_SPECS]]
      >
    )
      .filter(([, spec]) => spec?.bindTo === "source" && spec.bind !== false)
      .map(([name]) => SYSTEM_PROPERTY_DISPLAY_NAMES[name])
      .sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(expectedNames);

    const rows = [...container.querySelectorAll(".nt-propdef")];
    // RETYPED 2026-10-23 (owner ruling, source-library slice 1 task 4):
    // authors is free TEXT, multi — the 2026-09-27 node-typed commitment is
    // superseded; node-typed authorship survives as `linkedAuthors`.
    const authorsRow = rows.find((row) =>
      row.querySelector(".nt-propdef-name")?.textContent === "Authors",
    )!;
    // The row is identity-only (S6): no chevron, no inline fields — the
    // hover-revealed COG opens the S2 definition modal (the
    // unresolved-targets hint for the undeployed "agent" class lives there;
    // the name itself is display only — owner ruling 2026-10-21).
    expect(within(authorsRow as HTMLElement).queryByLabelText("Default for Authors")).toBeNull();
    expect(within(authorsRow as HTMLElement).queryByRole("checkbox", { name: "Required" })).toBeNull();
    expect(within(authorsRow as HTMLElement).queryByText("For this class")).toBeNull();
    expect(within(authorsRow as HTMLElement).queryByText("Definition")).toBeNull();
    expect(within(authorsRow as HTMLElement).queryByText("Target classes")).toBeNull();
    fireEvent.click(within(authorsRow as HTMLElement).getByRole("button", { name: "Definition settings for Authors" }));
    await flushWrites();
    // Authors is TEXT-typed since the 2026-10-23 retype: the definition
    // modal carries the ordinary default editor (the 2026-10-20 ruling
    // withholds it only from object/asset/image/datetime schemas).
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Property settings" })).not.toBeNull();
    expect(within(dialog).getByLabelText("Default value")).not.toBeNull();
  });

  it("renders the class's children as the editable body — a class has no child pages", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Container Class");
    // Classes are containers (spec I4) — and under the parent-page condition
    // (owner ruling 2026-10-15) a class is not a page, so a present-as-main
    // child of a class is unrepresentable: every non-class child renders
    // inline in the class body.
    await client.createObject({
      parentId: classId,
      contentAst: [{ type: "text", text: "class body block" }],
    });
    await client.createObject({ parentId: classId, name: "Second class child" });

    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The body is the page tree: both children render directly in the body
    // (the block tree IS the class body), with no Child-pages section
    // content — a class has no child pages under the parent-page condition.
    expect(screen.getByText("class body block")).not.toBeNull();
    expect(screen.getByText("Second class child")).not.toBeNull();
    expect(container.querySelectorAll(".nt-block-tree").length).toBeGreaterThan(0);
  });
});

describe("the class icon picker (the shared header icon button is the single entry)", () => {
  it("the page icon button opens the full emoji/icon picker — tabs, the entire sets, recents", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "pokemon");
    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // No curated class icon button — the shared icon entry for class pages
    // too: with no icon defined the header element hides (the Capacities
    // precedent) and the action row's "Add icon" opens the picker.
    fireEvent.click(screen.getByRole("button", { name: /Add icon/ }));

    // The full picker: the dialog with its three tabs…
    const dialog = screen.getByRole("dialog", { name: "Icon picker" });
    expect(within(dialog).getByRole("tab", { name: "All" })).not.toBeNull();
    expect(within(dialog).getByRole("tab", { name: "Emojis" })).not.toBeNull();
    expect(within(dialog).getByRole("tab", { name: "Icons" })).not.toBeNull();
    // …the search spanning both vocabularies and the typical emojis on All.
    expect(within(dialog).getByLabelText(/Search icons and emojis/)).not.toBeNull();
    expect(within(dialog).getByText("😀")).not.toBeNull();

    // The Emojis tab lists the full categorized set.
    fireEvent.click(within(dialog).getByRole("tab", { name: "Emojis" }));
    expect(within(dialog).getByText("Smileys")).not.toBeNull();
    expect(within(dialog).getByText("Animals")).not.toBeNull();
    expect(within(dialog).getByText("Flags")).not.toBeNull();

    // Selecting an emoji writes it as the class icon (the original contract)…
    fireEvent.click(within(dialog).getByRole("button", { name: "😀" }));
    await flushWrites();
    expect(client.getNode(classId)?.icon).toBe("😀");

    // …and lands in Recents — the section appears on reopen with the pick.
    fireEvent.click(container.querySelector<HTMLElement>(".page-icon-btn")!);
    const again = screen.getByRole("dialog", { name: "Icon picker" });
    expect(within(again).getByText("Recents")).not.toBeNull();
    // The pick appears twice — once in Recents, once in the typical set
    // (now marked active).
    expect(within(again).getAllByRole("button", { name: "😀" }).length).toBeGreaterThanOrEqual(2);
  });
});

describe("the class page's panelled layout (owner 2026-10-12)", () => {
  it("Properties + Class properties + Templates ride the first column; Classed nodes rides the content column; context column included", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "project");
    await client.createObject({ isEmbedded: false, name: "Alpha", classIds: [classId] });

    render(<PageView client={client} pageId={classId} onOpenPage={() => {}} />);
    expect(document.querySelector(".nt-page--panelled")).not.toBeNull();
    const side = document.querySelector(".nt-page-side-panel") as HTMLElement;
    expect(side).not.toBeNull();
    // The Properties panel + the two moved class sections live in the side panel.
    expect(within(side).getByRole("button", { name: /^Properties/ })).not.toBeNull();
    expect(within(side).getByRole("button", { name: /class properties/i })).not.toBeNull();
    expect(within(side).getByRole("button", { name: /templates/i })).not.toBeNull();
    // Classed nodes stays the content column's centerpiece — not in the panel.
    const content = document.querySelector(".nt-page-content") as HTMLElement;
    expect(within(content).getByRole("button", { name: /classed nodes/i })).not.toBeNull();
    expect(within(side).queryByRole("button", { name: /classed nodes/i })).toBeNull();
    // The context column rides the class page too (owner 2026-10-12, every
    // nodeview): the column renders and the top bar carries its toggle.
    expect(document.querySelector(".nt-page-context")).not.toBeNull();
    expect(screen.getByRole("button", { name: /hide context panel/i })).not.toBeNull();
    // The extends pills re-anchored to the nodeview top bar (the panelled corner).
    expect(screen.getByRole("button", { name: "Add class extension" })).not.toBeNull();
  });

  it("the compact layout keeps every class section in the content flow (the toggle's sections mode)", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "project");
    render(<PageView client={client} pageId={classId} layout="compact" onOpenPage={() => {}} />);

    expect(document.querySelector(".nt-page--panelled")).toBeNull();
    expect(document.querySelector(".nt-page-side-panel")).toBeNull();
    // In-flow Properties + the class sections in their original order.
    const flow = document.querySelector(".nt-page") as HTMLElement;
    const headerOf = (name: RegExp): HTMLElement =>
      within(flow).getByRole("button", { name }) as HTMLElement;
    const metadata = headerOf(/^Properties/i);
    const properties = headerOf(/class properties/i);
    const templates = headerOf(/templates/i);
    const classed = headerOf(/classed nodes/i);
    const precedes = (a: HTMLElement, b: HTMLElement): boolean =>
      (b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    expect(precedes(metadata, properties)).toBe(true);
    expect(precedes(properties, templates)).toBe(true);
    expect(precedes(templates, classed)).toBe(true);
  });
});
