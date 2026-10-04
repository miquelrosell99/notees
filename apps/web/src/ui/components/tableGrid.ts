/**
 * Table grid — §34.34 B4 structure writes and layout math. A table is a
 * container node classed `table`; its child blocks are the rows, and each
 * row's child blocks are the cells (tableFamily.ts carries the class seed).
 * These helpers are the only writers of table shape: the /table slash flow
 * (container + first row + cells at the caret), the hover toolbar's
 * + Row / + Column gestures, and the renderer's column-template math.
 * All writes are ordinary object.create ops — no new wire token.
 */

import type { BlockTreeNode, CreateObjectInput } from "@/core/workspace-client.js";

/** Minimal write surface: the outliner seam and both full clients satisfy it. */
export interface TableWriteSurface {
  createObject(partial: CreateObjectInput): Promise<string>;
}

/** The `/table` scaffolding default (a bare `/table` = three columns). */
export const DEFAULT_TABLE_COLUMNS = 3;

const MIN_COLUMNS = 1;
/** Generosity cap on the typed column count ("/table 500" is a typo, not a wish). */
const MAX_COLUMNS = 20;

/**
 * Parse the `/table` typed remainder into a column count: "/table 5" → 5.
 * An empty or unparseable remainder returns null (the caller takes the
 * default) — the v1 boundary rule: the remainder is the command's argument.
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
 * `columnCount` empty cells. Sequential creates — sibling order is
 * authoring order (createObject appends at the end).
 */
export async function createTable(
  client: TableWriteSurface,
  parentId: string,
  tableClassId: string,
  columnCount: number,
): Promise<CreatedTable> {
  const containerId = await client.createObject({ parentId, classIds: [tableClassId] });
  const rowId = await client.createObject({ parentId: containerId });
  let firstCellId = "";
  for (let i = 0; i < columnCount; i += 1) {
    const cellId = await client.createObject({ parentId: rowId });
    if (i === 0) firstCellId = cellId;
  }
  return { containerId, rowId, firstCellId };
}

/** + Row: append one row of `columnCount` empty cells to the container. */
export async function addTableRow(
  client: TableWriteSurface,
  containerId: string,
  columnCount: number,
): Promise<string> {
  const rowId = await client.createObject({ parentId: containerId });
  for (let i = 0; i < columnCount; i += 1) {
    await client.createObject({ parentId: rowId });
  }
  return rowId;
}

/** + Column: append one empty cell to every existing row (rows may be ragged afterward). */
export async function addTableColumn(
  client: TableWriteSurface,
  rows: readonly Pick<BlockTreeNode, "node">[],
): Promise<void> {
  for (const row of rows) {
    await client.createObject({ parentId: row.node.id });
  }
}
