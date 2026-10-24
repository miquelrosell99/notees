/**
 * View-modes tests: the registry, the child-blocks triad
 * (outline/prose/cards) over PageView, the classed-nodes table default,
 * and the Tasks/Assets hub modes. jsdom over the in-process
 * WorkspaceClient + MemoryRelay; view-mode state persists device-locally
 * under `viewMode.*` keys, and the global afterEach clears
 * localStorage — so a fresh render still lands on the surface default here.
 *
 * The outline/prose/cards switcher moved to the App-level NodeView chrome
 * (card top-right, owner 2026-10-06): a directly rendered PageView hosts
 * no header switcher — the triad specs below drive the mode through the
 * `viewMode.nodeBlocks.<pageId>` device preference (the same seam the
 * NodeView switcher writes).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { unzipSync } from "fflate";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { HubView } from "../src/ui/app/HubView.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeView } from "../src/ui/App.js";
import { CollectionHub } from "../src/features/collection/CollectionHub.js";
import { ReferenceSubtree } from "../src/features/block-editor/ReferenceSubtree.js";
import { childQuery } from "../src/features/collection/childQuery.js";
import { ensureTaskFamily } from "../src/features/classview/taskFamily.js";
import { getViewDefinition, getViewModeOptions, NodeCollection } from "../src/features/collection/index.js";
import { applyCardGroupDrop } from "../src/features/collection/CardsBoard.js";
import { writeViewModePref } from "../src/ui/viewPrefs.js";

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

/** Emulate typing into the contentEditable block editor (the title-editor
 *  suite's helper): mutate the DOM + a collapsed end caret + an input event. */
function typeInto(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  const node = editor.firstChild;
  if (node !== null) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, text.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  fireEvent.input(editor);
}

/**
 * The tasks hub authors the task family on open, so its cards
 * board groups by the fixed-id taskStatus schema — tests ensure the family
 * up front for a deterministic first render (and no in-flight writes at
 * teardown), reading the fresh option ids back from the authored schema.
 */
async function ensureTaskStatus(
  client: WorkspaceClient,
): Promise<{ schemaId: string; optionId: (label: string) => string }> {
  await ensureTaskFamily(client);
  const status = client
    .listPropertySchemas()
    .find((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.taskStatus)!;
  return {
    schemaId: status.id,
    optionId: (label) => status.options!.find((option) => option.label === label)!.id,
  };
}

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 *  class node's content — seed the title through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string, id?: string): Promise<string> {
  const classId =
    id !== undefined ? await client.createClass(title, { id }) : await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** Page with two root blocks, the first holding a nested child. */
async function seedTreePage(client: WorkspaceClient): Promise<string> {
  const pageId = await client.createObject({ isEmbedded: false, name: "Modes" });
  await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "root one" }],
  });
  const parent = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "root two" }],
  });
  await client.createObject({
    parentId: parent,
    contentAst: [{ type: "text", text: "nested under two" }],
  });
  return pageId;
}

describe("view registry", () => {
  it("registers the four view modes with labels and icons", () => {
    for (const [mode, label] of [
      ["outline", "Outline"],
      ["prose", "Prose"],
      ["cards", "Cards"],
      ["table", "Table"],
    ] as const) {
      const entry = getViewDefinition(mode);
      expect(entry, mode).toBeDefined();
      expect(entry!.label).toBe(label);
      expect(entry!.icon).toMatch(/^mdi-/);
    }
    expect(getViewModeOptions(["table", "outline"]).map((o) => o.mode)).toEqual(["table", "outline"]);
  });
});

describe("child-blocks triad", () => {
  it("defaults to outline and renders the editable block tree", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(tree).not.toBeNull();
    expect(tree.classList.contains("nt-prose")).toBe(false);
    // Scoped to the tree: the context column's TOC lists short one-line
    // blocks too.
    expect(within(tree).getByText("root one")).not.toBeNull();
    expect(within(tree).getByText("nested under two")).not.toBeNull();
    // The triad switcher moved out to the App-level NodeView chrome (card
    // top-right): a directly rendered PageView hosts no header switcher.
    // The mode itself rides the per-page device preference (below).
    for (const label of ["Outline", "Prose", "Cards"]) {
      expect(screen.queryByRole("radio", { name: label })).toBeNull();
    }
  });

  it("prose mode flattens the same tree via the nt-prose transform", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    // The NodeView switcher's seam: the per-page device preference.
    writeViewModePref(`nodeBlocks.${pageId}`, "prose");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(tree.classList.contains("nt-prose")).toBe(true);
    // Same rows, same content — a display transform only. (Scoped to the
    // tree: the context column's TOC lists short one-line blocks too.)
    expect(within(tree).getByText("root one")).not.toBeNull();
    expect(within(tree).getByText("nested under two")).not.toBeNull();
  });

  it("cards mode renders first-level blocks as cards with their children inside", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    writeViewModePref(`nodeBlocks.${pageId}`, "cards");
    render(<PageView client={client} pageId={pageId} />);

    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(2);
    // Card 1: the childless root. Card 2: title + the nested child in the
    // collapsible blocks row (collapsed by default — expand it).
    expect(within(cards[0]!).getByText("root one")).not.toBeNull();
    expect(within(cards[1]!).getByText("root two")).not.toBeNull();
    fireEvent.click(within(cards[1]!).getByRole("button", { name: "Expand root two" }));
    expect(within(cards[1]!).getByText("nested under two")).not.toBeNull();
  });
});

describe("classed-nodes table", () => {
  it("defaults to table with a column per bound property", async () => {
    const client = await seedClient();
    // The reserved system id: the seed-spec fallback synthesizes the source
    // family's columns with the manifest's normal-wording names.
    const classId = await createTitledClass(client, "Source", SYSTEM_CLASS_UUIDS.source);
    const member = await client.createObject({ isEmbedded: false, name: "A book" });
    await client.assignClass(member, classId);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The section defaults to expanded; only click when collapsed.
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }

    const table = screen.getByRole("table");
    const headers = [...table.querySelectorAll("th")].map((th) => th.textContent ?? "");
    // Leading selection checkbox column, then Name; seeded source bindings
    // become columns between Name and Created.
    expect(headers[0]).toBe("");
    expect(headers[1]).toBe("Name");
    expect(headers).toContain("Authors");
    expect(headers).toContain("ISBN");
    expect(headers[headers.length - 1]).toBe("Created");
  });
});

describe("the v1 node card (cards mode, owner 2026-10-13)", () => {
  it("a flat card resolves the node's child blocks from the client — the classed-nodes case", async () => {
    const client = await seedClient();
    const member = await client.createObject({ isEmbedded: false, name: "Member" });
    await client.createObject({
      parentId: member,
      contentAst: [{ type: "text", text: "member body block" }],
    });
    const parent = await client.createObject({
      parentId: member,
      contentAst: [{ type: "text", text: "body parent" }],
    });
    await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "body grandchild" }],
    });
    await flushWrites();

    // The classed-nodes shape: items carry NO children — cards resolve them.
    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(member)! }]}
        onNodeClick={() => {}}
      />,
    );
    const card = container.querySelector(".node-card") as HTMLElement;
    // The content row renders its header at rest (chevron + label), the body
    // collapsed by default — the chevron shows the content on demand.
    expect(card.querySelector(".node-card__body")).toBeNull();
    expect(within(card).getByText("Content")).not.toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Expand Member" }));
    expect(within(card).getByText("member body block")).not.toBeNull();
    expect(within(card).getByText("body grandchild")).not.toBeNull();
    // The chevron knows the body (bordered, now expanded).
    const chevron = within(card).getByRole("button", { name: "Collapse Member" });
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    expect(chevron.className).toContain("node-card__collapse-btn--has-children");
  });

  it("the blocks-row chevron shows and hides the child blocks (display state, never an op)", async () => {
    const client = await seedClient();
    const member = await client.createObject({ isEmbedded: false, name: "Foldable" });
    await client.createObject({
      parentId: member,
      contentAst: [{ type: "text", text: "fold me away" }],
    });
    await flushWrites();

    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(member)! }]}
        onNodeClick={() => {}}
      />,
    );
    const card = container.querySelector(".node-card") as HTMLElement;
    const body = () => card.querySelector(".node-card__body");
    // Collapsed at rest (the body is not mounted)…
    expect(body()).toBeNull();
    // …expand mounts it…
    fireEvent.click(within(card).getByRole("button", { name: "Expand Foldable" }));
    expect(body()).not.toBeNull();
    // …collapse unmounts it again.
    fireEvent.click(within(card).getByRole("button", { name: "Collapse Foldable" }));
    expect(body()).toBeNull();
    const chevron = within(card).getByRole("button", { name: "Expand Foldable" });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
  });

  it("classes chips, tags chips, and the nodeview properties table ride the card", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "Pokemon");
    const schemaId = await client.createPropertySchema({ name: "Level", type: "number" });
    await client.setClassProperty(classId, schemaId, {});
    // A second binding with NO value on the member: the table shows it as an
    // empty row (owner 2026-10-13 — the class's full column set).
    const noteId = await client.createPropertySchema({ name: "Note", type: "text" });
    await client.setClassProperty(classId, noteId, {});
    const tag = await client.createObject({ isEmbedded: false, name: "favorites" });
    // A BLOCK member (parented — inline-block render state): document-chrome
    // nodes carry text-only titles (the store's flatten invariant), so the
    // rich class chip survives only on a block's content.
    const dex = await client.createObject({ isEmbedded: false, name: "Dex" });
    const member = await client.createObject({
      parentId: dex,
      contentAst: [
        { type: "text", text: "A wild " },
        { type: "class_link", classId },
        { type: "text", text: " appears" },
      ],
    });
    await client.assignClass(member, classId);
    await client.assignTag(member, tag);
    await client.setProperty(member, schemaId, 25);
    // A second class with NO inline reference: the owner ruling (2026-10-15)
    // hides inline-referenced classes' pills, so this chip must still ride.
    const plainClassId = await createTitledClass(client, "Digimon");
    await client.assignClass(member, plainClassId);
    await flushWrites();

    const opened: string[] = [];
    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(member)! }]}
        onNodeClick={(id) => opened.push(id)}
      />,
    );
    const card = container.querySelector(".node-card") as HTMLElement;
    // The lead stack groups breadcrumbs → title → classes → tags (beside a
    // horizontal cover; full width in the top/no-cover flow).
    expect(card.querySelector(".node-card__lead .node-card__header")).not.toBeNull();
    expect(card.querySelector(".node-card__lead .node-card__classes-row")).not.toBeNull();
    expect(card.querySelector(".node-card__lead .node-card__tags-row")).not.toBeNull();
    // The title IS the page-view title row (BlockRow variant="title"): the
    // class chip rides as a live node link (the owner 2026-10-13 node-link
    // look) — a click opens THE CLASS, and the plain-title click opens the
    // node.
    const head = card.querySelector(".node-card__title") as HTMLElement;
    const classLink = head.querySelector(".nt-link--class") as HTMLElement;
    expect(classLink).not.toBeNull();
    expect(classLink.textContent).toBe("Pokemon");
    fireEvent.click(classLink);
    expect(opened).toEqual([classId]);
    // The plain-title click (the content surface) opens the NODE.
    fireEvent.click(head.querySelector(".nt-title-content")!);
    expect(opened).toEqual([classId, member]);
    // The classes row: the nodeview bar's interactive list — the member's
    // chip AND the add affordance ride. Pokemon is referenced INLINE (the
    // title's class link above), so the owner ruling (2026-10-15) hides its
    // pill; a class with no inline reference still wears the chip.
    const classesRow = card.querySelector(".node-card__classes-row")!;
    expect(classesRow).not.toBeNull();
    expect(within(classesRow as HTMLElement).queryByText("Pokemon")).toBeNull();
    expect(within(classesRow as HTMLElement).getByText("Digimon")).not.toBeNull();
    expect(within(classesRow as HTMLElement).getByText("Add class")).not.toBeNull();
    // The tags row: the header's TagsRow composition (label hidden) — the
    // assigned tag chip AND the add affordance ride.
    const tagsRow = card.querySelector(".node-card__tags-row")!;
    expect(tagsRow).not.toBeNull();
    expect(within(tagsRow as HTMLElement).getByText("favorites")).not.toBeNull();
    expect(within(tagsRow as HTMLElement).getByText("Add tag")).not.toBeNull();
    // The properties section IS the nodeview table (name column | value
    // column): the valued property, AND the unset bound property as an
    // empty row.
    const properties = card.querySelector(".node-card__properties")!;
    expect(properties).not.toBeNull();
    expect(properties.querySelector(".nt-properties-list")).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Level")).not.toBeNull();
    // The value rides in the table's editable cell (an input, not text).
    expect(within(properties as HTMLElement).getByDisplayValue("25")).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Note")).not.toBeNull();
  });

  it("right-click on the title opens the node menu; the three-dot is gone (the checkbox stays)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const member = await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "Child" }] });
    await flushWrites();

    const { container } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(member)! }]}
        onNodeClick={() => {}}
      />,
    );
    const card = container.querySelector(".node-card") as HTMLElement;
    // The breadcrumb FIRST row names the containing page.
    expect(within(card).getByText("Home")).not.toBeNull();
    // No three-dot action button anywhere on the card…
    expect(within(card).queryByRole("button", { name: "Node actions" })).toBeNull();
    // …the selection checkbox stays…
    expect(within(card).getByRole("checkbox", { name: "Select Child" })).not.toBeNull();
    // …and the title's context menu opens on right-click.
    const title = card.querySelector(".node-card__title") as HTMLElement;
    fireEvent.contextMenu(title);
    expect(screen.getByRole("menu")).not.toBeNull();
  });

  it("the breadcrumb row is read-only on the card — crumbs navigate, nothing edits (owner reversal 2026-10-13)", async () => {
    const client = await seedClient();
    // A parentless card: no crumbs, no Add parent pill.
    const orphan = await client.createObject({ isEmbedded: false, name: "Orphan" });
    // A parented card: the chain rides for navigation, but no edit gestures.
    const parent = await client.createObject({ isEmbedded: false, name: "Parent" });
    const child = await client.createObject({ parentId: parent, contentAst: [{ type: "text", text: "Child" }] });
    await flushWrites();

    const { container, unmount } = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(orphan)! }]}
        onNodeClick={() => {}}
      />,
    );
    let card = container.querySelector(".node-card") as HTMLElement;
    expect(within(card).queryByRole("button", { name: /Add parent/ })).toBeNull();
    unmount();

    const second = render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(child)! }]}
        onNodeClick={() => {}}
      />,
    );
    card = second.container.querySelector(".node-card") as HTMLElement;
    expect(within(card).getByText("Parent")).not.toBeNull();
    // Read-only: even a right-click on a crumb opens no edit menu.
    fireEvent.contextMenu(within(card).getByText("Parent"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("table mode never renders children even when the items carry them", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    await flushWrites();
    // Tree-shaped items (children attached) — the table stays flat anyway.
    const items = childQuery(client, pageId);

    render(
      <NodeCollection viewMode="table" client={client} items={items} onNodeClick={() => {}} />,
    );
    expect(screen.getByText("root one")).not.toBeNull();
    expect(screen.getByText("root two")).not.toBeNull();
    expect(screen.queryByText("nested under two")).toBeNull();
  });
});

describe("tasks hub", () => {
  it("lists pages AND blocks classed task, table by default, switchable", async () => {
    const client = await seedClient();
    // The hub authors the task family on open — ensure up front
    // so no write is in flight when the test teardown closes the client.
    await ensureTaskFamily(client);
    const taskPage = await client.createObject({ isEmbedded: false, name: "Write report" });
    await client.assignClass(taskPage, SYSTEM_CLASS_UUIDS.task);
    const host = await client.createObject({ isEmbedded: false, name: "Host" });
    const taskBlock = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "Call the office" }],
    });
    await client.assignClass(taskBlock, SYSTEM_CLASS_UUIDS.task);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    // Table default; both node types listed by their derived titles — the
    // name cell is the title block row (owner 2026-10-21): a div, not a
    // button (navigation rides the pinned "Open …" button).
    const table = screen.getByRole("table");
    expect(within(table).getByText("Write report")).not.toBeNull();
    expect(within(table).getByText("Call the office")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(2);

    fireEvent.click(screen.getByRole("radio", { name: "Outline" }));
    // The list view renders FULL block rows (the same outline row the page
    // body uses), inline-editable because the tasks hub is an editing
    // surface: one row per member, content editable in place, and the
    // status property riding the row as the bullet icon button (the task
    // family binds Status with the bullet display position).
    const hub = document.querySelector(".nt-hub") as HTMLElement;
    const rows = hub.querySelectorAll(".outline-flat > li");
    expect(rows.length).toBe(2);
    expect(hub.textContent).toContain("Write report");
    expect(hub.textContent).toContain("Call the office");
    expect(
      hub.querySelectorAll(
        `.nt-propicon[data-property-schema-id="${SYSTEM_PROPERTY_UUIDS.taskStatus}"]`,
      ).length,
    ).toBe(2);
    // Inline editing: clicking the row content swaps in the block editor.
    fireEvent.click(hub.querySelector(".nt-block-content") as HTMLElement);
    expect(hub.querySelector(".nt-block--editing")).not.toBeNull();
  });

  it("list view opens via the bullet: read-only rows are inert (content click does nothing)", async () => {
    const client = await seedClient();
    const parentless = await client.createObject({ isEmbedded: false, name: "Solo" });

    // A read-only flat collection (no editable): the owner-facing inert
    // contract — clicking the content does NOT open; the bullet element
    // does.
    const opened: string[] = [];
    const { container } = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Readonly list"
        items={[{ node: client.getNode(parentless)! }]}
        modes={["outline"]}
        defaultMode="outline"
        onOpenNode={(id) => opened.push(id)}
      />,
    );
    const content = container.querySelector(".nt-block-content") as HTMLElement;
    expect(content).not.toBeNull();
    expect(container.querySelector(".nt-block--inert")).not.toBeNull();
    fireEvent.click(content);
    expect(opened).toEqual([]);
    fireEvent.click(container.querySelector(".nt-bullet") as HTMLElement);
    expect(opened).toEqual([parentless]);
  });

  it("sorts by name ascending and descending via header clicks", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    await client.assignClass(
      await client.createObject({ isEmbedded: false, name: "Zulu" }),
      SYSTEM_CLASS_UUIDS.task,
    );
    await client.assignClass(
      await client.createObject({ isEmbedded: false, name: "Alpha" }),
      SYSTEM_CLASS_UUIDS.task,
    );
    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    const nameSort = screen.getByRole("button", { name: /^Name/ });
    const rowNames = () =>
      [...screen.getByRole("table").querySelectorAll("td.nt-table-name .nt-title-content")].map(
        (el) => el.textContent,
      );

    fireEvent.click(nameSort); // asc
    expect(rowNames()).toEqual(["Alpha", "Zulu"]);
    fireEvent.click(nameSort); // desc
    expect(rowNames()).toEqual(["Zulu", "Alpha"]);
  });
});

describe("cards board (property-dimension groupBy)", () => {
  const OPTION_A = "00000000-0000-0000-0005-000000000001";
  const OPTION_C = "00000000-0000-0000-0005-000000000003";

  /** A select schema with three options (A/B/C) — the board's dimension. */
  async function seedStatusSchema(client: WorkspaceClient): Promise<string> {
    return client.createPropertySchema({
      name: "Status",
      type: "select",
      options: [
        { id: OPTION_A, label: "Backlog" },
        { id: "00000000-0000-0000-0005-000000000002", label: "Doing" },
        { id: OPTION_C, label: "Done" },
      ],
    });
  }

  async function seedTask(client: WorkspaceClient, title: string): Promise<string> {
    const id = await client.createObject({ isEmbedded: false, name: title });
    await client.assignClass(id, SYSTEM_CLASS_UUIDS.task);
    return id;
  }

  function column(id: string): HTMLElement {
    const el = document.querySelector(`.board-column[data-column-id="${id}"]`);
    if (el === null) throw new Error(`no column ${id}`);
    return el as HTMLElement;
  }

  it("groups cards into option columns plus a None column, and the drop writes the property", async () => {
    const client = await seedClient();
    // The board's dimension is the authored task status schema (fixed seed
    // id — the hub's grouping property), not a workspace-local one.
    const { schemaId, optionId } = await ensureTaskStatus(client);
    const inBacklog = await seedTask(client, "Task Backlog");
    const inDone = await seedTask(client, "Task Done");
    const unscheduled = await seedTask(client, "Task Unset");
    await client.setProperty(inBacklog, schemaId, optionId("Backlog"), 0);
    await client.setProperty(inDone, schemaId, optionId("Done"), 0);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    // The hub defaults to table; cards mode IS the board when the grouping
    // property (the task status schema) exists — kanban is not a mode.
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));

    // Status option columns + None, counts in the headers.
    const titles = () =>
      [...document.querySelectorAll(".board-column__title")].map((el) => el.textContent);
    for (const label of ["Backlog", "Pending", "Doing", "Reviewing", "Done", "Cancelled", "None"]) {
      expect(titles()).toContain(label);
    }
    expect(within(column(optionId("Backlog"))).getByText("Task Backlog")).not.toBeNull();
    expect(within(column(optionId("Done"))).getByText("Task Done")).not.toBeNull();
    expect(within(column("__none__")).getByText("Task Unset")).not.toBeNull();
    // Empty columns still render as drop targets.
    expect(within(column(optionId("Doing"))).getByText("0")).not.toBeNull();

    // The drop write (what the drag handler calls): move the unset task into
    // the Doing column; the client notification re-renders the board.
    await applyCardGroupDrop(client, unscheduled, schemaId, optionId("Doing"), undefined);
    await flushWrites();
    expect(within(column(optionId("Doing"))).getByText("Task Unset")).not.toBeNull();
    expect(within(column("__none__")).queryByText("Task Unset")).toBeNull();

    // Drop on None clears the value again.
    await applyCardGroupDrop(client, unscheduled, schemaId, null, 0);
    await flushWrites();
    expect(within(column("__none__")).getByText("Task Unset")).not.toBeNull();
  });

  it("the tasks hub cards mode rides the authored task family; hubs without a grouping select render the flat grid", async () => {
    const client = await seedClient();
    await seedTask(client, "Lonely Task");
    // The hub authors the task family on open, so the status
    // schema (a usable select) always exists and the cards mode renders
    // the board.
    await ensureTaskFamily(client);
    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    // Kanban is gone from the switcher; the triad is unchanged.
    expect(screen.queryByRole("radio", { name: "Kanban" })).toBeNull();
    for (const label of ["Outline", "Cards", "Table"]) {
      expect(screen.getByRole("radio", { name: label })).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    expect(document.querySelector(".board")).not.toBeNull();

    // A hub whose members carry no usable select property renders the flat
    // cards grid instead (the Assets hub defaults to cards).
    const host = await client.createObject({ isEmbedded: false, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "scanned-receipt.pdf" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    const assets = render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    expect(within(assets.container).queryByRole("radio", { name: "Kanban" })).toBeNull();
    expect(assets.container.querySelector(".board")).toBeNull();
    expect(assets.container.querySelector(".cards-grid")).not.toBeNull();
  });

  it("classed nodes render the cards board when a bound select property has options", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "project");
    const schemaId = await seedStatusSchema(client);
    await client.setClassProperty(classId, schemaId, {});
    const member = await seedTask(client, "Member");
    await client.assignClass(member, classId);

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    // The section defaults to expanded; only click when collapsed.
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }

    // The section default stays table; cards mode renders the board.
    expect(screen.getByRole("table")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    expect(screen.getByText("Backlog")).not.toBeNull();
    expect(within(column("__none__")).getByText("Member")).not.toBeNull();
  });
});

describe("assets hub", () => {
  it("defaults to cards and switches to table", async () => {
    const client = await seedClient();
    const host = await client.createObject({ isEmbedded: false, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "scanned-receipt.pdf" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);

    render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);

    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(1);
    expect(within(cards[0]!).getByText("scanned-receipt.pdf")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Table" }));
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /scanned-receipt/ }).length).toBeGreaterThan(0);
  });
});

describe("pages hub (workspace roots)", () => {
  it("lists top-level pages only — subpages ride the parent's row, collapsed by default (owner 2026-10-21)", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Top Level" });
    const parentId = await client.createObject({ isEmbedded: false, name: "Parent" });
    await client.createObject({ parentId, isEmbedded: false, name: "Subpage" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);

    const hub = document.querySelector(".nt-hub") as HTMLElement;
    // Top-level membership reads each row's OWN content (the root block's
    // content div), not the whole subtree — children nest inside the row.
    const ownTitle = (li: Element): string =>
      li.querySelector(
        ":scope > .outline-row > .nt-block > .nt-block-row > .nt-block-content",
      )?.textContent ?? "";
    const ownTitles = [...hub.querySelectorAll(".outline-flat > li")].map(ownTitle);
    expect(ownTitles.some((t) => t.includes("Top Level"))).toBe(true);
    expect(ownTitles.some((t) => t.includes("Parent"))).toBe(true);
    // The subpage is not a top-level row…
    expect(ownTitles.some((t) => t.includes("Subpage"))).toBe(false);
    // …and the parent's row opens COLLAPSED — pages with children default
    // folded (owner 2026-10-21); the chevron reveals the subpage on demand.
    const parentRow = [...hub.querySelectorAll(".outline-flat > li")].find(
      (li) => ownTitle(li).includes("Parent"),
    ) as HTMLElement;
    expect(parentRow.textContent).not.toContain("Subpage");
    const chevron = parentRow.querySelector(".nt-block-chevron") as HTMLElement;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron);
    expect(parentRow.textContent).toContain("Subpage");
  });
});

describe("outline list: rows with children default collapsed (owner 2026-10-21)", () => {
  it("a page row folds its child blocks behind the chevron; the toggle is session-local display state", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Folded" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "the hidden block" }],
    });

    const { container } = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Fold list"
        items={[{ node: client.getNode(pageId)! }]}
        modes={["outline"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    const row = container.querySelector("ul.outline-flat > li") as HTMLElement;
    // Collapsed by default: the child block is not in the DOM, the chevron
    // names the folded state.
    expect(row.textContent).not.toContain("the hidden block");
    const chevron = row.querySelector(".nt-block-chevron") as HTMLElement;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    // Expand renders the child block; re-fold hides it again.
    fireEvent.click(chevron);
    expect(row.textContent).toContain("the hidden block");
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chevron);
    expect(row.textContent).not.toContain("the hidden block");
  });

  it("block rows with children fold too — the ruling covers every row, not pages only", async () => {
    const client = await seedClient();
    const hostId = await client.createObject({ isEmbedded: false, name: "Host" });
    const blockId = await client.createObject({
      parentId: hostId,
      contentAst: [{ type: "text", text: "the parent block" }],
    });
    await client.createObject({
      parentId: blockId,
      contentAst: [{ type: "text", text: "the nested block" }],
    });

    const { container } = render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-bulleted"
        title="Block list"
        items={[{ node: client.getNode(blockId)! }]}
        modes={["outline"]}
        defaultMode="outline"
        onOpenNode={() => {}}
      />,
    );
    const row = container.querySelector("ul.outline-flat > li") as HTMLElement;
    expect(row.textContent).not.toContain("the nested block");
    const chevron = row.querySelector(".nt-block-chevron") as HTMLElement;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron);
    expect(row.textContent).toContain("the nested block");
  });

  it("the backlinks-style reference subtree folds its root row the same way", async () => {
    const client = await seedClient();
    const hostId = await client.createObject({ isEmbedded: false, name: "Host" });
    const sourceId = await client.createObject({
      parentId: hostId,
      contentAst: [{ type: "text", text: "the referencing block" }],
    });
    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "the folded context" }],
    });

    const { container } = render(
      <ReferenceSubtree client={client} rootId={sourceId} onOpenNode={() => {}} />,
    );
    const row = container.querySelector(".nt-refblock-tree") as HTMLElement;
    expect(row.textContent).not.toContain("the folded context");
    const chevron = row.querySelector(".nt-block-chevron") as HTMLElement;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chevron);
    expect(row.textContent).toContain("the folded context");
  });

  it("the collapsed ring is ONE outer circle sized past the class-icon glyph (owner report 2026-10-21)", () => {
    // jsdom has no layout: the regression is CSS — the 19.2px icon glyph
    // is a solid plate that covered the old 16px halo entirely. The
    // ruling: the SAME soft outer circle on both bullet kinds, grown past
    // the glyph (ring 24px riding a 26px bullet box), never an icon-only
    // outline hack.
    const process_ = globalThis.process as unknown as {
      getBuiltinModule(name: string): { readFileSync(path: unknown, enc: string): string };
      cwd(): string;
    };
    const path = process_.getBuiltinModule("node:path") as unknown as {
      join(...parts: string[]): string;
    };
    const css = process_.getBuiltinModule("node:fs").readFileSync(
      path.join(process_.cwd(), "src", "ui", "app.css"),
      "utf8",
    );
    const ring = /\.nt-bullet-ring \{[^}]*\}/.exec(css);
    expect(ring).not.toBeNull();
    // Two sizes, one style: the classic 16px halo on dot bullets…
    expect(ring![0]).toContain("width: 16px");
    expect(ring![0]).toContain("height: 16px");
    expect(ring![0]).toContain("background-color");
    // …and the 28px circle on class-icon bullets (the halo that hides
    // behind the solid glyph without it) — a SIZE variant only, never
    // the retired border/outline treatment.
    const iconRing = /\.nt-bullet:has\(\.nt-bullet-icon\) \.nt-bullet-ring \{[^}]*\}/.exec(css);
    expect(iconRing).not.toBeNull();
    expect(iconRing![0]).toContain("width: 28px");
    expect(iconRing![0]).not.toContain("border");
    const bullet = /\.nt-bullet \{[^}]*\}/.exec(css);
    expect(bullet).not.toBeNull();
    expect(bullet![0]).toContain("width: 22px");
    expect(bullet![0]).toContain("height: 22px");
    const dot = /\.nt-bullet-dot \{[^}]*\}/.exec(css);
    expect(dot).not.toBeNull();
    expect(dot![0]).toContain("width: 6px");
    // The wrapper is layout, not indicator chrome: a flex item whose
    // height sets the row height — growing it inflated every row.
    expect(bullet![0]).not.toContain("46px");
    // The grouped rendering separates its rows from the group header —
    // the overhanging ring of the first row used to crowd the title.
    const outlineCss = process_.getBuiltinModule("node:fs").readFileSync(
      path.join(process_.cwd(), "src", "features", "collection", "OutlineView.css"),
      "utf8",
    );
    const items = /\.outline-group__items \{[^}]*\}/.exec(outlineCss);
    expect(items).not.toBeNull();
    expect(items![0]).toContain("padding: var(--spacing-2) 0 0 var(--spacing-3)");
  });
});

describe("groupBy: references grouped by containing page", () => {
  /** Target page with one mention from each of two source pages. */
  async function seedReferencedPage(client: WorkspaceClient): Promise<string> {
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    for (const name of ["Source One", "Source Two"]) {
      const sourceId = await client.createObject({ isEmbedded: false, name });
      await client.createObject({
        parentId: sourceId,
        contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
      });
    }
    return targetId;
  }

  /**
   * The Backlinks section for within() scoping — it starts expanded, so the
   * groups render on mount without any interaction.
   */
  function expandLinkedReferences(): HTMLElement {
    const header = screen.getByRole("button", { name: /Backlinks/ });
    const section = header.closest("section");
    if (section === null) throw new Error("no Backlinks section rendered");
    return section as HTMLElement;
  }

  it("renders one collapsible group per containing page, headers open the page", async () => {
    const client = await seedClient();
    const targetId = await seedReferencedPage(client);
    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={targetId} onOpenPage={onOpenPage} />);

    const linked = expandLinkedReferences();

    // Two groups (one per source page), each with its page label + count.
    const groups = linked.querySelectorAll(".outline-group");
    expect(groups.length).toBe(2);
    const names = [...linked.querySelectorAll(".outline-group__name")].map((el) => el.textContent);
    expect(names).toContain("Source One");
    expect(names).toContain("Source Two");
    const counts = [...linked.querySelectorAll(".outline-group__count")].map((el) => el.textContent);
    expect(counts).toEqual(["1", "1"]);

    // The referencing blocks render inside their group.
    expect(groups[0]!.textContent).toContain("Zebra");

    // Header click opens the containing page.
    const headers = [...linked.querySelectorAll("button.outline-group__label")];
    fireEvent.click(headers[0]!);
    expect(onOpenPage).toHaveBeenCalled();
  });

  it("group headers render the containing page's effective icon — own icon and class-chain icon", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    // Source One carries its own authored icon.
    const sourceOne = await client.createObject({ isEmbedded: false, name: "Source One" });
    await client.updateObject(sourceOne, { icon: "mdi-star" });
    await client.createObject({
      parentId: sourceOne,
      contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    // Source Two inherits its icon through the class-extends chain (the
    // daily-page shape: no own icon, the glyph arrives via its class).
    const glyphParent = await client.createClass("Glyph Parent", { icon: "mdi-heart" });
    const glyphChild = await client.createClass("Glyph Child");
    await client.setClassExtends(glyphChild, [glyphParent]);
    const sourceTwo = await client.createObject({ isEmbedded: false, name: "Source Two" });
    await client.assignClass(sourceTwo, glyphChild);
    await client.createObject({
      parentId: sourceTwo,
      contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });

    render(<PageView client={client} pageId={targetId} onOpenPage={() => {}} />);
    const linked = expandLinkedReferences();

    const iconOf = (name: string): string | null =>
      [...linked.querySelectorAll("button.outline-group__label")]
        .find((el) => el.textContent?.includes(name))
        ?.querySelector("use")
        ?.getAttribute("href") ?? null;
    expect(iconOf("Source One")).toBe("/mdi-sprite.svg#mdi-star");
    expect(iconOf("Source Two")).toBe("/mdi-sprite.svg#mdi-heart");
  });

  it("group headers flatten markdown link spans in the page title to their label text", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    // The containing page's title IS a markdown link span (imported/pasted
    // content): `[Implaline - iRES Group](https://www.en.ires.dental/...)`.
    const sourceId = await client.createObject({
      isEmbedded: false,
      contentAst: [{ type: "text", text: "[Implaline - iRES Group](https://www.en.ires.dental/products)" }],
    });
    await client.createObject({
      parentId: sourceId,
      contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    render(<PageView client={client} pageId={targetId} onOpenPage={() => {}} />);

    const linked = expandLinkedReferences();
    const name = linked.querySelector(".outline-group__name")?.textContent;
    // The label text renders; the raw `[label](href)` markdown never does.
    expect(name).toBe("Implaline - iRES Group");
    expect(linked.textContent).not.toContain("https://www.en.ires.dental/products)");
  });

  it("collapses and re-expands a group via its chevron", async () => {
    const client = await seedClient();
    const targetId = await seedReferencedPage(client);
    render(<PageView client={client} pageId={targetId} />);

    const linked = expandLinkedReferences();
    const toggle = within(linked).getByRole("button", { name: /Collapse group Source One/ });

    fireEvent.click(toggle);
    expect(within(linked).queryByRole("button", { name: /Expand group Source One/ })).not.toBeNull();
    expect(within(linked).getByRole("button", { name: /Collapse group Source Two/ })).not.toBeNull();

    fireEvent.click(within(linked).getByRole("button", { name: /Expand group Source One/ }));
    expect(within(linked).getByRole("button", { name: /Collapse group Source One/ })).not.toBeNull();
  });

  it("groups two references from the same page under one header with count 2", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    const sourceId = await client.createObject({ isEmbedded: false, name: "Double Source" });
    for (const text of ["first", "second"]) {
      await client.createObject({
        parentId: sourceId,
        contentAst: [
          { type: "text", text: `${text} ` },
          { type: "mention", targetNodeId: targetId, text: "Zebra" },
        ],
      });
    }
    render(<PageView client={client} pageId={targetId} onOpenPage={() => {}} />);

    const linked = expandLinkedReferences();
    expect(linked.querySelectorAll(".outline-group").length).toBe(1);
    const header = linked.querySelector("button.outline-group__label")!;
    expect(header.querySelector(".outline-group__name")?.textContent).toContain("Double Source");
    expect(header.querySelector(".outline-group__count")?.textContent).toContain("2");
  });

  /**
   * The owner 2026-10-20 ruling: a page referencing the target from its OWN
   * body is not a group (a self-named one-row group names nothing) — it
   * renders as its own top-level row, as a separated flat outline list,
   * BEFORE the group sections.
   */
  it("a page source renders as a top-level row before the groups, not inside its own group", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    // Direct Source mentions Zebra in its own body (the source IS the page).
    // (The mention rides an update — object.create flattens content to text.)
    const directId = await client.createObject({ isEmbedded: false, name: "see " });
    await client.updateObject(directId, {
      contentAst: [{ type: "text", text: "see " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    // Block Source mentions Zebra from a child block — a real group.
    const blockSource = await client.createObject({ isEmbedded: false, name: "Block Source" });
    await client.createObject({
      parentId: blockSource,
      contentAst: [{ type: "text", text: "via block " }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={targetId} onOpenPage={onOpenPage} />);

    const linked = expandLinkedReferences();

    // One group only — the block source's page. No self-named group for the
    // direct page source.
    const groupNames = [...linked.querySelectorAll(".outline-group__name")].map((el) => el.textContent);
    expect(groupNames).toEqual(["Block Source"]);

    // The page source rides its own top-level flat outline (a ul.outline-flat
    // that is NOT a group's item list)…
    const standaloneLists = [...linked.querySelectorAll("ul.outline-flat")].filter(
      (el) => !el.classList.contains("outline-group__items"),
    );
    expect(standaloneLists.length).toBe(1);
    expect(standaloneLists[0]!.textContent).toContain("see");
    // …BEFORE the group sections in the document order.
    const position = standaloneLists[0]!.compareDocumentPosition(linked.querySelector(".outline-groups")!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The standalone row's bullet opens the source page, like any row.
    fireEvent.click(standaloneLists[0]!.querySelector(".nt-bullet")!);
    expect(onOpenPage).toHaveBeenCalledWith(directId);
  });

  it("all-page references render flat with no group sections at all", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ isEmbedded: false, name: "Zebra" });
    for (const name of ["Page One", "Page Two"]) {
      const pageId = await client.createObject({ isEmbedded: false, name: `${name} ` });
      await client.updateObject(pageId, {
        contentAst: [{ type: "text", text: `${name} ` }, { type: "mention", targetNodeId: targetId, text: "Zebra" }],
      });
    }
    render(<PageView client={client} pageId={targetId} onOpenPage={() => {}} />);

    const linked = expandLinkedReferences();
    expect(linked.querySelectorAll(".outline-group")).toHaveLength(0);
    const rows = [...linked.querySelectorAll("ul.outline-flat > li")].map((el) => el.textContent ?? "");
    expect(rows.length).toBe(2);
    expect(rows.some((t) => t.includes("Page One"))).toBe(true);
    expect(rows.some((t) => t.includes("Page Two"))).toBe(true);
  });
});

describe("table polish: multi-sort, column selector, inline editing, selection", () => {
  const OPT_BACKLOG = "00000000-0000-0000-0005-000000000011";
  const OPT_DOING = "00000000-0000-0000-0005-000000000012";

  /** Class with bound select/text/number/date/object schemas + three members. */
  async function seedProjectTable(client: WorkspaceClient): Promise<{
    classId: string;
    statusId: string;
    noteId: string;
    effortId: string;
    dueId: string;
    ownerId: string;
    alpha: string;
    beta: string;
    gamma: string;
  }> {
    const classId = await createTitledClass(client, "project");
    const statusId = await client.createPropertySchema({
      name: "Status",
      type: "select",
      options: [
        { id: OPT_BACKLOG, label: "Backlog" },
        { id: OPT_DOING, label: "Doing" },
      ],
    });
    const noteId = await client.createPropertySchema({ name: "Note", type: "text" });
    const effortId = await client.createPropertySchema({ name: "Effort", type: "number" });
    const dueId = await client.createPropertySchema({ name: "Due", type: "datetime" });
    const ownerId = await client.createPropertySchema({ name: "Owner", type: "object" });
    for (const schema of [statusId, noteId, effortId, dueId, ownerId]) {
      await client.setClassProperty(classId, schema, {});
    }
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
    const gamma = await client.createObject({ isEmbedded: false, name: "Gamma" });
    for (const id of [alpha, beta, gamma]) await client.assignClass(id, classId);
    await client.setProperty(alpha, statusId, OPT_BACKLOG, 0);
    await client.setProperty(beta, statusId, OPT_DOING, 0);
    return { classId, statusId, noteId, effortId, dueId, ownerId, alpha, beta, gamma };
  }

  const expandClassedNodes = async (): Promise<void> => {
    // The section defaults to expanded; only click when collapsed.
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }
  };

  const rowNames = (): Array<string | undefined> =>
    [...screen.getByRole("table").querySelectorAll("td.nt-table-name .nt-title-content")].map((el) => el.textContent ?? undefined);

  it("sort panel composes multi-column sorts and the header keeps quick-sort", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    // The section opens on its Name-asc default (owner 2026-10-13); the
    // panel composes on top of it.
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Status" }));
    // [Name asc, Status asc] would let name dominate — promote Status with
    // the priority reorder (the second entry's Move up).
    fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1]!);
    // Status asc: Backlog (Alpha), Doing (Beta); empty sinks last (Gamma).
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    // The header register: every sorted column wears its direction
    // arrow and a multi-sort shows the priority index badges.
    expect(document.querySelectorAll(".nt-table-sort--active")).toHaveLength(2);
    expect(
      [...document.querySelectorAll(".nt-table-sort-index")]
        .map((el) => el.textContent)
        .sort(),
    ).toEqual(["1", "2"]);

    // Toggle Status to desc: Doing first.
    fireEvent.click(screen.getByRole("button", { name: "Status: ascending — toggle" }));
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma"]);

    // Remove the Status entry: the Name-asc default sort remains.
    fireEvent.click(screen.getByRole("button", { name: "Remove Status sort" }));
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);
    // Single sort: the arrow stays, the index badge is gone.
    expect(document.querySelectorAll(".nt-table-sort--active")).toHaveLength(1);
    expect(document.querySelector(".nt-table-sort-index")).toBeNull();
  });

  it("name cell IS the title block row: markdown links render as anchors (never the raw source), click edits inline", async () => {
    const client = await seedClient();
    const classId = await client.createClass("project");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "project" }] });
    const member = await client.createObject({
      isEmbedded: false,
      contentAst: [
        { type: "text", text: "[Blender course](https://www.youtube.com/watch?v=abc123)" },
      ],
    });
    await client.assignClass(member, classId);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    // Read mode renders the markdown span as a real anchor — the owner
    // ruling (2026-10-21) retired the raw [label](href) text flatten.
    const cell = screen.getByRole("table").querySelector("td.nt-table-name") as HTMLElement;
    const link = cell.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.youtube.com/watch?v=abc123");
    expect(link?.textContent).toBe("Blender course");
    expect(cell.textContent ?? "").not.toContain("[");

    // A click inside the cell swaps in the full block editor (the title
    // projection's edit contract — the retired single-token rename input
    // edited rich titles by flattening; the real editor needs no guard).
    const content = cell.querySelector(".nt-title-content") as HTMLElement;
    fireEvent.click(content);
    expect(content.querySelector(".nt-block-text")).not.toBeNull();
  });

  it("column selector hides defaults and adds property columns", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    await client.createPropertySchema({ name: "Pages", type: "text" });
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    const headers = () => [...screen.getByRole("table").querySelectorAll("th")].map((th) => th.textContent ?? "");

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Created" }));
    expect(headers()).not.toContain("Created");

    fireEvent.click(screen.getByRole("checkbox", { name: "Pages" }));
    expect(headers()).toContain("Pages");
  });

  it("text cells ride the carrier block row — the Empty placeholder creates and edits it, the Open button navigates, empty unsets; numbers commit as scalars", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    const onOpen = vi.fn();
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={onOpen} />);
    await expandClassedNodes();

    // Text cells are node-backed (PB2 one-shape-per-type) and render through
    // the name cell's block row (owner 2026-10-21 — the retired inline input
    // flattened rich text). The empty cell is the muted "Empty" placeholder
    // (its accessible name names the action): one click creates the carrier
    // block child, links {nodeId}, and lands straight in the block editor.
    // [0] is Alpha's cell (the header sort button is named "Note", not
    // "Add Note").
    fireEvent.click(screen.getAllByRole("button", { name: "Add Note" })[0]!);
    await flushWrites();
    const note = client.getEffectiveProperties(seeded.alpha).find((p) => p.propertySchemaId === seeded.noteId);
    const carrierId = (note?.value as { nodeId?: string }).nodeId;
    expect(typeof carrierId).toBe("string");
    const carrier = client.getNode(carrierId!);
    expect(carrier?.parentId).toBe(seeded.alpha);

    // The editor mounted straight away (autoEdit) — typing writes the carrier.
    const editor = document.querySelector(".nt-table-text-cell .nt-block-text") as HTMLElement;
    expect(editor).not.toBeNull();
    typeInto(editor, "hello world");
    fireEvent.blur(editor);
    await flushWrites();
    expect(client.getNode(carrierId!)?.contentAst).toEqual([{ type: "text", text: "hello world" }]);

    // The pinned Open button rides the assigned cell (owner 2026-10-21): the
    // value click owns editing, the button owns navigation — the embedded
    // carrier resolves to its page (Alpha).
    const openBtn = screen.getByRole("button", { name: "Open hello world" });
    fireEvent.click(openBtn);
    expect(onOpen).toHaveBeenCalledWith(seeded.alpha);

    // Leaving the editor emptied unsets the property — the auto-unset pass
    // (the metadata row's contract) trashes the orphaned carrier. (The
    // bound-empty virtual row may show — the virtual/realized ruling; the
    // assertion is about the authored value.)
    const content = document.querySelector(".nt-table-text-cell .nt-title-content") as HTMLElement;
    fireEvent.click(content);
    const reEditor = document.querySelector(".nt-table-text-cell .nt-block-text") as HTMLElement;
    typeInto(reEditor, "");
    fireEvent.blur(reEditor);
    await flushWrites();
    expect(
      client
        .getEffectiveProperties(seeded.alpha)
        .find((p) => p.propertySchemaId === seeded.noteId && p.source === "authored"),
    ).toBeUndefined();

    const effortInput = screen.getAllByRole("spinbutton", { name: "Effort" })[1]!;
    fireEvent.change(effortInput, { target: { value: "5" } });
    fireEvent.blur(effortInput);
    await flushWrites();
    const effort = client.getEffectiveProperties(seeded.beta).find((p) => p.propertySchemaId === seeded.effortId);
    expect(effort?.value).toBe(5);
  });

  it("date cells write a day-node reference via ensureDateChain (shared zoom-picker control)", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    const { day } = await client.ensureDateChain("2026-10-02");
    await client.setProperty(seeded.alpha, seeded.dueId, { nodeId: day }, 0);
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    // PG17: the cell rides the shared DateSlotControl — clicking opens
    // the zoom picker initialized at the committed month (Oct 2026); picking
    // the 5th rewrites the ref through ensureDateChain.
    fireEvent.click(screen.getAllByRole("button", { name: "Due" })[1]!);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Date picker" })).getByText("5"));
    await flushWrites();

    const due = client.getEffectiveProperties(seeded.alpha).find((p) => p.propertySchemaId === seeded.dueId);
    const target = due?.value as { nodeId?: string };
    expect(typeof target?.nodeId).toBe("string");
    expect(target.nodeId).not.toBe(day);
    expect(client.getDisplayName(target.nodeId!)).not.toBeNull();
  });

  it("node cells pick a target through the anchored NodeSelector", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    const paris = await client.createObject({ isEmbedded: false, name: "Paris" });
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    // [0] is Alpha's cell (the header sort button is named "Owner", not
    // "Add Owner"). The empty cell READS "Empty" (owner 2026-10-21) while
    // the accessible name names the action.
    const ownerCell = screen.getAllByRole("button", { name: "Add Owner" })[0]!;
    expect(ownerCell.textContent).toBe("Empty");
    fireEvent.click(ownerCell);
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Paris" } });
    await flushWrites();
    fireEvent.click(document.querySelector(".node-result-item:not(.node-result-item--create):not(.node-result-item--date)")!);

    const owner = client.getEffectiveProperties(seeded.alpha).find((p) => p.propertySchemaId === seeded.ownerId);
    expect(owner?.value).toEqual({ nodeId: paris });
  });

  it("multi-value node cells wear the pill cluster: every value a pill, add through the picker, remove per pill", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "paper");
    const authorsId = await client.createPropertySchema({ name: "Authors", type: "object", multi: true });
    await client.setClassProperty(classId, authorsId, {});
    const ada = await client.createObject({ isEmbedded: false, name: "Ada Lovelace" });
    const grace = await client.createObject({ isEmbedded: false, name: "Grace Hopper" });
    const paper = await client.createObject({ isEmbedded: false, name: "Notes on the Analytical Engine" });
    await client.assignClass(paper, classId);
    await client.setProperty(paper, authorsId, { nodeId: ada }, 0);
    await client.setProperty(paper, authorsId, { nodeId: grace }, 1);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    // Every value rides its own pill (the metadata row's NodePill cluster,
    // table-scaled) — the old read-only first-value-only cell is gone.
    const row = screen.getByRole("table").querySelector(`tr[data-node-id="${paper}"]`) as HTMLElement;
    const pillLabels = [...row.querySelectorAll(".nt-table-chips .pill")].map((el) => el.textContent ?? "");
    expect(pillLabels.some((label) => label.includes("Ada Lovelace"))).toBe(true);
    expect(pillLabels.some((label) => label.includes("Grace Hopper"))).toBe(true);

    // The hover-reveal × unsets its own slot, the sibling value survives.
    fireEvent.click(within(row).getByRole("button", { name: "Remove Ada Lovelace" }));
    await flushWrites();
    const remaining = client.getEffectiveProperties(paper).filter((p) => p.propertySchemaId === authorsId);
    expect(remaining).toHaveLength(1);
    expect((remaining[0]!.value as { nodeId: string }).nodeId).toBe(grace);

    // The "+ Add Authors" pill opens the anchored picker; the create row
    // appends the new node at the next free idx.
    fireEvent.click(within(row).getByRole("button", { name: "Add Authors" }));
    fireEvent.change(screen.getByLabelText("Search Authors"), { target: { value: "Alan Turing" } });
    await flushWrites();
    fireEvent.click(document.querySelector(".node-result-item--create")!);
    await flushWrites();
    const after = client.getEffectiveProperties(paper).filter((p) => p.propertySchemaId === authorsId);
    expect(after).toHaveLength(2);
    // The append rides the next free idx past the highest authored slot (the
    // ObjectPropertyRow per-slot pattern) — sparse slots never backfill.
    expect(after.map((p) => p.idx).sort()).toEqual([1, 2]);
    expect(client.getDisplayName((after[1]!.value as { nodeId: string }).nodeId)).toBe("Alan Turing");
  });

  it("asset cells wear the asset buttons: filename pills, the ❝ annotations toggle, and the upload create row", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "source doc");
    const filesId = await client.createPropertySchema({
      name: "Files",
      type: "asset",
      multi: true,
      targetClassFilter: [SYSTEM_CLASS_UUIDS.asset],
    });
    await client.setClassProperty(classId, filesId, {});
    // The system asset class is authored on demand (never pre-seeded).
    await createTitledClass(client, "asset", SYSTEM_CLASS_UUIDS.asset);
    const pdf = await client.createObject({
      isEmbedded: false,
      name: "spec node",
      classIds: [SYSTEM_CLASS_UUIDS.asset],
    });
    await client.attachAsset(pdf, {
      assetId: "00000000-0000-0000-00aa-0000000000aa",
      hash: "a0".repeat(32),
      mimeType: "application/pdf",
      size: 1,
      originalName: "spec.pdf",
    });
    const doc = await client.createObject({ isEmbedded: false, name: "Design spec" });
    await client.assignClass(doc, classId);
    await client.setProperty(doc, filesId, { nodeId: pdf }, 0);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    const row = screen.getByRole("table").querySelector(`tr[data-node-id="${doc}"]`) as HTMLElement;
    // The pill labels the asset by its original filename (the metadata row's
    // contract) and carries the ❝ annotations toggle.
    const pill = row.querySelector(".nt-table-chips .pill") as HTMLElement;
    expect(pill.textContent).toContain("spec.pdf");
    expect(within(row).getByRole("button", { name: "Annotate spec.pdf" })).toBeTruthy();

    // ❝ opens the annotations panel anchored under the cell; the add form
    // renders even with no annotations yet.
    fireEvent.click(within(row).getByRole("button", { name: "Annotate spec.pdf" }));
    const popup = screen.getByRole("dialog", { name: "Annotations for spec.pdf" });
    expect(within(popup).getByLabelText(/quote/i)).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flushWrites();
    expect(screen.queryByRole("dialog", { name: "Annotations for spec.pdf" })).toBeNull();

    // The "+ Add Files" picker's create row IS the upload action.
    fireEvent.click(within(row).getByRole("button", { name: "Add Files" }));
    fireEvent.click(document.querySelector(".node-result-item--create")!);
    expect(screen.getByRole("dialog", { name: /upload/i })).toBeTruthy();
  });

  it("empty multi-value node and asset cells read Empty and open the picker from the placeholder — no separate add affordance", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "blank paper");
    const authorsId = await client.createPropertySchema({ name: "Authors", type: "object", multi: true });
    const filesId = await client.createPropertySchema({
      name: "Files",
      type: "asset",
      multi: true,
      targetClassFilter: [SYSTEM_CLASS_UUIDS.asset],
    });
    await client.setClassProperty(classId, authorsId, {});
    await client.setClassProperty(classId, filesId, {});
    await createTitledClass(client, "asset", SYSTEM_CLASS_UUIDS.asset);
    const blank = await client.createObject({ isEmbedded: false, name: "Blank paper" });
    await client.assignClass(blank, classId);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    const row = screen.getByRole("table").querySelector(`tr[data-node-id="${blank}"]`) as HTMLElement;
    // Both empty cells read "Empty" (the unified empty-state idiom) and no
    // add pill renders before the first value.
    const authorsCell = within(row).getByRole("button", { name: "Add Authors" });
    const filesCell = within(row).getByRole("button", { name: "Add Files" });
    expect(authorsCell.textContent).toBe("Empty");
    expect(filesCell.textContent).toBe("Empty");
    expect(row.querySelector(".pill--add")).toBeNull();

    // The node cell's click opens the picker; the create row appends.
    fireEvent.click(authorsCell);
    fireEvent.change(screen.getByLabelText("Search Authors"), { target: { value: "Ada Lovelace" } });
    await flushWrites();
    fireEvent.click(document.querySelector(".node-result-item--create")!);
    await flushWrites();
    const authors = client.getEffectiveProperties(blank).filter((p) => p.propertySchemaId === authorsId);
    expect(authors).toHaveLength(1);
    expect(client.getDisplayName((authors[0]!.value as { nodeId: string }).nodeId)).toBe("Ada Lovelace");

    // The asset cell's click opens the picker whose create row is the upload.
    fireEvent.click(filesCell);
    fireEvent.click(document.querySelector(".node-result-item--create")!);
    expect(screen.getByRole("dialog", { name: /upload/i })).toBeTruthy();
  });

  it("date stamps never navigate on click — Created/Edited render plain text with the pinned day-page Open button", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    const onOpen = vi.fn();
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={onOpen} />);
    await expandClassedNodes();

    const row = screen.getByRole("table").querySelector(`tr[data-node-id="${seeded.alpha}"]`) as HTMLElement;
    const created = row.querySelector("td.nt-table-created") as HTMLElement;
    // The date text is NOT a click target (the retired day link is gone) —
    // no button inside the cell but the pinned Open button.
    const createdButtons = within(created).getAllByRole("button");
    expect(createdButtons).toHaveLength(1);
    expect(createdButtons[0]!.getAttribute("aria-label")).toMatch(/^Open the .* day page$/);
    // And the button owns the navigation.
    fireEvent.click(createdButtons[0]!);
    await flushWrites();
    expect(onOpen).toHaveBeenCalled();
  });

  it("row checkboxes select rows; the header box selects the visible window", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(3);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(0);
  });
});

describe("table export: CSV view export + selection-scoped export", () => {
  /** Minimal RFC-4180 reader (spec-local; mirrors the package escaper). */
  function parseCsv(text: string): string[][] {
    const input = text.startsWith("﻿") ? text.slice(1) : text;
    const records: string[][] = [];
    let field = "";
    let record: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i]!;
      if (inQuotes) {
        if (char === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"' && field === "") inQuotes = true;
      else if (char === ",") {
        record.push(field);
        field = "";
      } else if (char === "\n") {
        record.push(field);
        records.push(record);
        record = [];
        field = "";
      } else if (char === "\r") {
        if (input[i + 1] !== "\n") field += char;
      } else {
        field += char;
      }
    }
    if (field !== "" || record.length > 0) {
      record.push(field);
      records.push(record);
    }
    return records;
  }

  /** Capture downloadBlob's anchor + blob (jsdom has no URL.createObjectURL). */
  function stubDownload() {
    const captured: { blob: Blob | null; anchor: HTMLAnchorElement | null; restore: () => void } = {
      blob: null,
      anchor: null,
      restore: () => {},
    };
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        captured.blob = blob;
        return "blob:mock";
      }),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured.anchor = this;
      });
    captured.restore = () => click.mockRestore();
    return captured;
  }

  /** Read a Blob as UTF-8 text in jsdom (whose Blob has no arrayBuffer()). */
  function readBlobText(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  }

  async function seedCsvTable(client: WorkspaceClient): Promise<{
    classId: string;
    statusId: string;
    noteId: string;
    alpha: string;
    beta: string;
    gamma: string;
  }> {
    const classId = await createTitledClass(client, "project");
    const statusId = await client.createPropertySchema({
      name: "Status",
      type: "select",
      options: [
        { id: "00000000-0000-0000-00c5-000000000011", label: "Backlog" },
        { id: "00000000-0000-0000-00c5-000000000012", label: "Doing" },
      ],
    });
    const noteId = await client.createPropertySchema({ name: "Note", type: "text" });
    for (const schema of [statusId, noteId]) {
      await client.setClassProperty(classId, schema, {});
    }
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
    const gamma = await client.createObject({ isEmbedded: false, name: "Gamma" });
    for (const id of [alpha, beta, gamma]) await client.assignClass(id, classId);
    await client.setProperty(alpha, statusId, "00000000-0000-0000-00c5-000000000011", 0);
    await client.setProperty(beta, statusId, "00000000-0000-0000-00c5-000000000012", 0);
    return { classId, statusId, noteId, alpha, beta, gamma };
  }

  const expandClassedNodes = async (): Promise<void> => {
    const header = screen.getByRole("button", { name: /classed nodes/i });
    if (header.getAttribute("aria-expanded") === "false") {
      fireEvent.click(header);
      await flushWrites();
    }
  };

  it("Export CSV downloads the current view — visible columns × all rows, BOM + quoting", async () => {
    const client = await seedClient();
    const seeded = await seedCsvTable(client);
    // A node-backed text value with a comma (PB2 shape) exercises quoting.
    const carrier = await client.createObject({
      parentId: seeded.alpha,
      contentAst: [{ type: "text", text: "needs, quotes" }],
    });
    await client.setProperty(seeded.alpha, seeded.noteId, { nodeId: carrier }, 0);
    const download = stubDownload();
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "More table actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export CSV" }));

    expect(download.anchor?.download).toMatch(/^table-export-\d{12}\.csv$/);
    // The BOM rides the bytes; jsdom's readAsText strips a leading BOM per
    // the encoding spec, so assert the UTF-8 prefix on the raw bytes and
    // decode the remainder.
    const bytes = new Uint8Array(await readBlobBytes(download.blob!));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes.slice(3));
    // Excel BOM + RFC-4180 CRLF records.
    const records = parseCsv(csv);
    // Property columns are ALPHABETICAL by property name (owner ruling
    // 2026-10-21 — binding sequence retired): Note before Status.
    expect(records[0]).toEqual(["Name", "Note", "Status", "Created"]);
    expect(records).toHaveLength(4); // header + 3 members
    // WYSIWYG rows in table order; the comma value round-trips quoted; the
    // locale created date renders non-empty (display-shaped, like the cell).
    expect(records[1]).toEqual(["Alpha", "needs, quotes", "Backlog", records[1]![3]!]);
    expect(records[1]![3]).not.toBe("");
    expect(records[2]!.slice(0, 3)).toEqual(["Beta", "", "Doing"]);
    expect(records[2]![3]).not.toBe("");
    expect(records[3]![0]).toBe("Gamma");
    expect(csv).toContain('"needs, quotes"');
    download.restore();
  });

  it("hidden columns stay out of the CSV (the visible-column contract)", async () => {
    const client = await seedClient();
    const seeded = await seedCsvTable(client);
    const download = stubDownload();
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Created" }));
    fireEvent.click(screen.getByRole("button", { name: "More table actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export CSV" }));

    const records = parseCsv(await readBlobText(download.blob!));
    expect(records[0]).toEqual(["Name", "Note", "Status"]);
    download.restore();
  });

  it("Export selected… opens the modal over just the checked rows; the batch zip honors the id filter", async () => {
    const client = await seedClient();
    const seeded = await seedCsvTable(client);
    const download = stubDownload();
    render(<NodeView client={client} nodeId={seeded.classId} onOpenNode={() => {}} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    // The selection chrome offers the scoped export.
    fireEvent.click(screen.getByRole("button", { name: "Export selected…" }));
    expect(await screen.findByText("Export 2 nodes")).toBeTruthy();

    // The modal's batch path: one markdown zip over exactly the two ids.
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await vi.waitFor(() => expect(download.blob).not.toBeNull());
    expect(download.blob!.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await readBlobBytes(download.blob!)));
    const paths = Object.keys(entries);
    expect(paths.some((path) => path.toLowerCase().startsWith("alpha-") && path.endsWith(".md"))).toBe(true);
    expect(paths.some((path) => path.toLowerCase().startsWith("beta-") && path.endsWith(".md"))).toBe(true);
    expect(paths).not.toContain(`gamma-${"0".repeat(8)}.md`);
    const manifest = JSON.parse(new TextDecoder().decode(entries["notees-manifest.json"]!)) as {
      nodes: Array<{ id: string }>;
    };
    expect(manifest.nodes.map((node) => node.id).sort()).toEqual([seeded.alpha, seeded.beta].sort());
    download.restore();
  });

  /** Read a Blob's bytes in jsdom (whose Blob lacks arrayBuffer()). */
  function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
  }
});

describe("cards board polish: multi-select grouping, collapsible columns", () => {
  it("multi-select schemas make a card ride every column it carries; drops merge", async () => {
    const client = await seedClient();
    // PG6 one-shape-per-type: array values live on multi_select (multi:true
    // keeps the board's multi-membership path keyed off the schema flag).
    const statusId = await client.createPropertySchema({
      name: "Status",
      type: "multi_select",
      multi: true,
      options: [
        { id: "00000000-0000-0000-0005-000000000021", label: "Backlog" },
        { id: "00000000-0000-0000-0005-000000000022", label: "Doing" },
      ],
    });
    const both = await client.createObject({ isEmbedded: false, name: "Both" });
    await client.assignClass(both, SYSTEM_CLASS_UUIDS.task);
    await client.setProperty(both, statusId, ["00000000-0000-0000-0005-000000000021"], 0);
    const other = await client.createObject({ isEmbedded: false, name: "Other" });
    await client.assignClass(other, SYSTEM_CLASS_UUIDS.task);

    // The tasks hub groups by the authored single-select status,
    // so the multi-select dimension is exercised through an explicit board.
    const items = [both, other]
      .map((id) => client.getNode(id)!)
      .map((node) => ({ node }));
    render(
      <CollectionHub
        client={client}
        icon="mdi-format-list-checks"
        title="Tasks"
        items={items}
        modes={["cards"]}
        defaultMode="cards"
        groupByProperty={statusId}
        emptyTitle="No tasks"
        onOpenNode={() => {}}
      />,
    );

    const col = (id: string) => document.querySelector(`.board-column[data-column-id="${id}"]`) as HTMLElement;
    expect(within(col("00000000-0000-0000-0005-000000000021")).getByText("Both")).not.toBeNull();
    expect(within(col("__none__")).getByText("Other")).not.toBeNull();

    // Drop Other onto Backlog (multi merge) — the write the drag handler calls.
    await applyCardGroupDrop(client, other, statusId, "00000000-0000-0000-0005-000000000021", undefined, true);
    await flushWrites();
    const value = client.getEffectiveProperties(other).find((p) => p.propertySchemaId === statusId)?.value;
    expect(value).toEqual(["00000000-0000-0000-0005-000000000021"]);
  });

  it("columns collapse and expand via their header chevron", async () => {
    const client = await seedClient();
    const { schemaId, optionId } = await ensureTaskStatus(client);
    const task = await client.createObject({ isEmbedded: false, name: "Solo" });
    await client.assignClass(task, SYSTEM_CLASS_UUIDS.task);
    await client.setProperty(task, schemaId, optionId("Backlog"), 0);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));

    // The bucket section also lists "Solo"; the collapse
    // assertions scope to the board itself.
    const board = () => document.querySelector(".board") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Collapse column Backlog" }));
    expect(within(board()).queryByText("Solo")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand column Backlog" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand column Backlog" }));
    expect(within(board()).getByText("Solo")).not.toBeNull();
  });
});

describe("card covers and asset thumbnails", () => {
  it("image assets render a thumbnail only under a cover layout; the toggle switches placements", async () => {
    const client = await seedClient();
    const host = await client.createObject({ isEmbedded: false, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "photo.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,AAAA");

    render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);

    // Assets default to cover-top (owner rule): the thumbnail renders in
    // the top placement before any device choice exists.
    const cover = await screen.findByAltText("");
    expect(cover.tagName).toBe("IMG");
    expect(cover.getAttribute("src")).toContain("data:image/png");
    expect(cover.closest(".node-card")!.className).toContain("node-card--cover-top");

    // Switch to no-cover: the layout prop is honored, so the card renders
    // text-only — no cover element at all.
    fireEvent.click(screen.getByRole("radio", { name: "No cover" }));
    expect(document.querySelector(".node-card__cover")).toBeNull();
  });

  it("cards surfaces without a cover default stay no-cover until a choice is made", async () => {
    const client = await seedClient();
    const host = await client.createObject({ isEmbedded: false, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "photo.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,AAAA");

    render(
      <CollectionHub
        client={client}
        icon="mdi-folder-multiple-image"
        title="Loose assets"
        items={client.getClassMembers(SYSTEM_CLASS_UUIDS.asset).map((node) => ({ node }))}
        modes={["cards"]}
        defaultMode="cards"
        onOpenNode={() => {}}
      />,
    );

    // No defaultCoverLayout: the fallback stays the shipped "no-cover" —
    // the cover-top default is the Assets hub's alone.
    expect(document.querySelector(".node-card__cover")).toBeNull();
  });

  it("the flat cards flow: masonry by default, the toggle switches stack / grid / masonry, the choice persists device-locally", async () => {
    const client = await seedClient();
    const host = await client.createObject({ isEmbedded: false, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "photo.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);

    render(
      <CollectionHub
        client={client}
        icon="mdi-folder-multiple-image"
        title="Loose assets"
        items={client.getClassMembers(SYSTEM_CLASS_UUIDS.asset).map((node) => ({ node }))}
        modes={["cards"]}
        defaultMode="cards"
        onOpenNode={() => {}}
      />,
    );

    // No persisted choice: the grid rides the recovered original — masonry.
    expect(document.querySelector(".cards-grid--masonry")).not.toBeNull();
    expect(document.querySelector(".cards-grid--grid")).toBeNull();
    expect(document.querySelector(".cards-grid--stack")).toBeNull();

    // The flow picker switches the arrangement; the write lands on the
    // device-local seam (never an op).
    fireEvent.click(screen.getByRole("radio", { name: "Grid" }));
    expect(document.querySelector(".cards-grid--grid")).not.toBeNull();
    expect(localStorage.getItem("notees.settings.cards.flow")).toBe('"grid"');

    fireEvent.click(screen.getByRole("radio", { name: "Single column" }));
    expect(document.querySelector(".cards-grid--stack")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Masonry" }));
    expect(document.querySelector(".cards-grid--masonry")).not.toBeNull();

    // A stale/hand-edited value falls back to the surface default instead of
    // resurrecting a dead arrangement.
    localStorage.setItem("notees.settings.cards.flow", '"diagonal"');
    window.dispatchEvent(new Event("storage"));
    expect(document.querySelector(".cards-grid--masonry")).not.toBeNull();
  });

  it("the grouped board ignores the flow — its columns are the property groupBy", async () => {
    const client = await seedClient();
    const task = await client.createObject({ isEmbedded: false, name: "Board Task" });
    await client.assignClass(task, SYSTEM_CLASS_UUIDS.task);
    await ensureTaskFamily(client);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    expect(document.querySelector(".board")).not.toBeNull();

    // No flow toggle on the board toolbar (the flat grid's toolbar only).
    expect(screen.queryByRole("radiogroup", { name: "Card layout" })).toBeNull();
    // And the flow class family never reaches the board's column lists.
    expect(document.querySelector(".cards-grid")).toBeNull();
  });
});
