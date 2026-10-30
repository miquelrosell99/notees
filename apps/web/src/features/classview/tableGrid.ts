/**
 * Table grid — structure writes and layout math. A table is a
 * container node classed `table`; its child blocks are the rows, and each
 * row's child blocks are the cells (tableFamily.ts carries the class seed).
 * These helpers are the only writers of table shape: the /table slash flow
 * (container + first row + cells at the caret), the hover toolbar's
 * + Row / + Column / − Row / − Column gestures, and the renderer's
 * column-template math. All writes are ordinary object.create /
 * object.delete ops — no new wire token.
 */

import { uuidv7 } from "uuidv7";

import type {
  BlockTreeNode,
  ClientWriteOp,
  CreateObjectInput,
} from "@/core/workspace-client/index.js";

/** Minimal write surface: the outliner seam and both full clients satisfy it. */
export interface TableWriteSurface {
  createObject(partial: CreateObjectInput): Promise<string>;
  /**
   * The batch-write primitive: N ops in ONE undo batch, applied in order;
   * anchors may reference ids created earlier in the batch (the helpers
   * below assign the container/row ids so the cell creates can anchor).
   */
  applyOps(ops: ClientWriteOp[], opts?: { verb?: string }): Promise<Array<string | undefined>>;
}

/** The `/table` scaffolding default (a bare `/table` = three columns). */
export const DEFAULT_TABLE_COLUMNS = 3;

const MIN_COLUMNS = 1;
/** Generosity cap on the typed column count ("/table 500" is a typo, not a wish). */
const MAX_COLUMNS = 20;

/**
 * Parse the `/table` typed remainder into a column count: "/table 5" → 5.
 * An empty or unparseable remainder returns null (the caller takes the
 * default) — the boundary rule: the remainder is the command's argument.
 */
export function parseTableColumnCount(remainder: string): number | null {
  const trimmed = remainder.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, parsed));
}

/** The grid's column count: the FIRST ROW's cell count (the directive's template rule), min 1. */
export function tableColumnCount(rows: readonly Pick<BlockTreeNode, "children">[]): number {
  return Math.max(1, rows[0]?.children.length ?? 1);
}

export interface CreatedTable {
  containerId: string;
  rowId: string;
  /** The slash flow hands this to requestFocus — the caret lands in cell one. */
  firstCellId: string;
}

/**
 * Create the table structure under `parentId`: the container (already
 * classed by the caller via ensureTableFamily's id) with one row of
 * `columnCount` empty cells. ONE applyOps batch ("Undo create table") —
 * sibling order is authoring order (creates append at the end); the
 * container/row ids are caller-assigned so the row/cell creates anchor
 * within the batch.
 */
export async function createTable(
  client: TableWriteSurface,
  parentId: string,
  tableClassId: string,
  columnCount: number,
): Promise<CreatedTable> {
  const containerId = uuidv7();
  const rowId = uuidv7();
  const ops: ClientWriteOp[] = [
    { kind: "create", input: { id: containerId, parentId, classIds: [tableClassId] } },
    { kind: "create", input: { id: rowId, parentId: containerId } },
  ];
  for (let i = 0; i < columnCount; i += 1) {
    ops.push({ kind: "create", input: { parentId: rowId } });
  }
  const results = await client.applyOps(ops, { verb: "create table" });
  return { containerId, rowId, firstCellId: results[2] ?? "" };
}

/** + Row: append one row of `columnCount` empty cells to the container (one batch). */
export async function addTableRow(
  client: TableWriteSurface,
  containerId: string,
  columnCount: number,
): Promise<string> {
  const rowId = uuidv7();
  const ops: ClientWriteOp[] = [{ kind: "create", input: { id: rowId, parentId: containerId } }];
  for (let i = 0; i < columnCount; i += 1) {
    ops.push({ kind: "create", input: { parentId: rowId } });
  }
  await client.applyOps(ops, { verb: "add row" });
  return rowId;
}

/** + Column: append one empty cell to every existing row, one batch (rows may be ragged afterward). */
export async function addTableColumn(
  client: TableWriteSurface,
  rows: readonly Pick<BlockTreeNode, "node">[],
): Promise<void> {
  const ops: ClientWriteOp[] = rows.map((row) => ({
    kind: "create",
    input: { parentId: row.node.id },
  }));
  await client.applyOps(ops, { verb: "add column" });
}

/**
 * − Row: delete the row node — its cell children ride the standard
 * object.delete subtree trash (SCHEMA.md deletion semantics), so one delete
 * per row.
 */
export async function deleteTableRow(
  client: TableWriteSurface & { deleteObject(id: string): Promise<void> },
  row: Pick<BlockTreeNode, "node">,
): Promise<void> {
  await client.deleteObject(row.node.id);
}

/**
 * − Column: delete the cell at `columnIndex` from every row (ragged rows
 * skip missing cells), one batch. The right-most column is the toolbar's
 * target.
 */
export async function deleteTableColumn(
  client: TableWriteSurface & { deleteObject(id: string): Promise<void> },
  rows: readonly Pick<BlockTreeNode, "children">[],
  columnIndex: number,
): Promise<void> {
  const ops: ClientWriteOp[] = [];
  for (const row of rows) {
    const cell = row.children[columnIndex];
    if (cell !== undefined) ops.push({ kind: "delete", id: cell.node.id });
  }
  await client.applyOps(ops, { verb: "delete column" });
}

