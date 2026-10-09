/**
 * QueriesHub — the shell's ad-hoc query surface + the home of the
 * saved views (tabs). Saved views are `query` content tokens hosted on an
 * ordinary workspace page (the host page is created lazily on first save
 * — the same client-side lazy-create pattern as the journal date chain; it
 * is a normal page, visible in the Pages hub, whose content IS the saved
 * views). Everything persists through the content update path — no view
 * entity, no new op, sync rides the op log.
 *
 * The surface: ViewTabs over the host's tokens (the default tab
 * is the token whose view record carries `isDefault`, i.e. configuration in
 * the record rather than code), a "New query" action opening the
 * FilterBuilderModal: Run executes an ad-hoc query session-only;
 * "Save as view" names it and appends a token. The selected view's results
 * render through NodeCollection at section scale (list/table persisted in
 * the token's view record — synced), with the same burst-coalesced live
 * re-run (queryRun.ts) and the 200-row render window + load-more contract.
 */

import { useEffect, useState } from "react";

import type { QueryAst } from "@notees/query";

import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { Icon } from "../Icon.js";
import { displayNameForSettings } from "../dateDisplay.js";
import { useDeviceSetting, writeDeviceSetting } from "./modals/deviceSettings.js";
import { Button, EmptyState } from "./ui/index.js";
import { FilterBuilderModal } from "./FilterBuilderModal.js";
import { ViewTabs } from "./ViewTabs.js";
import { NodeCollection, ViewSwitcher } from "../views/index.js";
import type { ViewMode } from "../views/index.js";
import {
  QUERY_RESULT_CAP,
  aggregateColumnLabel,
  formatAggregateCell,
} from "../QueryBlockView.js";
import {
  QUERY_TABLE_COLUMNS,
  openQueryResult,
  queryResultItems,
  useQueryRun,
  type QueryRunClient,
} from "../queryRun.js";
import { parseQueryViewRecord } from "../queryViewRecord.js";
import {
  appendQueryToken,
  listQueryTokens,
  patchTokenView,
  updateQueryTokenAst,
  type TokenWriteClient,
} from "../queryTokens.js";

const HOST_PAGE_SETTING = "queriesHostPageId";

type AnyClient = WorkspaceClient | WorkerClient;

type HubView =
  | { kind: "saved"; index: number }
  | { kind: "adhoc"; ast: QueryAst; name: string }
  | null;

/** Result body shared by the saved-view and ad-hoc branches. */
function QueryResults({
  client,
  ast,
  viewMode,
  onViewMode,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  ast: unknown;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  const { result, error } = useQueryRun(client as unknown as QueryRunClient, ast);
  const [limit, setLimit] = useState(QUERY_RESULT_CAP);
  const [limitKey, setLimitKey] = useState(JSON.stringify(ast ?? null));
  const astKey = JSON.stringify(ast ?? null);
  if (limitKey !== astKey) {
    setLimitKey(astKey);
    setLimit(QUERY_RESULT_CAP);
  }

  if (error !== null) {
    return (
      <div className="nt-query-invalid" title={error}>
        invalid query
      </div>
    );
  }
  if (result === null) return null;
  if (result.rows.length === 0) return <div className="nt-query-empty">No results.</div>;
  if (result.kind === "aggregate") {
    // Aggregates render the grouped grid (measures need columns) — the same
    // projection the token view uses.
    const classes = client.listClasses();
    const classNames = new Map(classes.map((cls) => [cls.id, displayNameForSettings(cls) || cls.id]));
    const propertyNames = new Map(client.listPropertySchemas().map((s) => [s.id, s.name]));
    return (
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
    );
  }
  return (
    <>
      <NodeCollection
        viewMode={viewMode === "table" ? "table" : "outline"}
        client={client as unknown as import("../views/index.js").AnyClient}
        // The query result owns ITS pagination — the 200-row window
        // (QUERY_RESULT_CAP) + the load-more below — so the collection view
        // must not window again (double-windowing would cut the cap to 100).
        windowed={false}
        items={queryResultItems(client, result.rows, limit)}
        tableColumns={QUERY_TABLE_COLUMNS}
        onNodeClick={(id) => {
          const row = result.rows.find((entry) => entry.id === id);
          if (row !== undefined) openQueryResult(client as unknown as QueryRunClient, row, onOpenNode);
        }}
        onNodeShiftClick={onOpenInSidebar}
      />
      {viewMode !== "table" && result.ids.length > limit && (
        <button
          type="button"
          className="nt-query-more"
          onClick={() => setLimit((value) => value + QUERY_RESULT_CAP)}
        >
          {result.ids.length - limit} more — load more
        </button>
      )}
    </>
  );
}

export function QueriesHub({
  client,
  onOpenNode,
  onOpenInSidebar,
}: {
  client: AnyClient;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  // The saved-views host page: a lazily created ordinary page, its id
  // remembered device-locally. A stale id (page deleted) re-creates on save.
  const [storedHostId, setStoredHostId] = useDeviceSetting<string | null>(HOST_PAGE_SETTING, null);
  const hostId = storedHostId !== null && client.getNode(storedHostId) !== undefined ? storedHostId : null;

  const [view, setView] = useState<HubView>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /** The token index the modal edits (edit path), or null for a new query. */
  const [editing, setEditing] = useState<number | null>(null);
  const [adhocMode, setAdhocMode] = useState<ViewMode>("outline");

  const host = hostId !== null ? client.getNode(hostId) : undefined;
  const tokens = host === undefined ? [] : listQueryTokens(host.contentAst as readonly unknown[]);

  // The effective selection is the explicit choice, else the
  // record-configured default, else the first saved view.
  const selectedToken =
    view?.kind === "saved"
      ? tokens.find((token) => token.index === view.index)
      : undefined;
  const defaultToken = tokens.find((token) => parseQueryViewRecord(token.view).isDefault) ?? tokens[0];
  const effectiveToken = selectedToken ?? defaultToken;
  const effectiveView: HubView =
    view?.kind === "adhoc" && view !== null
      ? view
      : effectiveToken !== undefined
        ? { kind: "saved", index: effectiveToken.index }
        : null;

  const ensureHost = async (): Promise<string | null> => {
    if (hostId !== null) return hostId;
    const id = await client.createObject({ presentAsMain: true, name: "Queries" });
    writeDeviceSetting(HOST_PAGE_SETTING, id);
    setStoredHostId(id);
    return id;
  };

  const handleSaveAsView = async (ast: QueryAst, name: string): Promise<void> => {
    if (editing !== null) {
      // Edit path: rewrite the saved view's AST + title in place.
      await updateQueryTokenAst(client, hostId ?? "", editing, ast);
      await patchTokenView(client, hostId ?? "", editing, { title: name });
      setView({ kind: "saved", index: editing });
      setEditing(null);
      return;
    }
    const ownerId = await ensureHost();
    if (ownerId === null) return;
    const index = await appendQueryToken(client, ownerId, {
      queryAst: ast,
      view: { title: name, mode: "list" },
    });
    if (index >= 0) setView({ kind: "saved", index });
  };

  const handleReorder = (from: number, to: number) => {
    setView((current) =>
      current?.kind === "saved"
        ? {
            kind: "saved",
            index:
              current.index === tokens[from]?.index
                ? tokens[to]!.index
                : current.index,
          }
        : current,
    );
  };

  const selectedRecord = effectiveToken !== undefined ? parseQueryViewRecord(effectiveToken.view) : null;
  const isAdhoc = effectiveView?.kind === "adhoc";

  return (
    <div className="nt-hub nt-queries-hub">
      <header className="nt-hub-header">
        <Icon path="mdi-database-search-outline" size={1.2} className="nt-hub-icon" />
        <h1 className="nt-hub-title">Queries</h1>
        {effectiveView !== null && (
          <span className="nt-hub-switcher">
            <ViewSwitcher
              modes={["outline", "table"]}
              value={
                isAdhoc
                  ? adhocMode
                  : selectedRecord?.mode === "table"
                    ? "table"
                    : "outline"
              }
              onChange={(mode) => {
                if (isAdhoc) {
                  setAdhocMode(mode);
                } else if (effectiveView.kind === "saved") {
                  void patchTokenView(client, hostId ?? "", effectiveView.index, {
                    mode: mode === "table" ? "table" : "list",
                  });
                }
              }}
            />
          </span>
        )}
        <span className="nt-hub-actions">
          {effectiveView?.kind === "saved" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(effectiveView.index);
                setModalOpen(true);
              }}
            >
              Edit query
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            New query
          </Button>
        </span>
      </header>
      {hostId !== null && tokens.length > 0 && (
        <ViewTabs
          client={client as unknown as TokenWriteClient & { subscribe(listener: () => void): () => void }}
          ownerId={hostId}
          activeIndex={effectiveView?.kind === "saved" ? effectiveView.index : null}
          onSelect={(index) => setView({ kind: "saved", index })}
          onReordered={handleReorder}
        />
      )}
      {effectiveView === null ? (
        <EmptyState
          title="No saved views yet"
          description="Build a query with New query — run it ad hoc, or save it as a view and it lives here (and on the host page, like any content)."
        />
      ) : (
        <QueryResults
          client={client}
          onOpenInSidebar={onOpenInSidebar}
          ast={effectiveView.kind === "adhoc" ? effectiveView.ast : effectiveToken?.queryAst}
          viewMode={
            isAdhoc
              ? adhocMode
              : selectedRecord?.mode === "table"
                ? "table"
                : "outline"
          }
          onViewMode={(mode) => {
            if (isAdhoc) setAdhocMode(mode);
          }}
          onOpenNode={onOpenNode}
        />
      )}
      <FilterBuilderModal
        client={client}
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        initialAst={editing !== null ? effectiveToken?.queryAst : undefined}
        initialName={editing !== null ? (selectedRecord?.title ?? "") : undefined}
        onRun={(ast) => setView({ kind: "adhoc", ast, name: "" })}
        onSaveAsView={handleSaveAsView}
      />
      {hostId !== null && (
        <p className="nt-queries-host">
          Saved views live on the{" "}
          <button type="button" className="nt-link-button" onClick={() => onOpenNode(hostId)}>
            Queries page
          </button>{" "}
          (a normal page — the tokens render as query blocks there too).
        </p>
      )}
    </div>
  );
}
