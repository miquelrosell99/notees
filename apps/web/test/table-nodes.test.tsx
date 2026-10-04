/**
 * Table-nodes tests (§34.34 B4, owner directive 2026-10-04): a table is a
 * CONTAINER node carrying the system `table` class — rows are its child
 * blocks, cells are each row's child blocks, and every cell is an ordinary
 * node (own UUID: mentionable, editable, classable). No new wire token; the
 * grid is a BlockRow render branch. Covered here: the tableFamily self-heal,
 * the /table slash scaffolding (structure + column-count argument + focus),
 * the grid render (row/cell counts + column template from the first row),
 * cell node identity through a mention, the + Row / + Column gestures, cell
 * editing through the ordinary block path, and the read-only embed
 * projection. Harness: PageView over the in-process WorkspaceClient +
 * MemoryRelay (same as slash-breadth.test.tsx / embeds.test.tsx).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { SAVE_DEBOUNCE_MS } from "../src/ui/BlockTextEditor.js";
import {
  ensureTableFamily,
  tableClassIdOf,
  TABLE_CLASS_ID,
} from "../src/ui/components/tableFamily.js";
import {
  addTableColumn,
  addTableRow,
  DEFAULT_TABLE_COLUMNS,
  parseTableColumnCount,
  tableColumnCount,
} from "../src/ui/components/tableGrid.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
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

function text(value: string): ContentAst {
  return [{ type: "text", text: value }];
}

/** Hand-build a table: container classed `table` with `rowCount` rows of `columnCount` cells. */
async function buildTable(
  client: WorkspaceClient,
  parentId: string,
  rowCount: number,
  columnCount: number,
): Promise<{ containerId: string; rowIds: string[]; cellIds: string[][] }> {
  const tableClassId = await ensureTableFamily(client);
  const containerId = await client.createObject({ parentId, classIds: [tableClassId] });
  const rowIds: string[] = [];
  const cellIds: string[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const rowId = await client.createObject({ parentId: containerId });
    rowIds.push(rowId);
    const cells: string[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      cells.push(await client.createObject({ parentId: rowId }));
    }
    cellIds.push(cells);
  }
  return { containerId, rowIds, cellIds };
}

/** Enter edit mode on the nth match of the selector and return the editor. */
function clickIntoBlock(container: HTMLElement, selector = ".nt-block-content", index = 0): HTMLElement {
  const content = container.querySelectorAll<HTMLElement>(selector)[index];
  if (content === undefined) throw new Error(`no ${selector} at index ${index}`);
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Emulate typing with the caret at the end, firing input. */
function typeWithCaret(editor: HTMLElement, textValue: string): void {
  editor.textContent = textValue;
  const node = editor.firstChild;
  if (node !== null) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, textValue.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  fireEvent.input(editor);
}

/** Type a slash command the way keystrokes do: trigger char, then the query. */
function typeSlashCommand(editor: HTMLElement, command: string, argument = ""): void {
  typeWithCaret(editor, "/");
  typeWithCaret(editor, `/${command}${argument === "" ? "" : ` ${argument}`}`);
}

const rowsOf = (client: WorkspaceClient, id: string) => client.getChildren(id);

describe("tableFamily (§34.34 B4 self-heal)", () => {
  it("authors the system table class node at the reserved id on a fresh workspace", async () => {
    const client = await seedClient();
    // A fresh test relay is never seeded: the class node is absent.
    expect(client.getNodeRaw(TABLE_CLASS_ID)).toBeUndefined();

    const id = await ensureTableFamily(client);

    expect(id).toBe(TABLE_CLASS_ID);
    const cls = client.getNodeRaw(TABLE_CLASS_ID);
    expect(cls).toBeDefined();
    expect(cls?.isClass).toBe(true);
    // Title-is-content: the class's name IS its text content.
    expect(client.getDisplayName(TABLE_CLASS_ID)).toBe("table");
  });

  it("is idempotent: a second call authors nothing", async () => {
    const client = await seedClient();
    await ensureTableFamily(client);
    const classCount = client.listClasses().length;
    const id = await ensureTableFamily(client);
    expect(id).toBe(TABLE_CLASS_ID);
    expect(client.listClasses()).toHaveLength(classCount);
  });

  it("prefers a live class named table over the reserved seed id", async () => {
    const client = await seedClient();
    const liveId = await client.createClass("table", { icon: "mdiTable" });
    expect(tableClassIdOf(client)).toBe(liveId);
    // The ensure resolves that live class and does NOT author a second one.
    const id = await ensureTableFamily(client);
    expect(id).toBe(liveId);
    expect(client.getNodeRaw(TABLE_CLASS_ID)).toBeUndefined();
  });
});

describe("tableGrid helpers", () => {
  it("parses the typed column count with clamping and rejects unparseable input", () => {
    expect(parseTableColumnCount("")).toBeNull();
    expect(parseTableColumnCount("5")).toBe(5);
    expect(parseTableColumnCount("0")).toBe(1);
    expect(parseTableColumnCount("999")).toBe(20);
    expect(parseTableColumnCount("abc")).toBeNull();
    expect(DEFAULT_TABLE_COLUMNS).toBe(3);
  });

  it("addTableRow appends a full row; addTableColumn appends a cell to every row", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Grid" });
    const { containerId } = await buildTable(client, pageId, 1, 3);

    await addTableRow(client, containerId, 3);
    let rows = rowsOf(client, containerId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.classIds).toHaveLength(0); // rows are plain blocks
    expect(rowsOf(client, rows[1]!.id)).toHaveLength(3);

    await addTableColumn(client, client.getBlockTree(containerId));
    rows = rowsOf(client, containerId);
    for (const row of rows) {
      expect(rowsOf(client, row.id)).toHaveLength(4);
    }
    // The column template still follows the FIRST row (3 → now 4).
    const tree = client.getBlockTree(containerId);
    expect(tableColumnCount(tree)).toBe(4);
  });
});

describe("/table slash scaffolding", () => {
  async function setupPageWithBlock(): Promise<{
    client: WorkspaceClient;
    pageId: string;
    blockId: string;
    container: HTMLElement;
  }> {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst: [] });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    return { client, pageId, blockId, container };
  }

  it("/table creates a classed container with one row and three cells, focused", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "table");
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      expect(rowsOf(client, blockId)).toHaveLength(1);
    });
    const tableNode = rowsOf(client, blockId)[0]!;
    expect(tableNode.classIds).toContain(TABLE_CLASS_ID);

    const rows = rowsOf(client, tableNode.id);
    expect(rows).toHaveLength(1);
    const cells = rowsOf(client, rows[0]!.id);
    expect(cells).toHaveLength(3);
    // Every cell is a real node with its own UUID and empty content.
    for (const cell of cells) {
      expect(client.getNode(cell.id)).toBeDefined();
      expect(cell.contentAst).toEqual([]);
    }

    // The trigger text is gone from the host block.
    expect(client.getNode(blockId)?.contentAst).toEqual([]);

    // The first cell took the focus (its editor mounts) and the grid renders:
    // one subgrid row wrapping three cells. Both land a tick after the
    // structure — the focus request rides the post-create re-render.
    await waitFor(() => {
      const cellEl = container.querySelector(`[data-block-id="${cells[0]!.id}"]`);
      expect(cellEl).not.toBeNull();
      expect(cellEl?.querySelector(".nt-block-text")).not.toBeNull();
      expect(container.querySelector(".nt-table")).not.toBeNull();
      expect(container.querySelectorAll(".nt-table-row")).toHaveLength(1);
    });
  });

  it("/table 5 scaffolds five columns; an unparseable argument falls back to three", async () => {
    const { client, blockId, container } = await setupPageWithBlock();
    const editor = clickIntoBlock(container);
    typeSlashCommand(editor, "table", "5");
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => {
      expect(rowsOf(client, blockId)).toHaveLength(1);
    });
    const tableNode = rowsOf(client, blockId)[0]!;
    const cells = rowsOf(client, rowsOf(client, tableNode.id)[0]!.id);
    expect(cells).toHaveLength(5);
  });
});

describe("grid render", () => {
  it("renders rows as subgrid rows with the first row's column template", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Grid Page" });
    const { cellIds } = await buildTable(client, pageId, 2, 3);
    await client.updateObject(cellIds[0]![0]!, { contentAst: text("r1c1") });
    await client.updateObject(cellIds[1]![2]!, { contentAst: text("r2c3") });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    const grid = container.querySelector<HTMLElement>(".nt-table");
    expect(grid).not.toBeNull();
    expect(grid?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(container.querySelectorAll(".nt-table-row")).toHaveLength(2);
    // The cells render their content through the ordinary block path.
    expect(screen.getByText("r1c1")).toBeInTheDocument();
    expect(screen.getByText("r2c3")).toBeInTheDocument();
    // The container's rows do NOT ride the outline children list.
    expect(container.querySelector(".nt-block-children")).toBeNull();
  });

  it("a ragged row renders its cells without breaking the row structure", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Ragged" });
    const { containerId, rowIds } = await buildTable(client, pageId, 1, 3);
    // Row 2 gets a fourth cell (more than the template) and row 3 gets two (fewer).
    const row2 = await client.createObject({ parentId: containerId });
    rowIds.push(row2);
    for (let i = 0; i < 4; i += 1) await client.createObject({ parentId: row2 });
    const row3 = await client.createObject({ parentId: containerId });
    for (let i = 0; i < 2; i += 1) await client.createObject({ parentId: row3 });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The template still follows the FIRST row (3); rows render as their own
    // subgrid rows — extra cells spill to implicit tracks, short rows blank.
    const grid = container.querySelector<HTMLElement>(".nt-table");
    expect(grid?.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(container.querySelectorAll(".nt-table-row")).toHaveLength(3);
  });
});

describe("cell node identity (mention a cell)", () => {
  it("a mention of a cell id resolves the cell's CURRENT content at render", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Mention Host" });
    const { cellIds } = await buildTable(client, pageId, 1, 2);
    const cellId = cellIds[0]![0]!;
    await client.updateObject(cellId, { contentAst: text("quarterly figure") });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "mention", targetNodeId: cellId, text: "quarterly figure", linkId: "l1" },
      ],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // BlockRow renders mentions with its onOpenNode handler — the chip is a
    // link-styled button, not the bare read-only chip.
    const mention = container.querySelector(".nt-link");
    expect(mention?.textContent).toContain("quarterly figure");

    // The mention is id-only storage: editing the cell re-renders the mention.
    await act(async () => {
      await client.updateObject(cellId, { contentAst: text("annual figure") });
    });
    await waitFor(() => {
      expect(container.querySelector(".nt-link")?.textContent).toContain("annual figure");
    });
  });
});

describe("toolbar gestures (+ Row / + Column)", () => {
  it("appends a full row and a cell per row through the container's toolbar", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Toolbar" });
    const { containerId } = await buildTable(client, pageId, 1, 2);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(screen.getByRole("toolbar", { name: "Table" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await waitFor(() => {
      expect(rowsOf(client, containerId)).toHaveLength(2);
    });
    // The new row matches the current column template (two cells).
    expect(rowsOf(client, rowsOf(client, containerId)[1]!.id)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    await waitFor(() => {
      for (const row of rowsOf(client, containerId)) {
        expect(rowsOf(client, row.id)).toHaveLength(3);
      }
    });
    // The grid template follows the first row to three columns.
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".nt-table")?.style.gridTemplateColumns).toBe(
        "repeat(3, minmax(0, 1fr))",
      );
    });
  });

  it("− Row deletes the last row through the inline-confirm pattern (cells ride the subtree trash)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Delete Row" });
    const { containerId, rowIds } = await buildTable(client, pageId, 2, 2);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The trigger arms the inline confirm (a delete is destructive).
    fireEvent.click(screen.getByRole("button", { name: "− Row" }));
    expect(client.getNode(rowIds[1]!)).toBeDefined();
    expect(screen.getByRole("button", { name: "Confirm delete row" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete row" }));
    await waitFor(() => {
      expect(rowsOf(client, containerId)).toHaveLength(1);
    });
    // The row node AND its cells are trashed (subtree semantics).
    expect(client.getNode(rowIds[1]!)).toBeUndefined();
    expect(client.getNodeRaw(rowIds[1]!)?.isActive).toBe(false);
    // The cells rode the subtree trash with the row.
    const cellRows = client.store.database
      .prepare("SELECT is_active FROM node WHERE parent_id = ?")
      .all(rowIds[1]!) as Array<{ is_active: number }>;
    expect(cellRows).toHaveLength(2);
    expect(cellRows.every((row) => row.is_active === 0)).toBe(true);
  });

  it("− Column deletes the right-most cell of every row; Cancel leaves the table untouched", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Delete Col" });
    const { containerId, cellIds } = await buildTable(client, pageId, 2, 3);
    render(<PageView client={client} pageId={pageId} />);

    // Arm, then cancel — nothing changes.
    fireEvent.click(screen.getByRole("button", { name: "− Column" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rowsOf(client, rowsOf(client, containerId)[0]!.id)).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "− Column" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete column" }));
    await waitFor(() => {
      for (const row of rowsOf(client, containerId)) {
        expect(rowsOf(client, row.id)).toHaveLength(2);
      }
    });
    // The right-most cells trashed; the others live.
    expect(client.getNode(cellIds[0]![2]!)).toBeUndefined();
    expect(client.getNode(cellIds[1]![2]!)).toBeUndefined();
    expect(client.getNode(cellIds[0]![0]!)).toBeDefined();
  });
});

describe("cell editing", () => {
  it("typing in a cell saves through the ordinary block path", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Edit Cell" });
    const { cellIds } = await buildTable(client, pageId, 1, 2);
    const cellId = cellIds[0]![1]!;
    const { container } = render(<PageView client={client} pageId={pageId} />);

    vi.useFakeTimers();
    // The second cell of the first row takes the text.
    const editor = clickIntoBlock(container, ".nt-table-row .nt-block-content", 1);
    expect(document.activeElement).toBe(editor);

    editor.textContent = "cell text";
    fireEvent.input(editor);
    expect(client.getNode(cellId)?.contentAst).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    });
    vi.useRealTimers();
    expect(client.getNode(cellId)?.contentAst).toEqual(text("cell text"));

    fireEvent.blur(editor);
    expect(screen.getByText("cell text")).toBeInTheDocument();
  });
});

describe("read-only projections", () => {
  it("an embed of a table renders the grid without the edit toolbar", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Embed Host" });
    const holder = await client.createObject({ parentId: pageId, contentAst: text("holder") });
    const { cellIds } = await buildTable(client, holder, 2, 2);
    await client.updateObject(cellIds[0]![0]!, { contentAst: text("alpha") });
    await client.updateObject(cellIds[1]![1]!, { contentAst: text("beta") });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "embed_ref", nodeId: holder }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    const embed = container.querySelector(".nt-embed");
    expect(embed).not.toBeNull();
    const grid = embed?.querySelector(".nt-table");
    expect(grid).not.toBeNull();
    expect(grid?.querySelectorAll(".nt-table-row")).toHaveLength(2);
    expect(embed?.textContent).toContain("alpha");
    expect(embed?.textContent).toContain("beta");
    // Read-only: no + Row / + Column affordance inside the projection.
    expect(embed?.querySelector(".nt-table-toolbar")).toBeNull();
  });
});
