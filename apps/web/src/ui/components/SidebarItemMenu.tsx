/**
 * SidebarItemMenu — right-click menu for the sidebar's Favorites and Recents
 * rows (the archived editor's unified node menu, scoped to what a list row
 * needs): navigate (main view / sidebar card), copy the node link, favorites
 * toggle, remove-from-recents on the Recents list, and Delete (danger, with
 * the house confirmation modal). Composes the ContextMenu primitive.
 */

import type { ClientNode } from "@/core/workspace-client.js";

import { ContextMenu } from "./ui/ContextMenu.js";
import { notificationStore } from "./ui/notificationStore.js";
import { copyToClipboard } from "./modals/clipboard.js";
import { nodeLinkUrl } from "../nodeLink.js";

export interface SidebarItemMenuState {
  x: number;
  y: number;
  node: ClientNode;
  /** Which list the row belongs to — drives the "Remove from …" item. */
  list: "favorites" | "recents";
}

interface SidebarItemMenuProps {
  state: SidebarItemMenuState;
  /** True when the node is in the favorites list (the toggle's direction). */
  isFavorited: boolean;
  onClose(): void;
  onOpen(nodeId: string): void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  onToggleFavorite(nodeId: string): void;
  onRemoveFromRecents(nodeId: string): void;
  /**
   * The Delete item requests confirmation — the modal itself lives in the
   * host (this menu closes on item click; a modal inside it would unmount).
   */
  onRequestDelete(): void;
}

export function SidebarItemMenu({
  state,
  isFavorited,
  onClose,
  onOpen,
  onOpenInSidebar,
  onToggleFavorite,
  onRemoveFromRecents,
  onRequestDelete,
}: SidebarItemMenuProps) {
  const { node } = state;
  const openLabel =
    node.nodeType === "block" ? "Open block" : node.nodeType === "class" ? "Open class" : "Open page";

  return (
      <ContextMenu
        companion
        position={{ x: state.x, y: state.y }}
        onClose={onClose}
        items={[
          {
            id: "open",
            label: openLabel,
            icon: "mdi-open-in-app",
            onClick: () => onOpen(node.id),
          },
          ...(onOpenInSidebar !== undefined
            ? [
                {
                  id: "open-sidebar",
                  label: "Open in sidebar",
                  icon: "mdi-dock-right",
                  onClick: () => onOpenInSidebar(node.id),
                },
              ]
            : []),
          { id: "sep-copy", label: "", separator: true },
          {
            id: "copy-link",
            label: "Copy link",
            icon: "mdi-link-variant",
            onClick: () => {
              copyToClipboard(nodeLinkUrl(node.id)).then(
                () => notificationStore.success("Node link copied", node.id),
                () => notificationStore.error("Couldn't copy", "Clipboard access was denied."),
              );
            },
          },
          {
            id: "favorite",
            label: isFavorited ? "Remove from Favorites" : "Add to Favorites",
            icon: isFavorited ? "mdi-star" : "mdi-star-outline",
            onClick: () => onToggleFavorite(node.id),
          },
          ...(state.list === "recents"
            ? [
                {
                  id: "remove-recent",
                  label: "Remove from recents",
                  icon: "mdi-history",
                  onClick: () => onRemoveFromRecents(node.id),
                },
              ]
            : []),
          { id: "sep-danger", label: "", separator: true },
          {
            id: "delete",
            label: "Delete",
            icon: "mdi-trash-can-outline",
            danger: true,
            onClick: onRequestDelete,
          },
        ]}
      />
  );
}
