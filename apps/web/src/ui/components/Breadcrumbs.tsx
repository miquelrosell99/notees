/**
 * Breadcrumbs — the page-ancestry chain at the top of the content card.
 * ancestor pages separated by mdi-chevron-right, collapsing to
 * [first] [second] […] [second-to-last] [last] beyond four items, the
 * ellipsis opening a popup of the hidden ancestors.
 *
 * Data wiring is v2: the chain walks node.parentId via client.getNode
 * until the workspace root (no ancestors → nothing renders). The parent
 * re-renders on client notifications, so renames refresh the chain.
 */

import { useEffect, useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
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

/** Human crumb label: display name, never a raw uuid; per-crumb capped. */
function crumbNameOf(node: ClientNode): string {
  return clipCrumbName(
    displayNameForSettings(node) ||
      (node.nodeType === "page" ? "Untitled page" : node.nodeType === "class" ? "Untitled class" : "Untitled block"),
  );
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
    chain.unshift({ node: parent, name: crumbNameOf(parent) });
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
  /** Append the current node itself as a highlighted trailing crumb. */
  showCurrent = false,
  anchor = "left",
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
  showCurrent?: boolean | undefined;
  /**
   * Overflow anchor. "left" (default) packs the trail from the left and clips
   * the right end (the deepest crumbs truncate). "right" packs from the
   * right and clips the LEFT end — top-level parents hide behind a leading
   * "…" button that pops up the full trail. Per-crumb names are always
   * capped (see clipCrumbName).
   */
  anchor?: "left" | "right" | undefined;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [leadPopupOpen, setLeadPopupOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const [leadClipped, setLeadClipped] = useState(false);

  const currentNode = showCurrent ? client.getNode(nodeId) : undefined;
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
  const showCurrentCrumb = currentNode !== undefined;

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
  }, [anchor, items, showCurrentCrumb]);

  if (items.length === 0 && !showCurrentCrumb) return null;

  const needsCollapse = items.length > COLLAPSE_AT;
  const startItems = needsCollapse ? items.slice(0, VISIBLE_START) : items;
  const hiddenItems = needsCollapse
    ? items.slice(VISIBLE_START, items.length - VISIBLE_END)
    : [];
  const endItems = needsCollapse ? items.slice(items.length - VISIBLE_END) : [];
  /** The trailing trail item needs a chevron when the current crumb follows. */
  const lastKey = needsCollapse
    ? (endItems[endItems.length - 1]?.node.id ?? null)
    : (startItems[startItems.length - 1]?.node.id ?? null);
  const withSeparator = (id: string, base: boolean) => base || (showCurrentCrumb && id === lastKey);

  const crumb = (item: Crumb, key: string, showSeparator: boolean) => (
    <span key={key} className="node-breadcrumb-item">
      <button
        type="button"
        className="node-breadcrumb-link"
        onClick={() => onOpenNode?.(item.node.id)}
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
      {showSeparator && (
        <Icon path="mdi-chevron-right" size={0.7} className="node-breadcrumb-separator" />
      )}
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
          <button
            type="button"
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            aria-label="Show hidden breadcrumbs"
            aria-expanded={leadPopupOpen}
            onClick={() => setLeadPopupOpen((open) => !open)}
          >
            …
          </button>
          <Icon path="mdi-chevron-right" size={0.7} className="node-breadcrumb-separator" />
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
                  {[...items, ...(currentNode !== undefined ? [{ node: currentNode, name: crumbNameOf(currentNode) }] : [])].map(
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
                        {item.node.icon !== null && (
                          <Icon
                            path={item.node.icon}
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
          withSeparator(item.node.id, needsCollapse || index < startItems.length - 1),
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
          <Icon path="mdi-chevron-right" size={0.7} className="node-breadcrumb-separator" />
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
          crumb(item, item.node.id, withSeparator(item.node.id, index < endItems.length - 1)),
        )}

      {currentNode !== undefined && (
        <span className="node-breadcrumb-item node-breadcrumb-current">
          <button
            type="button"
            className="node-breadcrumb-link"
            aria-current="page"
            onClick={() => onOpenNode?.(currentNode.id)}
          >
            {client.effectiveNodeIcon(currentNode) !== null && (
              <Icon
                path={client.effectiveNodeIcon(currentNode)!}
                size={0.8}
                className="node-breadcrumb-icon"
              />
            )}
            <span className="node-breadcrumb-name">{crumbNameOf(currentNode)}</span>
          </button>
        </span>
      )}
    </nav>
  );
}
