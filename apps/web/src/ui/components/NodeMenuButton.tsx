/**
 * NodeMenuButton — the "…" affordance pinned to the main content card's
 * top-right corner whenever a node is open in it (hosted by NodeView's
 * cornerMenu mode; sidebar peek cards opt out). Clicking opens the node's
 * context menu anchored to the button (right edge aligned), giving every
 * node surface a discoverable path to Open / Copy link / Favorites /
 * Export / Delete without right-clicking. The ExportPageModal lives here,
 * mirroring PageView's header-menu wiring.
 */

import { useRef, useState } from "react";

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { ExportPageModal } from "./modals/ExportPageModal.js";
import { NodeContextMenu, type NodeMenuState } from "./NodeContextMenu.js";
import "./NodeMenuButton.css";

export function NodeMenuButton({
  client,
  node,
  onOpenNode,
  onPresent,
  onDeleted,
}: {
  client: WorkspaceClient | WorkerClient;
  node: ClientNode;
  onOpenNode: (nodeId: string) => void;
  /** Presentation mode (§34.26): the "Present" menu item decks the page. */
  onPresent?: ((nodeId: string) => void) | undefined;
  onDeleted?: ((node: ClientNode) => void) | undefined;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<NodeMenuState>(null);
  const [exporting, setExporting] = useState<{ pageId: string; name: string } | null>(null);

  return (
    <>
      <span className="nt-node-menu-corner">
        <button
          ref={buttonRef}
          type="button"
          className="nt-icon-btn"
          title="Node actions"
          aria-label="Node actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={() =>
            setMenu({
              x: 0,
              y: 0,
              node,
              isPage: rendersWithDocumentChrome(node),
              anchorEl: buttonRef.current,
            })
          }
        >
          <Icon path="mdi-dots-vertical" size={1} />
        </button>
      </span>
      <NodeContextMenu
        state={menu}
        client={client}
        onClose={() => setMenu(null)}
        onOpenNode={(id) => {
          setMenu(null);
          onOpenNode(id);
        }}
        onPresent={onPresent}
        onExport={(pageId, name) => {
          setMenu(null);
          setExporting({ pageId, name });
        }}
        onDeleted={(deleted) => {
          setMenu(null);
          onDeleted?.(deleted);
        }}
      />
      {exporting !== null && (
        <ExportPageModal
          isOpen
          client={client}
          nodeUuid={exporting.pageId}
          nodeName={exporting.name}
          onClose={() => setExporting(null)}
        />
      )}
    </>
  );
}
