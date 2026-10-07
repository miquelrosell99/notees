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
 * Card management: collapse toggles the body (session-local — display
 * state, never an op); the close button dismisses the card; REORDER rides
 * the workspace drag session — the header's GRIP (the drag handle, the
 * block-row grip precedent) registers the card as a reorder source, so
 * the reorder gesture never conflicts with the header's drop gesture or
 * the breadcrumb clicks: dragging a block ONTO the header still appends
 * it as the card node's LAST CHILD (unchanged), while dragging the GRIP
 * reorders the rail's card stack (the App owns the stack + its
 * device-local persistence; the host reports the gesture, see
 * useWorkspaceDnd). While a card drag hovers a header, the header renders
 * its reorder edge (a line above/below, the pointer's half).
 *
 * The workspace drag session: the card's header is a droppable — dropping
 * a block on it moves the block as the LAST CHILD of the card's node
 * (one code path with a child drop on that node; see useWorkspaceDnd),
 * and the header renders its own distinct active-drop state while it is
 * the drop target. A collapsed card under drag-hover transiently expands
 * (drag-scoped — the session holds the temporary set; the collapse state
 * here never mutates) and re-collapses at drag end. Without a host the
 * header droppable and the grip are inert and the body renders exactly
 * per the collapse state. The card also passes `globalShortcuts: false`
 * down — the document-level chords (find/replace, fold) stay
 * main-surface-only.
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
  useWorkspaceDndRailCard,
  workspaceCardHeaderDroppableId,
  workspaceRailCardDraggableId,
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
  /** Session-local collapse — display state only (card management). */
  const [collapsed, setCollapsed] = useState(false);
  const node = client.getNode(nodeId);
  /**
   * The header droppable: registers with the workspace session (no-op
   * without a host — the droppable stays inert) and attaches the measured
   * node ref to the header element.
   */
  const headerDroppableId = workspaceCardHeaderDroppableId(nodeId);
  const setHeaderRef = useWorkspaceDndHeader({ droppableId: headerDroppableId, nodeId, client });
  /**
   * The reorder grip: registers the card as a rail reorder source (no-op
   * without a host — the grip stays inert) and attaches the draggable ref
   * + activator props to the grip element.
   */
  const railCardDraggableId = workspaceRailCardDraggableId(nodeId);
  const { setGripRef, attributes, listeners, isDragging } = useWorkspaceDndRailCard({
    draggableId: railCardDraggableId,
    nodeId,
    client,
  });
  /** Drag-scoped UI: the header's active-drop state, the transient
   *  expand, and this card's reorder edge while a card drag is live. */
  const dragUi = useContext(WorkspaceDndHostContext)?.dragUi ?? null;
  const headerDropActive = dragUi !== null && dragUi.headerDropId === headerDroppableId;
  const dragExpanded = dragUi !== null && dragUi.expandedNodeIds.has(nodeId);
  const reorderEdge =
    dragUi !== null && dragUi.railReorder !== null && dragUi.railReorder.nodeId === nodeId
      ? dragUi.railReorder.position
      : null;
  const headerClass = [
    "nt-sidebar-card__header",
    headerDropActive ? "nt-sidebar-card__header--drop-active" : "",
    reorderEdge === "before" ? "nt-sidebar-card__header--reorder-before" : "",
    reorderEdge === "after" ? "nt-sidebar-card__header--reorder-after" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <section
      className={isDragging ? "nt-sidebar-card nt-sidebar-card--drag-source" : "nt-sidebar-card"}
      aria-label="Node preview"
    >
      <header className={headerClass} ref={setHeaderRef} data-header-droppable={headerDroppableId}>
        <span
          ref={setGripRef}
          className="nt-sidebar-card__grip"
          title="Drag to reorder"
          aria-label="Drag to reorder card"
          {...attributes}
          {...listeners}
        >
          <Icon path="mdi-drag-vertical" size={0.8} />
        </span>
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
