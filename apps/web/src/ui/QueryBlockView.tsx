/**
 * QueryBlockView — the live rendering of a `query` content token (SCHEMA.md
 * block-scale token): a header ("Query" + result-count badge + list/table
 * view toggle + settings gear + Export), and the result in one of two shapes:
 *
 *  - list mode (default): the references-section idiom (display name +
 *    render-state chip — Page/Block/Class from the isClass/presentAsMain
 *    booleans), windowed (RESULT_CAP rows + a load-more button past the cap);
 *  - table mode: a simple table (Name / Class / Main / Created) of the
 *    result set;
 *  - an AST carrying an `aggregation` always renders the aggregate grid
 *    (dimension columns + measure columns, numeric alignment) — measures
 *    need columns a list cannot carry. The badge shows the result count
 *    (group count for aggregates); Export (ids-based) stays list-only.
 *
 * The view mode persists in the token's `view` record (the
 * formalized record — see queryViewRecord.ts), written through the normal
 * content update path (`object.update` on the owning node's contentAst,
 * token splice by index) — the same splice the builder uses for `queryAst`.
 *
 * Live re-runs are coalesced by notification burst: a re-run in
 * flight marks notifications dirty and schedules exactly one trailing run,
 * and a run whose (AST, version) pair is already the latest is skipped.
 *
 * Editing: the gear opens the builder popover (the shared subset from
 * queryBuilder.ts — flat AND of class/isClass/presentAsMain/text/created-
 * window conditions, one sort, one aggregation dimension+measure):
 * when the AST uses constructs outside that subset (or-roots, nested groups,
 * NOT, property/linkedTo conditions, fts, multi-sort, multi-dimension
 * aggregations), the popover renders a READ-ONLY summary plus the list of
 * what would be lost, and an explicit "Edit anyway" opt-in gates the lossy
 * form — a single Apply can no longer silently clobber a richer AST.
 *
 * The created-window fields accept `{today}`-style placeholders alongside
 * fixed dates (compiled at run time per @notees/query's placeholders module).
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
import { parseQueryAst, type QueryAst } from "@notees/query";

import { displayNameFromClient } from "./dateDisplay.js";
import { NodeCollection, ViewSwitcher } from "./views/index.js";
import type { NodeCollectionItem } from "./views/index.js";
import {
  QUERY_TABLE_COLUMNS,
  openQueryResult,
  queryResultItems,
  useQueryRun,
  type QueryRunState,
} from "./queryRun.js";
import { QueryBuilderFields, useBuilderFacts } from "./components/QueryBuilderFields.js";

import type {
  ClientNode,
  EffectiveProperty,
  QueryRunSummary,
} from "@/core/workspace-client.js";

import type { OutlinerClient, OutlinerReader } from "./outliner-context.js";
import {
  DEFAULT_BUILDER_STATE,
  builderUnsupportedConstructs,
  composeAggregation,
  composeQueryAst,
  describeBuilderState,
  extractBuilderState,
  type QueryBuilderState,
} from "./queryBuilder.js";
import { mergeQueryViewRecord, parseQueryViewRecord, type QueryViewMode } from "./queryViewRecord.js";

export {
  DEFAULT_BUILDER_STATE,
  builderUnsupportedConstructs,
  composeAggregation,
  composeQueryAst,
  describeBuilderState,
  extractBuilderState,
  type QueryBuilderState,
} from "./queryBuilder.js";

/** Result list cap: the token is deliberate inline content, but stays cheap. */
export const QUERY_RESULT_CAP = 200;

// --- slash-created tokens: builder auto-open ------------------------------------
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

type QueryBlockClient = OutlinerClient & OutlinerReader;

// --- view mode (token contract) ---------------------------------------------------

/**
 * The persisted view mode — the record's `mode` key
 * (queryViewRecord.ts is the disciplined reader; this stays exported for
 * the existing test imports).
 */
export function parseQueryViewMode(view: unknown): QueryViewMode {
  return parseQueryViewRecord(view).mode;
}

/** Loose-token parse for the render path: invalid ASTs render the placeholder. */
function safeParseAst(raw: unknown): QueryAst | null {
  try {
    return parseQueryAst(raw);
  } catch {
    return null;
  }
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
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderState, setBuilderState] = useState<QueryBuilderState>(DEFAULT_BUILDER_STATE);
  /** Constructs the current AST uses that the builder can't represent. */
  const [builderGuard, setBuilderGuard] = useState<string[]>([]);
  /** The explicit "edit anyway" opt-in that unlocks the lossy builder form. */
  const [builderOverride, setBuilderOverride] = useState(false);

  const viewMode = parseQueryViewMode(view);

  // Live coalesced run (the hook shares the burst-coalescing
  // contract with the Queries hub): re-runs when the token's AST or the
  // store version changes; the last result caches between runs.
  const { result, error } = useQueryRun(client, queryAst);

  // The render window: the 200 cap is a per-render window, not a
  // hard result ceiling — "Load more" widens it. Reset when the query itself
  // changes (a different query starts back at the default window).
  const astKey = JSON.stringify(queryAst ?? null);
  const [limit, setLimit] = useState(QUERY_RESULT_CAP);
  const [limitKey, setLimitKey] = useState(astKey);
  if (limitKey !== astKey) {
    setLimitKey(astKey);
    setLimit(QUERY_RESULT_CAP);
  }

  const rootNode = client.getNode(rootId);
  const rootIsPage = rootNode !== undefined && rendersWithDocumentChrome(rootNode);
  // Picker sources for the builder fields + the aggregate grid labels.
  const facts = useBuilderFacts(client);
  const { classNames, propertyNames } = facts;

  const openBuilder = () => {
    const parsed = safeParseAst(queryAst);
    // When the AST uses constructs the builder can't represent,
    // open on the READ-ONLY summary; the lossy form needs the explicit
    // "edit anyway" opt-in.
    setBuilderGuard(builderUnsupportedConstructs(parsed));
    setBuilderOverride(false);
    setBuilderState(extractBuilderState(parsed));
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
    const next = owner.contentAst.map((token, index) =>
      index === tokenIndex
        ? ({
            ...(token as unknown as Record<string, unknown>),
            view: mergeQueryViewRecord(view, { mode }),
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
    openQueryResult(client, row, onOpenNode);
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
            // The query result owns ITS pagination — the 200-row
            // render window (QUERY_RESULT_CAP) widened by the "N more — load
            // more" button below — so the collection view must not window
            // again (double-windowing would cut the 200 cap to 100).
            windowed={false}
            items={queryResultItems(client, result.rows, limit)}
            tableColumns={QUERY_TABLE_COLUMNS}
            onNodeClick={(id) => {
              const row = result.rows.find((entry) => entry.id === id);
              if (row !== undefined) openResult(row);
            }}
          />
          {result.kind === "query" && viewMode !== "table" && result.ids.length > limit && (
            <button
              type="button"
              className="nt-query-more"
              onClick={() => setLimit((value) => value + QUERY_RESULT_CAP)}
            >
              {result.ids.length - limit} more — load more
            </button>
          )}
        </>
      )}
      {builderOpen && (
        <div className="nt-query-builder" role="dialog" aria-label="Query builder">
          {builderGuard.length > 0 && !builderOverride ? (
            <>
              <p className="nt-query-guard" role="alert">
                This query uses constructs the builder can&rsquo;t represent (
                {builderGuard.join(", ")}). Editing it here would rewrite the query and drop
                them.
              </p>
              <ul className="nt-query-summary">
                {describeBuilderState(builderState, {
                  className: (id) => classNames.get(id) ?? id,
                  propertyName: (id) => propertyNames.get(id) ?? id,
                }).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="nt-query-builder-actions">
                <button type="button" onClick={() => setBuilderOverride(true)}>
                  Edit anyway
                </button>
                <button type="button" onClick={() => setBuilderOpen(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {builderGuard.length > 0 && (
                <p className="nt-query-guard" role="alert">
                  Editing will drop: {builderGuard.join(", ")}.
                </p>
              )}
              <QueryBuilderFields
                state={builderState}
                onChange={(patch) => setBuilderState((s) => ({ ...s, ...patch }))}
                facts={facts}
                rootIsPage={rootIsPage}
              />
              <div className="nt-query-builder-actions">
                <button type="button" onClick={() => void applyBuilder()}>
                  Apply
                </button>
                <button type="button" onClick={() => setBuilderOpen(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
