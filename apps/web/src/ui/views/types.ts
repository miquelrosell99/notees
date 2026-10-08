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
import type { ClientNode, EffectiveProperty, HostedSectionKey, WorkspaceClient } from "@/core/workspace-client.js";

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
}

/** The collection view modes (graph = the workspace graph). */
export type ViewMode = "outline" | "prose" | "cards" | "kanban" | "table" | "graph";

export type SortDirection = "asc" | "desc";

/** One sort criterion: a column id (see TableColumn) + direction. */
export interface SortSpec {
  key: string;
  direction: SortDirection;
}

/**
 * A table column. `kind` selects the renderer/comparator; property columns
 * carry the schema id and resolve values per row through `propertiesOf`.
 * The Revision-11 boolean columns (`isClass` / `presentAsMain`) replace the
 * retired single type column — render states, not identities.
 */
export interface TableColumn {
  id: string;
  kind: "name" | "classes" | "created" | "isClass" | "presentAsMain" | "property";
  label: string;
  /** Required when kind === "property". */
  propertySchemaId?: string;
  sortable?: boolean;
}

/** Card cover placement (the four placements). */
export type CardLayout = "no-cover" | "cover-top" | "cover-left" | "cover-right";

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
  /** Zero-data chrome (kit EmptyState) — omitted renders nothing. */
  emptyTitle?: string | undefined;
  emptyHint?: string | undefined;

  // --- outline / tree flags (ported subset) ---------------------------------

  /**
   * The items form an editor tree (child blocks / child pages): render the
   * BlockRow machinery even when no item currently has children — a flat
   * list of childless blocks is still a tree context. Auto-detected from
   * `children` presence when omitted.
   */
  tree?: boolean | undefined;
  /**
   * Editable tree: live BlockRow editors + drag reorder (child blocks). The
   * surrounding DndContext/SortableContext chrome stays at the call site —
   * the view renders the `.nt-block-tree` rows only.
   */
  editable?: boolean | undefined;
  /** Read-only rows: every mutation gesture off, clicking opens the node. */
  readOnly?: boolean | undefined;
  /** Tree paths filter children to main children (the Pages zone). */
  pagesOnly?: boolean | undefined;
  /** Depth cap for recursive tree rendering. */
  maxDepth?: number | undefined;
  /** Flat rows show containing-page breadcrumbs above the label. */
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
   * separate feature. Cards/kanban (flat node sets): a per-card checkbox
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
  /** Optional initial sort (session state; the view owns cycling after). */
  defaultSort?: SortSpec | undefined;
  /** Cards: property schemas shown on flat node cards, in order. */
  cardProperties?: string[] | undefined;
  /**
   * Cards: the cover layout this surface falls back to when the device has
   * no persisted `cards.coverLayout` choice yet (default "no-cover"; the
   * Assets hub passes "cover-top" — its cards read as an image gallery).
   * A persisted choice wins on every surface — the preference stays global.
   */
  defaultCoverLayout?: CardLayout | undefined;
  /**
   * Kanban: the single-select property schema whose options seed the board
   * columns (the property-dimension groupBy). Items whose value is empty or
   * not among the options land in the trailing "None" column; dragging a
   * card onto a column writes the property (drop on "None" clears it).
   */
  kanbanProperty?: string | undefined;

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
  /** Supports groupBy (containing-page groups / kanban property columns). */
  groupBy?: boolean;
  /** Supports cover layouts (cards/kanban; the choice persists device-locally). */
  cardLayout?: boolean;
  /** Wrap in the ErrorBoundary when rendered inside chrome. */
  errorBoundary?: boolean;
}
