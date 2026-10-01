/**
 * NodeContextMenu — right-click menu for node surfaces (page headers, block
 * bullets/rows, class/tag pills). Actions: open, copy link, favorite,
 * export (pages), remove pill (class/tag on an owner), delete. Favorites
 * toggle localStorage directly and broadcast so the sidebar refreshes.
 *
 * Delete: blocks vanish instantly; pages and classes close the menu and ask
 * in the reusable ConfirmationModal (danger variant) — never an inline
 * two-step, and the message names the node by its display name (never a
 * raw uuid). `onDeleted` lets the host navigate away (parent page, else the
 * default view) once the delete lands.
 */

import { useState } from "react";

import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu.js";

/** The minimal client surface the menu needs (both client classes satisfy it). */
interface MenuClient {
  unassignClass(id: string, classId: string): Promise<void>;
  deleteObject(id: string, opts?: { permanent?: boolean }): Promise<void>;
}

export type NodeMenuState =
  | { x: number; y: number; node: ClientNode; ownerId?: string; isPage: boolean }
  | null;

/** Human label for a node in destructive messages: display name, never an id. */
export function displayLabelOf(node: ClientNode): string {
  return (
    displayNameForSettings(node) ||
    (node.nodeType === "page" ? "Untitled page" : node.nodeType === "class" ? "Untitled class" : "Untitled block")
  );
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
  onChangeColor,
  onRemoveFromOwner,
  onDeleted,
}: {
  state: NodeMenuState;
  client: MenuClient;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onExport?: ((pageId: string, name: string) => void) | undefined;
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
        const url = `${window.location.origin}/${node.id}`;
        void navigator.clipboard?.writeText(url).catch(() => undefined);
      },
    },
  ];
  // Favorites surface pages/classes in the sidebar; a bare block has no
  // sidebar presence, so the toggle is hidden for node_type === 'block'.
  if (node.nodeType !== "block") {
    items.push({
      id: "favorite",
      label: favorite ? "Remove from favorites" : "Add to favorites",
      icon: favorite ? "mdi-star" : "mdi-star-outline",
      onClick: () => toggleFavorite(node.id),
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
  // Blocks delete instantly; pages and classes ask in the reusable
  // ConfirmationModal (danger) — the menu closes, the modal decides.
  const confirmDelete = node.nodeType !== "block";
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
      <ContextMenu items={items} position={{ x: state.x, y: state.y }} onClose={onClose} />
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
