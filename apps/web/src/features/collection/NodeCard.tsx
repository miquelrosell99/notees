/**
 * NodeCard — the right rail's peeked-node card: a SOLID surfaced card (the
 * main content card's surface + hairline + shape) around NodeView, one card
 * per node. The header is separated from the body by a hairline and carries,
 * left section first: the collapse chevron, then a NON-CLICKABLE
 * right-anchored breadcrumb trail (on overflow the upper parent levels hide
 * behind a plain "…" — the lower/current levels always show). Right section:
 * the card-actions menu (the three-dot) and the close X. A collapsed card
 * hides its body and keeps the header bar — collapse is card management,
 * never node state.
 *
 * Card management: the collapse state is stack state owned by the App (the
 * menu's collapse/expand actions act across the whole stack); the close X
 * dismisses this card; "Open in main view" navigates the main surface to
 * the node and removes the card from the rail. The stack itself renders in
 * AppBody (the rail's top bar + the card list, most recent first).
 *
 * The workspace drag session: the card's header remains a BLOCK drop target
 * — dropping a block onto it appends the block as the card node's LAST
 * CHILD (one code path with a child drop on that node; see useWorkspaceDnd).
 * The header renders its distinct active-drop state while it is the target,
 * and a collapsed card under drag-hover transiently expands (drag-scoped —
 * the session holds the temporary set; the collapse state never mutates).
 * There is NO card reorder drag: the stack order is the peek recency.
 *
 * Without a host the header droppable is inert and the body renders exactly
 * per the collapse state. The card passes `globalShortcuts: false` down —
 * the document-level chords (find/replace, fold) stay main-surface-only.
 */

import { useContext } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { Breadcrumbs } from "../node-menu/Breadcrumbs.js";
import { ButtonWithPanel } from "../../components/ui/kit/ButtonWithPanel.js";
import { Icon } from "../../ui/Icon.js";
import { NodeView } from "../../ui/NodeView.js";
import {
  WorkspaceDndHostContext,
  useWorkspaceDndHeader,
  workspaceCardHeaderDroppableId,
} from "../../ui/useWorkspaceDnd.js";
import "./NodeCard.css";

/** The stack-scope menu actions (the App owns the stack). */
export interface NodeCardStackActions {
  closeOthers: () => void;
  closeAll: () => void;
  collapseOthers: () => void;
  collapseAll: () => void;
  expandAll: () => void;
}

export function NodeCard({
  client,
  nodeId,
  onOpenNode,
  onOpenNodeRaw,
  onOpenInSidebar,
  onClose,
  collapsed,
  onToggleCollapsed,
  stackActions,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  /** Main-view navigation (links inside the card + open-in-main). */
  onOpenNode: (nodeId: string) => void;
  /**
   * The RAW open (no alias redirect) — the aliases UI's NAVIGATE bypass
   * inside the card. Defaults to onOpenNode.
   */
  onOpenNodeRaw?: ((nodeId: string) => void) | undefined;
  /** The peek gesture (Shift+click a bullet) — the same contract the main
   *  surface's NodeView receives; unwired it silently no-ops. */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  onClose: () => void;
  /** The card's collapsed state — stack state owned by the App. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The stack-scope menu rows; undefined hides them (standalone renders). */
  stackActions?: NodeCardStackActions | undefined;
}) {
  const node = client.getNode(nodeId);
  /**
   * The header droppable: registers with the workspace session (no-op
   * without a host — the droppable stays inert) and attaches the measured
   * node ref to the header element.
   */
  const headerDroppableId = workspaceCardHeaderDroppableId(nodeId);
  const setHeaderRef = useWorkspaceDndHeader({ droppableId: headerDroppableId, nodeId, client });
  /** Drag-scoped UI: the header's active-drop state + the transient expand. */
  const dragUi = useContext(WorkspaceDndHostContext)?.dragUi ?? null;
  const headerDropActive = dragUi !== null && dragUi.headerDropId === headerDroppableId;
  const dragExpanded = dragUi !== null && dragUi.expandedNodeIds.has(nodeId);
  const headerClass = [
    "nt-sidebar-card__header",
    headerDropActive ? "nt-sidebar-card__header--drop-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section
      className={collapsed ? "nt-sidebar-card nt-sidebar-card--collapsed" : "nt-sidebar-card"}
      aria-label="Node preview"
    >
      <header className={headerClass} ref={setHeaderRef} data-header-droppable={headerDroppableId}>
        <button
          type="button"
          className="nt-sidebar-card__action"
          aria-label={collapsed ? "Expand card" : "Collapse card"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand card" : "Collapse card"}
          onClick={onToggleCollapsed}
        >
          <Icon path={collapsed ? "mdi-chevron-down" : "mdi-chevron-up"} size={0.8} />
        </button>
        {node !== undefined && (
          <Breadcrumbs client={client} nodeId={nodeId} anchor="right" interactive={false} />
        )}
        <span className="nt-sidebar-card__actions">
          <ButtonWithPanel
            variant="ghost"
            size="sm"
            icon="mdi-dots-horizontal"
            panelPosition="bottom"
            panelAlignment="end"
            showCloseButton={false}
            aria-label="Card actions"
            tooltip="Card actions"
            panelClassName="nt-sidebar-card__menu-panel"
          >
            {(closePanel) => (
              <div className="nt-sidebar-card__menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  data-menu-item
                  className="nt-sidebar-card__menu-item"
                  onClick={() => {
                    closePanel();
                    onOpenNode(nodeId);
                    onClose();
                  }}
                >
                  <Icon path="mdi-arrow-right" size={0.8} />
                  <span>Open in main view</span>
                </button>
                <div className="nt-sidebar-card__menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  data-menu-item
                  className="nt-sidebar-card__menu-item"
                  onClick={() => {
                    closePanel();
                    onClose();
                  }}
                >
                  <Icon path="mdi-close" size={0.8} />
                  <span>Close card</span>
                </button>
                {stackActions !== undefined && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        stackActions.closeOthers();
                      }}
                    >
                      <Icon path="mdi-close-circle-outline" size={0.8} />
                      <span>Close others</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        stackActions.closeAll();
                      }}
                    >
                      <Icon path="mdi-close-box-outline" size={0.8} />
                      <span>Close all</span>
                    </button>
                    <div className="nt-sidebar-card__menu-sep" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        onToggleCollapsed();
                      }}
                    >
                      <Icon path={collapsed ? "mdi-chevron-down" : "mdi-chevron-up"} size={0.8} />
                      <span>{collapsed ? "Expand card" : "Collapse card"}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        stackActions.collapseOthers();
                      }}
                    >
                      <Icon path="mdi-unfold-less-horizontal" size={0.8} />
                      <span>Collapse others</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        stackActions.collapseAll();
                      }}
                    >
                      <Icon path="mdi-arrow-collapse-vertical" size={0.8} />
                      <span>Collapse all</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-menu-item
                      className="nt-sidebar-card__menu-item"
                      onClick={() => {
                        closePanel();
                        stackActions.expandAll();
                      }}
                    >
                      <Icon path="mdi-arrow-expand-vertical" size={0.8} />
                      <span>Expand all</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </ButtonWithPanel>
          <button
            type="button"
            className="nt-sidebar-card__action"
            aria-label="Close card"
            title="Close"
            onClick={onClose}
          >
            <Icon path="mdi-close" size={0.8} />
          </button>
        </span>
      </header>
      {(!collapsed || dragExpanded) && (
        <div className="nt-sidebar-card__body">
          {node === undefined ? (
            <div className="nt-page-missing">Page not found.</div>
          ) : (
            <NodeView
              client={client}
              nodeId={nodeId}
              onOpenNode={onOpenNode}
              onOpenNodeRaw={onOpenNodeRaw}
              onOpenInSidebar={onOpenInSidebar}
              onDeleted={() => onClose()}
              globalShortcuts={false}
            />
          )}
        </div>
      )}
    </section>
  );
}
