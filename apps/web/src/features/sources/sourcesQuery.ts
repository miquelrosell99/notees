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
 *    chain year, citekey, doi/isbn, the attachment count.
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
  sourceBindingPropertyOf,
  type SystemClassName,
} from "@notees/domain";
import { renderCsv } from "@notees/export";
import type { QueryAst } from "@notees/query";

import { titleOf } from "../../ui/dateDisplay.js";
import { propertyDisplayText } from "../collection/propertyDisplay.js";
import type {
  ClassBinding,
  ClientNode,
  ClientPropertySchema,
  EffectiveProperty,
} from "../../core/workspace-client/index.js";
import type { CitekeyEntry } from "./citekey.js";

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

/** The hub modes: the library table (default) or the Literature Matrix
 *  (slice 6 — the comparison grid; the picked set rides the URL). */
export type SourcesMode = "library" | "matrix";

export interface SourcesQueryState {
  /** The picked source-type class key (journal_article, …); null = every type. */
  type: string | null;
  /** The search string (title/authors/citekey); "" = none. */
  q: string;
  /** The sort; null = the table's default order. */
  sort: SourcesSort | null;
  /** The hub mode; "library" is the default and rides the URL bare. */
  mode: SourcesMode;
  /** The matrix mode's picked source ids, in pick order (deep-linkable —
   *  Review Focus 5; empty outside the matrix mode). */
  ids: string[];
}

export const DEFAULT_SOURCES_QUERY: SourcesQueryState = {
  type: null,
  q: "",
  sort: null,
  mode: "library",
  ids: [],
};

const SORT_PATTERN = /^([a-z][a-z0-9_]*):(asc|desc)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 *
 * The matrix grammar (`mode=matrix&ids=<uuid>,<uuid>,…`): the picked set is
 * uuid-filtered (malformed entries drop), deduped preserving first-seen
 * order, and normalized away outside the matrix mode — the ids ride the
 * matrix's URL only, so a library-mode state always parses to `ids: []`.
 */
export function parseSourcesQuery(search: string): SourcesQueryState {
  const queryAt = search.indexOf("?");
  const params = new URLSearchParams(queryAt === -1 ? search : search.slice(queryAt + 1));
  const type = params.get("type");
  const mode: SourcesMode = params.get("mode") === "matrix" ? "matrix" : "library";
  const ids: string[] = [];
  if (mode === "matrix") {
    const seen = new Set<string>();
    for (const entry of (params.get("ids") ?? "").split(",")) {
      const id = entry.trim();
      if (!UUID_PATTERN.test(id) || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      ids.push(id);
    }
  }
  return {
    type: type !== null && type !== "" ? type : null,
    q: params.get("q") ?? "",
    sort: parseSourcesSort(params.get("sort")),
    mode,
    ids,
  };
}

/**
 * Serialize the state back to its path (the bare "/sources" when unset).
 * The sort rides `<field>:<dir>` with a literal colon — deep links stay
 * readable in the URL bar (law 9); the parser accepts the encoded form too.
 * The matrix mode serializes `mode=matrix` plus the comma-joined picked set
 * (uuid-only, safe unencoded); the picked set is dropped in the library
 * mode (parse normalizes it away — round-trip stable by construction).
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
  if (state.mode === "matrix") {
    parts.push("mode=matrix");
    if (state.ids.length > 0) parts.push(`ids=${state.ids.join(",")}`);
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
  getNodeRaw(id: string): { id: string; isActive: boolean } | undefined;
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
  /** The doi/isbn values (the quick-create identifier-normalization
   *  idiom's inputs — "" when unset; the duplicates grouping reads them). */
  doi: string;
  isbn: string;
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
  return titleOf(client, agentId);
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

/**
 * The citekey pattern renderer's input for ONE source node — the SAME
 * dual-track read contract the display rows ship (authors text literals
 * first, the linkedAuthors agent derivation when empty; the
 * publicationDate chain year; the display title). The regenerate
 * affordance on the metadata panel's citekey row rides this, so a
 * regeneration always renders from what the row itself shows.
 */
export function citekeyEntryOf(client: SourcesReadSurface, node: ClientNode): CitekeyEntry {
  return citekeyEntryFromRows(client, node, client.getEffectiveProperties(node.id));
}

/** The row-fetched half: the display projection already holds the node's
 *  effective rows — it passes them straight in instead of re-reading. The
 *  year narrows to the chain read's number-or-null (the pattern renderer
 *  accepts strings too, but a derived year is never one). */
interface SourceCitekeyEntry extends CitekeyEntry {
  year: number | null;
}

function citekeyEntryFromRows(
  client: SourcesReadSurface,
  node: ClientNode,
  rows: readonly EffectiveProperty[],
): SourceCitekeyEntry {
  const authorLiterals = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.authors);
  const authors =
    authorLiterals.length > 0
      ? authorLiterals
      : nodeRefs(rows, SYSTEM_PROPERTY_UUIDS.linkedAuthors)
          .map((ref) => agentCitationName(client, ref))
          .filter((name): name is string => name !== null && name.length > 0);
  let year: number | null = null;
  for (const row of rows) {
    if (row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.publicationDate) continue;
    const extracted = publicationYear(row.value);
    if (extracted !== null) {
      year = extracted;
      break;
    }
  }
  return { authors, year, title: deriveDisplayName(node) };
}

function projectRow(
  client: SourcesReadSurface,
  node: ClientNode,
  ancestorCache: Map<string, string[]>,
): SourceRow {
  const rows = client.getEffectiveProperties(node.id);
  const classKey = primaryClassKey(client, node, ancestorCache);

  // Authors + year ride the same entry the citekey regeneration renders
  // from — one read contract, both consumers (the rows are already fetched).
  const entry = citekeyEntryFromRows(client, node, rows);
  const authorsText = entry.authors.join("; ");

  // Venue — the FIRST container candidate the class's binding list carries
  //, the node's value for it ("" when unset; the class may
  // bind no container field at all — artwork, email, …).
  const bindings = SYSTEM_SOURCE_CLASS_BINDINGS[classKey];
  const boundNames = bindings?.map(sourceBindingPropertyOf);
  const venueKey = VENUE_CANDIDATES.find(
    (candidate) => boundNames !== undefined && boundNames.includes(candidate),
  );
  const venue = venueKey !== undefined ? (textLiterals(rows, SYSTEM_PROPERTY_UUIDS[venueKey])[0] ?? "") : "";

  // Year + citekey + attachments.
  const year = entry.year;
  const citekey = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.citekey)[0] ?? "";
  const doi = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.doi)[0] ?? "";
  const isbn = textLiterals(rows, SYSTEM_PROPERTY_UUIDS.isbn)[0] ?? "";
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
    doi,
    isbn,
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
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" }) * sign;
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
      titleOf(client, SYSTEM_CLASS_UUIDS[name]) ??
      SYSTEM_CLASS_DISPLAY_NAMES[name],
    count: counts.get(name) ?? 0,
    archived: !classIsActive(client, name),
  }));
}

// --- the Literature Matrix (slice 6) ----------------------------------------------------

/**
 * The structural read surface the matrix data layer composes from — the
 * sourcesQuery surface PLUS the schema registry reads (the field pool) and
 * the property-display funnel (cell values). Both client classes satisfy it.
 */
export interface MatrixReadSurface extends SourcesReadSurface {
  /** Own registry bindings of one class (class_property rows). */
  getRegistryBindings(classId: string): Array<Pick<ClassBinding, "propertySchemaId" | "name" | "active">>;
  /** The schema registry (select option labels, live schema names). */
  listPropertySchemas(): ClientPropertySchema[];
}

/** One pickable matrix column — a property schema the grid can render. */
export interface MatrixField {
  schemaId: string;
  /** The schema's live name (renames ride the registry row). */
  name: string;
}

/** One matrix row — a picked source and its per-field cell text. */
export interface MatrixRow {
  id: string;
  title: string;
  /** schemaId → display text ("" when the row carries no value). */
  cells: Record<string, string>;
}

/**
 * The matrix column pool: every property schema bound (active binding) to
 * the source base OR any roster type — the source family's LIVE bound
 * fields, so the workflow's source definition fields appear the moment the
 * research workflow is enabled — UNION any schema with an AUTHORED row on a
 * picked source (the rationale arm: a property present on a row's schemas
 * answers even when no family class binds it). Deduped by schema id,
 * alphabetical by the live schema name (the picker's pure-alphabetical
 * convention).
 */
export function matrixFields(client: MatrixReadSurface, ids: readonly string[]): MatrixField[] {
  const schemaIds = new Set<string>();
  // The family classes: the base every member inherits bindings from + the
  // roster types carrying their own container bindings.
  const familyClassIds = [SYSTEM_CLASS_UUIDS.source, ...SOURCE_TYPE_ROSTER.map((name) => SYSTEM_CLASS_UUIDS[name])];
  for (const classId of familyClassIds) {
    for (const binding of client.getRegistryBindings(classId)) {
      if (binding.active) schemaIds.add(binding.propertySchemaId);
    }
  }
  // The rationale arm: authored rows on the picked rows themselves.
  for (const id of ids) {
    const node = client.getNode(id);
    if (node === undefined) continue;
    for (const row of client.getEffectiveProperties(id)) {
      if (row.source === "authored" && !isEmptyMatrixValue(row.value)) {
        schemaIds.add(row.propertySchemaId);
      }
    }
  }
  const fields = [...schemaIds]
    .map((schemaId) => {
      const schema = client.listPropertySchemas().find((candidate) => candidate.id === schemaId);
      return { schemaId, name: schema?.name ?? schemaId };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return fields;
}

function isEmptyMatrixValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

/**
 * The matrix rows: the picked ids in pick order (a stale id degrades — the
 * row skips, never pinning an empty grid), titled per display-name
 * derivation, cells per the shared propertyDisplayText funnel (select ids →
 * option labels, node refs → display names, multi rows joined "; " — the
 * authorsText convention).
 */
export function matrixRows(client: MatrixReadSurface, ids: readonly string[]): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const id of ids) {
    const node = client.getNode(id);
    if (node === undefined) continue;
    const effective = client.getEffectiveProperties(id);
    const cells: Record<string, string> = {};
    for (const row of effective) {
      if (row.source !== "authored") continue;
      const text = propertyDisplayText(client, row);
      if (text === "") continue;
      cells[row.propertySchemaId] =
        cells[row.propertySchemaId] === undefined ? text : `${cells[row.propertySchemaId]}; ${text}`;
    }
    rows.push({ id, title: deriveDisplayName(node), cells });
  }
  return rows;
}

/**
 * The "New comparison" title, derived from the matrix itself: one source
 * names it, two read "A vs B", more append the "(+N more)" tail. Sources
 * with empty display names drop out of the naming (an empty name would
 * render as a bare " vs " gap); when none carry a name the title falls back
 * to the count — "Comparison — N sources".
 */
export function comparisonTitleFor(titles: readonly string[]): string {
  if (titles.length === 0) return "Comparison";
  const names = titles.filter((title) => title.trim() !== "");
  if (names.length === 0) return `Comparison — ${titles.length} sources`;
  if (names.length === 1) return `Comparison — ${names[0]}`;
  const base = `Comparison — ${names[0]} vs ${names[1]}`;
  return names.length > 2 ? `${base} (+${names.length - 2} more)` : base;
}

/**
 * The CSV projection over the picked rows — THE TABLE VIEW'S MACHINERY
 * (the package serializer owns RFC-4180 quoting + the UTF-8 BOM): the
 * header is "Title" + the picked field names, each row the source title +
 * its cell text. Cell values are display strings, never raw ids — the same
 * contract the table view's csvText rides.
 */
export function matrixCsv(fields: readonly MatrixField[], rows: readonly MatrixRow[]): string {
  return renderCsv(
    ["Title", ...fields.map((field) => field.name)],
    rows.map((row) => [row.title, ...fields.map((field) => row.cells[field.schemaId] ?? "")]),
  );
}
