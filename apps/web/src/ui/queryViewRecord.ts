/**
 * The persisted query-token `view` record — the §34.31 V3 formalization
 * (SCHEMA.md "The token view record"). The protocol grammar keeps the record
 * a free-form `z.record(z.unknown())` (foreign keys ride along; newer
 * writers must not break older readers), so this module is the web client's
 * disciplined reader/writer:
 *
 *  - `mode`      — "list" | "table" (list default); anything unknown reads
 *                  back as the list default;
 *  - `title`     — the saved view's display name (ViewTabs); null when unset
 *                  (the tab falls back to "Query N");
 *  - `isDefault` — the section opens on this saved view (V13: the default is
 *                  configuration in the record, not code).
 *
 * Writers merge into the existing record (never replace it) so keys this
 * build does not know survive a round-trip.
 */

export type QueryViewMode = "list" | "table";

export interface QueryViewRecord {
  mode: QueryViewMode;
  title: string | null;
  isDefault: boolean;
}

/** The disciplined read: unknown/absent shapes fall back to the defaults. */
export function parseQueryViewRecord(view: unknown): QueryViewRecord {
  const record = typeof view === "object" && view !== null ? (view as Record<string, unknown>) : {};
  return {
    mode: record.mode === "table" ? "table" : "list",
    title: typeof record.title === "string" && record.title.trim() !== "" ? record.title : null,
    isDefault: record.isDefault === true,
  };
}

/** The display label for a tab/row: the saved title, else the positional fallback. */
export function queryViewTitle(view: unknown, position: number): string {
  return parseQueryViewRecord(view).title ?? `Query ${position + 1}`;
}

/** A copy of the loose record with the patch merged in (foreign keys kept). */
export function mergeQueryViewRecord(view: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const record = typeof view === "object" && view !== null ? (view as Record<string, unknown>) : {};
  const next = { ...record, ...patch };
  // A cleared title removes the key (title: null reads back as unset).
  if (next.title === null || next.title === "") delete next.title;
  if (next.isDefault === false) delete next.isDefault;
  return next;
}
