/**
 * QueryBlockView — the live rendering of a `query` content token (SCHEMA.md
 * block-scale token): a header ("Query" + result-count badge + settings gear
 * + Export), and a result list like the references sections (display name +
 * nodeType chip). The query re-runs on every client notification while
 * mounted (the naive subscribe/notify loop — a matching node created
 * elsewhere appears without a reload), with the last result cached in state
 * between notifications. The list is capped (RESULT_CAP + an "N more" line);
 * the badge always shows the true count.
 *
 * Editing: the gear opens a minimal builder popover (scope / class / nodeType
 * / text-contains — the supported AST conditions only) that rewrites the
 * token's `queryAst` through the normal content update path
 * (`object.update` on the owning node's contentAst, token splice by index).
 *
 * Export (the export-on-query feature): the Export button runs
 * @notees/export's bundleMarkdown over the CURRENT result set — full nodes
 * resolved via the client, ctx.nameOf via display-name reads, ctx.childrenOf
 * via direct-children reads — and downloads one concatenated `.md` (the
 * bundle's files joined by `---`, the CLI's concatBundleMarkdown).
 *
 * Invalid ASTs (fail-loud parse, or M1-unsupported compilation such as
 * aggregation) render an "invalid query" placeholder instead of crashing;
 * the builder can then rewrite the token into a supported shape.
 */

import { useEffect, useState } from "react";

import {
  bundleMarkdown,
  concatBundleMarkdown,
  type ExportContext,
  type ExportNode,
} from "@notees/export";
import { parseQueryAst, type Child, type QueryAst, type Scope } from "@notees/query";
import { deriveDisplayName } from "@notees/domain";

import type {
  ClientNode,
  EffectiveProperty,
  QueryRunResult,
  QueryRunSummary,
} from "@/core/workspace-client.js";

import type { OutlinerClient, OutlinerReader } from "./outliner-context.js";

/** Result list cap: the token is deliberate inline content, but stays cheap. */
export const QUERY_RESULT_CAP = 200;

type QueryBlockClient = OutlinerClient & OutlinerReader;

// --- builder state <-> AST -----------------------------------------------------

export interface QueryBuilderState {
  /** Scope select value; "page" = the view root's subtree (only offered for pages). */
  scope: "workspace" | "pages" | "page";
  /** Class filter (class condition); null/"" = any. */
  classId: string | null;
  /** nodeType filter; "" = any. */
  nodeType: "" | "page" | "block" | "class";
  /** content contains filter (trimmed on write); "" = none. */
  contains: string;
}

const DEFAULT_BUILDER_STATE: QueryBuilderState = {
  scope: "workspace",
  classId: null,
  nodeType: "",
  contains: "",
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
 * a flat AND of the supported conditions, so an `or` root, nested groups,
 * `not` children, foreign conditions, or a linkedTo scope read back as
 * defaults/omitted — writing from the builder replaces them with the
 * composed AND (documented M1 builder behavior).
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
    else if (child.type === "nodeType") state.nodeType = child.nodeType;
    else if (child.type === "content" && child.op === "contains") state.contains = child.value;
  }
  return state;
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
  if (state.nodeType !== "") children.push({ type: "nodeType", nodeType: state.nodeType });
  const contains = state.contains.trim();
  if (contains !== "") children.push({ type: "content", op: "contains", value: contains });
  return { version: 1, scope, root: { type: "group", logic: "and", children } };
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
    nodeType: node.nodeType,
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
    nameOf: (id) => client.getDisplayName(id) ?? undefined,
    childrenOf: (id) =>
      client
        .getChildren(id)
        .filter((child) => child.nodeType === "block")
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

// --- view ------------------------------------------------------------------------

export interface QueryBlockViewProps {
  client: QueryBlockClient;
  /** The node whose contentAst holds the token (the builder's write target). */
  ownerId: string;
  /** The token's position in the owner's contentAst (token splice by index). */
  tokenIndex: number;
  /** The token's serialized QueryAST (loose — validation happens in runQueryAst). */
  queryAst: unknown;
  /** The view root id — the "this page" scope anchor when it is a page. */
  rootId: string;
  /** f(node_type) navigation (pages/classes direct, blocks → containing page). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

export function QueryBlockView({
  client,
  ownerId,
  tokenIndex,
  queryAst,
  rootId,
  onOpenNode,
}: QueryBlockViewProps) {
  const [result, setResult] = useState<QueryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderState, setBuilderState] = useState<QueryBuilderState>(DEFAULT_BUILDER_STATE);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // Live contract: re-run on every notification while mounted. The AST's
  // serialization is the re-run key (token identity changes on every notify
  // re-read); the result cache holds the last run until the next one lands.
  const astKey = JSON.stringify(queryAst ?? null);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const next = await Promise.resolve(client.runQueryAst(queryAst));
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
  const rootIsPage = rootNode?.nodeType === "page";
  const classes = client.listClasses();

  const openBuilder = () => {
    setBuilderState(extractBuilderState(safeParseAst(queryAst)));
    setBuilderOpen(true);
  };

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

  /** f(node_type) navigation: pages/classes open directly; blocks resolve to their containing page. */
  const openResult = (row: QueryRunSummary) => {
    if (onOpenNode === undefined) return;
    if (row.nodeType !== "block") {
      onOpenNode(row.id);
      return;
    }
    const seen = new Set<string>([row.id]);
    let current = client.getNode(row.parentId ?? "");
    while (current !== undefined && current.nodeType !== "page" && !seen.has(current.id)) {
      seen.add(current.id);
      current = current.parentId !== null ? client.getNode(current.parentId) : undefined;
    }
    onOpenNode(current !== undefined && current.nodeType === "page" ? current.id : row.id);
  };

  const handleExport = () => {
    if (result === null || result.ids.length === 0) return;
    downloadTextFile(
      queryExportFileName(result.ids),
      buildQueryExportMarkdown(client, result.ids),
    );
  };

  return (
    <div className="nt-query" onClick={(event) => event.stopPropagation()}>
      <div className="nt-query-header">
        <span className="nt-query-title">Query</span>
        {result !== null && <span className="nt-query-badge">{result.ids.length}</span>}
        <span className="nt-query-actions">
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
            disabled={result === null || result.ids.length === 0}
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
      ) : (
        <>
          <ul className="nt-query-list">
            {result.rows.slice(0, QUERY_RESULT_CAP).map((row) => (
              <li key={row.id}>
                <button type="button" className="nt-query-item" onClick={() => openResult(row)}>
                  <span className="nt-query-item-name">
                    {client.getDisplayName(row.id) ?? row.name ?? row.id}
                  </span>
                  <span className="nt-query-chip">{row.nodeType}</span>
                </button>
              </li>
            ))}
          </ul>
          {result.ids.length > QUERY_RESULT_CAP && (
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
                  {deriveDisplayName(cls) || cls.id}
                </option>
              ))}
            </select>
          </label>
          <label className="nt-query-field">
            <span>Type</span>
            <select
              value={builderState.nodeType}
              onChange={(event) =>
                setBuilderState((s) => ({
                  ...s,
                  nodeType: event.target.value as QueryBuilderState["nodeType"],
                }))
              }
            >
              <option value="">Any type</option>
              <option value="page">Page</option>
              <option value="block">Block</option>
              <option value="class">Class</option>
            </select>
          </label>
          <label className="nt-query-field">
            <span>Text contains</span>
            <input
              value={builderState.contains}
              onChange={(event) => setBuilderState((s) => ({ ...s, contains: event.target.value }))}
            />
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
