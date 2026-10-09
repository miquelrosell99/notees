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
import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";

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
    const pageId = await client.createObject({ presentAsMain: true, name: "A Page" });

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

  it("lists classed nodes without expansion (the section defaults to expanded) and shows the count badge", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const pageId = await client.createObject({ presentAsMain: true, name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    const membersSpy = vi.spyOn(client, "getClassMembers");
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Badge from the COUNT projection (eager, like the child-pages count) —
    // rendered in the header without expanding anything.
    expect(screen.getByRole("button", { name: /classed nodes 1/i })).not.toBeNull();
    expect(membersSpy).toHaveBeenCalledWith(classId);
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
  });

  it("lists a classed node and navigates to its page", async () => {
    const client = await seedClient();
    const classId = await client.createClass("agent");
    const pageId = await client.createObject({ presentAsMain: true, name: "Ada Lovelace" });
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
    const pageId = await client.createObject({ presentAsMain: true, name: "Ada Lovelace" });
    await client.assignClass(pageId, classId);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // Table is the section default (owner rule): the member renders as a
    // table row, and the unassign action lives in the outline mode. Two
    // view toolbars render on a class page (body + classed nodes) — scope
    // the mode switch to the classed-nodes section.
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ada Lovelace" })).not.toBeNull();

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

  it("renders the seeded property definitions in sequence order", async () => {
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
    expect(names).toEqual([
      "Attachments",
      "Authors",
      "ISBN",
      "DOI",
      "Publication date",
      "Publisher",
      "Citekey",
    ]);
    // Sequence order is explicit: Authors (seq 2) before ISBN (seq 3).
    expect(names.indexOf("Authors")).toBeLessThan(names.indexOf("ISBN"));

    const rows = [...container.querySelectorAll(".nt-propdef")];
    // FINAL citations authorship (2026-09-27): authors is the node-typed,
    // agent-filtered property (linkedAuthors was withdrawn same day, …0025).
    const authorsRow = rows[1]!;
    expect(authorsRow.querySelector(".nt-propdef-type")?.getAttribute("aria-label")).toBe(
      "Type: object (multi)",
    );
    expect(authorsRow.textContent).toContain("agent");
  });

  it("renders the class's child blocks as the editable body and main children under Child pages", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Container Class");
    // Classes are containers (spec I4): an inline body child and a
    // present-as-main child, both non-class.
    await client.createObject({
      parentId: classId,
      contentAst: [{ type: "text", text: "class body block" }],
    });
    await client.createObject({ presentAsMain: true, parentId: classId, name: "Class Main Child" });

    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The body is the page tree: the inline child renders directly, with no
    // section to expand (the read-only Blocks section left with the redesign).
    expect(screen.getByText("class body block")).not.toBeNull();

    // Child pages moved into the system sections — expanded by default, like
    // the page view: the main child renders there, not in the body.
    expect(screen.getByText("Class Main Child")).not.toBeNull();
    expect(container.querySelector(".nt-block-tree")?.textContent ?? "").not.toContain(
      "Class Main Child",
    );
  });
});

describe("the class icon picker (the shared header icon button is the single entry)", () => {
  it("the page icon button opens the full emoji/icon picker — tabs, the entire sets, recents", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "pokemon");
    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // No curated class icon button — the shared header icon button
    // (left of the title) is the single icon+color edit entry for class
    // pages too.
    const iconButton = container.querySelector<HTMLElement>(".page-icon-btn");
    if (iconButton === null) throw new Error("page icon button missing");
    fireEvent.click(iconButton);

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
