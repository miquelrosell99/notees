/**
 * OutlineView — the list/outline mode, the default collection rendering.
 *
 * Two paths over the same input shape:
 *
 * - TREE (items carry children, or `tree` forces it): the BlockRow machinery
 *   — editable when the container is an editor surface (child blocks), a
 *   read-only projection otherwise (child-page trees, reference subtrees).
 *   Editable trees render inside the call site's DndContext; read-only trees
 *   bring their own SortableContext (non-draggable rows, the Child pages
 *   precedent). A READ-ONLY tree's top-level set is windowed (the shared
 *   useWindowed + ShowMoreButton convention) — the editable outliner tree
 *   is deliberately NOT windowed (it is the live CRDT editing surface; a
 *   window could hide a freshly created block).
 *
 * - FLAT (no children): the SAME BlockRow machinery, one row per item — the
 *   list view is not a separate row kind, it is the outline row (owner
 *   2026-10-09): inline content editing when the container is editable
 *   (the tasks hub), collapse chevrons, recursive children (the item's own
 *   children when the container supplied them, else the client's live
 *   children), property icon buttons, classes/tags/metadata chrome.
 *   Read-only rows are the inert variant (`readOnlyInert`): the content
 *   click does NOTHING and the bullet element opens the node — no full-row
 *   hover wash, the bullet carries the only hover feedback. The list hosts
 *   its own OutlinerContext (the ReferenceSubtree precedent) so it renders
 *   outside a page view; open gestures resolve to the container's
 *   onNodeClick/onNodeShiftClick, falling back to the enclosing context's
 *   navigation when there is one. The container may append a trailing
 *   action (unassign) or replace the row wholesale via renderItem. The flat
 *   list (and every group of a grouped rendering) is windowed with the
 *   shared affordance.
 *
 * SORT (owner 2026-10-13): the read-only projections carry the sort button
 * (the table's mdi-sort control, generalized) — a small panel offering
 * Dates first (date pages newest → oldest, then the rest A–Z), Name A–Z,
 * and Default order (the container's natural order). The mode orders pages:
 * a grouped rendering sorts its GROUPS (rows inside a group keep their
 * position order), a tree sorts EVERY sibling level, a flat list sorts its
 * items; the window re-narrows on every resort. Editable surfaces (the
 * outliner, the task list) hide the button — there the drag order IS the
 * order. Hosted collections portal the toolbar into the tab bar's
 * right-hand cluster (the table/cards precedent); un-hosted it rides the
 * body top.
 */

import { useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { BlockRow } from "../BlockRow.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { OutlinerContext, useOutlinerValue } from "../outliner-context.js";
import { SortMenuButton, type SortMenuOption } from "../components/ui/index.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import { useViewChromeTarget } from "./viewChrome.js";
import { compareGroupsByMode, compareItemsByMode, sortTreeByMode } from "./collectionSort.js";
import type { BlockTreeNode } from "@/core/workspace-client.js";
import type { CollectionGroup, NodeCollectionItem, NodeCollectionProps, SortMode } from "./types.js";
import "./OutlineView.css";

/** The list view's sort vocabulary (the sort-button panel options). */
const OUTLINE_SORT_OPTIONS: SortMenuOption[] = [
  { value: "dates-first", label: "Dates first", hint: "Newest → oldest, then A–Z" },
  { value: "alphabetical", label: "Name A–Z" },
  { value: "position", label: "Default order" },
];

/** The modes the list view sorts by — `edit-date` is the cards view's. */
type OutlineSortMode = "dates-first" | "alphabetical" | "position";

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

function TreeRows({ items, props, resetKey }: { items: NodeCollectionItem[]; props: NodeCollectionProps; resetKey?: string | undefined }) {
  const { client, editable = false, readOnly = !editable, renderItem } = props;
  const resolveName = (id: string) => displayNameFromClient(client, id);
  // Only the READ-ONLY tree windows its top-level set (the child-
  // pages projection and friends); the editable outliner stays whole — it
  // is the live editing surface, and a window could hide a just-created
  // block. A BlockRow's own subtree renders whole (collapse chrome bounds it).
  // The resetKey re-narrows the window on every resort (the shared
  // useWindowed contract).
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
    resetKey,
  });
  const rows = readOnly ? visible : items;
  return (
    <SortableContext items={rows.map((row) => row.node.id)} strategy={verticalListSortingStrategy}>
      {rows.map((item) => {
        const row = (
          <BlockRow key={item.node.id} tree={toBlockTree(item)} client={client} resolveName={resolveName} readOnly={readOnly} hideBacklinks={props.hideBacklinkCount} />
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
function toBlockTree(item: NodeCollectionItem): BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

/**
 * The flat list's row tree: the item's own children when the container
 * supplied them, otherwise the client's live children (recursive,
 * depth-capped) — the list view shows children without the container
 * pre-resolving them.
 */
function flatTreeOf(client: NodeCollectionProps["client"], item: NodeCollectionItem, remaining = TREE_DEPTH_CAP): BlockTreeNode {
  if (remaining <= 0) return { node: item.node, children: [] };
  const children: NodeCollectionItem[] =
    item.children ?? client.getChildren(item.node.id).map((node) => ({ node }));
  return {
    node: item.node,
    children: children.map((child) => flatTreeOf(client, child, remaining - 1)),
  };
}

/**
 * FlatRows — the flat node collection as full block rows (see the file
 * header): one BlockRow per item inside the list's own OutlinerContext.
 * Editable when the container says so; read-only rows are the inert
 * variant (content click dead, bullet opens). The trailing action rides
 * the row's right end; renderItem may wrap or replace the row.
 */
function FlatRows({
  items,
  props,
  listClassName = "outline-flat",
  resetKey,
}: {
  items: NodeCollectionItem[];
  props: NodeCollectionProps;
  listClassName?: string | undefined;
  resetKey?: string | undefined;
}) {
  const {
    client,
    editable = false,
    readOnly = !editable,
    trailingAction,
    renderItem,
    onNodeClick,
    onNodeShiftClick,
  } = props;
  // The enclosing context (page/class view) is the navigation fallback when
  // the container named no click handler; the shell hubs have none of their
  // own, so the list hosts its own context regardless (the ReferenceSubtree
  // precedent) and wires the container's handlers in.
  const outer = useContext(OutlinerContext);
  const { visible, remaining, showMore } = useWindowed(items, {
    enabled: props.windowed ?? true,
    resetKey,
  });
  const outliner = useOutlinerValue(client, visible[0]?.node.id ?? "", {
    openNode: (id) => (onNodeClick ?? outer?.openNode ?? (() => {}))(id),
    openInSidebar: (id) => (onNodeShiftClick ?? outer?.openInSidebar ?? (() => {}))(id),
  });
  const resolveName = (id: string) => displayNameFromClient(client, id);
  return (
    <OutlinerContext.Provider value={outliner}>
      <SortableContext items={visible.map((row) => row.node.id)} strategy={verticalListSortingStrategy}>
        <ul className={listClassName}>
          {visible.map((item) => {
            const row: ReactNode = (
              <span className="outline-row">
                <BlockRow
                  tree={flatTreeOf(client, item)}
                  client={client}
                  resolveName={resolveName}
                  readOnly={readOnly}
                  readOnlyInert={readOnly}
                  suppressWidgets
                  hideBacklinks={props.hideBacklinkCount}
                />
                {trailingAction?.(item)}
              </span>
            );
            return <li key={item.node.id}>{renderItem !== undefined ? renderItem(item, row) : row}</li>;
          })}
        </ul>
        <ShowMoreButton remaining={remaining} onShowMore={showMore} />
      </SortableContext>
    </OutlinerContext.Provider>
  );
}

export function OutlineView(props: NodeCollectionProps) {
  const { client, items = [], groups, pagesOnly = false, maxDepth, editable = false, tree = undefined } = props;
  /**
   * The sort-button state (session-local; the container only names the
   * starting mode — `defaultSortMode`). `edit-date` is the cards view's
   * vocabulary; an unsupported mode falls back to `position` (the natural
   * order) and the button shows that.
   *
   * The default stays LIVE (the useWindowed resetKey precedent): when the
   * container CHANGES `defaultSortMode` and the user has not picked a sort
   * yet, the state re-derives from the new default. The ranked quick
   * search rides this (owner 2026-10-13): while the search ranks the pool
   * the section passes "position" so the ranked order shows; a user-picked
   * mode latches `chosen` and survives default flips.
   */
  const defaultMode: OutlineSortMode =
    props.defaultSortMode === "dates-first" || props.defaultSortMode === "alphabetical" || props.defaultSortMode === "position"
      ? props.defaultSortMode
      : "position";
  const [sortState, setSortState] = useState<{ mode: OutlineSortMode; chosen: boolean }>({
    mode: defaultMode,
    chosen: false,
  });
  if (sortState.mode !== defaultMode && !sortState.chosen) {
    setSortState({ mode: defaultMode, chosen: false });
  }
  const sortMode: OutlineSortMode = sortState.mode;
  const setSortChoice = (mode: SortMode) => setSortState({ mode: mode as OutlineSortMode, chosen: true });
  const chromeTarget = useViewChromeTarget();
  const sortedItems = useMemo(() => {
    const resolveClassName = (classId: string) => client.getDisplayName(classId);
    if (sortMode === "position") return items;
    if (tree === true || isTree(items)) return sortTreeByMode(items, sortMode, resolveClassName);
    return [...items].sort(compareItemsByMode(sortMode, resolveClassName));
  }, [items, tree, sortMode, client]);
  const sortedGroups = useMemo(() => {
    if (groups === undefined || sortMode === "position") return groups;
    return [...groups].sort(compareGroupsByMode(sortMode));
  }, [groups, sortMode]);

  if (items.length === 0) return null;

  // The sort button rides the read-only projections only: an editable
  // surface is the live editing/ordering surface (the outliner, the task
  // list), where a sort would fight the drag order. Hosted collections
  // portal the toolbar into the tab bar's right-hand cluster (the table /
  // cards precedent); un-hosted it rides the body top.
  const toolbar = editable ? null : (
    <div className="outline-toolbar">
      <SortMenuButton value={sortMode} options={OUTLINE_SORT_OPTIONS} onChange={(mode) => setSortChoice(mode as SortMode)} />
    </div>
  );
  const chrome = chromeTarget !== null && toolbar !== null ? createPortal(toolbar, chromeTarget) : toolbar;

  if (tree === true || isTree(items)) {
    let tree = sortedItems;
    if (pagesOnly) tree = filterPages(tree);
    if (maxDepth !== undefined) tree = capDepth(tree, maxDepth);
    const className = `nt-block-tree ${editable ? "" : "nt-block-tree--readonly"}`.trim();
    // TreeRows owns its SortableContext so the items match the window.
    return (
      <>
        {chrome}
        <div className={className}>
          <TreeRows items={tree} props={props} resetKey={sortMode} />
        </div>
      </>
    );
  }

  if (sortedGroups !== undefined && sortedGroups.length > 0) {
    return (
      <>
        {chrome}
        <GroupedFlat props={props} groups={sortedGroups} sortKey={sortMode} />
      </>
    );
  }

  return (
    <>
      {chrome}
      <FlatRows items={sortedItems} props={props} resetKey={sortMode} />
    </>
  );
}

/**
 * The grouped flat rendering (groupBy): one collapsible section per group —
 * chevron toggles collapse (session-local), the header label opens the group
 * (e.g. the containing page) when the container wired onHeaderClick. Rows
 * reuse the flat full block rows (or the container's renderItem). Each
 * group's rows are their own window — the header count names the FULL group
 * while the list renders the loaded slice + the shared affordance.
 */
function GroupedFlat({ props, groups, sortKey }: { props: NodeCollectionProps; groups: CollectionGroup[]; sortKey?: string | undefined }) {
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
            {!isCollapsed && <GroupRows group={group} props={props} resetKey={sortKey} />}
          </section>
        );
      })}
    </div>
  );
}

/** One group's rows + its own window (component-scoped hook). */
function GroupRows({ group, props, resetKey }: { group: CollectionGroup; props: NodeCollectionProps; resetKey?: string | undefined }) {
  return <FlatRows items={group.items} props={props} listClassName="outline-flat outline-group__items" resetKey={resetKey} />;
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
