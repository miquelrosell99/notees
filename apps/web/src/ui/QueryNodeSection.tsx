/**
 * QueryNodeSection — the query node's chrome BELOW the block's content row
 *: the block stays a normal, typeable row, MARKED
 * by the query system class (the whiteboard precedent — class = identity
 * and membership, so every query in the workspace lists through the class
 * machinery). The block's first `query` content token carries the DEFAULT
 * tab's AST as payload and renders nothing in the stream; a classed block
 * without a token is an unspecified query (the "Set a query to see results"
 * state) and the first Apply creates the token. After the content row the block renders the nodecollection chrome,
 * exactly like a system section:
 *
 *  - NodeCollectionTabs — the DEFAULT tab (the token's queryAst, refined by
 *    the op log) + custom tabs (node-scoped views on the empty section key,
 *    the node's "main query" surface) + "+", which creates the tab
 *    immediately from the bar's draft;
 *  - NodeCollectionToolbar (the trailing cluster, LAST so its structured panel
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

import { NodeCollectionTabs, NodeCollectionTopBar, SECTION_DEFAULT_TAB } from "../features/collection/index.js";
import { SelectionButton } from "../components/ui/kit/SelectionButton.js";
import { NodeCollectionToolbar } from "../features/collection/NodeCollectionToolbar.js";
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
import { Button } from "../components/ui/kit/Button.js";
import { QueryResultsBody, isUnspecifiedQueryAst, type QueryViewMode } from "./queryResults.js";
import { useQueryRun } from "./queryRun.js";
import { appendQueryToken, updateQueryTokenAst } from "./queryTokens.js";
import { buildQueryExportMarkdown, downloadTextFile, queryExportFileName } from "./queryExport.js";

import "./QueryNodeSection.css";

// --- slash-created query nodes: builder auto-open --------------------------------
//
// The `/query` slash flow (BlockTextEditor, edit mode) marks the block and
// wants the structured builder open when the section renders. The request is
// a module-level queue consumed on mount (a listener pattern would race: the
// request fires before this mounts).

const pendingBuilderOpens = new Set<string>();

/** Ask the live section at `ownerId` to open its structured builder. */
export function requestQueryBuilderOpen(ownerId: string): void {
  pendingBuilderOpens.add(ownerId);
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
  /** The query-classed block node (the write target). */
  nodeId: string;
  /** Render-cascade navigation (App routes the id). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

export function QueryNodeSection({ client, nodeId, onOpenNode }: QueryNodeSectionProps) {
  // The token read is reactive: a sibling section holds its own subscription
  // (the row above may not re-render on another surface's edit).
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // Consume a `/query` slash request targeted at this block (see the module
  // queue above). Runs on every fresh mount — the normal case finds no entry.
  const [builderAutoOpen, setBuilderAutoOpen] = useState(false);
  useEffect(() => {
    if (!pendingBuilderOpens.has(nodeId)) return;
    pendingBuilderOpens.delete(nodeId);
    setBuilderAutoOpen(true);
  }, [nodeId]);

  const [tab, setTab] = useState<string>(SECTION_DEFAULT_TAB);
  const [draft, setDraft] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  /** View modes are transient surface state —
      the pivot's dimensions and measure are transient too (QueryPivot). */
  const [viewMode, setViewMode] = useState<QueryViewMode>("outline");

  // The node's main query surface: the empty section key.
  const { views } = useSectionViews(client, nodeId, "");
  const selectedView = views.find((view) => view.id === tab) ?? null;

  // The payload: the FIRST query token in the content stream, when present.
  const contentAst = client.getNode(nodeId)?.contentAst ?? [];
  let tokenIndex = -1;
  for (let i = 0; i < contentAst.length; i += 1) {
    const entry = contentAst[i] as { type?: unknown };
    if (typeof entry === "object" && entry !== null && entry.type === "query") {
      tokenIndex = i;
      break;
    }
  }
  const token = tokenIndex >= 0 ? contentAst[tokenIndex] : undefined;
  const tokenAst =
    typeof token === "object" && token !== null
      ? (token as { queryAst?: unknown }).queryAst
      : undefined;

  // The selected tab's query: the default tab rides the token's AST (the op
  // log); a custom tab rides its stored view row.
  const effectiveAst = selectedView !== null ? selectedView.queryAst : tokenAst;
  // The empty match-all never runs — the user has not said what they are
  // looking for.
  const unspecified = isUnspecifiedQueryAst(effectiveAst);

  const run = useQueryRun(client, effectiveAst, { enabled: !unspecified });
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
    if (tokenIndex >= 0) {
      await updateQueryTokenAst(client, nodeId, tokenIndex, ast);
    } else {
      // The class marks the block but no payload token exists yet — the
      // first Apply creates it.
      await appendQueryToken(client, nodeId, { queryAst: ast });
    }
    return true;
  };

  const handleExport = () => {
    if (run.result === null || run.result.kind !== "query" || run.result.ids.length === 0) return;
    downloadTextFile(
      queryExportFileName(run.result.ids),
      buildQueryExportMarkdown(client, run.result.ids),
    );
  };



  return (
    <div className="nt-query-node" onClick={(event) => event.stopPropagation()}>
      <NodeCollectionTopBar
        tabs={
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
                {/* The results' three transient modes — the kit SelectionButton
                    directly (pivot is a query-results view, NOT a collection
                    registry mode, so the registry-backed ViewSwitcher cannot
                    name it). */}
                <SelectionButton
                  options={[
                    { value: "outline", icon: "mdi-format-list-bulleted", label: "Outline" },
                    { value: "table", icon: "mdi-table", label: "Table" },
                    { value: "pivot", icon: "mdi-table-pivot", label: "Pivot" },
                  ]}
                  value={viewMode}
                  onChange={(value) => setViewMode(value as QueryViewMode)}
                  size="sm"
                  aria-label="View mode"
                  className="view-switcher"
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
              </>
            }
          />
        }
        toolbar={
          /* The toolbar renders LAST in the cluster: its structured panel
             wraps a full-width line beneath the tab row. The key remounts
             it once when the /query slash queue is consumed — the panel's
             initial-open prop only reads at mount. */
          <NodeCollectionToolbar
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
        }
      />
      <QueryResultsBody
        client={client}
        ast={effectiveAst}
        run={run}
        unspecified={unspecified}
        viewMode={viewMode}
        onOpenNode={(id) => onOpenNode?.(id)}
      />
    </div>
  );
}
