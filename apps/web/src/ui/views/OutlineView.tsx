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
 *
 * - FLAT (no children): bullet + icon + label rows for node lists (classed
 *   nodes, tasks, assets, hub lists) — click opens, shift+click peeks, and
 *   the container may append a trailing action (unassign) or replace the row
 *   wholesale via renderItem.
 */

import type { ReactNode } from "react";
import { useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome } from "@notees/domain";

import { Icon } from "../Icon.js";
import { BlockRow } from "../BlockRow.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "../dateDisplay.js";
import { renderStateLabel } from "../renderStateLabel.js";
import { registerView } from "./registry.js";
import type { NodeCollectionItem, NodeCollectionProps } from "./types.js";
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
  return (
    <>
      {items.map((item) => {
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
    </>
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
  const icon = nodeIcon(item.node, classIconMap(client.listClasses()));
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
  const { items, groups, pagesOnly = false, maxDepth, editable = false, tree = undefined } = props;
  if (items.length === 0) return null;

  if (tree === true || isTree(items)) {
    let tree = items;
    if (pagesOnly) tree = filterPages(tree);
    if (maxDepth !== undefined) tree = capDepth(tree, maxDepth);
    const className = `nt-block-tree ${editable ? "" : "nt-block-tree--readonly"}`.trim();
    const rows = <TreeRows items={tree} props={props} />;
    return (
      <SortableContext items={tree.map((t) => t.node.id)} strategy={verticalListSortingStrategy}>
        <div className={className}>{rows}</div>
      </SortableContext>
    );
  }

  if (groups !== undefined && groups.length > 0) {
    return <GroupedFlat props={props} groups={groups} />;
  }

  return (
    <ul className="outline-flat">
      {items.map((item) => (
        <li key={item.node.id}>
          <OutlineRow item={item} props={props} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The grouped flat rendering (groupBy): one collapsible section per group —
 * chevron toggles collapse (session-local), the header label opens the group
 * (e.g. the containing page) when the container wired onHeaderClick. Rows
 * reuse the flat OutlineRow (or the container's renderItem).
 */
function GroupedFlat({ props, groups }: { props: NodeCollectionProps; groups: import("./types.js").CollectionGroup[] }) {
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
            {!isCollapsed && (
              <ul className="outline-flat outline-group__items">
                {group.items.map((item) => (
                  <li key={item.node.id}>
                    <OutlineRow item={item} props={props} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
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
