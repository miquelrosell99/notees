/**
 * QueryBlockView — the live rendering of a `query` content token (SCHEMA.md
 * block-scale token): a header ("Query" + result-count badge + list/table
 * view toggle + settings gear + Export), and the result in one of two shapes:
 *
 *  - list mode (default): the references-section idiom (display name +
 *    render-state chip — Page/Block/Class from the isClass/presentAsMain
 *    booleans), capped (RESULT_CAP + an "N more" line);
 *  - table mode: a simple table (Name / Class / Main / Created) of the
 *    result set;
 *  - an AST carrying an `aggregation` always renders the aggregate grid
 *    (dimension columns + measure columns, numeric alignment) — measures
 *    need columns a list cannot carry. The badge shows the result count
 *    (group count for aggregates); Export (ids-based) stays list-only.
 *
 * The view mode persists in the token's `view: { mode: "list" | "table" }`
 * (the protocol token's free-form `view` record), written through the normal
 * content update path (`object.update` on the owning node's contentAst,
 * token splice by index) — the same splice the builder uses for `queryAst`.
 *
 * The query re-runs on every client notification while mounted (the naive
 * subscribe/notify loop — a matching node created elsewhere appears without
 * a reload), with the last result cached in state between notifications.
 * Aggregated ASTs run through the client's runAggregateAst bridge (grouped
 * grid); plain ASTs through runQueryAst.
 *
 * Editing: the gear opens a minimal builder popover (scope / class /
 * isClass / presentAsMain / text-contains — the supported AST conditions —
 * plus a minimal aggregation section: one group-by dimension and one
 * measure) that rewrites the token's `queryAst`. Multi-dimension /
 * multi-measure aggregations stay AST-by-hand; the builder reads back the
 * FIRST dimension/measure and rewrites the aggregation from its own fields
 * (documented M1 builder behavior, same as unsupported conditions).
 *
 * Export (the export-on-query feature): the Export button runs
 * @notees/export's bundleMarkdown over the CURRENT result set — full nodes
 * resolved via the client, ctx.nameOf via display-name reads, ctx.childrenOf
 * via direct-children reads — and downloads one concatenated `.md` (the
 * bundle's files joined by `---`, the CLI's concatBundleMarkdown).
 *
 * Invalid ASTs (fail-loud parse or compilation) render an "invalid query"
 * placeholder instead of crashing; the builder can then rewrite the token
 * into a supported shape.
 */

import { useEffect, useState } from "react";

import {
  bundleMarkdown,
  concatBundleMarkdown,
  type ExportContext,
  type ExportNode,
} from "@notees/export";
import { rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";
import { parseQueryAst, type Aggregation, type AggregationMeasure, type Child, type QueryAst, type Scope } from "@notees/query";

import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";
import { NodeCollection, ViewSwitcher } from "./views/index.js";
import type { NodeCollectionItem, TableColumn } from "./views/index.js";

import type {
  ClientNode,
  EffectiveProperty,
  QueryAggregateResult,
  QueryRunResult,
  QueryRunSummary,
} from "@/core/workspace-client.js";

import type { OutlinerClient, OutlinerReader } from "./outliner-context.js";

/** Result list cap: the token is deliberate inline content, but stays cheap. */
export const QUERY_RESULT_CAP = 200;

// --- slash-created tokens: builder auto-open (§34.31 B1) ----------------------
//
// The `/query` slash flow (BlockTextEditor, edit mode) inserts a token and
// wants the builder popover open when the block re-renders in read mode. The
// popover lives in this component, which mounts fresh on every edit-cycle
// exit — so the request is a module-level queue consumed on mount (a
// listener pattern would race: the request fires before this mounts).

const pendingBuilderOpens = new Set<string>();

/** Ask the live token view at `ownerId`:`tokenIndex` to open its builder popover. */
export function requestQueryBuilderOpen(ownerId: string, tokenIndex: number): void {
  pendingBuilderOpens.add(`${ownerId}:${tokenIndex}`);
}

/** The query result's table columns (aligned with the view registry's table). */
const QUERY_TABLE_COLUMNS: TableColumn[] = [
  { id: "name", kind: "name", label: "Name", sortable: true },
  { id: "isClass", kind: "isClass", label: "Class", sortable: true },
  { id: "presentAsMain", kind: "presentAsMain", label: "Main", sortable: true },
  { id: "created", kind: "created", label: "Created", sortable: true },
];

/** Query run rows → the collection input shape (unresolvable rows drop out). */
function queryResultItems(
  client: QueryBlockClient,
  rows: QueryRunSummary[],
): NodeCollectionItem[] {
  const items: NodeCollectionItem[] = [];
  for (const row of rows.slice(0, QUERY_RESULT_CAP)) {
    const node = client.getNode(row.id);
    if (node !== undefined) items.push({ node });
  }
  return items;
}

type QueryBlockClient = OutlinerClient & OutlinerReader;

// --- view mode (token contract) ---------------------------------------------------

/**
 * The persisted token view contract: `view: { mode: "list" | "table" }` on
 * the `query` content token (a free-form record in the protocol grammar, so
 * foreign keys ride along). Anything unknown reads back as the list default.
 */
export type QueryViewMode = "list" | "table";

export function parseQueryViewMode(view: unknown): QueryViewMode {
  if (
    typeof view === "object" &&
    view !== null &&
    (view as { mode?: unknown }).mode === "table"
  ) {
    return "table";
  }
  return "list";
}

// --- builder state <-> AST -----------------------------------------------------

export interface QueryBuilderState {
  /** Scope select value; "page" = the view root's subtree (only offered for document-chrome roots). */
  scope: "workspace" | "pages" | "page";
  /** Class filter (class condition); null/"" = any. */
  classId: string | null;
  /** isClass filter (Revision-11 boolean condition); "" = any. */
  isClass: "" | "true" | "false";
  /** presentAsMain filter (Revision-11 boolean condition); "" = any. */
  presentAsMain: "" | "true" | "false";
  /** content contains filter (trimmed on write); "" = none. */
  contains: string;
  /** Aggregation group-by; "" / absent = none. "isClass" | "presentAsMain" | `class:<id>` | `property:<id>`. */
  groupBy?: string;
  /** Aggregation measure. "count" (default) | "countDistinct" | `<fn>:<propertyId>`. */
  measure?: string;
}

const DEFAULT_BUILDER_STATE: QueryBuilderState = {
  scope: "workspace",
  classId: null,
  isClass: "",
  presentAsMain: "",
  contains: "",
  groupBy: "",
  measure: "count",
};

function safeParseAst(raw: unknown): QueryAst | null {
  try {
    return parseQueryAst(raw);
  } catch {
    return null;
  }
}

/**
 * Populate the builder from an AST, best effort: the builder only represents
 * a flat AND of the supported conditions and ONE aggregation dimension +
 * measure, so an `or` root, nested groups, `not` children, foreign
 * conditions, multi-dimension/multi-measure aggregations, or a linkedTo
 * scope read back as defaults/omitted — writing from the builder replaces
 * them with the composed AND / single-dimension aggregation (documented M1
 * builder behavior).
 */
export function extractBuilderState(ast: QueryAst | null): QueryBuilderState {
  if (ast === null) return { ...DEFAULT_BUILDER_STATE };
  const state = { ...DEFAULT_BUILDER_STATE };
  switch (ast.scope.type) {
    case "pages":
      state.scope = "pages";
      break;
    case "subtree":
      state.scope = "page";
      break;
    default:
      state.scope = "workspace";
      break;
  }
  if (ast.root.logic !== "and") return state;
  for (const child of ast.root.children) {
    if (child.type === "class") state.classId = child.classId;
    else if (child.type === "isClass") state.isClass = child.isClass ? "true" : "false";
    else if (child.type === "presentAsMain") state.presentAsMain = child.presentAsMain ? "true" : "false";
    else if (child.type === "content" && child.op === "contains") state.contains = child.value;
  }
  const aggregation = ast.aggregation;
  if (aggregation !== undefined) {
    const dimension = aggregation.dimensions[0];
    state.groupBy =
      dimension === undefined
        ? ""
        : dimension.kind === "isClass"
          ? "isClass"
          : dimension.kind === "presentAsMain"
            ? "presentAsMain"
            : `${dimension.kind}:${dimension.id}`;
    const measure = aggregation.measures[0];
    if (measure === undefined) {
      state.measure = "count";
    } else {
      switch (measure.function) {
        case "count":
        case "countDistinct":
          state.measure = measure.function;
          break;
        default:
          state.measure = `${measure.function}:${measure.id}`;
      }
    }
  }
  return state;
}

/**
 * The aggregation the builder state composes: absent unless a group-by is
 * set or the measure is non-default (a bare count with no dimensions is the
 * plain query's own badge). Empty dimensions + a numeric measure = the grand
 * total. `min:`/`max:` measures (hand-written in the AST) round-trip through
 * the state untouched even though the select does not offer them.
 */
export function composeAggregation(state: QueryBuilderState): Aggregation | undefined {
  const groupBy = state.groupBy ?? "";
  const measureSpec = state.measure ?? "count";
  if (groupBy === "" && measureSpec === "count") return undefined;
  const dimensions: Aggregation["dimensions"] = [];
  if (groupBy === "isClass") {
    dimensions.push({ kind: "isClass" });
  } else if (groupBy === "presentAsMain") {
    dimensions.push({ kind: "presentAsMain" });
  } else if (groupBy.startsWith("class:")) {
    dimensions.push({ kind: "class", id: groupBy.slice("class:".length) });
  } else if (groupBy.startsWith("property:")) {
    dimensions.push({ kind: "property", id: groupBy.slice("property:".length) });
  }
  let measure: AggregationMeasure;
  if (measureSpec === "count") {
    measure = { function: "count" };
  } else if (measureSpec === "countDistinct") {
    measure = { function: "countDistinct", kind: "node" };
  } else {
    const fn = measureSpec.slice(0, measureSpec.indexOf(":"));
    const id = measureSpec.slice(measureSpec.indexOf(":") + 1);
    measure = { function: fn as "sum" | "avg" | "min" | "max", kind: "property", id };
  }
  return { dimensions, measures: [measure] };
}

/** Compose the supported AST conditions into a version-1 AST (flat AND root). */
export function composeQueryAst(
  state: QueryBuilderState,
  rootId: string,
  rootIsPage: boolean,
): QueryAst {
  const scope: Scope =
    state.scope === "pages"
      ? { type: "pages" }
      : state.scope === "page" && rootIsPage
        ? { type: "subtree", pageId: rootId }
        : { type: "entire_workspace" };
  const children: Child[] = [];
  if (state.classId !== null && state.classId !== "") {
    children.push({ type: "class", classId: state.classId });
  }
  if (state.isClass !== "") children.push({ type: "isClass", isClass: state.isClass === "true" });
  if (state.presentAsMain !== "") {
    children.push({ type: "presentAsMain", presentAsMain: state.presentAsMain === "true" });
  }
  const contains = state.contains.trim();
  if (contains !== "") children.push({ type: "content", op: "contains", value: contains });
  const aggregation = composeAggregation(state);
  return {
    version: 1,
    scope,
    root: { type: "group", logic: "and", children },
    ...(aggregation !== undefined ? { aggregation } : {}),
  };
}

// --- export on query -------------------------------------------------------------

/** The read surface export-on-query needs (satisfied by both client implementations). */
export interface QueryExportClient {
  getNode(id: string): ClientNode | undefined;
  getDisplayName(id: string): string | null;
  getEffectiveProperties(id: string): EffectiveProperty[];
  getChildren(id: string): ClientNode[];
}

function toExportNode(client: QueryExportClient, id: string): ExportNode | undefined {
  const node = client.getNode(id);
  if (node === undefined) return undefined;
  return {
    id: node.id,
    isClass: node.isClass ? 1 : 0,
    presentAsMain: node.presentAsMain ? 1 : 0,
    parentId: node.parentId,
    name: node.name,
    contentAst: node.contentAst,
    classIds: node.classIds,
    properties: client.getEffectiveProperties(id).map((property) => ({
      schemaId: property.propertySchemaId,
      schemaName: property.schema?.name ?? "",
      value: property.value,
      ...(property.metadata !== null ? { metadata: property.metadata } : {}),
    })),
  };
}

/**
 * Build the concatenated Markdown for a query result set: full nodes resolved
 * via the client, @notees/export's bundleMarkdown over them (ctx.nameOf from
 * display-name reads, ctx.childrenOf from direct block children), then the
 * bundle's files joined with `---` separators (concatBundleMarkdown).
 * Factored out of the component so tests can assert the markdown directly.
 */
export function buildQueryExportMarkdown(client: QueryExportClient, ids: readonly string[]): string {
  const nodes = ids
    .map((id) => toExportNode(client, id))
    .filter((node): node is ExportNode => node !== undefined);
  const exportCtx: ExportContext = {
    nameOf: (id) => displayNameFromClient(client, id) ?? undefined,
    childrenOf: (id) =>
      client
        .getChildren(id)
        .filter((child) => rendersAsInlineBlock(child))
        .map((child) => toExportNode(client, child.id))
        .filter((node): node is ExportNode => node !== undefined),
  };
  return concatBundleMarkdown(bundleMarkdown(nodes, exportCtx));
}

/** Download filename: the first result id's short prefix (deterministic for tests). */
export function queryExportFileName(ids: readonly string[]): string {
  const shortId = ids[0] !== undefined ? ids[0].slice(0, 8) : "query";
  return `notees-export-${shortId}.md`;
}

/** Blob + anchor download (no helper exists in the app yet — deliberately simple). */
export function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

// --- aggregate grid ---------------------------------------------------------------

/** The result of a live run: a plain query's id set, or an aggregation's grid. */
type QueryRunState =
  | ({ kind: "query" } & QueryRunResult)
  | { kind: "aggregate"; dimensionCount: number } & QueryAggregateResult;

/**
 * Aggregate column labels: the compiler's names are deterministic (`isClass`,
 * `presentAsMain`, `class:<id>`, `property:<id>`, `count`, `countDistinct`,
 * `<fn>:<id>`) but bare ids are unreadable — resolve class/property names
 * from the client's class facts, falling back to a short id prefix. Unknown
 * shapes stay raw.
 */
export function aggregateColumnLabel(
  column: string,
  classNames: ReadonlyMap<string, string>,
  propertyNames: ReadonlyMap<string, string>,
): string {
  if (column === "isClass") return "Class";
  if (column === "presentAsMain") return "Present as main";
  if (column === "count") return "Count";
  if (column === "countDistinct") return "Count distinct";
  const match = /^(class|property|sum|avg|min|max):(.+)$/.exec(column);
  if (match === null || match[1] === undefined || match[2] === undefined) return column;
  const [, kind, id] = match;
  if (kind === "class") {
    return classNames.get(id) ?? `Class ${id.slice(0, 8)}`;
  }
  const base = propertyNames.get(id) ?? id.slice(0, 8);
  return kind === "property" ? base : `${kind}(${base})`;
}

/** Grid cell rendering: null/undefined read as a dash, objects as JSON. */
export function formatAggregateCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// --- view ------------------------------------------------------------------------

export interface QueryBlockViewProps {
  client: QueryBlockClient;
  /** The node whose contentAst holds the token (the write target). */
  ownerId: string;
  /** The token's position in the owner's contentAst (token splice by index). */
  tokenIndex: number;
  /** The token's serialized QueryAST (loose — validation happens in runQueryAst). */
  queryAst: unknown;
  /** The token's persisted view record (`{ mode: "list" | "table" }`; loose). */
  view?: unknown;
  /** The view root id — the "this page" scope anchor when it has document chrome. */
  rootId: string;
  /** Render-cascade navigation (App routes the id). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

export function QueryBlockView({
  client,
  ownerId,
  tokenIndex,
  queryAst,
  view,
  rootId,
  onOpenNode,
}: QueryBlockViewProps) {
  const [result, setResult] = useState<QueryRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderState, setBuilderState] = useState<QueryBuilderState>(DEFAULT_BUILDER_STATE);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const viewMode = parseQueryViewMode(view);

  // Live contract: re-run on every notification while mounted. The AST's
  // serialization is the re-run key (token identity changes on every notify
  // re-read); the result cache holds the last run until the next one lands.
  // Aggregated ASTs run through the aggregate bridge (grouped grid); plain
  // ASTs through the query bridge (id set + summaries).
  const astKey = JSON.stringify(queryAst ?? null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const parsed = safeParseAst(queryAst);
        const next: QueryRunState =
          parsed !== null && parsed.aggregation !== undefined
            ? {
                kind: "aggregate",
                dimensionCount: parsed.aggregation.dimensions.length,
                ...(await Promise.resolve(client.runAggregateAst(queryAst))),
              }
            : { kind: "query", ...(await Promise.resolve(client.runQueryAst(queryAst))) };
        if (cancelled) return;
        setResult(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // queryAst is keyed by its serialization (astKey).
  }, [client, astKey, version]);

  const rootNode = client.getNode(rootId);
  const rootIsPage = rootNode !== undefined && rendersWithDocumentChrome(rootNode);
  const classes = client.listClasses();

  // Bound properties across all classes (deduped by schema id) — the group-by
  // property picker and the numeric measure picker's source.
  const boundProperties: Array<{ id: string; name: string; type: string }> = [];
  const seenSchemas = new Set<string>();
  for (const cls of classes) {
    for (const binding of client.getClassBindings(cls.id)) {
      if (seenSchemas.has(binding.propertySchemaId)) continue;
      seenSchemas.add(binding.propertySchemaId);
      boundProperties.push({ id: binding.propertySchemaId, name: binding.name, type: binding.type });
    }
  }
  const numericProperties = boundProperties.filter((property) => property.type === "number");

  const classNames = new Map(classes.map((cls) => [cls.id, displayNameForSettings(cls) || cls.id]));
  const propertyNames = new Map(boundProperties.map((property) => [property.id, property.name]));

  const openBuilder = () => {
    setBuilderState(extractBuilderState(safeParseAst(queryAst)));
    setBuilderOpen(true);
  };

  // Consume a `/query` slash request targeted at this token (see the module
  // queue above). Runs on every fresh mount — the normal case finds no entry.
  useEffect(() => {
    const key = `${ownerId}:${tokenIndex}`;
    if (!pendingBuilderOpens.has(key)) return;
    pendingBuilderOpens.delete(key);
    openBuilder();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume-once on mount; openBuilder reads the current queryAst prop.
  }, [ownerId, tokenIndex]);

  /** Rewrite the token's queryAst via the normal content update path. */
  const applyBuilder = async () => {
    const owner = client.getNode(ownerId);
    if (owner === undefined) return;
    const nextAst = composeQueryAst(builderState, rootId, rootIsPage);
    const next = owner.contentAst.map((token, index) =>
      index === tokenIndex
        ? ({ ...(token as unknown as Record<string, unknown>), queryAst: nextAst } as typeof token)
        : token,
    );
    await client.updateObject(ownerId, { contentAst: next });
    setBuilderOpen(false);
  };

  /** Persist the view mode in the token's view record (foreign keys ride along). */
  const applyViewMode = async (mode: QueryViewMode) => {
    const owner = client.getNode(ownerId);
    if (owner === undefined) return;
    const viewRecord =
      typeof view === "object" && view !== null ? (view as Record<string, unknown>) : {};
    const next = owner.contentAst.map((token, index) =>
      index === tokenIndex
        ? ({
            ...(token as unknown as Record<string, unknown>),
            view: { ...viewRecord, mode },
          } as unknown as typeof token)
        : token,
    );
    await client.updateObject(ownerId, { contentAst: next });
  };

  /**
   * Render-cascade navigation: document-chrome nodes (pages, classes) open
   * directly; an inline block resolves to its containing main node.
   */
  const openResult = (row: QueryRunSummary) => {
    if (onOpenNode === undefined) return;
    if (!rendersAsInlineBlock(row)) {
      onOpenNode(row.id);
      return;
    }
    const seen = new Set<string>([row.id]);
    let current = client.getNode(row.parentId ?? "");
    while (current !== undefined && !rendersWithDocumentChrome(current) && !seen.has(current.id)) {
      seen.add(current.id);
      current = current.parentId !== null ? client.getNode(current.parentId) : undefined;
    }
    onOpenNode(current !== undefined && rendersWithDocumentChrome(current) ? current.id : row.id);
  };

  const handleExport = () => {
    if (result === null || result.kind !== "query" || result.ids.length === 0) return;
    downloadTextFile(
      queryExportFileName(result.ids),
      buildQueryExportMarkdown(client, result.ids),
    );
  };

  const resultCount = result === null ? null : result.kind === "query" ? result.ids.length : result.rows.length;
  const exportable = result !== null && result.kind === "query" && result.ids.length > 0;

  return (
    <div className="nt-query" onClick={(event) => event.stopPropagation()}>
      <div className="nt-query-header">
        <span className="nt-query-title">Query</span>
        {resultCount !== null && <span className="nt-query-badge">{resultCount}</span>}
        <span className="nt-query-actions">
          <ViewSwitcher
            modes={["outline", "table"]}
            value={viewMode === "table" ? "table" : "outline"}
            onChange={(mode) => void applyViewMode(mode === "table" ? "table" : "list")}
          />
          <button
            type="button"
            className="nt-query-action"
            aria-label="Query settings"
            onClick={openBuilder}
          >
            ⚙
          </button>
          <button
            type="button"
            className="nt-query-action"
            disabled={!exportable}
            onClick={handleExport}
          >
            Export
          </button>
        </span>
      </div>
      {error !== null ? (
        <div className="nt-query-invalid" title={error}>
          invalid query
        </div>
      ) : result === null ? null : result.rows.length === 0 ? (
        <div className="nt-query-empty">No results.</div>
      ) : result.kind === "aggregate" ? (
        <table className="nt-query-table">
          <thead>
            <tr>
              {result.columns.map((column, index) => (
                <th
                  key={`${column}:${index}`}
                  className={index >= result.dimensionCount ? "nt-query-num" : undefined}
                >
                  {aggregateColumnLabel(column, classNames, propertyNames)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                {cells.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={cellIndex >= result.dimensionCount ? "nt-query-num" : undefined}
                  >
                    {formatAggregateCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <NodeCollection
            viewMode={viewMode === "table" ? "table" : "outline"}
            // The seam type is structural; the runtime object is the full
            // client (both classes satisfy it).
            client={client as unknown as import("./views/index.js").AnyClient}
            items={queryResultItems(client, result.rows)}
            tableColumns={QUERY_TABLE_COLUMNS}
            onNodeClick={(id) => {
              const row = result.rows.find((entry) => entry.id === id);
              if (row !== undefined) openResult(row);
            }}
          />
          {result.kind === "query" && viewMode !== "table" && result.ids.length > QUERY_RESULT_CAP && (
            <div className="nt-query-more">{result.ids.length - QUERY_RESULT_CAP} more</div>
          )}
        </>
      )}
      {builderOpen && (
        <div className="nt-query-builder" role="dialog" aria-label="Query builder">
          <label className="nt-query-field">
            <span>Scope</span>
            <select
              value={builderState.scope}
              onChange={(event) =>
                setBuilderState((s) => ({
                  ...s,
                  scope: event.target.value as QueryBuilderState["scope"],
                }))
              }
            >
              <option value="workspace">Entire workspace</option>
              {rootIsPage && <option value="page">This page</option>}
              <option value="pages">Pages only</option>
            </select>
          </label>
          <label className="nt-query-field">
            <span>Class</span>
            <select
              value={builderState.classId ?? ""}
              onChange={(event) =>
                setBuilderState((s) => ({ ...s, classId: event.target.value || null }))
              }
            >
              <option value="">Any class</option>
              {classes.map((cls) => (
                <option key={cls.id} value={cls.id}>
                  {displayNameForSettings(cls) || cls.id}
                </option>
              ))}
            </select>
          </label>
          <label className="nt-query-field">
            <span>Class bit</span>
            <select
              value={builderState.isClass}
              onChange={(event) =>
                setBuilderState((s) => ({
                  ...s,
                  isClass: event.target.value as QueryBuilderState["isClass"],
                }))
              }
            >
              <option value="">Any</option>
              <option value="true">Class</option>
              <option value="false">Not a class</option>
            </select>
          </label>
          <label className="nt-query-field">
            <span>Render bit</span>
            <select
              value={builderState.presentAsMain}
              onChange={(event) =>
                setBuilderState((s) => ({
                  ...s,
                  presentAsMain: event.target.value as QueryBuilderState["presentAsMain"],
                }))
              }
            >
              <option value="">Any</option>
              <option value="true">Main children</option>
              <option value="false">Inline body</option>
            </select>
          </label>
          <label className="nt-query-field">
            <span>Text contains</span>
            <input
              value={builderState.contains}
              onChange={(event) => setBuilderState((s) => ({ ...s, contains: event.target.value }))}
            />
          </label>
          <label className="nt-query-field">
            <span>Group by</span>
            <select
              value={builderState.groupBy}
              onChange={(event) =>
                setBuilderState((s) => ({ ...s, groupBy: event.target.value }))
              }
            >
              <option value="">None</option>
              <option value="isClass">Class bit</option>
              <option value="presentAsMain">Render bit</option>
              {classes.map((cls) => (
                <option key={cls.id} value={`class:${cls.id}`}>
                  Class: {displayNameForSettings(cls) || cls.id}
                </option>
              ))}
              {boundProperties.map((property) => (
                <option key={property.id} value={`property:${property.id}`}>
                  Property: {property.name}
                </option>
              ))}
            </select>
          </label>
          <label className="nt-query-field">
            <span>Measure</span>
            <select
              value={builderState.measure}
              onChange={(event) =>
                setBuilderState((s) => ({ ...s, measure: event.target.value }))
              }
            >
              <option value="count">Count</option>
              <option value="countDistinct">Count distinct</option>
              {numericProperties.map((property) => (
                <option key={property.id} value={`sum:${property.id}`}>
                  Sum of {property.name}
                </option>
              ))}
              {numericProperties.map((property) => (
                <option key={property.id} value={`avg:${property.id}`}>
                  Average of {property.name}
                </option>
              ))}
            </select>
          </label>
          <div className="nt-query-builder-actions">
            <button type="button" onClick={() => void applyBuilder()}>
              Apply
            </button>
            <button type="button" onClick={() => setBuilderOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
