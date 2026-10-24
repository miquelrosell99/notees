/**
 * sourcesQuery — the Sources hub's URL-state seam (law 9 — /sources owns
 * its URL from day one) AND its data layer:
 *
 *  - The `?type=<classKey>&q=<search>&sort=<field>:<dir>` query-string's
 *    parse/serialize helpers (pure, unit-tested).
 *  - `buildSourcesAst` — the hub's QueryAST over the source family: the
 *    closure-aware `class` condition on the picked type (a user class
 *    extending the type answers the pick) plus the content/title text
 *    condition for q.
 *  - `runSourcesQuery` — the display projection (the items-table rows):
 *    title, the primary classKey pick, authors per the SHIPPED read
 *    contract, the class's container binding as venue, the publicationDate
 *    chain year, citekey, the attachment count.
 *  - `facetCounts` — ONE grouped read over the live source family, counted
 *    per roster type (extends-aware), with the archived flag off the class
 *    row's active bit.
 *
 * The q filter is deliberately applied CLIENT-SIDE over the loaded set
 * (fine at library scale): the linkedAuthors fallback half
 * of the authors read contract derives names from agent nodes behind
 * {nodeId} refs, which no store-level condition can express, so the AST's
 * content condition is a title-only narrow for AST consumers; the row
 * producer applies the full title/authorsText/citekey filter itself.
 */

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  deriveDisplayName,
  type SystemClassName,
} from "@notees/domain";
import type { QueryAst } from "@notees/query";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import type { ClientNode, EffectiveProperty } from "../../core/workspace-client/index.js";

/**
 * The table's sortable display columns (the URL grammar's five fields; the
 * items table's sortable custom columns carry the same ids).
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

// --- the data layer -------------------------------------------------------------------

/**
 * The structural read surface the data layer composes from — both client
 * classes (the in-process WorkspaceClient and the OPFS WorkerClient)
 * satisfy it (the ExportReadSurface precedent).
 */
export interface SourcesReadSurface {
  runQueryAst(rawAst: unknown): { ids: string[] } | Promise<{ ids: string[] }>;
  getNode(id: string): ClientNode | undefined;
  getNodeRaw(id: string): { isActive: boolean } | undefined;
  getEffectiveProperties(id: string): EffectiveProperty[];
  getClassParents(classId: string): string[];
  getClassMembers(classId: string): ClientNode[];
  getDisplayName(id: string): string | null;
}

/** The 39 source type-classes in the SYSTEM roster order (the pinned
 *  SYSTEM_SOURCE_CLASS_BINDINGS key order — the tiebreak register). */
const SOURCE_TYPE_ROSTER = Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS) as SystemClassName[];

const ROSTER_INDEX = new Map<SystemClassName, number>(
  SOURCE_TYPE_ROSTER.map((name, index) => [name, index]),
);

const ROSTER_ID_TO_KEY = new Map<string, SystemClassName>(
  SOURCE_TYPE_ROSTER.map((name) => [SYSTEM_CLASS_UUIDS[name], name]),
);

/** The class's container binding, candidate-ordered: the
 *  FIRST binding of this list the class carries names its venue field. */
const VENUE_CANDIDATES: readonly (keyof typeof SYSTEM_PROPERTY_UUIDS)[] = [
  "publicationTitle",
  "bookTitle",
  "proceedingsTitle",
  "websiteTitle",
  "blogTitle",
  "forumTitle",
  "programTitle",
  "seriesTitle",
];

/** A class row's liveness — the SAME active bit the gallery and the
 *  settings section read (an absent class row reads archived, the
 *  settings-section precedent). */
function classIsActive(client: SourcesReadSurface, name: SystemClassName): boolean {
  return client.getNodeRaw(SYSTEM_CLASS_UUIDS[name])?.isActive === true;
}

/**
 * The roster types a node's class set answers to — the classes it carries
 * directly PLUS every roster class among their extends-ancestors (a user
 * class extending journal_article counts as a journal article). The
 * extends walk is memoized per client call.
 */
function rosterHitsOf(
  client: SourcesReadSurface,
  classIds: readonly string[],
  ancestorCache: Map<string, string[]>,
): SystemClassName[] {
  const hits = new Set<SystemClassName>();
  const ancestorsOf = (classId: string): string[] => {
    const cached = ancestorCache.get(classId);
    if (cached !== undefined) return cached;
    const seen = new Set<string>([classId]);
    const result: string[] = [];
    const walk = (id: string): void => {
      for (const parent of client.getClassParents(id)) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        result.push(parent);
        walk(parent);
      }
    };
    walk(classId);
    ancestorCache.set(classId, result);
    return result;
  };
  for (const classId of classIds) {
    const direct = ROSTER_ID_TO_KEY.get(classId);
    if (direct !== undefined) hits.add(direct);
    for (const ancestor of ancestorsOf(classId)) {
      const hit = ROSTER_ID_TO_KEY.get(ancestor);
      if (hit !== undefined) hits.add(hit);
    }
  }
  return [...hits];
}

/**
 * The display projection's primary type pick: the enabled-
 * most-specific roster class on the node — archived classes lose to
 * enabled ones, ties break by the SYSTEM roster order. A source node with
 * NO roster class in its closure (a bare user subclass of `source`)
 * degrades to the `source` base.
 */
function primaryClassKey(
  client: SourcesReadSurface,
  node: ClientNode,
  ancestorCache: Map<string, string[]>,
): SystemClassName {
  const hits = rosterHitsOf(client, node.classIds, ancestorCache);
  if (hits.length === 0) return "source";
  hits.sort((a, b) => {
    const archivedDelta = Number(classIsActive(client, a)) - Number(classIsActive(client, b));
    if (archivedDelta !== 0) return -archivedDelta; // enabled first
    return ROSTER_INDEX.get(a)! - ROSTER_INDEX.get(b)!;
  });
  return hits[0]!;
}

/**
 * The primary type pick for ONE node — the same enabled-most-specific roster
 * rule the table's rows carry (the detail pane's type chip reads it, so the
 * chip and the row always agree).
 */
export function sourceTypeKey(
  client: SourcesReadSurface,
  node: ClientNode,
): SystemClassName {
  return primaryClassKey(client, node, new Map());
}

// --- buildSourcesAst ------------------------------------------------------------------

export interface SourcesFilters {
  /** The picked source-type class key; null/absent = every type. */
  classKey?: string | null | undefined;
  /**
   * The search string. At the AST level this is a TITLE-ONLY content
   * narrow — the full title/authorsText/citekey contract needs the
   * linkedAuthors derivation and is applied client-side by
   * {@link runSourcesQuery} (see the module header).
   */
  q?: string;
}

/**
 * Build the hub's QueryAST: the closure-aware `class` condition on the
 * source family (or the picked type) — the same condition shape the
 * collection hub's leaf reads run through — plus the content/title
 * condition when q is set. A stale/unknown type key degrades to the
 * source base rather than pinning an empty table.
 */
export function buildSourcesAst(filters: SourcesFilters): QueryAst {
  const key = filters.classKey ?? null;
  const picked =
    key !== null && (SOURCE_TYPE_ROSTER as readonly string[]).includes(key)
      ? (key as SystemClassName)
      : null;
  // A stale/unknown type key degrades to the source base rather than
  // pinning an empty table.
  const classId = picked !== null ? SYSTEM_CLASS_UUIDS[picked] : SYSTEM_CLASS_UUIDS.source;
  const children: QueryAst["root"]["children"] = [{ type: "class", classId }];
  const q = (filters.q ?? "").trim();
  if (q !== "") children.push({ type: "content", op: "contains", value: q });
  return {
    version: 1,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

// --- the display projection -------------------------------------------------------------

/** The items-table row — the shape tasks 3–4 consume. */
export interface SourceRow {
  id: string;
  /** The primary type pick (roster key; "source" for a bare user subclass). */
  classKey: string;
  title: string;
  /** "Family, Given; Family, Given" — authors rows first, the linkedAuthors
   *  agent derivation when empty (the SHIPPED read contract). */
  authorsText: string;
  /** The publicationDate chain year; null when unset. */
  year: number | null;
  /** The class's container binding value (publicationTitle, bookTitle, …);
   *  "" when the class binds none or the node carries no value. */
  venue: string;
  citekey: string;
  attachmentCount: number;
  isActive: boolean;
}

/** The linkedAuthors fallback half of the read contract, mirrored from the
 *  export package's resolution (the accepted overlap — the web app does
 *  NOT import @notees/export here): an agent's citation name is
 *  "Family, Given" from its effective givenName/familyName property rows,
 *  either half optional, falling back to its display title. */
function agentCitationName(client: SourcesReadSurface, agentId: string): string | null {
  let family: string | undefined;
  let given: string | undefined;
  for (const row of client.getEffectiveProperties(agentId)) {
    if (row.source !== "authored") continue;
    if (typeof row.value !== "string") continue;
    if (row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.familyName) family = row.value;
    if (row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.givenName) given = row.value;
  }
  const parts = [family, given].filter(
    (part): part is string => part !== undefined && part.trim().length > 0,
  );
  if (parts.length > 0) return parts.map((part) => part.trim()).join(", ");
  return displayNameFromClient(client, agentId);
}

/** Every non-empty string an effective row carries for the schema, in row
 *  order (the export package's textLiterals shape). */
function textLiterals(rows: readonly EffectiveProperty[], schemaId: string): string[] {
  const literals: string[] = [];
  for (const row of rows) {
    if (row.propertySchemaId !== schemaId) continue;
    if (typeof row.value === "string" && row.value.trim().length > 0) literals.push(row.value);
  }
  return literals;
}

/** Every {nodeId} ref an effective row carries for the schema, in row order. */
function nodeRefs(rows: readonly EffectiveProperty[], schemaId: string): string[] {
  const refs: string[] = [];
  for (const row of rows) {
    if (row.propertySchemaId !== schemaId) continue;
    const value = row.value;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { nodeId?: unknown }).nodeId === "string"
    ) {
      refs.push((value as { nodeId: string }).nodeId);
    }
  }
  return refs;
}

/**
 * The chain year straight off a date-node id's FIXED payload layout
 * (00bb-YYYY… / 00aa-YYYYMM… / 00dd-YYYYMMDD… — `dates.ts`, never
 * regenerated). Unlike `parseDateNodeId`'s 1900..2200 acceptance window
 * (the journal's display gate), this reads ANY content-addressed year —
 * a bibliography import mints pre-1900 chain refs (Lovelace 1843), and the
 * year column must read them.
 */
const CHAIN_ID_PREFIX = /^00000000-0000-0000-00(?:bb|aa|dd)-(\d{4})/;

function chainYearOf(id: string): number | null {
  const match = CHAIN_ID_PREFIX.exec(id);
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

/** The publicationDate year: the year-node ref's chain year — a point's
 *  nodeId, a range's start, a plain string's first 4-digit run, a legacy
 *  bare date-uuid's payload. */
function publicationYear(value: unknown): number | null {
  if (typeof value === "string") {
    const fromId = chainYearOf(value);
    if (fromId !== null) return fromId;
    const match = /(\d{4})/.exec(value);
    const year = match !== null ? Number(match[1]) : NaN;
    return Number.isFinite(year) && year >= 1000 ? year : null;
  }
  if (typeof value === "object" && value !== null) {
    const point = (value as { nodeId?: unknown }).nodeId;
    if (typeof point === "string") return chainYearOf(point);
    const start = (value as { start?: { nodeId?: unknown } | null }).start;
    if (start !== null && typeof start === "object" && typeof start.nodeId === "string") {
      return chainYearOf(start.nodeId);
    }
  }
  return null;
}

function projectRow(
  client: SourcesReadSurface,
  node: ClientNode,
  ancestorCache: Map<string, string[]>,
): SourceRow {
  const rows = client.getEffectiveProperties(node.id);
  const classKey = primaryClassKey(client, node, ancestorCache);

  // Authors — the read contract's ORDER: text rows first; the
  // linkedAuthors people-graph track only when no authors row resolves.
  const authorLiterals = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.authors);
  const authorNames =
    authorLiterals.length > 0
      ? authorLiterals
      : nodeRefs(rows, SYSTEM_PROPERTY_UUIDS.linkedAuthors)
          .map((ref) => agentCitationName(client, ref))
          .filter((name): name is string => name !== null && name.length > 0);
  const authorsText = authorNames.join("; ");

  // Venue — the FIRST container candidate the class's binding list carries
  //, the node's value for it ("" when unset; the class may
  // bind no container field at all — artwork, email, …).
  const bindings = SYSTEM_SOURCE_CLASS_BINDINGS[classKey];
  const venueKey = VENUE_CANDIDATES.find(
    (candidate) => bindings !== undefined && bindings.includes(candidate),
  );
  const venue = venueKey !== undefined ? (textLiterals(rows, SYSTEM_PROPERTY_UUIDS[venueKey])[0] ?? "") : "";

  // Year + citekey + attachments.
  let year: number | null = null;
  for (const row of rows) {
    if (row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.publicationDate) continue;
    const extracted = publicationYear(row.value);
    if (extracted !== null) {
      year = extracted;
      break;
    }
  }
  const citekey = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.citekey)[0] ?? "";
  // Count rows carrying a ref — the bound-but-empty synthesis reads value
  // null and never counts (an asset ref is an object value).
  const attachmentCount = rows.filter(
    (row) =>
      row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.attachments &&
      row.value !== null &&
      row.value !== undefined &&
      row.value !== "",
  ).length;

  return {
    id: node.id,
    classKey,
    title: deriveDisplayName(node),
    authorsText,
    year,
    venue,
    citekey,
    attachmentCount,
    isActive: node.isActive,
  };
}

/** The q contract: a row answers when the (lowercased) search string hits
 *  the title, the authorsText, OR the citekey. Exported for the items
 *  table's live local filter (the same predicate the row producer applies). */
export function rowMatchesQ(row: SourceRow, q: string): boolean {
  return (
    row.title.toLowerCase().includes(q) ||
    row.authorsText.toLowerCase().includes(q) ||
    row.citekey.toLowerCase().includes(q)
  );
}

/** Client-side sort over the loaded set (the URL grammar's five fields).
 *  Empty values — the null years AND the empty strings — sink LAST in both
 *  directions (Review Focus 2), the table view's shared comparator
 *  convention. */
function sortRows(rows: SourceRow[], sort: SourcesSort | null): SourceRow[] {
  const field = sort?.field ?? "title";
  const dir = sort?.direction ?? "asc";
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (field === "year") {
      const av = a.year;
      const bv = b.year;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * sign;
    }
    const key = field === "authors" ? "authorsText" : field;
    const av = a[key];
    const bv = b[key];
    const emptyA = av === "";
    const emptyB = bv === "";
    if (emptyA !== emptyB) return emptyA ? 1 : -1;
    if (emptyA && emptyB) return 0;
    return av.localeCompare(bv) * sign;
  });
}

/**
 * Run the hub's query: the class-scoped AST through the client's query
 * channel, then the projection, the node-id dedupe (Review Focus 1), the
 * client-side q contract, and the sort. The q filter is deliberately
 * client-side (see the module header) — the AST carries the class
 * condition only, so the linkedAuthors-derived authors text matches too.
 */
export async function runSourcesQuery(
  client: SourcesReadSurface,
  filters: SourcesFilters,
  sort: SourcesSort | null,
): Promise<SourceRow[]> {
  const result = await Promise.resolve(client.runQueryAst(buildSourcesAst({ classKey: filters.classKey })));
  const ancestorCache = new Map<string, string[]>();
  const seen = new Set<string>();
  const rows: SourceRow[] = [];
  for (const id of result.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = client.getNode(id);
    if (node === undefined || node.isClass) continue;
    rows.push(projectRow(client, node, ancestorCache));
  }
  const q = (filters.q ?? "").trim().toLowerCase();
  const filtered = q === "" ? rows : rows.filter((row) => rowMatchesQ(row, q));
  return sortRows(filtered, sort);
}

// --- facetCounts ------------------------------------------------------------------------

export interface SourceFacet {
  classKey: string;
  label: string;
  count: number;
  archived: boolean;
}

/**
 * The facet data behind the left pane: ONE grouped read over the live
 * source family (`getClassMembers(source)` — the extends-aware, active-
 * only members read), counted per roster type with the extends walk (a
 * user subclass of journal_article counts as a journal article; a
 * multi-type node counts under EVERY roster type it carries — the table
 * dedupes it to one row, each per-type filtered view still answers it).
 * NOT 39 count queries — one family read plus memoized class-parent walks.
 */
export function facetCounts(client: SourcesReadSurface): SourceFacet[] {
  const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.source).filter((node) => !node.isClass);
  const ancestorCache = new Map<string, string[]>();
  const counts = new Map<SystemClassName, number>();
  for (const node of members) {
    for (const hit of rosterHitsOf(client, node.classIds, ancestorCache)) {
      counts.set(hit, (counts.get(hit) ?? 0) + 1);
    }
  }
  return SOURCE_TYPE_ROSTER.map((name) => ({
    classKey: name,
    label:
      displayNameFromClient(client, SYSTEM_CLASS_UUIDS[name]) ??
      SYSTEM_CLASS_DISPLAY_NAMES[name],
    count: counts.get(name) ?? 0,
    archived: !classIsActive(client, name),
  }));
}
