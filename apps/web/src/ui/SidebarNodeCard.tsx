/**
 * SidebarNodeCard — one independent peek card in the right sidebar
 * (shift+click a block bullet): the node's own view (page/class/focused
 * block) with a close button; links inside navigate the main view. The
 * header title IS the breadcrumb trail (right-anchored): for inline blocks
 * it ends at the containing main node, for pages/classes at the node itself.
 * Extracted from App.tsx (the main-content restructure, S1); the cards-only
 * rail rework (S7) replaces the frame chrome, the NodeView render stays.
 */

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Breadcrumbs } from "./components/Breadcrumbs.js";
import { Icon } from "./Icon.js";
import { NodeView } from "./NodeView.js";

export function SidebarNodeCard({
  client,
  nodeId,
  onOpenNode,
  onClose,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
}) {
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
      <div className="nt-sidebar-card__body">
        {node === undefined ? (
          <div className="nt-page-missing">Page not found.</div>
        ) : (
          <NodeView client={client} nodeId={nodeId} onOpenNode={onOpenNode} onDeleted={() => onClose()} />
        )}
      </div>
    </section>
  );
}
