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
 * (the page header already names the page).
 *
 * PROPERTY HOPS (opt-in via `showPropertyHops`): a node
 * stored as another node's property value (the node-backed text carrier
 * shape — the value IS a child block of the carrier) is reached from its
 * parent THROUGH the property, so the trail names it: a non-navigable
 * property entry rides between the parent crumb and the node below it
 * ("Holder › Sobre › (the row)"). A hop is detected per parent→child step
 * from the incoming property edges (source = the parent, verb = the schema)
 * and resolves the schema's name; a deleted value leaves no edge and no
 * entry. The entry survives the dropped containing-page crumb — for a row
 * stored directly in the page's property it IS the whole trail, the one
 * place naming where the link lives.
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
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { titleOfNode } from "../../ui/dateDisplay.js";
import { parentlessBlockResolverOf } from "../../ui/renderStateLabel.js";
import { Icon } from "../../ui/Icon.js";
import { AddPill } from "../../components/ui/kit/AddPill.js";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/kit/ContextMenu.js";
import { HoverRevealButton } from "../../components/ui/kit/HoverRevealButton.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import "./Breadcrumbs.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Hard cap on the walk — a corrupt cycle must never hang the render. */
const MAX_CHAIN = 32;

/** Show everything up to this many ancestors; beyond, collapse the middle. */
const COLLAPSE_AT = 4;
const VISIBLE_START = 2;
const VISIBLE_END = 2;

/**
 * One element of the rendered trail: a node crumb (navigable, icon + name)
 * or a property hop (non-navigable — the node below is stored on this crumb's
 * node THROUGH that property; `showPropertyHops` only).
 */
type TrailEntry =
  | { kind: "node"; node: ClientNode; name: string }
  | { kind: "property"; name: string };

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

/** Human crumb label: the plain-text chrome title: markdown link spans reduce to their label (no raw
 *  `[label](href)` in a crumb, no href crowding the 28-char clip),
 *  inline class chips resolve to the class's current name, and a mention
 *  resolves to the target's current display name (its customLabel wins) —
 *  all via titleOfNode's chrome flatten, the same derivation the sidebar
 *  rows use, so a block whose content is ONLY a node link crumbs as the
 *  target's name, never "Untitled". Never a raw uuid; per-crumb capped. */
function crumbNameOf(client: AnyClient, node: ClientNode): string {
  return clipCrumbName(
    titleOfNode(node, {
      flatten: "chrome",
      resolveClassName: (classId) => client.getDisplayName(classId),
      resolveMentionName: (targetId) => client.getDisplayName(targetId),
      empty: "untitled",
      isParentlessBlockClass: parentlessBlockResolverOf(client),
    }),
  );
}

/**
 * The property schemas through which `childId` is stored on `parentId` —
 * the incoming property edges of the child keyed to this parent (verb = the
 * schema). Names resolve through `schemaNameById`; an unknown id renders
 * raw, honestly. Distinct verbs, edge order.
 */
function propertyHopNamesOf(
  client: AnyClient,
  schemaNameById: Map<string, string>,
  parentId: string,
  childId: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const edge of client.getBacklinks(childId)) {
    if (edge.type !== "property" || edge.sourceId !== parentId || edge.verb === null) continue;
    if (seen.has(edge.verb)) continue;
    seen.add(edge.verb);
    names.push(schemaNameById.get(edge.verb) ?? edge.verb);
  }
  return names;
}

function ancestryOf(client: AnyClient, nodeId: string, propertyHops: boolean): TrailEntry[] {
  const schemaNameById = propertyHops
    ? new Map(client.listPropertySchemas().map((schema) => [schema.id, schema.name]))
    : new Map<string, string>();
  // Built leaf-first (property entries, then the parent crumb, per hop) and
  // reversed at the end — a hop's entries land between the parent crumb and
  // the node below it.
  const up: TrailEntry[] = [];
  const seen = new Set<string>([nodeId]);
  let current = client.getNode(nodeId);
  for (
    let hops = 0;
    current !== undefined && current.parentId !== null && hops < MAX_CHAIN;
    hops += 1
  ) {
    const parentId = current.parentId;
    if (seen.has(parentId)) break; // cycle guard
    seen.add(parentId);
    const parent = client.getNode(parentId);
    if (parent === undefined) break;
    if (propertyHops) {
      for (const name of propertyHopNamesOf(client, schemaNameById, parent.id, current.id)) {
        up.push({ kind: "property", name });
      }
    }
    // Never render a raw UUID: unnamed pages/blocks get a human label.
    up.push({ kind: "node", node: parent, name: crumbNameOf(client, parent) });
    current = parent;
  }
  return up.reverse();
}

export function Breadcrumbs({
  client,
  nodeId,
  onOpenNode,
  stopAfterId,
  excludeIds,
  excludeLeaf = false,
  anchor = "left",
  /** Non-interactive trail: crumbs render as plain text (no navigation, no
   *  overflow popups, no edit affordances) — the peek-card header's
   *  right-anchored occlusion still hides the upper levels when the trail
   *  overflows. */
  interactive = true,
  /** The trail ends at the current node (the leaf crumb). */
  leaf = false,
  /** Parent-edit gestures: crumb chevron/right-click menus + Add parent. */
  editable = false,
  /** The "+ Add parent" pill on a parentless node (default on with `editable`).
   *  Surfaces that edit only EXISTING parents (the card's breadcrumb row) opt
   *  out — the pill is noise there. */
  addParent = true,
  showPropertyHops = false,
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
  /** False renders the trail as plain text (no clicks, no popups). */
  interactive?: boolean | undefined;
  /** Append the node's OWN crumb after the ancestors — the trail ends at
   *  the current node (the peek-card header's contract: the card names what
   *  it holds, root pages included). */
  leaf?: boolean | undefined;
  editable?: boolean | undefined;
  /** False hides the "+ Add parent" pill (existing-parents-only surfaces). */
  addParent?: boolean | undefined;
  /**
   * Name the properties the walk steps through: when a node on the trail is
   * stored on the crumb above it as that node's property value (the
   * node-backed text carrier shape), a non-navigable property entry rides
   * between the two ("Holder › Sobre › (the row)"). Default off — the page
   * chrome trails stay pure ancestry; collection rows opt in.
   */
  showPropertyHops?: boolean | undefined;
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
  let items = ancestryOf(client, nodeId, showPropertyHops ?? false);
  // The leaf crumb: the trail names the current node itself (the
  // peek-card header's contract). Appended BEFORE the early return so a
  // root page's trail is its own name, not an empty header.
  if (leaf && currentNode !== undefined) {
    items = [...items, { kind: "node", node: currentNode, name: crumbNameOf(client, currentNode) }];
  }
  if (stopAfterId !== undefined) {
    // Truncate AT this node (inclusive): property entries between the stop
    // node and the row survive — they name the hops below it.
    const stopAt = items.findIndex(
      (item) => item.kind === "node" && item.node.id === stopAfterId,
    );
    if (stopAt !== -1) items = items.slice(stopAt);
  }
  if (excludeIds !== undefined && excludeIds.length > 0) {
    // Only node crumbs drop — a dropped crumb's hop entries toward the row
    // stay: for a row stored in the page's own property they ARE the trail.
    const drop = new Set(excludeIds);
    items = items.filter((item) => item.kind === "property" || !drop.has(item.node.id));
  }
  if (excludeLeaf && items.length > 0) items = items.slice(0, -1);
  // a parentless node hides itself from the trail —
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
  const childBelowOf = (item: { node: ClientNode }): ClientNode | undefined => {
    const index = items.findIndex((entry) => entry.kind === "node" && entry.node.id === item.node.id);
    // Property entries name edges, not nodes — the edge's child is the next
    // NODE entry below (for the direct parent crumb: the current node itself).
    for (let i = index + 1; i < items.length; i += 1) {
      const entry = items[i];
      if (entry !== undefined && entry.kind === "node") return entry.node;
    }
    return currentNode;
  };

  const crumb = (item: { node: ClientNode; name: string }, key: string, showSeparator: boolean) => {
    const childBelow = childBelowOf(item);
    // The date-chain parenting lock: an edge whose child is a date node has
    // no edit affordance (reassign/remove would be rejected by the store).
    const edgeEditable = interactive && editable && childBelow !== undefined && !isDateLocked(childBelow);
    const crumbLabel = (
      <>
        {client.effectiveNodeIcon(item.node) !== null && (
          <Icon
            path={client.effectiveNodeIcon(item.node)!}
            size={0.8}
            className="node-breadcrumb-icon"
          />
        )}
        <span className="node-breadcrumb-name">{item.name}</span>
      </>
    );
    return (
    <span key={key} className="node-breadcrumb-item ui-hover-reveal-group">
      {interactive ? (
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
          {crumbLabel}
        </button>
      ) : (
        <span className="node-breadcrumb-link node-breadcrumb-link--static">{crumbLabel}</span>
      )}
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

  /**
   * A property hop entry: non-navigable (a property is an attribute, not a
   * place) — a tag glyph + the schema name, italic to read as metadata
   * between the two node crumbs it connects.
   */
  const propertyCrumb = (item: { name: string }, key: string, showSeparator: boolean) => (
    <span key={key} className="node-breadcrumb-item">
      <span className="node-breadcrumb-property" title={`stored in the "${item.name}" property`}>
        <Icon path="mdi-tag-outline" size={0.75} className="node-breadcrumb-property-icon" />
        <span className="node-breadcrumb-property-name">{item.name}</span>
      </span>
      {showSeparator && (
        <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
      )}
    </span>
  );

  /** One trail entry rendered in its place — node crumbs navigate, property
   *  hops render their tag entry. */
  const entryView = (item: TrailEntry, key: string, showSeparator: boolean) =>
    item.kind === "node" ? crumb(item, key, showSeparator) : propertyCrumb(item, key, showSeparator);

  /** One trail entry in an overflow popup: node crumbs stay open-buttons,
   *  property hops render as inert rows. */
  const popupRow = (item: TrailEntry, key: string, close: () => void) =>
    item.kind === "node" ? (
      <button
        key={key}
        type="button"
        className="node-breadcrumbs-popup-item"
        onClick={() => {
          close();
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
        <span className="node-breadcrumbs-popup-name">{item.name}</span>
      </button>
    ) : (
      <span key={key} className="node-breadcrumbs-popup-item node-breadcrumbs-popup-property">
        <Icon path="mdi-tag-outline" size={0.8} className="node-breadcrumb-popup-icon" />
        <span className="node-breadcrumbs-popup-name">{item.name}</span>
      </span>
    );

  return (
    <nav
      ref={navRef}
      className={`node-breadcrumbs${anchor === "right" ? " node-breadcrumbs--anchor-right" : ""}`}
      aria-label="Page hierarchy"
    >
      {anchor === "right" && leadClipped && (
        <span className="node-breadcrumb-item node-breadcrumb-lead-clip">
          {!interactive ? (
            <span className="node-breadcrumb-link node-breadcrumb-ellipsis node-breadcrumb-link--static" aria-hidden="true">
              …
            </span>
          ) : (
          <button
            type="button"
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            aria-label="Show hidden breadcrumbs"
            aria-expanded={leadPopupOpen}
            onClick={() => setLeadPopupOpen((open) => !open)}
          >
            …
          </button>
          )}
          <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
          {interactive && leadPopupOpen && (
            <>
              <button
                type="button"
                className="node-breadcrumb-popup-backdrop"
                aria-label="Close breadcrumbs popup"
                onClick={() => setLeadPopupOpen(false)}
              />
              <div className="node-breadcrumb-popup-anchor">
                <div className="node-breadcrumbs-popup">
                  {items.map((item, index) =>
                    popupRow(item, `${item.kind}:${index}`, () => setLeadPopupOpen(false)),
                  )}
                </div>
              </div>
            </>
          )}
        </span>
      )}
      {startItems.map((item, index) =>
        entryView(item, `${item.kind}:${index}`, needsCollapse || index < startItems.length - 1),
      )}

      {needsCollapse && (
        <span className="node-breadcrumb-item node-breadcrumb-ellipsis-container">
          {!interactive ? (
            <span className="node-breadcrumb-link node-breadcrumb-ellipsis node-breadcrumb-link--static" aria-hidden="true">
              …
            </span>
          ) : (
          <button
            type="button"
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            aria-label={`Show ${hiddenItems.length} more breadcrumbs`}
            aria-expanded={popupOpen}
            onClick={() => setPopupOpen((open) => !open)}
          >
            …
          </button>
          )}
          <Icon path="mdi-chevron-right" size={0.75} className="node-breadcrumb-separator" />
          {interactive && popupOpen && (
            <>
              <button
                type="button"
                className="node-breadcrumb-popup-backdrop"
                aria-label="Close breadcrumbs popup"
                onClick={() => setPopupOpen(false)}
              />
              <div className="node-breadcrumb-popup-anchor">
                <div className="node-breadcrumbs-popup">
                  {hiddenItems.map((item, index) =>
                    popupRow(item, `${item.kind}:${index}`, () => setPopupOpen(false)),
                  )}
                </div>
              </div>
            </>
          )}
        </span>
      )}

      {needsCollapse &&
        endItems.map((item, index) =>
          entryView(item, `${item.kind}:${index}`, index < endItems.length - 1),
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
