/**
 * QueryNodeSection — the query node's chrome BELOW the block's content row
 *: the block stays a normal, typeable row; its
 * `query` content token only MARKS the block and carries the DEFAULT tab's
 * AST. After the content row the block renders the nodecollection chrome,
 * exactly like a system section:
 *
 *  - NodeCollectionTabs — the DEFAULT tab (the token's queryAst, refined by
 *    the op log) + custom tabs (node-scoped views on the empty section key,
 *    the node's "main query" surface) + "+", which creates the tab
 *    immediately from the bar's draft;
 *  - NodeCollectionBar (the trailing cluster, LAST so its structured panel
 *    wraps a full-width line beneath the tab row) — the full-grammar
 *    builder, toggleable per tab; its "Apply to <tab>" commit rewrites the
 *    SELECTED tab's query (the default tab → the token's queryAst through
 *    the normal content update path; a custom tab → the view row via
 *    updateSectionViewAst);
 *  - the shared QueryResults body (list/table + aggregate grid, the
 *    QUERY_RESULT_CAP window) plus the transient view switcher and the
 *    ids-based Markdown export.
 *
 * The view switcher's mode is TRANSIENT component state. The token's `view` record (title/
 * isDefault) belongs to the Queries hub's saved views and is not read here.
 */

import { useEffect, useState } from "react";

import { parseQueryAst, type QueryAst } from "@notees/query";

import { NodeCollectionTabs, SECTION_DEFAULT_TAB, ViewSwitcher } from "../features/collection/index.js";
import { NodeCollectionBar } from "../features/collection/NodeCollectionBar.js";
import {
  updateSectionViewAst,
  useSectionViews,
} from "../features/collection/sectionViews.js";
import {
  EMPTY_FILTER_QUERY,
  FACTORY_QUERY_AST,
  filterQueryToGroup,
  type FilterQuery,
} from "../features/collection/filterQuery.js";
import type { AnyClient } from "../features/collection/index.js";
import type { ViewMode } from "../features/collection/index.js";
import { Button } from "../components/ui/fleet/Button.js";
import { QueryResultsBody } from "./queryResults.js";
import { useQueryRun } from "./queryRun.js";
import { updateQueryTokenAst } from "./queryTokens.js";
import { buildQueryExportMarkdown, downloadTextFile, queryExportFileName } from "./queryExport.js";

import "./QueryNodeSection.css";

// --- slash-created tokens: builder auto-open ------------------------------------
//
// The `/query` slash flow (BlockTextEditor, edit mode) inserts a token and
// wants the structured builder open when the section renders. The request is
// a module-level queue consumed on mount (a listener pattern would race: the
// request fires before this mounts).

const pendingBuilderOpens = new Set<string>();

/** Ask the live section at `ownerId`:`tokenIndex` to open its structured builder. */
export function requestQueryBuilderOpen(ownerId: string, tokenIndex: number): void {
  pendingBuilderOpens.add(`${ownerId}:${tokenIndex}`);
}

/** Loose-token parse: a malformed default AST surfaces as the invalid-query line. */
function safeParseAst(raw: unknown): QueryAst | null {
  try {
    return parseQueryAst(raw);
  } catch {
    return null;
  }
}

export interface QueryNodeSectionProps {
  client: AnyClient;
  /** The block node whose contentAst holds the token (the write target). */
  nodeId: string;
  /** The token's position in the node's contentAst (the splice key). */
  tokenIndex: number;
  /** Render-cascade navigation (App routes the id). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

export function QueryNodeSection({ client, nodeId, tokenIndex, onOpenNode }: QueryNodeSectionProps) {
  // The token read is reactive: a sibling section holds its own subscription
  // (the row above may not re-render on another surface's edit).
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // Consume a `/query` slash request targeted at this token (see the module
  // queue above). Runs on every fresh mount — the normal case finds no entry.
  const [builderAutoOpen, setBuilderAutoOpen] = useState(false);
  useEffect(() => {
    const key = `${nodeId}:${tokenIndex}`;
    if (!pendingBuilderOpens.has(key)) return;
    pendingBuilderOpens.delete(key);
    setBuilderAutoOpen(true);
  }, [nodeId, tokenIndex]);

  const [tab, setTab] = useState<string>(SECTION_DEFAULT_TAB);
  const [draft, setDraft] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  /** View modes are transient surface state. */
  const [viewMode, setViewMode] = useState<ViewMode>("outline");

  // The node's main query surface: the empty section key.
  const { views } = useSectionViews(client, nodeId, "");
  const selectedView = views.find((view) => view.id === tab) ?? null;

  const token = client.getNode(nodeId)?.contentAst[tokenIndex];
  const tokenAst =
    typeof token === "object" && token !== null
      ? (token as { queryAst?: unknown }).queryAst
      : undefined;

  // The selected tab's query: the default tab rides the token's AST (the op
  // log); a custom tab rides its stored view row.
  const effectiveAst = selectedView !== null ? selectedView.queryAst : tokenAst;

  const run = useQueryRun(client, effectiveAst);
  const resultCount =
    run.result === null ? null : run.result.kind === "query" ? run.result.ids.length : run.result.rows.length;
  const exportable = run.result !== null && run.result.kind === "query" && run.result.ids.length > 0;

  /** "+" seeds the new tab from the bar's draft, else a copy of the default query. */
  const createAst = (): QueryAst => {
    const group = filterQueryToGroup(draft);
    return group === null
      ? (safeParseAst(tokenAst) ?? FACTORY_QUERY_AST)
      : { version: 1, scope: { type: "entire_workspace" }, root: group };
  };

  /** The per-tab builder commit: rewrite the SELECTED tab's query. */
  const applyToTab = async (ast: QueryAst): Promise<boolean> => {
    if (selectedView !== null) {
      return updateSectionViewAst(client, nodeId, "", selectedView.id, ast);
    }
    await updateQueryTokenAst(client, nodeId, tokenIndex, ast);
    return true;
  };

  const handleExport = () => {
    if (run.result === null || run.result.kind !== "query" || run.result.ids.length === 0) return;
    downloadTextFile(
      queryExportFileName(run.result.ids),
      buildQueryExportMarkdown(client, run.result.ids),
    );
  };

  // The token vanished (content rewritten without it) — the section goes too.
  if (tokenAst === undefined) return null;

  return (
    <div className="nt-query-node" onClick={(event) => event.stopPropagation()}>
      <NodeCollectionTabs
        client={client}
        nodeId={nodeId}
        sectionKey=""
        selected={selectedView !== null ? tab : SECTION_DEFAULT_TAB}
        onSelect={setTab}
        createAst={createAst}
        activeCount={resultCount}
        trailing={
          <>
            <ViewSwitcher
              modes={["outline", "table"]}
              value={viewMode === "table" ? "table" : "outline"}
              onChange={setViewMode}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="mdi mdi-download"
              aria-label="Export results"
              title="Export results (Markdown)"
              disabled={!exportable}
              onClick={handleExport}
            />
            {/* The bar renders LAST in the cluster: its structured panel
                wraps a full-width line beneath the tab row. The key remounts
                it once when the /query slash queue is consumed — the panel's
                initial-open prop only reads at mount. */}
            <NodeCollectionBar
              key={builderAutoOpen ? "builder-open" : "builder-closed"}
              client={client}
              layout="inline"
              value={draft}
              onChange={setDraft}
              matchCount={null}
              totalCount={null}
              defaultPanelOpen={builderAutoOpen}
              applyTarget={{
                tabLabel: selectedView?.name ?? "Default",
                onApply: applyToTab,
              }}
            />
          </>
        }
      />
      <QueryResultsBody
        client={client}
        ast={effectiveAst}
        run={run}
        viewMode={viewMode}
        onOpenNode={(id) => onOpenNode?.(id)}
      />
    </div>
  );
}
