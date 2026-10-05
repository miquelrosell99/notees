/**
 * View-modes tests: the registry + switcher, the child-blocks triad
 * (outline/prose/cards) over PageView, the classed-nodes table default,
 * and the Tasks/Assets hub modes. jsdom over the in-process
 * WorkspaceClient + MemoryRelay; view-mode state persists device-locally
 * (§34.27 L1), and the global afterEach clears localStorage — so a fresh
 * render still lands on the surface default here.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { unzipSync } from "fflate";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { HubView } from "../src/ui/App.js";
import { PageView } from "../src/ui/PageView.js";
import { ClassView } from "../src/ui/ClassView.js";
import { CollectionHub } from "../src/ui/components/CollectionHub.js";
import { ensureTaskFamily } from "../src/ui/components/taskFamily.js";
import { getViewDefinition, getViewModeOptions } from "../src/ui/views/index.js";
import { applyKanbanDrop } from "../src/ui/views/KanbanView.js";

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

/**
 * The tasks hub authors the task family on open (§34.28 #2), so its kanban
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
  const pageId = await client.createObject({ presentAsMain: true, name: "Modes" });
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
    expect(screen.getByText("root one")).not.toBeNull();
    expect(screen.getByText("nested under two")).not.toBeNull();
    // The switcher offers the triad.
    for (const label of ["Outline", "Prose", "Cards"]) {
      expect(screen.getByRole("radio", { name: label })).not.toBeNull();
    }
  });

  it("prose mode flattens the same tree via the nt-prose transform", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    fireEvent.click(screen.getByRole("radio", { name: "Prose" }));

    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(tree.classList.contains("nt-prose")).toBe(true);
    // Same rows, same content — a display transform only.
    expect(screen.getByText("root one")).not.toBeNull();
    expect(screen.getByText("nested under two")).not.toBeNull();
  });

  it("cards mode renders first-level blocks as cards with their children inside", async () => {
    const client = await seedClient();
    const pageId = await seedTreePage(client);
    render(<PageView client={client} pageId={pageId} />);

    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));

    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(2);
    // Card 1: the childless root. Card 2: title + the nested child inside.
    expect(within(cards[0]!).getByText("root one")).not.toBeNull();
    expect(within(cards[1]!).getByText("root two")).not.toBeNull();
    expect(within(cards[1]!).getByText("nested under two")).not.toBeNull();
  });
});

describe("classed-nodes table", () => {
  it("defaults to table with a column per bound property", async () => {
    const client = await seedClient();
    // The reserved system id: the seed-spec fallback synthesizes the source
    // family's columns with the manifest's normal-wording names.
    const classId = await createTitledClass(client, "Source", SYSTEM_CLASS_UUIDS.source);
    const member = await client.createObject({ presentAsMain: true, name: "A book" });
    await client.assignClass(member, classId);
    render(<ClassView client={client} classId={classId} />);

    // The section defaults to expanded (§34.44); only click when collapsed.
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

describe("tasks hub", () => {
  it("lists pages AND blocks classed task, table by default, switchable", async () => {
    const client = await seedClient();
    // The hub authors the task family on open (§34.28 #2) — ensure up front
    // so no write is in flight when the test teardown closes the client.
    await ensureTaskFamily(client);
    const taskPage = await client.createObject({ presentAsMain: true, name: "Write report" });
    await client.assignClass(taskPage, SYSTEM_CLASS_UUIDS.task);
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const taskBlock = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "Call the office" }],
    });
    await client.assignClass(taskBlock, SYSTEM_CLASS_UUIDS.task);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    // Table default; both node types listed by their derived titles.
    const table = screen.getByRole("table");
    expect(within(table).getByRole("button", { name: "Write report" })).not.toBeNull();
    expect(within(table).getByRole("button", { name: "Call the office" })).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
    const cards = screen.getAllByRole("article");
    expect(cards.length).toBe(2);

    fireEvent.click(screen.getByRole("radio", { name: "Outline" }));
    // §34.28 #5 — the bucket section above the collection lists the same
    // tasks; scope the outline assertions to the hub collection itself.
    const hub = within(document.querySelector(".nt-hub") as HTMLElement);
    expect(hub.getByRole("button", { name: /Write report/ })).not.toBeNull();
    expect(hub.getByRole("button", { name: /Call the office/ })).not.toBeNull();
  });

  it("sorts by name ascending and descending via header clicks", async () => {
    const client = await seedClient();
    await ensureTaskFamily(client);
    await client.assignClass(
      await client.createObject({ presentAsMain: true, name: "Zulu" }),
      SYSTEM_CLASS_UUIDS.task,
    );
    await client.assignClass(
      await client.createObject({ presentAsMain: true, name: "Alpha" }),
      SYSTEM_CLASS_UUIDS.task,
    );
    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    const nameSort = screen.getByRole("button", { name: /^Name/ });
    const rowNames = () =>
      [...screen.getByRole("table").querySelectorAll(".nt-table-name-label")].map(
        (el) => el.textContent,
      );

    fireEvent.click(nameSort); // asc
    expect(rowNames()).toEqual(["Alpha", "Zulu"]);
    fireEvent.click(nameSort); // desc
    expect(rowNames()).toEqual(["Zulu", "Alpha"]);
  });
});

describe("kanban board (property-dimension groupBy)", () => {
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
    const id = await client.createObject({ presentAsMain: true, name: title });
    await client.assignClass(id, SYSTEM_CLASS_UUIDS.task);
    return id;
  }

  function column(id: string): HTMLElement {
    const el = document.querySelector(`.kanban-column[data-column-id="${id}"]`);
    if (el === null) throw new Error(`no column ${id}`);
    return el as HTMLElement;
  }

  it("groups cards into option columns plus a None column, and the drop writes the property", async () => {
    const client = await seedClient();
    // The board's dimension is the authored task status schema (fixed seed
    // id — the hub's kanban preference), not a workspace-local one.
    const { schemaId, optionId } = await ensureTaskStatus(client);
    const inBacklog = await seedTask(client, "Task Backlog");
    const inDone = await seedTask(client, "Task Done");
    const unscheduled = await seedTask(client, "Task Unset");
    await client.setProperty(inBacklog, schemaId, optionId("Backlog"), 0);
    await client.setProperty(inDone, schemaId, optionId("Done"), 0);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    fireEvent.click(screen.getByRole("radio", { name: "Kanban" }));

    // Status option columns + None, counts in the headers.
    const titles = () =>
      [...document.querySelectorAll(".kanban-column__title")].map((el) => el.textContent);
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
    await applyKanbanDrop(client, unscheduled, schemaId, optionId("Doing"), undefined);
    await flushWrites();
    expect(within(column(optionId("Doing"))).getByText("Task Unset")).not.toBeNull();
    expect(within(column("__none__")).queryByText("Task Unset")).toBeNull();

    // Drop on None clears the value again.
    await applyKanbanDrop(client, unscheduled, schemaId, null, 0);
    await flushWrites();
    expect(within(column("__none__")).getByText("Task Unset")).not.toBeNull();
  });

  it("kanban rides the authored task family; hubs without a grouping select offer no kanban", async () => {
    const client = await seedClient();
    await seedTask(client, "Lonely Task");
    // §34.28 #2: the hub authors the task family on open, so the status
    // schema (a usable select) always exists and kanban is always offered.
    await ensureTaskFamily(client);
    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    expect(screen.getByRole("radio", { name: "Kanban" })).not.toBeNull();
    // The other modes are unaffected.
    for (const label of ["Outline", "Cards", "Table"]) {
      expect(screen.getByRole("radio", { name: label })).not.toBeNull();
    }

    // A hub whose members carry no usable select property never offers it.
    const assets = render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);
    expect(within(assets.container).queryByRole("radio", { name: "Kanban" })).toBeNull();
  });

  it("classed nodes offer kanban when a bound select property has options", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "project");
    const schemaId = await seedStatusSchema(client);
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const member = await seedTask(client, "Member");
    await client.assignClass(member, classId);

    render(<ClassView client={client} classId={classId} />);
    // The section defaults to expanded (§34.44); only click when collapsed.
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }

    // The section default stays table; kanban rides the switcher.
    expect(screen.getByRole("table")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Kanban" }));
    expect(screen.getByText("Backlog")).not.toBeNull();
    expect(within(column("__none__")).getByText("Member")).not.toBeNull();
  });
});

describe("assets hub", () => {
  it("defaults to cards and switches to table", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Attachments" });
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
  it("lists top-level pages only — subpages stay in their parent's zone", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Top Level" });
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    await client.createObject({ parentId, presentAsMain: true, name: "Subpage" });

    render(<HubView client={client} nav="pages" onOpenNode={() => {}} />);

    expect(screen.getByText("Top Level")).not.toBeNull();
    expect(screen.getByText("Parent")).not.toBeNull();
    expect(screen.queryByText("Subpage")).toBeNull();
  });
});

describe("groupBy: references grouped by containing page", () => {
  /** Target page with one mention from each of two source pages. */
  async function seedReferencedPage(client: WorkspaceClient): Promise<string> {
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    for (const name of ["Source One", "Source Two"]) {
      const sourceId = await client.createObject({ presentAsMain: true, name });
      await client.createObject({
        parentId: sourceId,
        contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
      });
    }
    return targetId;
  }

  function expandLinkedReferences(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: /Linked references/ }));
    return screen.getByRole("button", { name: /Linked references/ }).closest("section") as HTMLElement;
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
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    // Source One carries its own authored icon.
    const sourceOne = await client.createObject({ presentAsMain: true, name: "Source One" });
    await client.updateObject(sourceOne, { icon: "mdi-star" });
    await client.createObject({
      parentId: sourceOne,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
    });
    // Source Two inherits its icon through the class-extends chain (the
    // daily-page shape: no own icon, the glyph arrives via its class).
    const glyphParent = await client.createClass("Glyph Parent", { icon: "mdi-heart" });
    const glyphChild = await client.createClass("Glyph Child");
    await client.setClassExtends(glyphChild, [glyphParent]);
    const sourceTwo = await client.createObject({ presentAsMain: true, name: "Source Two" });
    await client.assignClass(sourceTwo, glyphChild);
    await client.createObject({
      parentId: sourceTwo,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Zebra" }],
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
    const targetId = await client.createObject({ presentAsMain: true, name: "Zebra" });
    const sourceId = await client.createObject({ presentAsMain: true, name: "Double Source" });
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
    const dueId = await client.createPropertySchema({ name: "Due", type: "date" });
    const ownerId = await client.createPropertySchema({ name: "Owner", type: "object" });
    for (const [schema, sequence] of [
      [statusId, 0],
      [noteId, 1],
      [effortId, 2],
      [dueId, 3],
      [ownerId, 4],
    ] as const) {
      await client.setClassProperty(classId, schema, { sequence });
    }
    const alpha = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const beta = await client.createObject({ presentAsMain: true, name: "Beta" });
    const gamma = await client.createObject({ presentAsMain: true, name: "Gamma" });
    for (const id of [alpha, beta, gamma]) await client.assignClass(id, classId);
    await client.setProperty(alpha, statusId, OPT_BACKLOG, 0);
    await client.setProperty(beta, statusId, OPT_DOING, 0);
    return { classId, statusId, noteId, effortId, dueId, ownerId, alpha, beta, gamma };
  }

  const expandClassedNodes = async (): Promise<void> => {
    // The section defaults to expanded (§34.44); only click when collapsed.
    const classedNodesHeader = screen.getByRole("button", { name: /classed nodes/i });
    if (classedNodesHeader.getAttribute("aria-expanded") === "false") {
      fireEvent.click(classedNodesHeader);
      await flushWrites();
    }
  };

  const rowNames = (): Array<string | undefined> =>
    [...screen.getByRole("table").querySelectorAll(".nt-table-name-label")].map((el) => el.textContent ?? undefined);

  it("sort panel composes multi-column sorts and the header keeps quick-sort", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Status" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Name" }));
    // Status asc: Backlog (Alpha), Doing (Beta); empty sinks last (Gamma).
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);

    // Toggle Status to desc: Doing first.
    fireEvent.click(screen.getByRole("button", { name: "Status: ascending — toggle" }));
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma"]);

    // Remove the Status entry: single Name sort remains.
    fireEvent.click(screen.getByRole("button", { name: "Remove Status sort" }));
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("column selector hides defaults and adds property columns", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    await client.createPropertySchema({ name: "Pages", type: "text" });
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    const headers = () => [...screen.getByRole("table").querySelectorAll("th")].map((th) => th.textContent ?? "");

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Created" }));
    expect(headers()).not.toContain("Created");

    fireEvent.click(screen.getByRole("checkbox", { name: "Pages" }));
    expect(headers()).toContain("Pages");
  });

  it("inline text editing writes a node-backed carrier; numbers commit as scalars; empty unsets", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    // Text cells are node-backed (PB2 one-shape-per-type): the commit
    // creates a carrier block child and links {nodeId}; the carrier's
    // content holds the text.
    const noteInput = screen.getAllByRole("textbox", { name: "Note" })[0]!;
    fireEvent.change(noteInput, { target: { value: "hello world" } });
    fireEvent.blur(noteInput);
    await flushWrites();
    const note = client.getEffectiveProperties(seeded.alpha).find((p) => p.propertySchemaId === seeded.noteId);
    const carrierId = (note?.value as { nodeId?: string }).nodeId;
    expect(typeof carrierId).toBe("string");
    const carrier = client.getNode(carrierId!);
    expect(carrier?.parentId).toBe(seeded.alpha);
    expect(carrier?.contentAst).toEqual([{ type: "text", text: "hello world" }]);

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
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    // §34.32 PG17: the cell rides the shared DateSlotControl — clicking opens
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
    const paris = await client.createObject({ presentAsMain: true, name: "Paris" });
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    // [0] is the column header sort button; [1] is Alpha's cell.
    fireEvent.click(screen.getAllByRole("button", { name: "Owner" })[1]!);
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Paris" } });
    await flushWrites();
    fireEvent.click(document.querySelector(".node-result-item:not(.node-result-item--create):not(.node-result-item--date)")!);

    const owner = client.getEffectiveProperties(seeded.alpha).find((p) => p.propertySchemaId === seeded.ownerId);
    expect(owner?.value).toEqual({ nodeId: paris });
  });

  it("row checkboxes select rows; the header box selects the visible window", async () => {
    const client = await seedClient();
    const seeded = await seedProjectTable(client);
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(3);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    expect(document.querySelectorAll(".nt-table-row--selected").length).toBe(0);
  });
});

describe("table export: CSV view export + selection-scoped export (§34.59)", () => {
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
    for (const [schema, sequence] of [
      [statusId, 0],
      [noteId, 1],
    ] as const) {
      await client.setClassProperty(classId, schema, { sequence });
    }
    const alpha = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const beta = await client.createObject({ presentAsMain: true, name: "Beta" });
    const gamma = await client.createObject({ presentAsMain: true, name: "Gamma" });
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
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(download.anchor?.download).toBe("table-export.csv");
    // The BOM rides the bytes; jsdom's readAsText strips a leading BOM per
    // the encoding spec, so assert the UTF-8 prefix on the raw bytes and
    // decode the remainder.
    const bytes = new Uint8Array(await readBlobBytes(download.blob!));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes.slice(3));
    // Excel BOM + RFC-4180 CRLF records.
    const records = parseCsv(csv);
    expect(records[0]).toEqual(["Name", "Status", "Note", "Created"]);
    expect(records).toHaveLength(4); // header + 3 members
    // WYSIWYG rows in table order; the comma value round-trips quoted; the
    // locale created date renders non-empty (display-shaped, like the cell).
    expect(records[1]).toEqual(["Alpha", "Backlog", "needs, quotes", records[1]![3]!]);
    expect(records[1]![3]).not.toBe("");
    expect(records[2]!.slice(0, 3)).toEqual(["Beta", "Doing", ""]);
    expect(records[2]![3]).not.toBe("");
    expect(records[3]![0]).toBe("Gamma");
    expect(csv).toContain('"needs, quotes"');
    download.restore();
  });

  it("hidden columns stay out of the CSV (the visible-column contract)", async () => {
    const client = await seedClient();
    const seeded = await seedCsvTable(client);
    const download = stubDownload();
    render(<ClassView client={client} classId={seeded.classId} />);
    await expandClassedNodes();

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Created" }));
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    const records = parseCsv(await readBlobText(download.blob!));
    expect(records[0]).toEqual(["Name", "Status", "Note"]);
    download.restore();
  });

  it("Export selected… opens the modal over just the checked rows; the batch zip honors the id filter", async () => {
    const client = await seedClient();
    const seeded = await seedCsvTable(client);
    const download = stubDownload();
    render(<ClassView client={client} classId={seeded.classId} />);
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

describe("kanban polish: multi-select grouping, collapsible columns", () => {
  it("multi-select schemas make a card ride every column it carries; drops merge", async () => {
    const client = await seedClient();
    // PG6 one-shape-per-type: array values live on multi_select (multi:true
    // keeps KanbanView's multi-membership path keyed off the schema flag).
    const statusId = await client.createPropertySchema({
      name: "Status",
      type: "multi_select",
      multi: true,
      options: [
        { id: "00000000-0000-0000-0005-000000000021", label: "Backlog" },
        { id: "00000000-0000-0000-0005-000000000022", label: "Doing" },
      ],
    });
    const both = await client.createObject({ presentAsMain: true, name: "Both" });
    await client.assignClass(both, SYSTEM_CLASS_UUIDS.task);
    await client.setProperty(both, statusId, ["00000000-0000-0000-0005-000000000021"], 0);
    const other = await client.createObject({ presentAsMain: true, name: "Other" });
    await client.assignClass(other, SYSTEM_CLASS_UUIDS.task);

    // The tasks hub groups by the authored single-select status (§34.28 #2),
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
        modes={["kanban"]}
        defaultMode="kanban"
        kanbanProperty={statusId}
        emptyTitle="No tasks"
        onOpenNode={() => {}}
      />,
    );

    const col = (id: string) => document.querySelector(`.kanban-column[data-column-id="${id}"]`) as HTMLElement;
    expect(within(col("00000000-0000-0000-0005-000000000021")).getByText("Both")).not.toBeNull();
    expect(within(col("__none__")).getByText("Other")).not.toBeNull();

    // Drop Other onto Backlog (multi merge) — the write the drag handler calls.
    await applyKanbanDrop(client, other, statusId, "00000000-0000-0000-0005-000000000021", undefined, true);
    await flushWrites();
    const value = client.getEffectiveProperties(other).find((p) => p.propertySchemaId === statusId)?.value;
    expect(value).toEqual(["00000000-0000-0000-0005-000000000021"]);
  });

  it("columns collapse and expand via their header chevron", async () => {
    const client = await seedClient();
    const { schemaId, optionId } = await ensureTaskStatus(client);
    const task = await client.createObject({ presentAsMain: true, name: "Solo" });
    await client.assignClass(task, SYSTEM_CLASS_UUIDS.task);
    await client.setProperty(task, schemaId, optionId("Backlog"), 0);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Kanban" }));

    // §34.28 #5 — the bucket section also lists "Solo"; the collapse
    // assertions scope to the board itself.
    const board = () => document.querySelector(".kanban-board") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Collapse column Backlog" }));
    expect(within(board()).queryByText("Solo")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand column Backlog" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand column Backlog" }));
    expect(within(board()).getByText("Solo")).not.toBeNull();
  });
});

describe("card covers and asset thumbnails", () => {
  it("image assets render a thumbnail; the layout toggle switches placements", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Attachments" });
    const asset = await client.createObject({
      parentId: host,
      contentAst: [{ type: "text", text: "photo.png" }],
    });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,AAAA");

    render(<HubView client={client} nav="assets" onOpenNode={() => {}} />);

    const cover = await screen.findByAltText("");
    expect(cover.tagName).toBe("IMG");
    expect(cover.getAttribute("src")).toContain("data:image/png");

    // Default layout is no-cover; switch to cover-top.
    expect(cover.closest(".node-card")!.className).toContain("node-card--no-cover");
    fireEvent.click(screen.getByRole("radio", { name: "Cover top" }));
    expect(cover.closest(".node-card")!.className).toContain("node-card--cover-top");
  });
});
