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
 *   ROWS WITH CHILDREN DEFAULT COLLAPSED (owner 2026-10-21, generalized
 *   same day): every row in a collection list — pages and blocks alike —
 *   opens folded, its children behind the chevron, so the list reads one
 *   row per item; the expansion override is session-local, so the default
 *   re-applies next session. The reference-subtree rows (the backlinks
 *   sections' renderItem) ride the same default through their own context.
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
 * position order) and its UNGROUPED top-level rows (the page sources — a
 * flat list sorts its items), a tree sorts EVERY sibling level, a flat list
 * sorts its items; the window re-narrows on every resort. Editable surfaces
 * (the outliner, the task list) hide the button — there the drag order IS
 * the order. Hosted collections portal the toolbar into the tab bar's
 * right-hand cluster (the table/cards precedent); un-hosted it rides the
 * body top.
 *
 * GROUPED + UNGROUPED (owner 2026-10-20): a grouped rendering may carry
 * `ungroupedItems` — rows that belong to no group (the references grouping's
 * page sources: a page mentioning the node from its own body). They render
 * FIRST, as a separated flat outline list of block rows, before the group
 * sections — never inside a self-named one-row group.
 *
 * BREADCRUMBS (owner 2026-10-22): every result row rides the containing-page
 * breadcrumb trail ABOVE it by default (`showBreadcrumbs`, default true) —
 * the breadcrumbs retired with the Logseq-era reference rows (2026-10-21)
 * are back as shared outline chrome, not a backlinks snowflake. The trail
 * is ancestors only, read-only navigation context; a reference row carrying
 * `meta.containingPageId` truncates at that page and drops its crumb (the
 * group header / the row itself already names it). The classed-nodes
 * section, the page body (child blocks), the Class View's Extended-by
 * section, and the Child pages section opt out — their rows already carry
 * their ancestry.
 */

import { useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { BlockRow, useStableIdArray } from "../../ui/BlockRow.js";
import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { Icon } from "../../ui/Icon.js";
import { OutlinerContext, useOutlinerValue } from "../../ui/outliner-context.js";
import { Breadcrumbs } from "../node-menu/Breadcrumbs.js";
import { SortMenuButton, type SortMenuOption } from "../../components/ui/fleet/index.js";
import { registerView } from "./registry.js";
import { useWindowed } from "./useWindowed.js";
import { ShowMoreButton } from "./ShowMoreButton.js";
import { useViewChromeTarget } from "./viewChrome.js";
import { compareGroupsByMode, compareItemsByMode, sortTreeByMode } from "./collectionSort.js";
import type { BlockTreeNode } from "@/core/workspace-client/index.js";
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

/** The empty id list (the focused-block branch's no-parent case). */
const EMPTY_IDS: string[] = [];

/** Filter a tree to main children (the pagesOnly flag), recursion-limited. */
function filterPages(items: NodeCollectionItem[], remaining = TREE_DEPTH_CAP): NodeCollectionItem[] {
  if (remaining <= 0) return [];
  return items
    .filter((item) => !item.node.isClass && item.node.isEmbedded)
    .map((item) => ({ ...item, children: filterPages(item.children ?? [], remaining - 1) }));
}

/** A tree has real children to recurse — then the BlockRow path applies. */
function isTree(items: NodeCollectionItem[]): boolean {
  return items.some((item) => (item.children?.length ?? 0) > 0);
}

/**
 * The containing-page breadcrumb trail above a result row (the
 * `showBreadcrumbs` prop, default on — owner 2026-10-22). The trail is
 * ancestors only, read-only navigation context (the card's breadcrumb-row
 * precedent). A reference row carrying `meta.containingPageId` truncates AT
 * that page and drops its crumb — the page the block lives on is named by
 * the group header (the containing-page grouping) or the row itself (a page
 * source), so the trail shows only the in-page path above the row (the
 * pre-2026-10-21 backlinks rendering, recovered as shared outline chrome).
 */
function RowBreadcrumbs({
  client,
  item,
  onOpenNode,
}: {
  client: NodeCollectionProps["client"];
  item: NodeCollectionItem;
  onOpenNode: (nodeId: string) => void;
}) {
  const metaPage = item.meta?.containingPageId;
  const containingPageId = typeof metaPage === "string" ? metaPage : undefined;
  return (
    <div className="outline-row__breadcrumbs">
      <Breadcrumbs
        client={client}
        nodeId={item.node.id}
        onOpenNode={onOpenNode}
        stopAfterId={containingPageId}
        excludeIds={containingPageId !== undefined ? [containingPageId] : undefined}
        editable={false}
        addParent={false}
      />
    </div>
  );
}

function TreeRows({ items, props, resetKey }: { items: NodeCollectionItem[]; props: NodeCollectionProps; resetKey?: string | undefined }) {
  const { client, editable = false, readOnly = !editable, renderItem } = props;
  // Stable identity — the memoized BlockRow compares it by reference, so a
  // fresh arrow per render would defeat the row bail-out.
  const resolveName = useCallback((id: string) => displayNameFromClient(client, id), [client]);
  // Breadcrumb rows (default on — owner 2026-10-22) navigate like the row
  // click: the container's onNodeClick, else the enclosing view's openNode.
  const outer = useContext(OutlinerContext);
  const openNode = (id: string) => (props.onNodeClick ?? outer?.openNode ?? (() => {}))(id);
  const showBreadcrumbs = props.showBreadcrumbs ?? true;
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
  // Stable identity for dnd-kit's SortableContext (the row memo's defeat
  // otherwise — see useStableIdArray).
  const rowIds = useStableIdArray(rows.map((row) => row.node.id));
  return (
    <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
      {rows.map((item) => {
        const row = (
          <BlockRow key={item.node.id} tree={toBlockTree(item)} client={client} resolveName={resolveName} readOnly={readOnly} hideBacklinks={props.hideBacklinkCount} condensed={props.condensed} />
        );
        // Opted-out trees (the page body, Child pages, Extended by) keep the
        // bare row — no wrapper, their DOM/CSS is untouched. Breadcrumb-on
        // trees wrap the row in a column entry, the crumb trail above.
        if (!showBreadcrumbs) {
          if (renderItem === undefined) return row;
          return (
            <span className="outline-tree-row" key={item.node.id}>
              {renderItem(item, row)}
            </span>
          );
        }
        return (
          <div className="outline-tree-entry" key={item.node.id}>
            <RowBreadcrumbs client={client} item={item} onOpenNode={openNode} />
            {renderItem !== undefined ? renderItem(item, row) : row}
          </div>
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
  // Rows WITH CHILDREN default COLLAPSED (owner 2026-10-21, generalized same
  // day: the ruling names pages but the owner's review caught block rows
  // too — every row in a collection list starts folded, its children
  // behind the chevron, so the list reads one row per item). The set
  // collects every rendered row with children, any node kind; the
  // expansion override is session-local (the context contract).
  const defaultCollapsed = useMemo(() => {
    const set = new Set<string>();
    const walk = (tree: BlockTreeNode): void => {
      if (tree.children.length > 0) set.add(tree.node.id);
      for (const child of tree.children) walk(child);
    };
    for (const item of visible) walk(flatTreeOf(client, item));
    return set;
  }, [client, visible]);
  const outliner = useOutlinerValue(client, visible[0]?.node.id ?? "", {
    openNode: (id) => (onNodeClick ?? outer?.openNode ?? (() => {}))(id),
    openInSidebar: (id) => (onNodeShiftClick ?? outer?.openInSidebar ?? (() => {}))(id),
    defaultCollapsed,
  });
  const resolveName = useCallback((id: string) => displayNameFromClient(client, id), [client]);
  const showBreadcrumbs = props.showBreadcrumbs ?? true;
  // Stable identity for dnd-kit's SortableContext (the row memo's defeat
  // otherwise — see useStableIdArray).
  const flatIds = useStableIdArray(visible.map((row) => row.node.id));
  return (
    <OutlinerContext.Provider value={outliner}>
      <SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
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
            return (
              <li key={item.node.id}>
                {showBreadcrumbs && (
                  <RowBreadcrumbs client={client} item={item} onOpenNode={outliner.openNode} />
                )}
                {renderItem !== undefined ? renderItem(item, row) : row}
              </li>
            );
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
  // Stable identity — the memoized BlockRow compares it by reference, so a
  // fresh arrow per render would defeat the row bail-out.
  const resolveName = useCallback((id: string) => displayNameFromClient(client, id), [client]);
  // Stable identity for dnd-kit's SortableContext (the row memo's defeat
  // otherwise — see useStableIdArray).
  const parentIds = useStableIdArray(props.parent !== undefined ? [props.parent.id] : EMPTY_IDS);
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
  /**
   * The ungrouped top-level rows (the references grouping's page sources):
   * one flat list sorted like any flat list — the grouped rendering lists
   * them before the group sections.
   */
  const sortedUngrouped = useMemo(() => {
    const ungrouped = props.ungroupedItems;
    if (ungrouped === undefined || sortMode === "position") return ungrouped;
    const resolveClassName = (classId: string) => client.getDisplayName(classId);
    return [...ungrouped].sort(compareItemsByMode(sortMode, resolveClassName));
  }, [props.ungroupedItems, sortMode, client]);

  if (items.length === 0 && props.parent === undefined) return null;

  // The focused-block view (the v1 "show parents" concern, owner 2026-10-20):
  // the parent renders as the ROOT block row — the items nested inside it,
  // the exact zoom grammar (parent row + rail + indented children), the
  // parentTrailing affordance riding the children container (the focused
  // view's "+ Add block" ghost). Rendered even with zero items — an empty
  // focused block still owns its row and the ghost.
  if (props.parent !== undefined) {
    return (
      <div className={`nt-block-tree ${editable ? "" : "nt-block-tree--readonly"}`.trim()}>
        {/* The parent row is sortable (the grip drag) — the rows live in
            their own SortableContext like TreeRows, the nested children
            bring their own per-row contexts. */}
        <SortableContext items={parentIds} strategy={verticalListSortingStrategy}>
          <BlockRow
            tree={{ node: props.parent, children: items.map(toBlockTree) }}
            client={client}
            resolveName={resolveName}
            readOnly={!editable}
            hideBacklinks={props.hideBacklinkCount}
            condensed={props.condensed}
            trailingGhost={props.parentTrailing}
          />
        </SortableContext>
      </div>
    );
  }

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
        {/* The page sources ride first, as a separated flat outline, before
            the group sections (the owner 2026-10-20 ruling) — never inside
            a self-named one-row group. */}
        {sortedUngrouped !== undefined && sortedUngrouped.length > 0 && (
          <FlatRows items={sortedUngrouped} props={props} resetKey={sortMode} />
        )}
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
