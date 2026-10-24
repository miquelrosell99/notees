/**
 * sourcesQuery — the Sources hub's URL-state seam (law 9 — /sources owns
 * its URL from day one): the `?type=<classKey>&q=<search>&sort=<field>:<dir>`
 * query-string's parse/serialize helpers. Pure and unit-tested. The hub
 * parses the location's search on render; the panes consume the parsed
 * state, and the filter/sort gestures (tasks 2–3) push the serialized path.
 */

/**
 * The table's sortable display columns (the sorting itself lands with the
 * items table — the register exists now so the URL grammar is stable).
 */
export const SOURCES_SORT_FIELDS = ["title", "authors", "year", "venue", "citekey"] as const;
export type SourcesSortField = (typeof SOURCES_SORT_FIELDS)[number];
export type SourcesSortDirection = "asc" | "desc";

export interface SourcesSort {
  field: SourcesSortField;
  direction: SourcesSortDirection;
}

export interface SourcesQueryState {
  /** The picked source-type class key (journal_article, …); null = every type. */
  type: string | null;
  /** The search string (title/authors/citekey); "" = none. */
  q: string;
  /** The sort; null = the table's default order. */
  sort: SourcesSort | null;
}

export const DEFAULT_SOURCES_QUERY: SourcesQueryState = { type: null, q: "", sort: null };

const SORT_PATTERN = /^([a-z][a-z0-9_]*):(asc|desc)$/;

/** Parse one `sort=<field>:<dir>` value; invalid sorts are rejected outright. */
export function parseSourcesSort(value: string | null | undefined): SourcesSort | null {
  if (value === null || value === undefined || value === "") return null;
  const match = SORT_PATTERN.exec(value);
  if (match === null) return null;
  const field = match[1]!;
  if (!(SOURCES_SORT_FIELDS as readonly string[]).includes(field)) return null;
  return { field: field as SourcesSortField, direction: match[2] as SourcesSortDirection };
}

/**
 * Parse a query string — a location search (with or without the leading ?)
 * or a full path (the "?" and everything after is the query).
 */
export function parseSourcesQuery(search: string): SourcesQueryState {
  const queryAt = search.indexOf("?");
  const params = new URLSearchParams(queryAt === -1 ? search : search.slice(queryAt + 1));
  const type = params.get("type");
  return {
    type: type !== null && type !== "" ? type : null,
    q: params.get("q") ?? "",
    sort: parseSourcesSort(params.get("sort")),
  };
}

/**
 * Serialize the state back to its path (the bare "/sources" when unset).
 * The sort rides `<field>:<dir>` with a literal colon — deep links stay
 * readable in the URL bar (law 9); the parser accepts the encoded form too.
 */
export function sourcesPathFor(state: SourcesQueryState): string {
  // URLSearchParams' form encoding (spaces as "+"), matching a pasted query.
  const encode = (value: string): string => encodeURIComponent(value).replace(/%20/g, "+");
  const parts: string[] = [];
  if (state.type !== null && state.type !== "") parts.push(`type=${encode(state.type)}`);
  if (state.q !== "") parts.push(`q=${encode(state.q)}`);
  if (state.sort !== null) {
    parts.push(`sort=${state.sort.field}:${state.sort.direction}`);
  }
  return parts.length === 0 ? "/sources" : `/sources?${parts.join("&")}`;
}
