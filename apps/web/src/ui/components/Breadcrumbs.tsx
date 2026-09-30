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

import { useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

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
    chain.unshift({ node: parent, name: deriveDisplayName(parent) || parent.id });
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
}) {
  const [popupOpen, setPopupOpen] = useState(false);

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
  if (items.length === 0) return null;

  const needsCollapse = items.length > COLLAPSE_AT;
  const startItems = needsCollapse ? items.slice(0, VISIBLE_START) : items;
  const hiddenItems = needsCollapse
    ? items.slice(VISIBLE_START, items.length - VISIBLE_END)
    : [];
  const endItems = needsCollapse ? items.slice(items.length - VISIBLE_END) : [];

  const crumb = (item: Crumb, key: string, showSeparator: boolean) => (
    <span key={key} className="node-breadcrumb-item">
      <button
        type="button"
        className="node-breadcrumb-link"
        onClick={() => onOpenNode?.(item.node.id)}
      >
        {item.node.icon !== null && (
          <Icon path={item.node.icon} size={0.8} className="node-breadcrumb-icon" />
        )}
        <span className="node-breadcrumb-name">{item.name}</span>
      </button>
      {showSeparator && (
        <Icon path="mdi-chevron-right" size={0.7} className="node-breadcrumb-separator" />
      )}
    </span>
  );

  return (
    <nav className="node-breadcrumbs" aria-label="Page hierarchy">
      {startItems.map((item, index) =>
        crumb(item, item.node.id, needsCollapse || index < startItems.length - 1),
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
                      {item.node.icon !== null && (
                        <Icon
                          path={item.node.icon}
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
        endItems.map((item, index) => crumb(item, item.node.id, index < endItems.length - 1))}
    </nav>
  );
}
