/**
 * NodeContextMenu — right-click menu for node surfaces (page headers, block
 * bullets/rows, class/tag pills). Actions: open, copy link, favorite,
 * move between the body and the Pages zone (parented nodes), export
 * (document-chrome nodes), the page banner upload (Add/Change banner),
 * remove pill (class/tag on an owner), delete.
 * Favorites toggle localStorage directly and broadcast so the sidebar
 * refreshes.
 *
 * Delete: inline blocks vanish instantly; pages and classes close the menu
 * and ask in the reusable ConfirmationModal (danger variant) — never an
 * inline two-step, and the message names the node by its display name (never
 * a raw uuid). `onDeleted` lets the host navigate away (parent page, else the
 * default view) once the delete lands. The confirmations latch their node
 * and render even while `state` is null: the menu closes the moment an item
 * fires (the host nulls our state), and the modal must outlive the menu —
 * before this latch, every host's onClose unmounted the confirmation with
 * the menu and neither the delete nor the promote dialog could appear.
 *
 * Promote ("Move to Pages"): promotion stringifies content server-side
 * (the title-is-content flatten — SCHEMA.md), so when the block carries rich
 * tokens the menu asks first, naming what will flatten;
 * extending the survivor set itself stays an owner ruling).
 */

import { useState } from "react";

import { rendersAsInlineBlock } from "@notees/domain";

import { cloneSubtree, type CloneReadSurface, type CloneWriteSurface } from "@/core/clone.js";
import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { nodeLinkUrl } from "../nodeLink.js";
import { untitledLabelOf } from "../renderStateLabel.js";
import { copyToClipboard } from "./modals/clipboard.js";import { notificationStore } from "./ui/notificationStore.js";
import { refuseClassRemoval } from "./classRemoval.js";
import { ConfirmationModal } from "./ui/ConfirmationModal.js";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu.js";

/**
 * The minimal client surface the menu needs (both client classes and the
 * outliner seam satisfy it). The clone surfaces power "Duplicate": a real
 * subtree clone through the shared engine —
 * the DuplicatePageModal name-conflict dialog is a different feature and
 * keeps its name).
 */
interface MenuClient extends CloneReadSurface, CloneWriteSurface {
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

/**
 * Human names for the token types a promotion to a page flattens away
 * (stringifyContentAst keeps text + whiteboard/query only — packages/domain
 * node.ts). Unknown future types flatten too; they name as generic rich
 * content rather than being silently ignored.
 */
const FLATTEN_TOKEN_LABELS: Record<string, string> = {
  mention: "mentions",
  class_chip: "class chips",
  typed_link: "typed links",
  external_link: "external links",
  math: "math",
  asset_ref: "asset attachments",
  embed_ref: "embeds",
  quote: "quotes",
};

/** The distinct flattening token types a block carries; empty = lossless. */
function promotionFlattenTypes(node: ClientNode): string[] {
  const labels = new Set<string>();
  for (const token of node.contentAst) {
    if (token.type === "text" || token.type === "hard_break") continue;
    if (token.type === "whiteboard" || token.type === "query") continue;
    labels.add(FLATTEN_TOKEN_LABELS[token.type] ?? "other rich content");
  }
  return [...labels];
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
  onShare,
  onPresent,
  onChangeColor,
  onRemoveFromOwner,
  onDeleted,
  onDuplicated,
}: {
  state: NodeMenuState;
  client: MenuClient;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
  onExport?: ((pageId: string, name: string) => void) | undefined;
  /** Shares: "Share…" opens the page's public read-only link manager. */
  onShare?: ((pageId: string, name: string) => void) | undefined;
  /** Presentation mode: "Present" decks the page's subtree read-only. */
  onPresent?: ((pageId: string) => void) | undefined;
  /** Present for class nodes: "Change color…" opens the swatch row. */
  onChangeColor?: ((x: number, y: number) => void) | undefined;
  /** Overrides the "Remove from this node" action (tags use unassignTag). */
  onRemoveFromOwner?: (() => void) | undefined;
  /** Called after a delete lands (host navigates: parent page / default view). */
  onDeleted?: ((node: ClientNode) => void) | undefined;
  /** Called with the fresh id after "Duplicate" lands (hosts may navigate). */
  onDuplicated?: ((nodeId: string) => void) | undefined;
}) {
  const [pendingDelete, setPendingDelete] = useState<ClientNode | null>(null);
  const [pendingPromote, setPendingPromote] = useState<ClientNode | null>(null);

  // The confirmations latch their node and render even while `state` is
  // null: firing a menu item closes the menu (the host nulls our state on
  // onClose), and the modal must outlive the menu — the component instance
  // stays mounted, only its render is gated. ConfirmationModal renders
  // nothing while isOpen is false.
  const confirmModals = (
    <>
      <ConfirmationModal
        isOpen={pendingDelete !== null}
        title={pendingDelete === null ? "" : `Delete ${displayLabelOf(pendingDelete)}?`}
        message={
          pendingDelete === null
            ? ""
            : `This will delete "${displayLabelOf(pendingDelete)}" and everything it contains.`
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          if (pendingDelete === null) return;
          const target = pendingDelete;
          await client.deleteObject(target.id);
          setPendingDelete(null);
          onClose();
          onDeleted?.(target);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmationModal
        isOpen={pendingPromote !== null}
        title={
          pendingPromote === null ? "" : `Move "${displayLabelOf(pendingPromote)}" to Pages?`
        }
        message={
          pendingPromote === null
            ? ""
            : `Promoting this block to a page flattens its rich content to plain text: ${promotionFlattenTypes(pendingPromote).join(", ")}. Whiteboards and queries survive.`
        }
        confirmLabel="Move to Pages"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={async () => {
          if (pendingPromote === null) return;
          await client.updateObject(pendingPromote.id, { presentAsMain: true });
          setPendingPromote(null);
          onClose();
        }}
        onCancel={() => setPendingPromote(null)}
      />
    </>
  );

  if (state === null) return confirmModals;
  const { node, ownerId, isPage } = state;
  const favorite = readFavorites().includes(node.id);
  const name = displayLabelOf(node);
  // What a promotion would flatten (empty when the content is already
  // text-only — the confirm modal stays out of that path entirely).
  const flattenTypes = promotionFlattenTypes(node);

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
            onClick: () => {
              // BC4 guard: promotion flattens rich tokens to one text run —
              // ask first, naming what will flatten. Text-only content (or
              // widgets that survive) promotes immediately.
              if (flattenTypes.length > 0) setPendingPromote(node);
              else void client.updateObject(node.id, { presentAsMain: true });
            },
          },
    );
  }
  // Duplicate: a real subtree clone through the shared
  // engine, placed right after the source (roots land with the other
  // root pages). Deliberately provenance-free — a copy is not "generated
  // from" a template.
  items.push({
    id: "duplicate",
    label: "Duplicate",
    icon: "mdi-content-duplicate",
    onClick: () => {
      onClose();
      void cloneSubtree(
        { reads: client, writes: client },
        {
          rootId: node.id,
          parentId: node.parentId,
          ...(node.parentId !== null ? { afterId: node.id } : {}),
        },
      )
        .then((freshId) => {
          notificationStore.success("Duplicated", name);
          onDuplicated?.(freshId);
        })
        .catch((error: unknown) => {
          console.warn(`[context-menu] duplicate (${node.id}) failed:`, error);
          notificationStore.error("Couldn't duplicate", name);
        });
    },
  });
  if (isPage && onPresent !== undefined) {
    items.push({
      id: "present",
      label: "Present",
      icon: "mdi-presentation-play",
      onClick: () => onPresent(node.id),
    });
  }
  if (isPage && onShare !== undefined && !node.isClass) {
    items.push({
      id: "share",
      label: "Share…",
      icon: "mdi-share-variant",
      onClick: () => onShare(node.id, name),
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
        // System/journal classes refuse membership removal.
        if (refuseClassRemoval(node.id)) return;
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
          onClick: () => setPendingDelete(node),
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
      {confirmModals}
    </>
  );
}
