/**
 * View-modes tests: the registry + switcher, the child-blocks triad
 * (outline/prose/cards) over PageView, the classed-nodes table default,
 * and the Tasks/Assets hub modes. jsdom over the in-process
 * WorkspaceClient + MemoryRelay; view-mode state is session-local, so a
 * fresh render always lands on the surface default.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { HubView } from "../src/ui/App.js";
import { PageView } from "../src/ui/PageView.js";
import { ClassView } from "../src/ui/ClassView.js";
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

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 *  class node's content — seed the title through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createClass(title);
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

/** Page with two root blocks, the first holding a nested child. */
async function seedTreePage(client: WorkspaceClient): Promise<string> {
  const pageId = await client.createObject({ nodeType: "page", name: "Modes" });
  await client.createObject({
    nodeType: "block",
    parentId: pageId,
    contentAst: [{ type: "text", text: "root one" }],
  });
  const parent = await client.createObject({
    nodeType: "block",
    parentId: pageId,
    contentAst: [{ type: "text", text: "root two" }],
  });
  await client.createObject({
    nodeType: "block",
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
    const classId = await createTitledClass(client, "source");
    const member = await client.createObject({ nodeType: "page", name: "A book" });
    await client.assignClass(member, classId);
    render(<ClassView client={client} classId={classId} />);

    fireEvent.click(screen.getByRole("button", { name: /classed nodes/i }));
    await flushWrites();

    const table = screen.getByRole("table");
    const headers = [...table.querySelectorAll("th")].map((th) => th.textContent);
    // Seeded source bindings become columns between Name and Created.
    expect(headers[0]).toBe("Name");
    expect(headers).toContain("authors");
    expect(headers).toContain("isbn");
    expect(headers[headers.length - 1]).toBe("Created");
  });
});

describe("tasks hub", () => {
  it("lists pages AND blocks classed task, table by default, switchable", async () => {
    const client = await seedClient();
    const taskPage = await client.createObject({ nodeType: "page", name: "Write report" });
    await client.assignClass(taskPage, SYSTEM_CLASS_UUIDS.task);
    const host = await client.createObject({ nodeType: "page", name: "Host" });
    const taskBlock = await client.createObject({
      nodeType: "block",
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
    expect(screen.getByRole("button", { name: /Write report/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Call the office/ })).not.toBeNull();
  });

  it("sorts by name ascending and descending via header clicks", async () => {
    const client = await seedClient();
    await client.assignClass(
      await client.createObject({ nodeType: "page", name: "Zulu" }),
      SYSTEM_CLASS_UUIDS.task,
    );
    await client.assignClass(
      await client.createObject({ nodeType: "page", name: "Alpha" }),
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
    const id = await client.createObject({ nodeType: "page", name: title });
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
    const schemaId = await seedStatusSchema(client);
    const inBacklog = await seedTask(client, "Task Backlog");
    const inDone = await seedTask(client, "Task Done");
    const unscheduled = await seedTask(client, "Task Unset");
    await client.setProperty(inBacklog, schemaId, OPTION_A, 0);
    await client.setProperty(inDone, schemaId, OPTION_C, 0);

    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    // The board is offered once a usable select property exists.
    fireEvent.click(screen.getByRole("radio", { name: "Kanban" }));

    // Three option columns + None, counts in the headers.
    for (const label of ["Backlog", "Doing", "Done", "None"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
    expect(within(column(OPTION_A)).getByText("Task Backlog")).not.toBeNull();
    expect(within(column(OPTION_C)).getByText("Task Done")).not.toBeNull();
    expect(within(column("__none__")).getByText("Task Unset")).not.toBeNull();
    // Empty columns still render as drop targets.
    expect(within(column("00000000-0000-0000-0005-000000000002")).getByText("0")).not.toBeNull();

    // The drop write (what the drag handler calls): move the unset task into
    // the Doing column; the client notification re-renders the board.
    await applyKanbanDrop(client, unscheduled, schemaId, "00000000-0000-0000-0005-000000000002", undefined);
    await flushWrites();
    expect(
      within(column("00000000-0000-0000-0005-000000000002")).getByText("Task Unset"),
    ).not.toBeNull();
    expect(within(column("__none__")).queryByText("Task Unset")).toBeNull();

    // Drop on None clears the value again.
    await applyKanbanDrop(client, unscheduled, schemaId, null, 0);
    await flushWrites();
    expect(within(column("__none__")).getByText("Task Unset")).not.toBeNull();
  });

  it("kanban is not offered without a usable select property", async () => {
    const client = await seedClient();
    await seedTask(client, "Lonely Task");
    render(<HubView client={client} nav="tasks" onOpenNode={() => {}} />);

    expect(screen.queryByRole("radio", { name: "Kanban" })).toBeNull();
    // The other modes are unaffected.
    for (const label of ["Outline", "Cards", "Table"]) {
      expect(screen.getByRole("radio", { name: label })).not.toBeNull();
    }
  });

  it("classed nodes offer kanban when a bound select property has options", async () => {
    const client = await seedClient();
    const classId = await createTitledClass(client, "project");
    const schemaId = await seedStatusSchema(client);
    await client.setClassProperty(classId, schemaId, { sequence: 0 });
    const member = await seedTask(client, "Member");
    await client.assignClass(member, classId);

    render(<ClassView client={client} classId={classId} />);
    fireEvent.click(screen.getByRole("button", { name: /classed nodes/i }));
    await flushWrites();

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
    const host = await client.createObject({ nodeType: "page", name: "Attachments" });
    const asset = await client.createObject({
      nodeType: "block",
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
    expect(screen.getByRole("button", { name: /scanned-receipt/ })).not.toBeNull();
  });
});

describe("groupBy: references grouped by containing page", () => {
  /** Target page with one mention from each of two source pages. */
  async function seedReferencedPage(client: WorkspaceClient): Promise<string> {
    const targetId = await client.createObject({ nodeType: "page", name: "Zebra" });
    for (const name of ["Source One", "Source Two"]) {
      const sourceId = await client.createObject({ nodeType: "page", name });
      await client.createObject({
        nodeType: "block",
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
    const targetId = await client.createObject({ nodeType: "page", name: "Zebra" });
    const sourceId = await client.createObject({ nodeType: "page", name: "Double Source" });
    for (const text of ["first", "second"]) {
      await client.createObject({
        nodeType: "block",
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
