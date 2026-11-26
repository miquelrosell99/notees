/**
 * CollectionHub — the hub shell behind a sidebar entry: the shared
 * SurfaceTopBar chrome (title, count, view switcher, the lifted
 * collection toolbar, header actions) pinned above a NodeCollection of the
 * hub's nodes. The transient filter layer rides the bar (the hosted tab
 * bar's contract): the FilterQuery is component state here, the quick text
 * narrows the items through the ranked search (membership AND order) and the
 * structured draft rides the query-run seam — the collection sees the
 * FILTERED set, while the bar's count and the mode-availability gate read
 * the UNFILTERED one (an active filter reads "N of M" on the toolbar badge,
 * the switcher never churns). The actions cluster composes the owner's
 * register, ONE shared order across every collection bar: the lifted filter
 * toolbar (`layout="inline"` — the search field FIRST) → the view-chrome
 * slot the bar owns (the view chrome — the sort button et al. — PORTALS
 * into it; the body-top fallback row retires) → the primary header actions
 * → the view switcher → the "⋮ More actions" overflow of the SECONDARY
 * action tier (`secondaryActions`, the SelectionButton tier vocabulary for
 * bar actions). The structured panel portals into the full-width seat
 * beneath the bar (the NodeCollectionTopBar precedent). View mode persists per
 * hub device-locally when `persistKey` is given (never an op); without a
 * key it stays session-local. The offered modes pass the registry's
 * availability gate against what the collection can feed — a gated mode
 * never rides the switcher and a persisted mode that gates out falls back
 * to the default (a dead switch never resurrects). The pages/classes hubs
 * ride the outline
 * mode, opening on the Dates first sort (the hub passes `defaultSortMode`;
 * unset = the container's row order). Tasks defaults to its section-scoped
 * outline (the master–detail TasksHub passes `narrowItems`); assets to
 * cards with a cover-top cover
 * fallback. The outline (list) mode renders the full
 * block-row surface — inline-editable when `editable` is set (the tasks
 * hub), read-only-inert otherwise (the content click does nothing; the
 * bullet opens the node).
 *
 * Two additive layout seams serve the panelled hubs (the Tasks hub's
 * master–detail): `sidePanel` renders a host-built aside beside the body
 * (the host composes it with `useSidePanel`; the linked toggle rides
 * `leading`, the bar's left-of-title slot) and `narrowItems` post-filter
 * narrows what the COLLECTION renders while the bar's count, filter
 * toolbar and mode gate keep reading the full pool.
 *
 * The surface shape: the root is full-bleed in the main
 * content card (the PageCard.css hub-surface exception) — the bar pins at
 * the card's top and the body scrolls at the CARD's right border, the
 * collection's measure riding the capped content column inside.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useViewModePreference, useGroupByPreference } from "../../ui/viewPrefs.js";
import { useQueryRun, type QueryRunState } from "../../ui/queryRun.js";
import { NodeCollection, ViewToolbar, useAvailableViewModes } from "./index.js";
import { getViewDefinition } from "./registry.js";
import { GroupByPicker } from "./GroupByPicker.js";
import { isGroupablePropertyType, type GroupBySpec } from "./grouping.js";
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
import { MoreActions, type MoreActionsItem } from "../../components/ui/kit/index.js";
import { ViewChromeSlot } from "./viewChrome.js";
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
  /** The bar's heading — never an icon (the view-title ruling). */
  title: string;
  /**
   * The hub's UNFILTERED item set: the transient filter layer (the toolbar
   * in the bar) narrows it before the collection sees it — the bar's count
   * and the mode-availability gate read this set, never the filtered one.
   */
  items: NodeCollectionItem[];
  /** Available modes in switcher order — ViewMode union ids and/or registered
   *  view ids outside the union (the tasks hub's "buckets"). */
  modes: Array<ViewMode | string>;
  defaultMode: ViewMode | string;
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
   * The hub's DEFAULT group-by axis (the generic group-by, 2026-11-25): the
   * "Group by" picker in the bar offers every groupable axis and persists
   * the choice device-locally under `groupBy.<persistKey>`; this names the
   * axis a fresh device opens on (the tasks hub: Status). The picker rides
   * the bar only while the selected mode's view consumes grouping.
   */
  defaultGroupBy?: GroupBySpec | undefined;
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
  /**
   * List mode hides ONLY the collapsed "Properties N" section — the
   * value-display icon buttons stay (the tasks hub: the status bullet owns
   * closing; the disclosure was a third line of chrome per row).
   */
  hidePropertySection?: boolean | undefined;
  /** List mode hides the per-row tags row (identity chrome only). */
  hideTags?: boolean | undefined;
  emptyTitle?: string | undefined;
  /** Right-aligned header extras (#14's "New class" button et al.) — the
   *  PRIMARY action tier: freeform chrome riding inline, AFTER the lifted
   *  filter toolbar and the ported view chrome, BEFORE the view switcher. */
  headerActions?: ReactNode;
  /**
   * The SECONDARY action tier (the SelectionButton tier vocabulary for bar
   * actions): low-frequency utilities — export et al. — ride the "⋮ More
   * actions" overflow panel (the kit MoreActions) at the cluster's far
   * right, after the view switcher, never inline.
   */
  secondaryActions?: MoreActionsItem[] | undefined;
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
   * cards hub's due/fresh/later strip rides this); the whole
   * block scrolls with the collection at the card border. Surfaces whose
   * bucketed listing IS the primary view offer it as a registered view mode
   * instead (the tasks hub's "buckets" — one body at a time, never stacked).
   */
  prepend?: ReactNode | undefined;
  onOpenNode: (nodeId: string) => void;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  /**
   * Post-filter item narrowing (the Tasks hub's section selection): applied
   * to the FILTERED set right before the collection renders, so the bar's
   * count, the filter toolbar and the mode-availability gate keep reading
   * the full pool while the collection shows the narrowed scope. Pure
   * display — identity changes just re-derive the collection set.
   */
  narrowItems?: ((filteredItems: NodeCollectionItem[]) => NodeCollectionItem[]) | undefined;
  /**
   * The collection's empty-title while narrowing is in play and left zero
   * with the filter inactive (the section-selection name: "No tasks in this
   * section."); without it an empty narrowing falls back to `emptyTitle`.
   */
  narrowEmptyTitle?: string | undefined;
  /**
   * A left side panel rendered beside the body (the Tasks hub's section
   * panel) — the host builds it with `useSidePanel` and passes the returned
   * aside verbatim; the linked toggle rides `leading`.
   */
  sidePanel?: ReactNode | undefined;
  /** The left-panel toggle (the `useSidePanel` pair) — SurfaceTopBar `leading`. */
  leading?: ReactNode | undefined;
}

export function CollectionHub({
  client,
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
  defaultGroupBy,
  editable = false,
  pagesOnly = false,
  nestUnderParents = false,
  hideProperties = false,
  hidePropertySection = false,
  hideTags = false,
  emptyTitle,
  headerActions,
  secondaryActions,
  onFilterChange,
  trailingAction,
  prepend,
  onOpenNode,
  onOpenInSidebar,
  narrowItems,
  narrowEmptyTitle,
  sidePanel,
  leading,
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
  // The group-by axis (the generic group-by): the picker's choice persists
  // per hub device-locally; the picker rides the bar only while the selected
  // mode's view consumes grouping (the registry capability).
  const [groupBySpec, setGroupBySpec] = useGroupByPreference(
    persistKey ?? `session.${title}`,
    defaultGroupBy ?? null,
    (spec) =>
      spec.kind !== "property" ||
      client
        .listPropertySchemas()
        .some((schema) => schema.id === spec.schemaId && isGroupablePropertyType(schema.type)),
  );
  const modeSupportsGroupBy = getViewDefinition(mode)?.capabilities.groupBy === true;
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
      ? { version: 2, scope: { type: "entire_workspace" as const }, root: filterGroup }
      : null,
    { enabled: filterGroup !== null },
  );
  const filteredItems = useMemo(
    () => (filterActive ? applyHubFilter(client, items, filter, filterGroup, filterRun.result) : items),
    [client, items, filter, filterActive, filterGroup, filterRun.result],
  );
  // The post-filter narrowing (the Tasks hub's section selection): the
  // collection renders the narrowed scope; everything chrome-side above
  // still reads the filtered pool.
  const collectionItems = useMemo(
    () => (narrowItems !== undefined ? narrowItems(filteredItems) : filteredItems),
    [narrowItems, filteredItems],
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
          title={title}
          count={items.length}
          leading={leading}
          actions={
            <>
              <NodeCollectionToolbar
                client={client}
                layout="inline"
                value={filter}
                onChange={setFilter}
                matchCount={filteredItems.length}
                totalCount={items.length}
              />
              <ViewChromeSlot slotRef={setChromeSlot} className="nt-hub__view-chrome" />
              {modeSupportsGroupBy && (
                <GroupByPicker client={client} items={items} value={groupBySpec} onChange={setGroupBySpec} />
              )}
              {headerActions}
              {availableModes.length > 1 && <ViewToolbar modes={availableModes} value={mode} onChange={setMode} />}
              {secondaryActions !== undefined && <MoreActions items={secondaryActions} />}
            </>
          }
        />
        <div className="nt-hub__bar-panel-host" ref={setPanelHost} />
        <div className="nt-hub__body">
          {sidePanel}
          <div className="nt-hub__main">
            <div className="nt-hub__content">
              {prepend}
              <NodeCollection
                viewMode={mode}
                client={client}
                items={collectionItems}
              viewChromeTarget={chromeSlot}
              tableColumns={tableColumns}
              defaultCoverLayout={defaultCoverLayout}
              propertiesOf={(id) => client.getEffectiveProperties(id)}
              tableEditable={tableEditable}
              {...(defaultSort !== undefined ? { defaultSort } : {})}
              {...(defaultSortMode !== undefined ? { defaultSortMode } : {})}
              groupByProperty={groupByProperty}
              groupBy={groupBySpec ?? undefined}
              // A filter emptied to zero answers "No matching rows." — the
              // container's empty state names the UNFILTERED hub instead; a
              // narrowing (the Tasks hub's section selection) that left zero
              // names the narrowed scope.
              {...(filterActive
                ? { emptyText: "No matching rows." }
                : {
                    emptyTitle:
                      narrowItems !== undefined && collectionItems.length === 0
                        ? (narrowEmptyTitle ?? emptyTitle)
                        : emptyTitle,
                  })}
              editable={editable}
              {...(trailingAction !== undefined ? { trailingAction } : {})}
              {...(pagesOnly ? { pagesOnly: true } : {})}
              {...(nestUnderParents ? { nestUnderParents: true } : {})}
              {...(hideProperties ? { hideProperties: true } : {})}
              {...(hidePropertySection ? { hidePropertySection: true } : {})}
              {...(hideTags ? { hideTags: true } : {})}
              onNodeClick={onOpenNode}
              onNodeShiftClick={onOpenInSidebar}
            />
            </div>
          </div>
        </div>
      </div>
    </PanelHostContext.Provider>
  );
}
