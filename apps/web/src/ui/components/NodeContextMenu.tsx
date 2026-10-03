/**
 * NodeContextMenu — right-click menu for node surfaces (page headers, block
 * bullets/rows, class/tag pills). Actions: open, copy link, favorite,
 * move between the body and the Pages zone (parented nodes), export
 * (document-chrome nodes), remove pill (class/tag on an owner), delete.
 * Favorites toggle localStorage directly and broadcast so the sidebar
 * refreshes.
 *
 * Delete: inline blocks vanish instantly; pages and classes close the menu
 * and ask in the reusable ConfirmationModal (danger variant) — never an
 * inline two-step, and the message names the node by its display name (never
 * a raw uuid). `onDeleted` lets the host navigate away (parent page, else the
 * default view) once the delete lands.
 */

import { useState } from "react";

import { rendersAsInlineBlock } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { nodeLinkUrl } from "../nodeLink.js";
import { untitledLabelOf } from "../renderStateLabel.js";
import { copyToClipboard } from "./modals/clipboard.js";import { notificationStore } from "./ui/notificationStore.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu.js";

/** The minimal client surface the menu needs (both client classes satisfy it). */
interface MenuClient {
  unassignClass(id: string, classId: string): Promise<void>;
  deleteObject(id: string, opts?: { permanent?: boolean }): Promise<void>;
  /** The render-bit toggle behind "Move to Pages" / "Move to content". */
  updateObject(id: string, fields: { presentAsMain?: boolean }): Promise<void>;
}

export type NodeMenuState =
  | {
      x: number;
      y: number;
      node: ClientNode;
      ownerId?: string;
      isPage: boolean;
      /**
       * Button anchor (three-dot menus): when present the menu opens
       * right-aligned to this element instead of at the x/y point.
       */
      anchorEl?: HTMLElement | null;
    }
  | null;

/** Human label for a node in destructive messages: display name, never an id. */
export function displayLabelOf(node: ClientNode): string {
  return displayNameForSettings(node) || untitledLabelOf(node);
}

export function readFavorites(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("notees.favorites") || "[]");
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

function toggleFavorite(id: string): void {
  const favorites = readFavorites();
  const next = favorites.includes(id) ? favorites.filter((e) => e !== id) : [...favorites, id];
  try {
    localStorage.setItem("notees.favorites", JSON.stringify(next));
  } catch {
    // Storage unavailable; the toggle just won't persist.
  }
  window.dispatchEvent(new Event("notees:favorites"));
}

export function NodeContextMenu({
  state,
  client,
  onClose,
  onOpenNode,
  onExport,
  onPresent,
  onChangeColor,
  onRemoveFromOwner,
  onDeleted,
}: {
  state: NodeMenuState;
  client: MenuClient;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onExport?: ((pageId: string, name: string) => void) | undefined;
  /** Presentation mode (§34.26): "Present" decks the page's subtree read-only. */
  onPresent?: ((pageId: string) => void) | undefined;
  /** Present for class nodes: "Change color…" opens the swatch row. */
  onChangeColor?: ((x: number, y: number) => void) | undefined;
  /** Overrides the "Remove from this node" action (tags use unassignTag). */
  onRemoveFromOwner?: (() => void) | undefined;
  /** Called after a delete lands (host navigates: parent page / default view). */
  onDeleted?: ((node: ClientNode) => void) | undefined;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (state === null) return null;
  const { node, ownerId, isPage } = state;
  const favorite = readFavorites().includes(node.id);
  const name = displayLabelOf(node);

  const items: ContextMenuItem[] = [
    {
      id: "open",
      label: "Open",
      icon: "mdi-open-in-app",
      onClick: () => onOpenNode(node.id),
    },
    {
      id: "copy-link",
      label: "Copy link",
      icon: "mdi-link-variant",
      onClick: () => {
        copyToClipboard(nodeLinkUrl(node.id)).then(
          () => notificationStore.success("Node link copied", name),
          () => notificationStore.error("Couldn't copy", "Clipboard access was denied."),
        );
      },
    },
  ];
  // Favorites surface pages/classes in the sidebar; an inline block has no
  // sidebar presence, so the toggle is hidden for the inline-body branch.
  if (!rendersAsInlineBlock(node)) {
    items.push({
      id: "favorite",
      label: favorite ? "Remove from favorites" : "Add to favorites",
      icon: favorite ? "mdi-star" : "mdi-star-outline",
      onClick: () => toggleFavorite(node.id),
    });
  }
  // Zone flip (Revision 11): a parented node shows the one toggle that
  // changes its render zone — inline body → the Pages zone (promotion
  // stringifies content server-side), main child → the inline body.
  // Classes are always parentless by the placement CHECK, so this only ever
  // targets non-class nodes. One undoable object.update gesture.
  if (node.parentId !== null) {
    items.push(
      node.presentAsMain
        ? {
            id: "move-to-content",
            label: "Move to content",
            icon: "mdi-format-indent-decrease",
            onClick: () => void client.updateObject(node.id, { presentAsMain: false }),
          }
        : {
            id: "move-to-pages",
            label: "Move to Pages",
            icon: "mdi-file-tree-outline",
            onClick: () => void client.updateObject(node.id, { presentAsMain: true }),
          },
    );
  }
  if (isPage && onPresent !== undefined) {
    items.push({
      id: "present",
      label: "Present",
      icon: "mdi-presentation-play",
      onClick: () => onPresent(node.id),
    });
  }
  if (isPage && onExport !== undefined) {
    items.push({
      id: "export",
      label: "Export…",
      icon: "mdi-export",
      onClick: () => onExport(node.id, name),
    });
  }
  if (onChangeColor !== undefined) {
    items.push({
      id: "change-color",
      label: "Change color…",
      icon: "mdi-palette-outline",
      onClick: () => onChangeColor(state.x, state.y),
    });
  }
  if (ownerId !== undefined && ownerId !== node.id) {
    items.push({ id: "s1", label: "", separator: true });
    items.push({
      id: "remove",
      label: "Remove from this node",
      icon: "mdi-close-circle-outline",
      onClick: () => {
        if (onRemoveFromOwner !== undefined) onRemoveFromOwner();
        else void client.unassignClass(ownerId, node.id);
      },
    });
  }
  items.push({ id: "s2", label: "", separator: true });
  // Inline blocks delete instantly; pages and classes ask in the reusable
  // ConfirmationModal (danger) — the menu closes, the modal decides.
  const confirmDelete = !rendersAsInlineBlock(node);
  items.push(
    confirmDelete
      ? {
          id: "delete",
          label: "Delete",
          icon: "mdi-delete-outline",
          danger: true,
          onClick: () => setConfirmingDelete(true),
        }
      : {
          id: "confirm-delete",
          label: "Delete",
          icon: "mdi-delete-outline",
          danger: true,
          onClick: () => {
            void client.deleteObject(node.id).then(() => onDeleted?.(node));
            onClose();
          },
        },
  );

  return (
    <>
      <ContextMenu
        items={items}
        position={{ x: state.x, y: state.y }}
        anchorEl={state.anchorEl ?? undefined}
        alignRight={state.anchorEl != null}
        onClose={onClose}
      />
      <ConfirmationModal
        isOpen={confirmingDelete}
        title={`Delete ${name}?`}
        message={`This will delete "${name}" and everything it contains.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          await client.deleteObject(node.id);
          setConfirmingDelete(false);
          onClose();
          onDeleted?.(node);
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}
