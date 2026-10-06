/**
 * OutlineView — the list/outline mode, the default collection rendering.
 *
 * Two paths over the same input shape:
 *
 * - TREE (items carry children): the BlockRow machinery — editable when the
 *   container is an editor surface (child blocks), read-only projection
 *   otherwise (child-page trees, reference subtrees). Editable trees render
 *   inside the call site's DndContext; read-only trees bring their own
 *   SortableContext (non-draggable rows, the Child pages precedent).
 *   §34.70: a READ-ONLY tree's top-level set is windowed (the shared
 *   useWindowed + ShowMoreButton convention) — the editable outliner tree
 *   is deliberately NOT windowed (it is the live CRDT editing surface; a
 *   window could hide a freshly created block).
 *
 * - FLAT (no children): bullet + icon + label rows for node lists (classed
 *   nodes, tasks, assets, hub lists) — click opens, shift+click peeks, and
 *   the container may append a trailing action (unassign) or replace the row
 *   wholesale via renderItem. §34.70: the flat list (and every group of a
 *   grouped rendering) is windowed with the shared affordance.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome } from "@notees/domain";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { renderStateLabel } from "../renderStateLabel.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import type { CollectionGroup, NodeCollectionItem, NodeCollectionProps } from "./types.js";
import "./OutlineView.css";

/** Depth cap for safety on deep recursive trees. */
const TREE_DEPTH_CAP = 64;

/** Filter a tree to main children (the pagesOnly flag), recursion-limited. */
function filterPages(items: NodeCollectionItem[], remaining = TREE_DEPTH_CAP): NodeCollectionItem[] {
  if (remaining <= 0) return [];
  return items
    .filter((item) => !item.node.isClass && item.node.presentAsMain)
    .map((item) => ({ ...item, children: filterPages(item.children ?? [], remaining - 1) }));
}

/** A tree has real children to recurse — then the BlockRow path applies. */
function isTree(items: NodeCollectionItem[]): boolean {
  return items.some((item) => (item.children?.length ?? 0) > 0);
}

function TreeRows({ items, props }: { items: NodeCollectionItem[]; props: NodeCollectionProps }) {
  const { client, editable = false, readOnly = !editable, renderItem } = props;
  const resolveName = (id: string) => displayNameFromClient(client, id);
  // §34.70: only the READ-ONLY tree windows its top-level set (the child-
  // pages projection and friends); the editable outliner stays whole — it
  // is the live editing surface, and a window could hide a just-created
  // block. A BlockRow's own subtree renders whole (collapse chrome bounds it).
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
  });
  const rows = readOnly ? visible : items;
  return (
    <SortableContext items={rows.map((row) => row.node.id)} strategy={verticalListSortingStrategy}>
      {rows.map((item) => {
        const row = (
          <BlockRow key={item.node.id} tree={toBlockTree(item)} client={client} resolveName={resolveName} readOnly={readOnly} />
        );
        if (renderItem === undefined) return row;
        return (
          <span className="outline-tree-row" key={item.node.id}>
            {renderItem(item, row)}
          </span>
        );
      })}
      {readOnly && <ShowMoreButton remaining={remaining} onShowMore={showMore} />}
    </SortableContext>
  );
}

/** Recursive map to the BlockTreeNode shape BlockRow consumes. */
function toBlockTree(item: NodeCollectionItem): import("@/core/workspace-client.js").BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

/** One flat row: bullet + icon + label (+ trailing action / custom render). */
export function OutlineRow({
  item,
  props,
}: {
  item: NodeCollectionItem;
  props: NodeCollectionProps;
}) {
  const { client, onNodeClick, onNodeShiftClick, trailingAction, renderItem } = props;
  const icon = nodeIcon(item.node, client.effectiveClassIcons());
  const label = displayNameForSettings(item.node) || "Untitled";
  const row = (
    <span className="outline-row">
      <button
        type="button"
        className="outline-row__main"
        title={label}
        onClick={(event) => {
          if (event.shiftKey) {
            onNodeShiftClick?.(item.node.id);
            return;
          }
          onNodeClick?.(item.node.id);
        }}
      >
        <span className="nt-bullet outline-row__bullet" aria-hidden="true">
          •
        </span>
        {icon !== null && <Icon path={icon} size={0.9} className="outline-row__icon" />}
        <span className="outline-row__label">{label}</span>
        {!rendersWithDocumentChrome(item.node) && (
          <span className="outline-row__type">{renderStateLabel(item.node)}</span>
        )}
      </button>
      {trailingAction?.(item)}
    </span>
  );
  return <>{renderItem !== undefined ? renderItem(item, row) : row}</>;
}

export function OutlineView(props: NodeCollectionProps) {
  const { items = [], groups, pagesOnly = false, maxDepth, editable = false, tree = undefined } = props;
  if (items.length === 0) return null;

  if (tree === true || isTree(items)) {
    let tree = items;
    if (pagesOnly) tree = filterPages(tree);
    if (maxDepth !== undefined) tree = capDepth(tree, maxDepth);
    const className = `nt-block-tree ${editable ? "" : "nt-block-tree--readonly"}`.trim();
    // TreeRows owns its SortableContext so the items match the window.
    return (
      <div className={className}>
        <TreeRows items={tree} props={props} />
      </div>
    );
  }

  if (groups !== undefined && groups.length > 0) {
    return <GroupedFlat props={props} groups={groups} />;
  }

  return <FlatList props={props} items={items} />;
}

/** The §34.70-windowed flat list: the loaded rows + the shared affordance. */
function FlatList({ items, props }: { items: NodeCollectionItem[]; props: NodeCollectionProps }) {
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
  });
  return (
    <>
      <ul className="outline-flat">
        {visible.map((item) => (
          <li key={item.node.id}>
            <OutlineRow item={item} props={props} />
          </li>
        ))}
      </ul>
      <ShowMoreButton remaining={remaining} onShowMore={showMore} />
    </>
  );
}

/**
 * The grouped flat rendering (groupBy): one collapsible section per group —
 * chevron toggles collapse (session-local), the header label opens the group
 * (e.g. the containing page) when the container wired onHeaderClick. Rows
 * reuse the flat OutlineRow (or the container's renderItem). §34.70: each
 * group's rows are their own window — the header count names the FULL group
 * while the list renders the loaded slice + the shared affordance.
 */
function GroupedFlat({ props, groups }: { props: NodeCollectionProps; groups: CollectionGroup[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div className="outline-groups">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        return (
          <section className="outline-group" key={group.id} data-group-id={group.id}>
            <div className="outline-group__header">
              <button
                type="button"
                className="outline-group__toggle"
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} group ${group.label}`}
                aria-expanded={!isCollapsed}
                onClick={() => toggle(group.id)}
              >
                <Icon
                  path={isCollapsed ? "mdi-chevron-right" : "mdi-chevron-down"}
                  size={0.9}
                  className="outline-group__chevron"
                />
              </button>
              {group.onHeaderClick !== undefined ? (
                <button type="button" className="outline-group__label" onClick={group.onHeaderClick}>
                  {group.icon !== undefined && (
                    <Icon path={group.icon} size={0.9} className="outline-group__icon" />
                  )}
                  <span className="outline-group__name">{group.label}</span>
                  <span className="outline-group__count">{group.items.length}</span>
                </button>
              ) : (
                <span className="outline-group__label">
                  {group.icon !== undefined && (
                    <Icon path={group.icon} size={0.9} className="outline-group__icon" />
                  )}
                  <span className="outline-group__name">{group.label}</span>
                  <span className="outline-group__count">{group.items.length}</span>
                </span>
              )}
            </div>
            {!isCollapsed && <GroupRows group={group} props={props} />}
          </section>
        );
      })}
    </div>
  );
}

/** One group's rows + its own window (component-scoped hook). */
function GroupRows({ group, props }: { group: CollectionGroup; props: NodeCollectionProps }) {
  const { visible, remaining, showMore } = useWindowed(group.items, {
    enabled: props.windowed ?? true,
  });
  return (
    <>
      <ul className="outline-flat outline-group__items">
        {visible.map((item) => (
          <li key={item.node.id}>
            <OutlineRow item={item} props={props} />
          </li>
        ))}
      </ul>
      <ShowMoreButton remaining={remaining} onShowMore={showMore} />
    </>
  );
}

function capDepth(items: NodeCollectionItem[], maxDepth: number, level = 0): NodeCollectionItem[] {
  if (level >= maxDepth - 1) return items.map((item) => ({ ...item, children: [] }));
  return items.map((item) => ({ ...item, children: capDepth(item.children ?? [], maxDepth, level + 1) }));
}

registerView({
  id: "outline",
  label: "Outline",
  icon: "mdi-format-list-bulleted",
  component: OutlineView,
  capabilities: { sorting: true },
});
