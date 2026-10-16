/**
 * Breadcrumbs — the page-ancestry chain at the top of the content card.
 * ancestor pages separated by mdi-chevron-right, collapsing to
 * [first] [second] […] [second-to-last] [last] beyond four items, the
 * ellipsis opening a popup of the hidden ancestors.
 *
 * Data wiring: the chain walks node.parentId via client.getNode
 * until the workspace root (no ancestors → nothing renders). The parent
 * re-renders on client notifications, so renames refresh the chain.
 *
 * The trail is ancestors only — the current node never crumbs itself
 * (owner 2026-10-13: the page header already names the page).
 *
 * Edit gestures (opt-in via `editable`):
 * hovering a crumb reveals a chevron and right-click opens the same menu —
 * Open / Reassign parent… / Remove parent — acting on the EDGE BELOW the
 * crumb: the menu edits the parent relationship between the crumb and the
 * node directly under it (for the direct parent crumb, that node is the
 * page itself — the button edits or removes THAT parent). A parentless
 * node instead offers the trailing "+ Add parent" pill. Single-parent
 * tree: every gesture is one object.move. Date-chain nodes are parent-locked
 * (SCHEMA.md "Datetime"): every affordance whose target is a date node
 * (the edge into it, the Add-parent pill) hides itself.
 */

import { useEffect, useRef, useState, type MouseEvent } from "react";

import { parseDateNodeId } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { untitledLabelOf } from "../renderStateLabel.js";
import { Icon } from "../Icon.js";
import { AddPill } from "./ui/AddPill.js";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu.js";
import { HoverRevealButton } from "./ui/HoverRevealButton.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import "./Breadcrumbs.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Hard cap on the walk — a corrupt cycle must never hang the render. */
const MAX_CHAIN = 32;

/** Show everything up to this many ancestors; beyond, collapse the middle. */
const COLLAPSE_AT = 4;
const VISIBLE_START = 2;
const VISIBLE_END = 2;

interface Crumb {
  node: ClientNode;
  name: string;
}

/** Per-crumb cap: long page/block names clip to "XXXX…" inside the trail. */
const CRUMB_NAME_MAX = 28;
export function clipCrumbName(name: string, max: number = CRUMB_NAME_MAX): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** The date-chain parenting lock (SCHEMA.md "Datetime"): the edge into a
 *  date node is fixed (year → root, month → year, day → month), so every
 *  parent-edit affordance on such an edge — or on a parentless date node —
 *  hides itself; the store guard rejects the move anyway. */
function isDateLocked(node: ClientNode | undefined): boolean {
  return node !== undefined && parseDateNodeId(node.id) !== null;
}

/** Human crumb label: display name, never a raw uuid; per-crumb capped.
 *  A title that IS only a class chip excerpts to "" at the domain layer (the
 *  chip's label is graph state) — fall back to the chip's resolved class
 *  display name so the crumb never reads "Untitled". */
function crumbNameOf(client: AnyClient, node: ClientNode): string {
  const excerpt = displayNameForSettings(node);
  if (excerpt !== "") return clipCrumbName(excerpt);
  const chip = node.contentAst.find(
    (token) => token.type === "class_link",
  ) as { classId?: string } | undefined;
  if (chip !== undefined && typeof chip.classId === "string") {
    const resolved = client.getDisplayName(chip.classId);
    if (resolved !== null && resolved !== "") return clipCrumbName(resolved);
  }
  return clipCrumbName(untitledLabelOf(node));
}

function ancestryOf(client: AnyClient, nodeId: string): Crumb[] {
  const chain: Crumb[] = [];
  const seen = new Set<string>([nodeId]);
  let current = client.getNode(nodeId);
  while (current !== undefined && current.parentId !== null && chain.length < MAX_CHAIN) {
    const parentId = current.parentId;
    if (seen.has(parentId)) break; // cycle guard
    seen.add(parentId);
    const parent = client.getNode(parentId);
    if (parent === undefined) break;
    // Never render a raw UUID: unnamed pages/blocks get a human label.
    chain.unshift({ node: parent, name: crumbNameOf(client, parent) });
    current = parent;
  }
  return chain;
}

export function Breadcrumbs({
  client,
  nodeId,
  onOpenNode,
  stopAfterId,
  excludeIds,
  excludeLeaf = false,
  anchor = "left",
  /** Parent-edit gestures: crumb chevron/right-click menus + Add parent. */
  editable = false,
  /** The "+ Add parent" pill on a parentless node (default on with `editable`).
   *  Surfaces that edit only EXISTING parents (the card's breadcrumb row) opt
   *  out — the pill is noise there (owner 2026-10-13). */
  addParent = true,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /** Truncate the chain AT this node (inclusive): ancestors above it drop. */
  stopAfterId?: string | undefined;
  /** Crumb ids to drop from the rendered trail (e.g. the page under a
   *  group-by-page reference list, whose header already names it). */
  excludeIds?: readonly string[] | undefined;
  /** Drop the trailing crumb (the node itself) — its content renders below. */
  excludeLeaf?: boolean | undefined;
  /**
   * Overflow anchor. "left" (default) packs the trail from the left and clips
   * the right end (the deepest crumbs truncate). "right" packs from the
   * right and clips the LEFT end — top-level parents hide behind a leading
   * "…" button that pops up the full trail. Per-crumb names are always
   * capped (see clipCrumbName).
   */
  anchor?: "left" | "right" | undefined;
  editable?: boolean | undefined;
  /** False hides the "+ Add parent" pill (existing-parents-only surfaces). */
  addParent?: boolean | undefined;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [leadPopupOpen, setLeadPopupOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const [leadClipped, setLeadClipped] = useState(false);
  /** Edit menu: the edge being edited (the crumb and the node under it). */
  const [editMenu, setEditMenu] = useState<{
    parent: ClientNode;
    child: ClientNode;
    position: { x: number; y: number };
  } | null>(null);
  /** Parent picker target (the node whose parent is being reassigned/added). */
  const [parentPicker, setParentPicker] = useState<{
    nodeId: string;
    position: { x: number; y: number };
  } | null>(null);

  const currentNode = client.getNode(nodeId);
  let items = ancestryOf(client, nodeId);
  if (stopAfterId !== undefined) {
    const stopAt = items.findIndex((item) => item.node.id === stopAfterId);
    if (stopAt !== -1) items = items.slice(stopAt);
  }
  if (excludeIds !== undefined && excludeIds.length > 0) {
    const drop = new Set(excludeIds);
    items = items.filter((item) => !drop.has(item.node.id));
  }
  if (excludeLeaf && items.length > 0) items = items.slice(0, -1);
  // Owner rule (2026-10-04): a parentless node hides itself from the trail —
  // there is no chain to trail — and offers only the Add parent affordance
  // (never on classes: classes are always roots, a parent is unrepresentable;
  // never on date nodes: the chain parent is locked). Surfaces that only edit
  // existing parents opt out of the pill via `addParent={false}`.
  const showAddParent =
    addParent &&
    editable &&
    currentNode !== undefined &&
    currentNode.parentId === null &&
    !currentNode.isClass &&
    !isDateLocked(currentNode);

  // Right-anchored trails: detect left-side overflow so the lead "…" button
  // appears exactly when top-level crumbs are being clipped. Measurement is
  // layout-only (jsdom rects stay zero → the button simply never shows).
  // Runs BEFORE any early return: the hook order must stay stable across
  // the empty→populated store re-render (deep links render null first).
  useEffect(() => {
    if (anchor !== "right") return;
    const el = navRef.current;
    if (el === null) return;
    const update = () => setLeadClipped(el.scrollWidth > el.clientWidth + 1);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, items]);

  if (items.length === 0 && !showAddParent) return null;

  const needsCollapse = items.length > COLLAPSE_AT;
  const startItems = needsCollapse ? items.slice(0, VISIBLE_START) : items;
  const hiddenItems = needsCollapse
    ? items.slice(VISIBLE_START, items.length - VISIBLE_END)
    : [];
  const endItems = needsCollapse ? items.slice(items.length - VISIBLE_END) : [];

  /** Open the crumb's edit menu (right-click, or the hover chevron). */
  const openEditMenu = (
    event: MouseEvent,
    parent: ClientNode,
    child: ClientNode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setEditMenu({ parent, child, position: { x: event.clientX, y: event.clientY } });
  };

  /** The parentage menu for the edge below one crumb: reassign/remove the
   *  CHILD's parent (the crumb) — for the direct parent crumb that edits
   *  the page's own parentage. */
  const editMenuItems = (
    parent: ClientNode,
    child: ClientNode,
    position: { x: number; y: number },
  ): ContextMenuItem[] => [
    {
      id: "open",
      label: "Open",
      icon: "mdi-arrow-top-right",
      onClick: () => onOpenNode?.(parent.id),
    },
    {
      id: "reassign",
      label: "Reassign parent…",
      icon: "mdi-file-move-outline",
      onClick: () => setParentPicker({ nodeId: child.id, position }),
    },
    {
      id: "remove",
      label: "Remove parent",
      icon: "mdi-link-variant-off",
      danger: true,
      onClick: () => void client.moveObject(child.id, null).catch(() => undefined),
    },
  ];

  /** The node directly under a crumb in the trail (the edge the crumb's
   *  edit menu acts on): the next trail item, else the current node itself
   *  under the direct parent crumb. Undefined only when the current node is
   *  missing from the store — no edge to edit, so the crumb renders without
   *  the edit affordance. */
  const childBelowOf = (item: Crumb): ClientNode | undefined => {
    const index = items.findIndex((entry) => entry.node.id === item.node.id);
    const next = items[index + 1];
    if (next !== undefined) return next.node;
    return currentNode;
  };

  const crumb = (item: Crumb, key: string, showSeparator: boolean) => {
    const childBelow = childBelowOf(item);
    // The date-chain parenting lock: an edge whose child is a date node has
    // no edit affordance (reassign/remove would be rejected by the store).
    const edgeEditable = editable && childBelow !== undefined && !isDateLocked(childBelow);
    return (
    <span key={key} className="node-breadcrumb-item ui-hover-reveal-group">
      <button
        type="button"
        className="node-breadcrumb-link"
        onClick={() => onOpenNode?.(item.node.id)}
        onContextMenu={
          edgeEditable
            ? (event) => openEditMenu(event, item.node, childBelow)
            : undefined
        }
      >
        {client.effectiveNodeIcon(item.node) !== null && (
          <Icon
            path={client.effectiveNodeIcon(item.node)!}
            size={0.8}
            className="node-breadcrumb-icon"
          />
        )}
        <span className="node-breadcrumb-name">{item.name}</span>
      </button>
      {edgeEditable && (
        <HoverRevealButton
          className="node-breadcrumb-edit"
          aria-label={`Edit parent of ${crumbNameOf(client, childBelow)}`}
          title="Edit parent"
          onClick={(event) => openEditMenu(event, item.node, childBelow)}
        >
          <Icon path="mdi-menu-down" size={0.7} />
        </HoverRevealButton>
      )}
      {showSeparator && (
        <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
      )}
    </span>
    );
  };

  return (
    <nav
      ref={navRef}
      className={`node-breadcrumbs${anchor === "right" ? " node-breadcrumbs--anchor-right" : ""}`}
      aria-label="Page hierarchy"
    >
      {anchor === "right" && leadClipped && (
        <span className="node-breadcrumb-item node-breadcrumb-lead-clip">
          <button
            type="button"
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            aria-label="Show hidden breadcrumbs"
            aria-expanded={leadPopupOpen}
            onClick={() => setLeadPopupOpen((open) => !open)}
          >
            …
          </button>
          <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
          {leadPopupOpen && (
            <>
              <button
                type="button"
                className="node-breadcrumb-popup-backdrop"
                aria-label="Close breadcrumbs popup"
                onClick={() => setLeadPopupOpen(false)}
              />
              <div className="node-breadcrumb-popup-anchor">
                <div className="node-breadcrumbs-popup">
                  {items.map(
                    (item) => (
                      <button
                        key={item.node.id}
                        type="button"
                        className="node-breadcrumbs-popup-item"
                        onClick={() => {
                          setLeadPopupOpen(false);
                          onOpenNode?.(item.node.id);
                        }}
                      >
                        {client.effectiveNodeIcon(item.node) !== null && (
                          <Icon
                            path={client.effectiveNodeIcon(item.node)!}
                            size={0.8}
                            className="node-breadcrumb-popup-icon"
                          />
                        )}
                        <span className="node-breadcrumb-popup-name">{item.name}</span>
                      </button>
                    ),
                  )}
                </div>
              </div>
            </>
          )}
        </span>
      )}
      {startItems.map((item, index) =>
        crumb(
          item,
          item.node.id,
          needsCollapse || index < startItems.length - 1,
        ),
      )}

      {needsCollapse && (
        <span className="node-breadcrumb-item node-breadcrumb-ellipsis-container">
          <button
            type="button"
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            aria-label={`Show ${hiddenItems.length} more breadcrumbs`}
            aria-expanded={popupOpen}
            onClick={() => setPopupOpen((open) => !open)}
          >
            …
          </button>
          <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
          {popupOpen && (
            <>
              <button
                type="button"
                className="node-breadcrumb-popup-backdrop"
                aria-label="Close breadcrumbs popup"
                onClick={() => setPopupOpen(false)}
              />
              <div className="node-breadcrumb-popup-anchor">
                <div className="node-breadcrumbs-popup">
                  {hiddenItems.map((item) => (
                    <button
                      key={item.node.id}
                      type="button"
                      className="node-breadcrumbs-popup-item"
                      onClick={() => {
                        setPopupOpen(false);
                        onOpenNode?.(item.node.id);
                      }}
                    >
                      {client.effectiveNodeIcon(item.node) !== null && (
                        <Icon
                          path={client.effectiveNodeIcon(item.node)!}
                          size={0.8}
                          className="node-breadcrumb-popup-icon"
                        />
                      )}
                      <span className="node-breadcrumb-popup-name">{item.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </span>
      )}

      {needsCollapse &&
        endItems.map((item, index) =>
          crumb(item, item.node.id, index < endItems.length - 1),
        )}

      {showAddParent && (
        <AddPill
          label="Add parent"
          onClick={(element) => {
            const rect = element.getBoundingClientRect();
            setParentPicker({
              nodeId: currentNode!.id,
              position: { x: rect.left + rect.width / 2, y: rect.bottom },
            });
          }}
        />
      )}

      {editable && editMenu !== null && !isDateLocked(editMenu.child) && (
        <ContextMenu
          items={editMenuItems(editMenu.parent, editMenu.child, editMenu.position)}
          position={editMenu.position}
          onClose={() => setEditMenu(null)}
        />
      )}
      {editable && parentPicker !== null && parseDateNodeId(parentPicker.nodeId) === null && (
        <NodeSelector
          client={client}
          anchorRect={{
            top: parentPicker.position.y,
            left: parentPicker.position.x,
          }}
          searchMode="pages"
          excludeNodeId={parentPicker.nodeId}
          searchPlaceholder="Search pages…"
          onClose={() => setParentPicker(null)}
          onAdd={(node) => {
            const target = parentPicker.nodeId;
            setParentPicker(null);
            if (node.id !== target) {
              void client.moveObject(target, node.id).catch(() => undefined);
            }
          }}
        />
      )}
    </nav>
  );
}
