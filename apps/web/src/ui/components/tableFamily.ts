/**
 * Table family — §34.34 B4 (owner directive 2026-10-04): a table is a
 * CONTAINER node carrying the system `table` class — the whiteboard pattern
 * (the class says what-it-is; the grid render is a projection). Rows are the
 * container's child blocks, cells are each row's child blocks, and every
 * cell is an ordinary node: mentionable, classable, property-carrying,
 * zoomable via its bullet. No new wire token — the structure is pure
 * parent/child tree, so linking to a cell rides the existing mention
 * machinery.
 *
 * The `table` UUID is reserved vocabulary in @notees/domain seeds; the class
 * NODE rides the server seed like the other system classes. Workspaces that
 * never got the seed (offline-first devices) self-heal the class node here
 * at the reserved id — the ensureTaskFamily precedent. The helpers type
 * against minimal structural surfaces so both the full clients (Workspace/
 * Worker) and the outliner context seam satisfy them.
 */

import { plainTextExcerpt, SYSTEM_CLASS_ICONS, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

/** Reserved system class id (the domain seed's fixed vocabulary). */
export const TABLE_CLASS_ID = SYSTEM_CLASS_UUIDS.table;

/**
 * The minimal surface the family ensure composes: class listing + raw node
 * read + class creation. Satisfied by WorkspaceClient, WorkerClient, and
 * the OutlinerContext seam (the slash-command flow passes the latter).
 */
export interface TableFamilySurface {
  listClasses(): ClientNode[];
  getNodeRaw(id: string): ClientNode | undefined;
  createClass(name: string, opts?: { icon?: string; color?: string; id?: string }): Promise<string>;
}

/**
 * The class id that means "table": a live class whose TITLE is "table" wins
 * (a migrated workspace may carry its own table class), else the reserved
 * seed id. Title-is-content: the title is the class's text content —
 * `node.name` is a vestigial always-NULL column in the derived store, so the
 * lookup derives the name from content (the checkbox command's `cls.name`
 * check can never match and always falls back — not replicated here).
 */
export function tableClassIdOf(client: Pick<TableFamilySurface, "listClasses">): string {
  const live = client
    .listClasses()
    .find((cls) => plainTextExcerpt(cls.contentAst) === "table");
  return live?.id ?? TABLE_CLASS_ID;
}

/**
 * Author the system `table` class node when missing (idempotent no-op once
 * present — safe to call on every /table). Returns the resolved class id to
 * assign at container creation.
 */
export async function ensureTableFamily(client: TableFamilySurface): Promise<string> {
  const id = tableClassIdOf(client);
  if (client.getNodeRaw(id) === undefined) {
    await client.createClass("table", { id, icon: SYSTEM_CLASS_ICONS.table });
  }
  return id;
}
