/**
 * CollectionHub — the hub shell behind a sidebar entry: the shared
 * SurfaceTopBar chrome (icon, title, count, view switcher, the lifted
 * collection toolbar, header actions) pinned above a NodeCollection of the
 * hub's nodes. The transient filter layer rides the bar (the hosted tab
 * bar's contract): the FilterQuery is component state here, the quick text
 * narrows the items through the ranked search (membership AND order) and the
 * structured draft rides the query-run seam — the collection sees the
 * FILTERED set, while the bar's count and the mode-availability gate read
 * the UNFILTERED one (an active filter reads "N of M" on the toolbar badge,
 * the switcher never churns). The toolbar renders `layout="inline"` between
 * the view-chrome slot and the header actions; the view chrome (the sort
 * button et al.) PORTALS into a slot the bar owns — the body-top fallback
 * row retires — and the structured panel portals into the full-width seat
 * beneath the bar (the NodeCollectionTopBar precedent). View mode persists per
 * hub device-locally when `persistKey` is given (never an op); without a
 * key it stays session-local. The offered modes pass the registry's
 * availability gate against what the collection can feed — a gated mode
 * never rides the switcher and a persisted mode that gates out falls back
 * to the default (a dead switch never resurrects). The pages/classes hubs
 * ride the outline
 * mode, opening on the Dates first sort (the hub passes `defaultSortMode`;
 * unset = the container's row order). Tasks defaults to table; assets to
 * cards with a cover-top cover
 * fallback. The outline (list) mode renders the full
 * block-row surface — inline-editable when `editable` is set (the tasks
 * hub), read-only-inert otherwise (the content click does nothing; the
 * bullet opens the node).
 *
 * The surface shape: the root is full-bleed in the main
 * content card (the PageCard.css hub-surface exception) — the bar pins at
 * the card's top and the body scrolls at the CARD's right border, the
 * collection's measure riding the capped content column inside.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useViewModePreference } from "../../ui/viewPrefs.js";
import { useQueryRun, type QueryRunState } from "../../ui/queryRun.js";
import { NodeCollection, ViewToolbar, useAvailableViewModes } from "./index.js";
import type { NodeCollectionItem, SortMode, SortSpec, TableColumn, ViewMode } from "./index.js";
import type { AnyClient, CoverLayout } from "./types.js";
import { NodeCollectionToolbar } from "./NodeCollectionToolbar.js";
import { PanelHostContext } from "./NodeCollectionTopBar.js";
import {
  EMPTY_FILTER_QUERY,
  filterQueryToGroup,
  isFilterInactive,
  quickTextOf,
  type FilterQuery,
} from "./filterQuery.js";
import { SurfaceTopBar } from "../../components/ui/kit/SurfaceTopBar.js";
import "./CollectionHub.css";

/** The quick-text rank window (the global search's cap — the section-data
 *  contract: rows past the limit drop, mirroring the global search). */
const HUB_TEXT_RANK_LIMIT = 1000;

/**
 * The hub filter application (the section-data contract, filterQuery.ts):
 * the quick text narrows the pool through the ranked search FIRST
 * (membership AND order — the search's tier order, which an AST condition
 * cannot express), then the composed structured group filters the narrowed
 * pool by the run's id set (the run executes workspace-wide; membership ∩
 * the hub's items applies here, preserving the pool's order). While a
 * structured run is in flight its pool reads empty — the group owns the
 * pool once the run lands (the cards-hub precedent).
 */
function applyHubFilter(
  client: AnyClient,
  items: NodeCollectionItem[],
  filter: FilterQuery,
  group: ReturnType<typeof filterQueryToGroup>,
  run: QueryRunState | null,
): NodeCollectionItem[] {
  const text = quickTextOf(filter);
  let pool = items;
  if (text !== "") {
    const rankOf = new Map<string, number>();
    for (const [index, node] of client.search(text, HUB_TEXT_RANK_LIMIT).entries()) {
      rankOf.set(node.id, index);
    }
    pool = pool
      .filter((item) => rankOf.has(item.node.id))
      .sort((a, b) => rankOf.get(a.node.id)! - rankOf.get(b.node.id)!);
  }
  if (group !== null) {
    if (run === null || run.kind !== "query") return [];
    const runIds = new Set(run.ids);
    pool = pool.filter((item) => runIds.has(item.node.id));
  }
  return pool;
}

export interface CollectionHubProps {
  client: AnyClient;
  icon: string;
  title: string;
  /**
   * The hub's UNFILTERED item set: the transient filter layer (the toolbar
   * in the bar) narrows it before the collection sees it — the bar's count
   * and the mode-availability gate read this set, never the filtered one.
   */
  items: NodeCollectionItem[];
  /** Available modes in switcher order. */
  modes: ViewMode[];
  defaultMode: ViewMode;
  /**
   * The hub's persistence identity (e.g. the nav key "tasks"): the chosen
   * mode survives reloads under `viewMode.hub.<persistKey>`. Omitted = the
   * title is the identity (ad-hoc hubs persist too, keyed by title).
   */
  persistKey?: string | undefined;
  tableColumns?: TableColumn[] | undefined;
  /**
   * List mode's sort default (the mode the sort button opens on — Dates
   * first for the shell hubs); unset = the container's row order (position).
   * The table/cards modes ignore it (the table sorts per column, the cards
   * per its own vocabulary).
   */
  defaultSortMode?: SortMode | undefined;
  /**
   * Cards: the cover layout this hub's cards fall back to when the device
   * has no persisted cover choice yet (the Assets hub passes "cover-top").
   */
  defaultCoverLayout?: CoverLayout | undefined;
  tableEditable?: boolean | undefined;
  /**
   * Table mode's sort default; other modes ignore it. Unset = the container's
   * row order (the view default is no sort — containers own their table
   * defaults).
   */
  defaultSort?: SortSpec | undefined;
  /** Cards board: the select property whose options seed the board columns. */
  groupByProperty?: string | undefined;
  /**
   * The outline (list) mode is an inline-editing surface: rows edit in
   * place (content, property icon buttons), children render recursively.
   * Off (default) renders the same rows read-only-inert — the content
   * click does nothing and the bullet opens the node.
   */
  editable?: boolean | undefined;
  /**
   * The collection's item set is flat but structurally nested: the views
   * derive parent/child structure from the item set at render time (the
   * Pages hub — its query is all page nodes). Unset = every item renders
   * as its own row regardless of parentage (the backlinks ruling).
   */
  nestUnderParents?: boolean | undefined;
  /**
   * List mode scopes its recursive children to the main-children zone
   * (subpages only — the getChildPages read): page listings (the shell
   * hubs) expand their subpage tree and never a page's inline body blocks.
   */
  pagesOnly?: boolean | undefined;
  /**
   * List mode hides the per-row properties chrome (value-display icon
   * buttons + the collapsed "Properties N" section): listing surfaces
   * answer "which nodes", not "what metadata".
   */
  hideProperties?: boolean | undefined;
  /** List mode hides the per-row tags row (identity chrome only). */
  hideTags?: boolean | undefined;
  emptyTitle?: string | undefined;
  /** Right-aligned header extras (#14's "New class" button et al.), AFTER
   *  the lifted filter toolbar. */
  headerActions?: ReactNode;
  /**
   * The filtered-set report (optional): the hub owns the transient
   * FilterQuery, and hosts whose chrome outside the collection rides the
   * filtered subset (the Cards hub's bucket strip + Review actions) read it
   * here. Fires from an effect only when the filtered membership or the
   * query actually changes — never per render.
   */
  onFilterChange?: ((query: FilterQuery, filteredItems: NodeCollectionItem[]) => void) | undefined;
  /**
   * Per-row trailing action (e.g. the Cards hub's Review button) — the
   * NodeCollection trailingAction seam, forwarded verbatim.
   */
  trailingAction?: ((item: NodeCollectionItem) => ReactNode) | undefined;
  /**
   * Content rendered inside the scrolling body ABOVE the collection (the
   * tasks hub's bucketed surface rides this); the whole
   * block scrolls with the collection at the card border.
   */
  prepend?: ReactNode | undefined;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}

export function CollectionHub({
  client,
  icon,
  title,
  items,
  modes,
  defaultMode,
  persistKey,
  tableColumns,
  defaultSortMode,
  defaultCoverLayout,
  tableEditable = false,
  defaultSort,
  groupByProperty,
  editable = false,
  pagesOnly = false,
  nestUnderParents = false,
  hideProperties = false,
  hideTags = false,
  emptyTitle,
  headerActions,
  onFilterChange,
  trailingAction,
  prepend,
  onOpenNode,
  onOpenInSidebar,
}: CollectionHubProps) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  // Availability gating: the modes the collection can actually feed ride
  // the switcher AND the persisted-mode sanitize — a gated mode never
  // renders and a persisted mode that gates out falls back to the default
  // (a dead switch never resurrects). The gate reads the UNFILTERED set —
  // a filter that empties the pool never churns the switcher.
  const availableModes = useAvailableViewModes(client, items, modes);
  const [mode, setMode] = useViewModePreference(
    persistKey ?? `session.${title}`,
    defaultMode,
    availableModes,
  );
  // The transient filter layer (the section contract — nothing persisted):
  // the FilterQuery is component state, the quick text narrows through the
  // ranked search and the structured draft rides the query-run seam; the
  // collection sees the filtered set, the bar count and the mode gate stay
  // unfiltered.
  const [filter, setFilter] = useState<FilterQuery>(EMPTY_FILTER_QUERY);
  const filterActive = !isFilterInactive(filter);
  const filterGroup = filterActive ? filterQueryToGroup(filter) : null;
  const filterRun = useQueryRun(
    client,
    filterGroup !== null
      ? { version: 1, scope: { type: "entire_workspace" as const }, root: filterGroup }
      : null,
    { enabled: filterGroup !== null },
  );
  const filteredItems = useMemo(
    () => (filterActive ? applyHubFilter(client, items, filter, filterGroup, filterRun.result) : items),
    [client, items, filter, filterActive, filterGroup, filterRun.result],
  );
  // The filtered-set report (the Cards hub's buckets/review): guarded by a
  // stable key so a parent setState re-render (fresh `items` identity, same
  // membership) never re-fires it — no report→render→report loop.
  const reportKey = `${filteredItems.map((item) => item.node.id).join(",")}|${JSON.stringify(filter)}`;
  const lastReportKey = useRef("");
  useEffect(() => {
    if (onFilterChange === undefined || reportKey === lastReportKey.current) return;
    lastReportKey.current = reportKey;
    onFilterChange(filter, filteredItems);
  }, [reportKey, onFilterChange, filter, filteredItems]);
  // The bar's two portal seats: the view-chrome slot inside the actions
  // cluster (views portal their per-view toolbar here — sort et al. — via
  // NodeCollection's `viewChromeTarget`) and the structured panel's
  // full-width seat beneath the bar. Both refs land before paint, so the
  // portals never flash in the fallback seats.
  const [chromeSlot, setChromeSlot] = useState<HTMLSpanElement | null>(null);
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  return (
    <PanelHostContext.Provider value={panelHost}>
      <div className="nt-hub">
        <SurfaceTopBar
          className="nt-hub__surface-bar"
          icon={icon}
          title={title}
          count={items.length}
          actions={
            <>
              {availableModes.length > 1 && <ViewToolbar modes={availableModes} value={mode} onChange={setMode} />}
              <span className="nt-hub__view-chrome" ref={setChromeSlot} />
              <NodeCollectionToolbar
                client={client}
                layout="inline"
                value={filter}
                onChange={setFilter}
                matchCount={filteredItems.length}
                totalCount={items.length}
              />
              {headerActions}
            </>
          }
        />
        <div className="nt-hub__bar-panel-host" ref={setPanelHost} />
        <div className="nt-hub__body">
          <div className="nt-hub__content">
            {prepend}
            <NodeCollection
              viewMode={mode}
              client={client}
              items={filteredItems}
              viewChromeTarget={chromeSlot}
              tableColumns={tableColumns}
              defaultCoverLayout={defaultCoverLayout}
              propertiesOf={(id) => client.getEffectiveProperties(id)}
              tableEditable={tableEditable}
              {...(defaultSort !== undefined ? { defaultSort } : {})}
              {...(defaultSortMode !== undefined ? { defaultSortMode } : {})}
              groupByProperty={groupByProperty}
              // A filter emptied to zero answers "No matching rows." — the
              // container's empty state names the UNFILTERED hub instead.
              {...(filterActive
                ? { emptyText: "No matching rows." }
                : { emptyTitle })}
              editable={editable}
              {...(trailingAction !== undefined ? { trailingAction } : {})}
              {...(pagesOnly ? { pagesOnly: true } : {})}
              {...(nestUnderParents ? { nestUnderParents: true } : {})}
              {...(hideProperties ? { hideProperties: true } : {})}
              {...(hideTags ? { hideTags: true } : {})}
              onNodeClick={onOpenNode}
              onNodeShiftClick={onOpenInSidebar}
            />
          </div>
        </div>
      </div>
    </PanelHostContext.Provider>
  );
}
