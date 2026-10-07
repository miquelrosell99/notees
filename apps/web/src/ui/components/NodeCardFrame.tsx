/**
 * NodeCardFrame — the generic frame around NodeView for the right rail's
 * workspace cards (the main-content restructure): the
 * `nt-sidebar-card` chrome (a breadcrumbs header — right-anchored, ending
 * at the node for pages/classes, at the containing main node for inline
 * blocks — plus the open-in-main, collapse, and close actions) with
 * NodeView in the body (compact layout, no corner menu — the card's own
 * header carries the actions). A card at any level is a generic frame
 * around NodeView; `SidebarNodeCard` is deleted as a component (its body
 * render rides here unchanged).
 *
 * Card management (this slice): collapse toggles the body
 * (session-local — display state, never an op); reorder/dismiss gestures
 * beyond the close button are a registered follow-up.
 *
 * The workspace drag session: the card's header is a droppable — dropping
 * a block on it moves the block as the LAST CHILD of the card's node
 * (one code path with a child drop on that node; see useWorkspaceDnd),
 * and the header renders its own distinct active-drop state while it is
 * the drop target. A collapsed card under drag-hover transiently expands
 * (drag-scoped — the session holds the temporary set; the collapse state
 * here never mutates) and re-collapses at drag end. Without a host the
 * header droppable is inert and the body renders exactly per the collapse
 * state. The card also passes `globalShortcuts: false` down — the
 * document-level chords (find/replace, fold) stay main-surface-only.
 */

import { useContext, useState } from "react";

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Breadcrumbs } from "./Breadcrumbs.js";
import { Icon } from "../Icon.js";
import { NodeView } from "../NodeView.js";
import {
  WorkspaceDndHostContext,
  useWorkspaceDndHeader,
  workspaceCardHeaderDroppableId,
} from "../useWorkspaceDnd.js";

export function NodeCardFrame({
  client,
  nodeId,
  onOpenNode,
  onOpenNodeRaw,
  onClose,
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
  onClose: () => void;
}) {
  /** Session-local collapse — display state only (card management, first pass). */
  const [collapsed, setCollapsed] = useState(false);
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
  return (
    <section className="nt-sidebar-card" aria-label="Node preview">
      <header
        className={
          headerDropActive ? "nt-sidebar-card__header nt-sidebar-card__header--drop-active" : "nt-sidebar-card__header"
        }
        ref={setHeaderRef}
        data-header-droppable={headerDroppableId}
      >
        {node !== undefined && (
          <Breadcrumbs
            client={client}
            nodeId={nodeId}
            onOpenNode={onOpenNode}
            showCurrent={!rendersAsInlineBlock(node)}
            anchor="right"
            editable
          />
        )}
        <span className="nt-sidebar-card__actions">
          <button
            type="button"
            className="nt-sidebar-card__action"
            aria-label={collapsed ? "Expand card" : "Collapse card"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand card" : "Collapse card"}
            onClick={() => setCollapsed((open) => !open)}
          >
            <Icon
              path={collapsed ? "mdi-chevron-down" : "mdi-chevron-up"}
              size={0.8}
            />
          </button>
          <button
            type="button"
            className="nt-sidebar-card__action"
            aria-label="Open in main view"
            title="Open in main view"
            onClick={() => {
              onOpenNode(nodeId);
              onClose();
            }}
          >
            <Icon path="mdi-arrow-right" size={0.8} />
          </button>
          <button
            type="button"
            className="nt-sidebar-card__action"
            aria-label="Close card"
            title="Close"
            onClick={onClose}
          >
            ×
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
              onDeleted={() => onClose()}
              globalShortcuts={false}
            />
          )}
        </div>
      )}
    </section>
  );
}
