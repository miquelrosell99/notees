/**
 * CondensedLinksPopup — the condensed layer's links-badge popup (owner idea,
 * 2026-10-15): the bounded list of nodes a condensed block mentions BEYOND
 * its excerpt cut — "N nodes you can't see". Rows reuse the picker row
 * (`NodeResultItem`, the `@` picker convention — a BLOCK target carries its
 * containing page as the breadcrumb); clicking a row opens the node through
 * the host funnel (opening does not stretch the block — the list is the
 * discovery surface, the "…" remains the stretch surface, one surface per
 * action). Dismissal is the one convention (Esc + outside pointer-down, via
 * the shared usePopupDismissal hook); the list is a bounded-scroll surface
 * (no search in v1 — the count is named and the scroll is honest).
 */

import { useRef, type RefObject } from "react";

import { rendersWithDocumentChrome } from "@notees/domain";

import type { WorkspaceClient } from "@/core/workspace-client/index.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { NodeResultItem } from "../pickers/NodeResultItem.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import type { HiddenLinkTarget } from "@/editor/condensed.js";
import "./CondensedLinksPopup.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The containing-page label for a block target (the `@` picker convention):
 * the nearest ancestor that renders with document chrome. Page targets (and
 * targets whose chain can't be resolved) render no breadcrumb.
 */
function containingPageLabel(client: AnyClient, targetId: string): string | null {
  let current = client.getNode(targetId);
  let currentParent =
    current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
  let guard = 0;
  while (
    current !== undefined &&
    !rendersWithDocumentChrome(current, currentParent) &&
    currentParent !== undefined &&
    guard < 64
  ) {
    current = currentParent;
    currentParent =
      current !== undefined && current.parentId !== null ? client.getNode(current.parentId) : undefined;
    guard += 1;
  }
  if (current === undefined || current.id === targetId) return null;
  return displayNameFromClient(client, current.id) ?? null;
}

export function CondensedLinksPopup({
  client,
  links,
  anchorRef,
  onOpenNode,
  onClose,
}: {
  client: AnyClient;
  links: readonly HiddenLinkTarget[];
  /** The badge button — pointer-downs on it toggle instead of dismissing. */
  anchorRef: RefObject<HTMLElement | null>;
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  usePopupDismissal({ popupRef, anchorRefs: [anchorRef], isOpen: true, onClose });
  return (
    <div
      className="nt-condensed-links"
      ref={popupRef}
      role="dialog"
      aria-label="Hidden links"
      onKeyDown={(event) => {
        // usePopupDismissal ignores Escape originating INSIDE the popup —
        // the sibling-popup convention wires the root handler ourselves so
        // a keyboard user who Tabs into the list can always Esc out.
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="nt-condensed-links__count">
        {links.length} hidden link{links.length === 1 ? "" : "s"}
      </div>
      <div className="nt-condensed-links__list">
        {links.map((link) => {
          const target = client.getNode(link.targetNodeId);
          // A deleted target renders its raw id — never silent retargeting
          // (the mention contract): getNode falls back to a name-less stub.
          const node = target ?? { name: link.targetNodeId };
          const parentPath =
            target !== undefined ? containingPageLabel(client, target.id) : null;
          return (
            <NodeResultItem
              key={`${link.targetNodeId}-${link.start}`}
              node={node}
              client={client}
              {...(parentPath !== null ? { parentPath } : {})}
              onClick={() => {
                onClose();
                onOpenNode(link.targetNodeId);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
