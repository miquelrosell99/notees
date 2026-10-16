/**
 * NodeContextMenu — right-click menu for node surfaces (page headers, block
 * bullets/rows, class/tag pills). Actions: open, copy (markdown / node id /
 * link — the Copy › submenu), favorite, convert an inline block to a page
 * (the Convert to page › submenu: keep under the parent vs extract to root,
 * children staying or following), move a main child back to the content,
 * export (document-chrome nodes), the page banner upload (Add/Change
 * banner), remove pill (class/tag on an owner), delete.
 * Favorites toggle localStorage directly and broadcast so the sidebar
 * refreshes.
 *
 * Delete: inline blocks vanish instantly; pages and classes close the menu
 * and ask in the reusable ConfirmationModal (danger variant) — never an
 * inline two-step, and the message names the node by its display name (never
 * a raw uuid). `onDeleted` lets the host navigate away (parent page, else the
 * default view) once the delete lands. The confirmations latch their node
 * and render even while `state` is null: the menu closes the moment an item
 * fires (the host nulls our state on onClose), and the modal must outlive the
 * menu — before this latch, every host's onClose unmounted the confirmation
 * with the menu and neither the delete nor the convert dialog could appear.
 *
 * Convert › keep-under: promotion stringifies content server-side
 * (the title-is-content flatten — SCHEMA.md), so when the block carries rich
 * tokens the menu asks first, naming what will flatten;
 * extending the survivor set itself stays an owner ruling).
 */

import { useState } from "react";

import { parseDateNodeId, rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { cloneSubtree, type CloneReadSurface, type CloneWriteSurface } from "@/core/clone.js";
import { extractBlockToPage } from "@/core/extractToPage.js";
import type { ClientNode, ClientPropertySchema } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { nodeLinkUrl } from "../nodeLink.js";
import { parentRenderFacts, untitledLabelOf } from "../renderStateLabel.js";
import { copyToClipboard } from "./modals/clipboard.js";import { notificationStore } from "./ui/notificationStore.js";
import { clipboardMarkdown } from "./modals/exportSubtree.js";
import { refuseClassRemoval, removeClassDissolvingLinks } from "./classRemoval.js";
import { headingAstOf, headingConversionOf, plainTextAstOf } from "./headingConvert.js";
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
  /** The render-bit toggle behind "Move to content" / keep-under-parent. */
  updateObject(id: string, fields: { presentAsMain?: boolean }): Promise<void>;
  /** Content rewrites — the heading conversion rides this (headingConvert). */
  updateObject(id: string, fields: { contentAst?: ContentAst }): Promise<void>;
  /** Reparenting — the block→page extraction rides this (extractToPage). */
  moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void>;
  /** The extraction's child reparenting plans from a FRESH read, never the render cache. */
  getChildrenFresh(id: string): Promise<ClientNode[]> | ClientNode[];
  /** The Copy › markdown shapes compose through exportSubtree's read surface. */
  listPropertySchemas(): ClientPropertySchema[];
  effectiveClassColor(classId: string): string | null;
  effectiveClassIcons(): ReadonlyMap<string, string | null>;
  getDisplayName(id: string): string | null;
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
  class_link: "class chips",
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
          pendingPromote === null ? "" : `Convert "${displayLabelOf(pendingPromote)}" to a page?`
        }
        message={
          pendingPromote === null
            ? ""
            : `Keeping it under its parent flattens its rich content to plain text: ${promotionFlattenTypes(pendingPromote).join(", ")}. Whiteboards and queries survive.`
        }
        confirmLabel="Convert to page"
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
  // The parent's render facts, for the parent-page condition (owner ruling
  // 2026-10-15) — undefined when parentless or the row is not at hand.
  const parentFacts = parentRenderFacts(client, node);
  // What a promotion would flatten (empty when the content is already
  // text-only — the confirm modal stays out of that path entirely).
  const flattenTypes = promotionFlattenTypes(node);

  /** Clipboard write + the success/error toast pair every Copy shape shares. */
  const copyText = (text: string, successTitle: string): void => {
    copyToClipboard(text).then(
      () => notificationStore.success(successTitle, name),
      () => notificationStore.error("Couldn't copy", "Clipboard access was denied."),
    );
  };
  /** The Copy › markdown shapes — exportSubtree composes, we clipboard it. */
  const copyMarkdown = (withChildren: boolean): void => {
    try {
      copyText(
        clipboardMarkdown(client, node.id, withChildren),
        withChildren ? "Markdown with children copied" : "Markdown copied",
      );
    } catch (error: unknown) {
      console.warn(`[context-menu] copy markdown (${node.id}) failed:`, error);
      notificationStore.error("Couldn't copy as markdown", name);
    }
  };

  const items: ContextMenuItem[] = [
    {
      id: "open",
      label: "Open",
      icon: "mdi-open-in-app",
      onClick: () => onOpenNode(node.id),
    },
    // Copy › (owner 2026-10-16): one bucket for the clipboard shapes —
    // the node as markdown (its own content, or with its child blocks as
    // nested bullets), the raw node id, and the app link. A fire copies
    // and toasts; a composition failure warns instead of writing nothing.
    {
      id: "copy",
      label: "Copy",
      icon: "mdi-content-copy",
      submenuItems: [
        {
          id: "copy-markdown",
          label: "Markdown",
          icon: "mdi-language-markdown-outline",
          onClick: () => copyMarkdown(false),
        },
        {
          id: "copy-markdown-children",
          label: "Markdown with children",
          icon: "mdi-language-markdown",
          onClick: () => copyMarkdown(true),
        },
        {
          id: "copy-node-id",
          label: "Node id",
          icon: "mdi-identifier",
          onClick: () =>
            copyText(node.id, "Node id copied"),
        },
        {
          id: "copy-link",
          label: "Link",
          icon: "mdi-link-variant",
          onClick: () => copyText(nodeLinkUrl(node.id), "Node link copied"),
        },
      ],
    },
  ];
  // Favorites surface pages/classes in the sidebar; an inline block has no
  // sidebar presence, so the toggle is hidden for the inline-body branch.
  if (!rendersAsInlineBlock(node, parentFacts)) {
    items.push({
      id: "favorite",
      label: favorite ? "Remove from favorites" : "Add to favorites",
      icon: favorite ? "mdi-star" : "mdi-star-outline",
      onClick: () => toggleFavorite(node.id),
    });
  }
  // Zone flip (Revision 11), demote direction only: a parented main child
  // returns to the inline body. The promote direction (inline → Pages zone)
  // lives in the "Convert to page" submenu below, grouped with the root
  // extraction so the two "make this a page" paths read as one deliberate
  // choice instead of two confusingly-named siblings.
  if (node.parentId !== null && node.presentAsMain) {
    items.push({
      id: "move-to-content",
      label: "Move to content",
      icon: "mdi-format-indent-decrease",
      onClick: () => void client.updateObject(node.id, { presentAsMain: false }),
    });
  }
  // Heading conversion (owner 2026-10-12 — the v1 "Convert to heading"
  // gesture, on the content grammar's `heading` token): shown conditionally,
  // each direction an ordinary undoable object.update. A single plain text
  // run converts TO a heading; a single heading token converts back to one
  // plain text run (children flattened, marks carried only in the
  // to-heading direction).
  const headingShape = headingConversionOf(node);
  if (headingShape === "to-heading") {
    items.push({
      id: "convert-to-heading",
      label: "Convert to heading",
      icon: "mdi-format-header-1",
      onClick: () => void client.updateObject(node.id, { contentAst: headingAstOf(node) }),
    });
  } else if (headingShape === "from-heading") {
    items.push({
      id: "convert-to-plain-text",
      label: "Convert to plain text",
      icon: "mdi-format-letter-case",
      onClick: () => void client.updateObject(node.id, { contentAst: plainTextAstOf(node) }),
    });
  }
  // Convert to page (owner 2026-10-16): ONE bucket for "make this block a
  // page", the variants self-describing plain clicks (no modifier keys, no
  // modal — the gesture is reversible, the choice is two clicks). KEEP UNDER
  // the parent = the presentAsMain zone flip (the node stays in the family,
  // listed in the parent's Pages zone; its rich content flattens — hence
  // the BC4 confirm when it carries rich tokens). EXTRACT = the block leaves
  // the parent and becomes a root page — the SAME node, not a new one — a
  // mention link block takes its exact slot, and the children either STAY
  // in the page (under the link block, order preserved) or FOLLOW the
  // block. The rows read short ("Children stay here" / "Children follow");
  // the full explanation — the link block, the same-node ruling — rides
  // the hover tooltips. Date-chain nodes are parent-locked and never
  // offered.
  if (rendersAsInlineBlock(node) && parseDateNodeId(node.id) === null) {
    const parentNode = node.parentId === null ? undefined : client.getNode(node.parentId);
    const parentName = parentNode === undefined ? "parent" : displayLabelOf(parentNode);
    // Parent-page condition (owner ruling 2026-10-15): KEEP UNDER only
    // exists under a page parent — the store rejects the bit under a class
    // or an inline block (move the block under a page first). A missing
    // parent row means "not at hand": the write-time invariant covers it.
    // EXTRACT TO ROOT is always legal (a parentless node renders with
    // document chrome by the second cascade branch).
    const promoteAllowed = parentNode === undefined || rendersWithDocumentChrome(parentNode);
    const extract = (keepChildren: boolean): void => {
      void extractBlockToPage(client, client, node.id, { keepChildren })
        .then(() => notificationStore.success("Converted to page", name))
        .catch((error: unknown) => {
          console.warn(`[context-menu] convert-to-page (${node.id}) failed:`, error);
          notificationStore.error("Couldn't convert to page", name);
        });
    };
    items.push({
      id: "convert-to-page",
      label: "Convert to page",
      icon: "mdi-file-document-outline",
      submenuItems: [
        ...(promoteAllowed
          ? [
              {
                id: "keep-under-parent",
                label: `Keep under "${parentName}"`,
                tooltip: "The block stays in this page, listed in its Pages zone.",
                icon: "mdi-file-tree-outline",
                onClick: () => {
                  // BC4 guard: this direction flattens rich tokens to one text
                  // run — ask first, naming what will flatten. Text-only content
                  // (or widgets that survive) converts immediately.
                  if (flattenTypes.length > 0) setPendingPromote(node);
                  else void client.updateObject(node.id, { presentAsMain: true });
                },
              },
            ]
          : []),
        {
          id: "extract-children-stay",
          label: "Children stay here",
          tooltip:
            "The block becomes a root page; a link block takes its place in this page, and the children stay nested under the link.",
          icon: "mdi-file-document-outline",
          onClick: () => extract(false),
        },
        {
          id: "extract-children-follow",
          label: "Children follow",
          tooltip:
            "The block becomes a root page; a link block takes its place, and the children stay with the block — the same node, now a root page.",
          icon: "mdi-file-document-multiple-outline",
          onClick: () => extract(true),
        },
      ],
    });
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
        else void removeClassDissolvingLinks(client, ownerId, node.id);
      },
    });
  }
  items.push({ id: "s2", label: "", separator: true });
  // Inline blocks delete instantly; pages and classes ask in the reusable
  // ConfirmationModal (danger) — the menu closes, the modal decides.
  const confirmDelete = !rendersAsInlineBlock(node, parentFacts);
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
