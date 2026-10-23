/**
 * View-mode types — the reusable node-collection contract.
 *
 * A view renders a `NodeCollectionItem[]`: the SAME input shape serves tree
 * contexts (a page's child blocks, the child-page tree, reference subtrees)
 * and flat lists (classed nodes, tasks, assets, hub lists) — the difference
 * is only whether items carry `children`. Containers resolve items from the
 * client, pick the available modes + defaults, and own the view-mode state:
 * display state per SCHEMA.md — never an op; durable where the container
 * persists it device-locally (`viewPrefs.ts`), session-local
 * otherwise.
 *
 * The flag set is the ported subset — extended on demand, not inherited
 * wholesale.
 */

import type { ReactNode, ComponentType } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, EffectiveProperty, HostedSectionKey, WorkspaceClient } from "@/core/workspace-client/index.js";

export type AnyClient = WorkspaceClient | WorkerClient;

/**
 * Hosted-views activation: the section a collection backs, addressed by the
 * page/class node it lives on + the section key. When present, NodeCollection
 * renders the custom-tabs chrome: the default tab first (permanent, never
 * closable), custom tabs additive in sequence order, "+" creating one via
 * the FilterBuilderModal. Custom views are per-user prefs-channel state —
 * the DEFAULT tab renders exactly the un-hosted behavior.
 */
export interface HostedViewsConfig {
  /** The page/class node the section lives on. */
  nodeId: string;
  /** The section key (the server's pinned vocabulary). */
  sectionKey: HostedSectionKey;
  /**
   * The selected tab (SECTION_DEFAULT_TAB or a view id) — OPTIONAL control:
   * when both `selected` and `onSelectTab` are set, the host owns the tab
   * state (the "Save as tab" flow selects the freshly saved view); absent,
   * NodeCollection keeps its internal useState (every other call site).
   */
  selected?: string | undefined;
  onSelectTab?: ((tab: string) => void) | undefined;
}

/** The collection view modes (graph = the workspace graph). */
export type ViewMode = "outline" | "prose" | "cards" | "table" | "graph";

export type SortDirection = "asc" | "desc";

/** One sort criterion: a column id (see TableColumn) + direction. */
export interface SortSpec {
  key: string;
  direction: SortDirection;
}

/**
 * A named collection sort mode (the sort-button vocabulary the list and
 * cards views offer — the table view keeps its per-column SortSpec list).
 * Each view interprets the modes it supports and falls back to its own
 * default for the rest:
 *
 * - `dates-first` (list): date pages first, newest → oldest, then the other
 *   pages A–Z; within a page group / sibling level the position order
 *   stands. The default for the Backlinks and Unlinked mentions sections.
 * - `alphabetical`: by display name A–Z (the child-pages, Extended-by and
 *   classed-nodes default).
 * - `position`: the container's natural order (the list default).
 * - `edit-date` (cards): by `updatedAt`, most recently edited first (the
 *   cards default; the table's equivalent is its Edited column's desc
 *   default).
 */
export type SortMode = "dates-first" | "alphabetical" | "position" | "edit-date";

/**
 * A table column. `kind` selects the renderer/comparator; property columns
 * carry the schema id and resolve values per row through `propertiesOf`.
 * The Revision-11 boolean columns (`isClass` / `isEmbedded`) replace the
 * retired single type column — render states, not identities.
 */
export interface TableColumn {
  id: string;
  kind: "name" | "classes" | "created" | "edited" | "isClass" | "isEmbedded" | "property";
  label: string;
  /** Required when kind === "property". */
  propertySchemaId?: string;
  sortable?: boolean;
}

/** Card cover placement (the four placements). */
export type CoverLayout = "no-cover" | "cover-top" | "cover-left" | "cover-right";

/**
 * The flat cards flow — how the card set arranges into columns:
 *
 * - `stack`: one full-width card per row (a vertical stack).
 * - `grid`: visual columns with ROW alignment — cards in a row stretch to the
 *   row's height (`display: grid`).
 * - `masonry`: visual columns with NATURAL card heights, packed vertically
 *   (CSS multicol — the recovered original card mode, the default).
 *
 * ONE enum, not a multi-column × grid pair: the boolean decomposition
 * creates a meaningless combination (single-column-and-grid), and grid vs
 * masonry only differ in multi-column. The grouped board ignores the flow —
 * its columns are semantic (the property groupBy), not visual.
 */
export type CardFlow = "stack" | "grid" | "masonry";

export interface NodeCollectionItem {
  node: ClientNode;
  children?: NodeCollectionItem[] | undefined;
  /** Free per-item bag for container-specific facts (e.g. reference kind). */
  meta?: Record<string, unknown> | undefined;
}

/**
 * A named group of items (the groupBy capability). Containers resolve the
 * grouping (they own the semantics — containing page, property value, …) and
 * the view renders the structure: collapsible headers + the group's rows.
 * Only the outline view consumes groups in this slice; other modes ignore
 * the prop.
 */
export interface CollectionGroup {
  id: string;
  label: string;
  /** Optional MDI icon for the header (e.g. the containing-page icon). */
  icon?: string | undefined;
  /** Header click target (e.g. open the containing page); without it the
   *  header is plain chrome and only the chevron toggles collapse. */
  onHeaderClick?: (() => void) | undefined;
  items: NodeCollectionItem[];
}

export interface NodeCollectionProps {
  client: AnyClient;
  /**
   * The rows to render. Optional for whole-topology views (graph): absent
   * means "the full workspace topology", present scopes the view to the
   * collection. Containers with rows always pass it.
   */
  items?: NodeCollectionItem[] | undefined;
  /**
   * Grouped rendering (groupBy): when present, the view renders one
   * collapsible group per entry instead of a single flat list. The container
   * resolves the grouping via `groupByContainingPage` (or its own key
   * function); the items prop stays the full un-grouped list.
   */
  groups?: CollectionGroup[] | undefined;
  /**
   * Rows that belong to NO group: the grouped outline rendering lists them
   * first, as a flat outline, BEFORE the group sections. The references
   * grouping uses it for page sources — a page mentioning the node from its
   * own body renders as its own top-level row, never inside a self-named
   * one-row group. Undefined unless `groups` is present.
   */
  ungroupedItems?: NodeCollectionItem[] | undefined;
  /** Zero-data chrome (kit EmptyState) — omitted renders nothing. */
  emptyTitle?: string | undefined;
  emptyHint?: string | undefined;
  /**
   * The subtle empty line (the `.nt-section-empty` register) rendered in
   * place of the view when the collection is empty and no EmptyState is
   * configured. For hosted collections it renders inside the selected tab's
   * body — the tabs (and the "+" affordance) stay visible on an empty
   * section — and names the DEFAULT tab's empty ("No backlinks."); a custom
   * tab refined to empty always reads "No matching rows.".
   */
  emptyText?: string | undefined;

  // --- outline / tree flags (ported subset) ---------------------------------

  /**
   * The items form an editor tree (child blocks / child pages): render the
   * BlockRow machinery even when no item currently has children — a flat
   * list of childless blocks is still a tree context. Auto-detected from
   * `children` presence when omitted. Ignored by cards mode (the card
   * always resolves and shows each node's child blocks — the v1 register)
   * and by table mode (rows never show children).
   */
  tree?: boolean | undefined;
  /**
   * Editable surface — the outline (list) mode's rows edit inline (content,
   * property icon buttons) with recursive children; the tree mode renders
   * the live BlockRow editor surface. Off (default) renders the same rows
   * read-only.
   */
  editable?: boolean | undefined;
  /**
   * Read-only rows: every CONTENT mutation gesture off — the text renders
   * statically and the properties chrome (property icon buttons, tags row,
   * the collapsed Metadata section) renders statically too, aligned with
   * the editable row. The classes column is the one exception (owner
   * ruling 2026-10-21): class membership answers edits from read-only
   * reference rows (backlinks, unlinked mentions — × / "+" / drag-sort),
   * only the date-chain lock renders it static. The click contract differs
   * by path: a read-only TREE opens the node on content click (Child pages,
   * "Extended by"); the flat LIST is inert instead — the content click does
   * nothing and the bullet element opens the node (no full-row hover wash).
   * The reference sections pass `readOnly={false}` explicitly (owner ruling
   * 2026-10-23): their flat rows are editable — a content click swaps in
   * the block editor, the bullet still opens — while `editable` stays false
   * so the read-time sort button keeps its place (there is no drag order
   * for a sort to fight).
   */
  readOnly?: boolean | undefined;
  /**
   * Hide the row-end backlink count — the gutter toggle AND its expanded
   * linked-references panel — in list/tree projections where the count is
   * reference noise: the Child pages tree and the Class View's "Extended by"
   * list (owner 2026-10-13).
   */
  hideBacklinkCount?: boolean | undefined;
  /** Tree paths filter children to main children (the Pages zone). */
  pagesOnly?: boolean;
  /**
   * The condensed layer opt-in (owner 2026-10-15): the page body sets it
   * while its condensed toggle is engaged, and ONLY the page body — every
   * other surface (embedded feeds, read-only projections, tables, hubs,
   * exports, shares) never passes it, so those rows render full content by
   * construction. Not a view mode: the layer rides over whichever mode the
   * collection wears.
   */
  condensed?: boolean | undefined;
  /** Depth cap for recursive tree rendering (the outline surface; cards and
   *  table ignore it — cards always resolve children, table never shows them). */
  maxDepth?: number | undefined;
  /**
   * Outline rows show the containing-page breadcrumb trail ABOVE each result
   * row (the Breadcrumbs component, ancestors only — the row names itself;
   * read-only, navigation context like the card's breadcrumb row). Default
   * ON (owner 2026-10-22: the breadcrumbs retired with the Logseq-era
   * reference rows are back, now as shared outline chrome); the classed-nodes
   * section, the page body (child blocks), the Class View's Extended-by
   * section, and the Child pages section opt out — their rows already carry
   * their ancestry (nesting or the surrounding chrome).
   */
  showBreadcrumbs?: boolean | undefined;
  /**
   * Escape hatch: wrap/replace a row's default rendering.
   * Receives the item and the default row; return custom chrome.
   */
  renderItem?: ((item: NodeCollectionItem, defaultRow: ReactNode) => ReactNode) | undefined;
  /** Row trailing action (e.g. the classed-nodes unassign button). */
  trailingAction?: ((item: NodeCollectionItem) => ReactNode) | undefined;
  onNodeClick?: ((nodeId: string) => void) | undefined;
  onNodeShiftClick?: ((nodeId: string) => void) | undefined;

  // --- the focused-block view (the v1 "show parents" concern) -----------------
  /**
   * The parent node — set ONLY by the focused block view (the bullet-zoom
   * surface): the collection shows the focused block ABOVE/AROUND its
   * children, and each VIEW MODE decides the display (owner 2026-10-20 —
   * the v1 NodeCollection prop, generalized). Outline renders the parent
   * as the root block row with the items nested under it (the zoom
   * grammar); prose renders it as an editable top-level header (the
   * title-variant row — title-is-content: the block's text IS the header);
   * cards/table have no defined parent display yet and ignore it (the
   * focused view falls back to outline for them at the callsite).
   */
  parent?: ClientNode | undefined;
  /**
   * A trailing affordance rendered at the CHILD INDENT LEVEL of a focused
   * block view — the "+ Add block" ghost. Outline rides it inside the
   * parent row's children container (the last child); prose trails it at
   * the end of the flattened list (no children container there). Only
   * meaningful with `parent`.
   */
  parentTrailing?: ReactNode | undefined;
  /**
   * The trailing "+ Add block" ghost — the COLLECTION's own chrome (owner
   * ruling 2026-10-23: the ghost is the collection's, the view mode decides
   * its UI): the host names only the PARENT; the collection renders the
   * mode-appropriate affordance (cards passes the twin GhostCard through
   * the grid's last cell, every other mode trails a GhostRow — prose drops
   * the gutter) AND owns the write (the click creates the empty child and
   * hands the caret to the active outliner session). Absent = no ghost
   * (read-only projections, hub sections, embedded renders). Ignored in
   * the focused grammar (`parent` set) — the focused view owns its
   * children-container ghost via `parentTrailing`.
   */
  addGhost?: { parentId: string } | undefined;
  /**
   * The raw trailing-affordance slot the CARDS view consumes (the grid's
   * last cell). Collection-internal: `addGhost` is the host contract — the
   * collection constructs the GhostCard and injects it here. Hosts with a
   * bespoke need (the reference subtree's opt-in child-level ghost) may
   * still pass their own; it wins over the constructed one.
   */
  trailingGhost?: ReactNode | undefined;

  // --- table / cards shared --------------------------------------------------

  /** Resolved table columns (container-derived; default per surface). */
  tableColumns?: TableColumn[] | undefined;
  /** Per-row property values for property columns / card property rows. */
  propertiesOf?: ((nodeId: string) => EffectiveProperty[]) | undefined;
  /** Boolean + select cells edit inline through client.setProperty. */
  tableEditable?: boolean | undefined;
  /**
   * Table: row checkboxes with a tri-state header box (default true). The
   * selection is session state; bulk actions over the selection are a
   * separate feature. Cards (flat node sets, the grouped board included):
   * a per-card checkbox
   * with the same session-selection semantics + the "Export selected…"
   * affordance; tree card contexts never render checkboxes.
   */
  selectable?: boolean | undefined;
  /**
   * Table: download stem for the "Export CSV"/"Export Excel" affordances —
   * the current view's rows as `<exportFileName>.csv|.xlsx` (default
   * "table-export").
   */
  exportFileName?: string | undefined;
  /**
   * Table's initial sort (session state after — the view owns cycling).
   * The default is LIVE: when the prop CHANGES and the user has not picked
   * a sort yet, the view re-seeds from it (the useWindowed resetKey
   * precedent) — the ranked quick search rides this (a section drops its
   * default while the search ranks its pool, restoring it when the search
   * clears). A user-picked sort survives default flips. Unset = no sort:
   * the container's row order (query results keep the query's order);
   * containers that want an opening sort pass one (the hubs pass
   * Edited-desc).
   */
  defaultSort?: SortSpec | undefined;
  /**
   * List/cards: the sort mode the view starts in (session state after; the
   * view owns the sort button). The list view supports `dates-first` /
   * `alphabetical` / `position` (default `position`); the cards view
   * supports `edit-date` / `alphabetical` (default `edit-date`). A mode the
   * view does not support falls back to its default. Like `defaultSort` the
   * default is LIVE — it re-seeds while the user has chosen none (the
   * ranked quick search passes `position` while it ranks the pool). The
   * table view ignores this prop — it sorts per column (`defaultSort`).
   * Never an op.
   */
  defaultSortMode?: SortMode | undefined;
  /**
   * Cards: the cover layout this surface falls back to when the device has
   * no persisted `cards.coverLayout` choice yet (default "no-cover"; the
   * Assets hub passes "cover-top" — its cards read as an image gallery).
   * A persisted choice wins on every surface — the preference stays global.
   */
  defaultCoverLayout?: CoverLayout | undefined;
  /**
   * Cards: the flat-card flow this surface falls back to when the device
   * has no persisted `cards.flow` choice yet (default "masonry"). Like the
   * cover layout, a persisted choice wins on every surface — one global
   * preference per device. The grouped board ignores the flow (its columns
   * are the property groupBy, not a visual layout).
   */
  defaultCardFlow?: CardFlow | undefined;
  /**
   * Cards board: the select property schema whose options seed the board
   * columns (the property-dimension groupBy; single- or multi-select). The
   * cards view dispatches to the board when this resolves to a usable select
   * schema — kanban is not a separate mode, it is cards + groupBy.
   * Items whose value is empty or not among the options land in the trailing
   * "None" column; dragging a card onto a column writes the property (drop on
   * "None" clears it).
   */
  groupByProperty?: string | undefined;

  /**
   * Windowing opt-out: the views window their list by default (the
   * shared useWindowed + ShowMoreButton convention). A container that owns
   * its own pagination (query results with their 200-row cap + load-more)
   * passes false so the list never double-windows. Display state, never an op.
   */
  windowed?: boolean | undefined;

  // --- create affordance -----------------------------------------------------

  /**
   * The collection's create affordance (a "+ Add …" kit button): renders
   * only when the flag AND the callback are both set — and only where the
   * container's context allows creation. In the empty state the button
   * rides the kit EmptyState's action slot; containers that render a
   * ViewToolbar place a second button in its children (left of the
   * switcher). Both default off.
   */
  showAddButton?: boolean | undefined;
  onAdd?: (() => void) | undefined;
  /** The affordance's label (e.g. "Add child page"); defaults to "Add". */
  addLabel?: string | undefined;

  /**
   * Hosted custom views (the section's stored tabs): when set, the
   * collection renders the tab chrome (default tab permanent + custom tabs
   * additive, "+" opens the query builder) and the selected custom view's
   * query_ast refines the items/groups passed in (see sectionViewResolve).
   */
  hostedViews?: HostedViewsConfig | undefined;
  /**
   * The host section's chrome riding the hosted tab bar's far right (owner
   * 2026-10-12 — the filter bar's collapsible quick search + structured
   * toggle, the view switcher): one row with the tabs. Renders only when
   * `hostedViews` is set — a non-hosted collection has no tab row.
   */
  tabBarTrailing?: ReactNode | undefined;

  className?: string | undefined;
}

/** Registry entry: one row per view mode, introspected by toolbar/switcher. */
export interface ViewRegistryEntry {
  id: ViewMode | string;
  label: string;
  /** MDI icon path (the kit Icon resolver). */
  icon: string;
  component: ComponentType<NodeCollectionProps>;
  capabilities: ViewCapabilities;
}

export interface ViewCapabilities {
  /** Supports property columns (future tune-panel column selector). */
  tableColumns?: boolean;
  /** Supports explicit sorting. */
  sorting?: boolean;
  /** Supports groupBy (containing-page groups / the cards-board property columns). */
  groupBy?: boolean;
  /** Supports cover layouts (cards surfaces; the choice persists device-locally). */
  coverLayout?: boolean;
  /** Wrap in the ErrorBoundary when rendered inside chrome. */
  errorBoundary?: boolean;
}
