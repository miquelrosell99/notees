/**
 * NodeCardFrame — the generic frame around NodeView for the right rail's
 * workspace cards (M15/M17 of the main-content restructure): the
 * `nt-sidebar-card` chrome (a breadcrumbs header — right-anchored, ending
 * at the node for pages/classes, at the containing main node for inline
 * blocks — plus the open-in-main, collapse, and close actions) with
 * NodeView in the body (compact layout, no corner menu — the card's own
 * header carries the actions). A card at any level is a generic frame
 * around NodeView; `SidebarNodeCard` is deleted as a component (its body
 * render rides here unchanged).
 *
 * Card management v1 (this slice): collapse toggles the body
 * (session-local — display state, never an op); reorder/dismiss gestures
 * beyond the close button are a registered follow-up.
 */

import { useState } from "react";

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Breadcrumbs } from "./Breadcrumbs.js";
import { Icon } from "../Icon.js";
import { NodeView } from "../NodeView.js";

export function NodeCardFrame({
  client,
  nodeId,
  onOpenNode,
  onClose,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  /** Main-view navigation (links inside the card + open-in-main). */
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  /** Session-local collapse — display state only (card management v1). */
  const [collapsed, setCollapsed] = useState(false);
  const node = client.getNode(nodeId);
  return (
    <section className="nt-sidebar-card" aria-label="Node preview">
      <header className="nt-sidebar-card__header">
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
      {!collapsed && (
        <div className="nt-sidebar-card__body">
          {node === undefined ? (
            <div className="nt-page-missing">Page not found.</div>
          ) : (
            <NodeView
              client={client}
              nodeId={nodeId}
              onOpenNode={onOpenNode}
              onDeleted={() => onClose()}
            />
          )}
        </div>
      )}
    </section>
  );
}
