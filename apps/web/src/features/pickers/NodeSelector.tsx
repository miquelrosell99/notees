/**
 * NodeSelector — universal node selection component.
 *
 * Trigger modes:
 * - 'pill-row': row of node pills with an add button (for tags/types/classes)
 * - 'inline': always-expanded search + results list, no toggle — the
 *   permanent-field idiom (the graph rail's search-to-select): there is no
 *   picker to close, so outside press / Escape never clears the query
 * - anchored (anchorEl + onClose): only the picker panel, portaled and
 *   anchored below the given element — for embedding the picker under a
 *   custom trigger.
 *
 * The empty-query picker opens to the device's RECENTLY USED nodes (MRU
 * order, "Recently used" caption), not an empty list (owner 2026-10-19);
 * the first keystroke replaces the list with search hits. Class-scoped
 * pickers keep their member listing; the classes picker is unaffected.
 *
 * All modes render the shared NodeResultItem rows; keyboard navigation,
 * date suggestions, and create-from-query are built in (`noCreate` turns
 * the create affordance off — search-without-match shows the honest empty
 * state instead). With `scopeTabs`
 * the picker adds Main/Blocks tabs scoping the results to document-chrome
 * nodes vs inline child blocks. `searchMode="blocks"` is the block-
 * linking candidate set — inline blocks only, each labeled with its
 * containing-page path. A leading `class:<name>` prefix in the query
 * refines any non-classes mode to that class's members; the create row
 * answers the rest of the query and carries the refined class. Data wiring
 * goes through the workspace client (search/list/create/class-assign).
 *
 * Async reads: the worker-backed client answers from a cache that converges
 * through a "changed" notify — the picker subscribes (search hits render
 * the moment they land, no retype needed) and renders a "Searching…" state
 * while the current query's read is pending (the client's `searchPending`
 * seam) instead of a lying "No matches found". Keystrokes coalesce through
 * a short debounce before the query hits the ranked index (async clients
 * only — one worker round-trip per query, not per keystroke), so the input
 * leads the list by at most the debounce. A create that returns an id
 * resolves through `waitForNode` — the fresh node is not readable until the
 * create's sync push lands, and picking must wait for it or the mention
 * never inserts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  chainNodeIds,
  parseDateNodeId,
  rendersAsInlineBlock,
  rendersWithDocumentChrome,
  systemClassNameForId,
  type SystemClassName,
} from "@notees/domain";
import type { WorkspaceFeature } from "@notees/protocol";
import { foldSearchText } from "@notees/store";

import type { ClientNode } from "@/core/workspace-client/index.js";
import { nodeDisplayName } from "../../ui/dateDisplay.js";
import { parentRenderFacts } from "../../ui/renderStateLabel.js";
import { readRecentIds } from "../sidebar/recentPages.js";
import { Icon } from "../../ui/Icon.js";
import { parseDate, isPlainYearQuery } from "../date-pickers/dateParser.js";
import { NodePill } from "../metadata/NodePill.js";
import { NodeResultItem } from "./NodeResultItem.js";
import { useKeyboardListNav } from "./useKeyboardListNav.js";
import { useViewportPosition } from "./useViewportPosition.js";
import { QuickCreateModal } from "../modals/QuickCreateModal.js";
import { enableArchivedSystemClass } from "../classview/systemClassDeploy.js";
import type { QuickCreateClient, QuickCreatePlan } from "../modals/quickCreate.js";
import { resolveQuickCreate } from "../modals/quickCreate.js";
import { Tabs } from "../../components/ui/fleet/Tabs.js";
import { SearchField } from "../../components/ui/fleet/SearchField.js";
import { Spinner } from "../../components/ui/fleet/Spinner.js";
import { useDelayedVisible } from "../../components/ui/fleet/useDelayedVisible.js";
import { usePopupDismissal } from "../../components/ui/fleet/usePopupDismissal.js";
import "./NodeSelector.css";

/**
 * The client surface the picker drives — structural, so both full clients
 * (in-process WorkspaceClient, WorkerClient proxy) and the outliner's
 * context client satisfy it. Extends the quick-create surface: the picker's
 * built-in create row opens the class-aware QuickCreateModal when the class
 * filter resolves to a family.
 */
export interface NodeSelectorClient extends QuickCreateClient {
  getNode(id: string): ClientNode | undefined;
  getNodeRaw(id: string): ClientNode | undefined;
  /** The document-chrome node pool (filter-prefix listings). */
  listPages(): ClientNode[];
  search(query: string): ClientNode[];
  /**
   * Async clients only (the worker proxy): true while `query`'s search read
   * is still in flight. A miss and a real no-match both read `[]`
   * synchronously, so this is the only "loading" signal. Sync clients omit
   * it — their `search` answers immediately.
   */
  searchPending?(query: string): boolean;
  createClass(name: string, opts?: { icon?: string; color?: string }): Promise<string>;
  /** The archival bit (the archived-class Enable row, 2026-10-22). */
  updateObject(id: string, fields: { active?: boolean }): Promise<void>;
  /**
   * The F4 inverse for an archived family base (the Enable row). Optional:
   * minimal seams (the outliner's context client) omit it — they degrade
   * to no archived-class rows.
   */
  setFeatureEnabled?(feature: WorkspaceFeature, enabled: boolean): Promise<void>;
  /** Archived class nodes (the classes picker's dimmed Enable matches). */
  listArchivedClasses?(): ClientNode[];
}

/**
 * Read `id` from the projection, waiting — bounded — for the async notify
 * that applies a just-created node. A write's RPC resolution can outrun the
 * sync push that materializes the node in the local store, so the immediate
 * read after `await ensureDateChain` answers undefined; the subscription
 * catches the landing notify. Both real clients (in-process WorkspaceClient,
 * WorkerClient proxy) expose `subscribe`; a host without it degrades to the
 * immediate read (the pre-fix behavior).
 */
async function waitForNode(
  client: NodeSelectorClient & { subscribe?: (listener: () => void) => () => void },
  id: string,
  timeoutMs = 2000,
): Promise<ClientNode | undefined> {
  const existing = client.getNode(id);
  if (existing !== undefined) return existing;
  if (client.subscribe === undefined) return undefined;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (node: ClientNode | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(node);
    };
    const unsubscribe = client.subscribe!(() => {
      const node = client.getNode(id);
      if (node !== undefined) finish(node);
    });
    const timer = setTimeout(() => finish(client.getNode(id)), timeoutMs);
  });
}

type AnyClient = NodeSelectorClient;

export type NodeSearchMode = "pages" | "classes" | "all" | "blocks";
type TriggerMode = "pill-row" | "inline";

/**
 * How a node was picked — reported alongside the node on every `onAdd` call.
 * Plain picks carry `withLabel: false`.
 */
export interface NodePickContext {
  /**
   * Picked via Ctrl/Cmd+Enter or Ctrl/Cmd+click: the caller may treat the
   * query as a custom label (the editor's "insert link with label" path).
   */
  withLabel: boolean;
  /** The picker's current search query (trimmed). */
  query: string;
}

/** Viewport edge clearance for the anchored picker. */
const PICKER_EDGE_PADDING = 8;
/** Default number of results shown before "Show more results". */
const DEFAULT_DISPLAY_LIMIT = 10;
/**
 * Async-client keystroke coalescing: the query that actually hits the
 * ranked index lags the input by this much, so typing a 10-character query
 * costs ONE worker round-trip instead of ten (the FTS itself is fast; the
 * per-keystroke postMessage + reindex on a huge workspace is not). Sync
 * clients (no `searchPending`) answer in microseconds and search every
 * keystroke — debouncing them would only add latency.
 */
const SEARCH_DEBOUNCE_MS = 150;

interface NodeSelectorProps {
  /** The nodes to display as pills ('pill-row' mode) or exclude as assigned. */
  nodes?: ClientNode[] | undefined;
  /** Alternative: provide node ids instead of ClientNode objects. */
  value?: string | string[] | null | undefined;
  /** The workspace client driving search/create. */
  client: AnyClient;
  /** Search mode — determines what types of nodes to show. */
  searchMode?: NodeSearchMode;
  /** Class ids to filter search results by (nodes must carry one of them). */
  classFilters?: string[] | undefined;
  /**
   * Render Main/Blocks scope tabs above the search input, scoping the
   * results to document-chrome nodes (top-level + present-as-main children,
   * plus classes) or to inline child blocks respectively. Default tab is
   * Main. Editor mention pickers use this; pickers with a fixed narrow
   * scope (pages/classes modes, or callers filtering via canAdd) don't.
   */
  scopeTabs?: boolean;
  /** Trigger style: 'pill-row' (default) or 'inline' (always expanded). */
  trigger?: TriggerMode;
  /** Placeholder text for empty state */
  placeholder?: string;
  /** Title/aria-label of the add button ('pill-row' mode). */
  emptyText?: string;
  /** Placeholder + aria-label of the search input. */
  searchPlaceholder?: string;
  /**
   * Optional row pinned before every result while the query is empty. The
   * New-node class picker uses this for "No class"; typing hides it so the
   * keyboard path keeps answering the class query.
   */
  emptyQueryOption?: { label: string; icon?: string; onPick: () => void } | undefined;
  /** Callback when clicking a pill. */
  onNodeClick?: ((node: ClientNode) => void) | undefined;
  /** Callback when removing a node (shows the pill's remove button). */
  onRemove?: ((node: ClientNode) => void) | undefined;
  /** Callback when changing a node's color via the pill's right-click menu. */
  onColorChange?: ((node: ClientNode, color: string | null) => void) | undefined;
  /** Callback when adding a node from the picker (receives the pick context). */
  onAdd?: ((node: ClientNode, context: NodePickContext) => void) | undefined;
  /**
   * Assigned-row pick handler (opt-in). When set, picking a row whose node
   * is already assigned (the checkmarked rows that resurface under a
   * matching query) reports HERE instead of the default idempotent
   * acknowledgment-close — the caller owns the semantics. The pick context
   * carries the same `withLabel` Ctrl/Cmd modifier as any pick (the
   * editor's `+` popup: a plain pick removes the class, a Ctrl/Cmd pick
   * converts the trigger to inline text). Anchored hosts own the close
   * (the callback unmounts the picker); pill-row closes itself as usual.
   */
  onAssignedPick?: ((node: ClientNode, context: NodePickContext) => void) | undefined;
  /** Callback when the value changes (value-based API). */
  onChange?: ((value: string | string[] | null) => void) | undefined;
  /** Callback when creating a new node (overrides the built-in create). */
  onCreateNew?: ((name: string) => void | Promise<ClientNode | string | void>) | undefined;
  /** Whether to show the "Create" option when a query is typed (default true). */
  allowCreate?: boolean;
  /** Always show the create row, even with an empty query (e.g. upload flows). */
  alwaysShowCreate?: boolean;
  /**
   * Suppress the create-from-query affordance entirely: a search
   * without a match shows the honest empty state instead of a create path
   * (the QuickCreateModal flow included). Default false.
   */
  noCreate?: boolean;
  /** Function to determine if a node can be added (filters search results). */
  canAdd?: (node: ClientNode) => boolean;
  /** Node id to exclude from search results (e.g. the current node). */
  excludeNodeId?: string | undefined;
  /** Whether pills are read-only (hides remove button and color menu). */
  readOnly?: boolean;
  /** Initial search query to pre-fill when the picker opens. */
  initialSearchQuery?: string;
  /** Additional CSS class. */
  className?: string;
  /**
   * When provided, renders the picker panel as a portal anchored to this
   * element (no trigger is rendered — use with onClose for dismissal).
   */
  anchorEl?: HTMLElement | null | undefined;
  /**
   * Viewport-coordinate anchor for the anchored panel when there is no
   * element to anchor to (editor caret popups: `{top}` = caret bottom,
   * `{left}` = caret left). Behaves exactly like `anchorEl` with a zero-size
   * rect at this position.
   */
  anchorRect?: { top: number; left: number } | null | undefined;
  /** Called when the anchored panel should close (Escape / click outside). */
  onClose?: (() => void) | undefined;
  /** Custom label for the create row (default: `Create "<query>"`). */
  createLabel?: string | undefined;
  /**
   * Classes picker only — the "Browse all types…" footer row's host hook:
   * opens the classes gallery (the ClassCreateModal), carrying the typed
   * query. The return resolves like onCreateNew's (created id → assigned).
   */
  onBrowseAllTypes?: ((query: string) => void | Promise<string | undefined>) | undefined;
  /**
   * Faint one-line mode banner rendered above the search field — the
   * editor's selection-link gestures use it to announce what the pending
   * pick will do ("Replacing selection with link" / 'Link with custom label
   * "…"').
   */
  hint?: string | undefined;
  /** ID for the root element. */
  id?: string;
  /** Hide the pill's remove icon until the pill is hovered or focused. */
  rightIconHoverReveal?: boolean;
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function NodeSelector({
  nodes: nodesProp,
  value,
  client,
  searchMode = "pages",
  classFilters,
  scopeTabs = false,
  trigger = "pill-row",
  placeholder = "Select node...",
  emptyText = "Add",
  searchPlaceholder = "Search...",
  emptyQueryOption,
  onNodeClick,
  onRemove,
  onColorChange,
  onAdd,
  onAssignedPick,
  onChange,
  onCreateNew,
  allowCreate,
  alwaysShowCreate = false,
  noCreate = false,
  canAdd,
  excludeNodeId,
  readOnly = false,
  initialSearchQuery = "",
  className = "",
  anchorEl,
  anchorRect,
  onClose,
  createLabel,
  onBrowseAllTypes,
  hint,
  id,
  rightIconHoverReveal = false,
}: NodeSelectorProps) {
  const isAnchored = anchorEl != null || anchorRect != null;
  const [isPickerOpen, setIsPickerOpen] = useState(isAnchored);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  /**
   * The query the search pipeline actually runs — `searchQuery` coalesced
   * through the debounce below on async clients. The input shows
   * `searchQuery` (every keystroke); results, the create row, and the
   * filter prefixes all answer THIS value, so the list, the create label,
   * and the searched text never disagree.
   */
  const [debouncedQuery, setDebouncedQuery] = useState(initialSearchQuery);
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_DISPLAY_LIMIT);
  /** Active scope-tab filter (only rendered when scopeTabs is set). */
  const [scope, setScope] = useState<"main" | "blocks">("main");
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Virtual zero-size anchor for viewport-coordinate anchoring (editor caret
  // popups): getBoundingClientRect is all the positioning hook reads.
  const virtualAnchor = useMemo<{ getBoundingClientRect(): DOMRect } | null>(() => {
    if (anchorRect == null) return null;
    return {
      getBoundingClientRect: () =>
        ({
          x: anchorRect.left,
          y: anchorRect.top,
          top: anchorRect.top,
          left: anchorRect.left,
          right: anchorRect.left,
          bottom: anchorRect.top,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    };
  }, [anchorRect]);
  const anchorRef = useRef<HTMLElement | { getBoundingClientRect(): DOMRect } | null>(null);
  // Latest-value ref assignment during render so the layout-phase position
  // hook measures the current anchor on the same commit that opens the picker.
  anchorRef.current = anchorEl ?? virtualAnchor;
  // The dismissal layer's anchor exemption takes a real element only (the
  // virtual rect anchor has none — any outside press closes, its contract).
  const dismissalAnchorRef = useRef<HTMLElement | null>(null);
  dismissalAnchorRef.current = anchorEl ?? null;

  // Compute value ids for fetching and exclusion.
  const valueIds = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  // Resolve nodes from the value ids when no nodes prop is given.
  const resolvedNodesFromValue = useMemo(
    () =>
      valueIds
        .map((nodeId) => client.getNode(nodeId))
        .filter((node): node is ClientNode => node !== undefined),
    [client, valueIds],
  );

  const nodes = nodesProp ?? resolvedNodesFromValue;

  // Assigned ids: pills' nodes + raw value ids (exclusion works pre-resolution).
  const assignedIds = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    for (const valueId of valueIds) ids.add(valueId);
    return ids;
  }, [nodes, valueIds]);

  const handleAdd = (node: ClientNode, withLabel = false): void => {
    if (assignedIds.has(node.id)) {
      if (onAssignedPick !== undefined) {
        // The caller owns assigned-row semantics (the editor's toggle).
        const query = searchQuery.trim();
        onAssignedPick(node, { withLabel: withLabel && query.length > 0, query });
        if (trigger === "pill-row") {
          setIsPickerOpen(false);
          setSearchQuery("");
        }
        return;
      }
      // Otherwise an idempotent acknowledgment, not a write: the row carries
      // the checkmark — close like any pick.
      if (isAnchored) {
        onClose?.();
      } else if (trigger === "pill-row") {
        setIsPickerOpen(false);
        setSearchQuery("");
      }
      return;
    }
    if (onChange) {
      const newValue = Array.isArray(value) ? [...value, node.id] : node.id;
      onChange(newValue);
    } else {
      const query = searchQuery.trim();
      onAdd?.(node, { withLabel: withLabel && query.length > 0, query });
    }
    if (trigger === "pill-row") {
      setIsPickerOpen(false);
      setSearchQuery("");
    }
  };

  const handleRemove = (node: ClientNode): void => {
    if (onChange) {
      if (Array.isArray(value)) {
        onChange(value.filter((valueId) => valueId !== node.id));
      } else {
        onChange(null);
      }
    } else {
      onRemove?.(node);
    }
  };

  // Inline filter prefixes (suggestion-popup row, the original popup's
  // filter family): `daily:` (bare = daily pages only), `is_daily:`,
  // `is_page:` and `is_class:` booleans refine any non-classes search. The
  // tokens are stripped from the search text before FTS/name matching (and
  // before the create row, so a filter never becomes a page title). Runs on
  // the debounced query — the prefixes coalesce with the rest of the input.
  const inlineFilters = useMemo(() => {
    const filters: { daily: boolean | null; page: boolean | null; cls: boolean | null } = {
      daily: null,
      page: null,
      cls: null,
    };
    const stripped = debouncedQuery
      .replace(/\b(is_daily|is_page|is_class)\s*:\s*(true|false)\b/gi, (_match, prefix: string, value: string) => {
        const bool = value.toLowerCase() === "true";
        const which = prefix.toLowerCase();
        if (which === "is_daily") filters.daily = bool;
        else if (which === "is_page") filters.page = bool;
        else filters.cls = bool;
        return " ";
      })
      .replace(/\bdaily\s*:/gi, () => {
        filters.daily = true;
        return " ";
      });
    return { filters, query: stripped };
  }, [debouncedQuery]);

  /** The filter predicates over one candidate node (daily reads the deterministic date id). */
  const matchesInlineFilters = (node: ClientNode): boolean => {
    const { daily, page, cls } = inlineFilters.filters;
    if (daily !== null && (parseDateNodeId(node.id)?.precision === "day") !== daily) return false;
    if (page !== null && rendersWithDocumentChrome(node, parentRenderFacts(client, node)) !== page)
      return false;
    if (cls !== null && node.isClass !== cls) return false;
    return true;
  };

  // Class refine: a leading `class:<name>` prefix scopes the
  // search to that class's members. The name is resolved greedily over the
  // class list — the LONGEST display-name prefix wins, so spaced names
  // ("class:My Class ada") parse unambiguously; an unknown name leaves the
  // query untouched (the raw text just searches).
  const classRefine = useMemo((): { classId: string | null; query: string } => {
    if (searchMode === "classes") return { classId: null, query: inlineFilters.query };
    const raw = inlineFilters.query.trim();
    if (!/^class:/i.test(raw)) return { classId: null, query: inlineFilters.query };
    const rest = raw.slice("class:".length).trimStart();
    const restLower = foldSearchText(rest.toLowerCase());
    const hit = client
      .listClasses()
      .map((cls) => {
        const raw = nodeDisplayName(cls) ?? "";
        return { cls, raw, folded: foldSearchText(raw.toLowerCase()) };
      })
      .filter(
        (entry) =>
          entry.folded !== "" &&
          (restLower === entry.folded || restLower.startsWith(entry.folded + " ")),
      )
      .sort((a, b) => b.folded.length - a.folded.length)[0];
    if (hit === undefined) return { classId: null, query: inlineFilters.query };
    return { classId: hit.cls.id, query: rest.slice(hit.raw.length) };
  }, [client, inlineFilters.query, searchMode]);

  // Effective class ids: caller-side classFilters plus the refined class —
  // the create row and the empty-query member listing both honor them.
  const effectiveClassIds = useMemo(() => {
    const ids = new Set<string>(classFilters ?? []);
    if (classRefine.classId !== null) ids.add(classRefine.classId);
    return [...ids];
  }, [classFilters, classRefine]);

  /**
   * 1172 — the class-aware create request: when the picker's create
   * row runs under a source/agent family filter, the QuickCreateModal opens
   * with the citation fields instead of silently creating a plain page. The
   * modal completes the create and hands the id back through resolveCreateResult.
   */
  const [quickCreate, setQuickCreate] = useState<{
    plan: QuickCreatePlan;
    name: string;
  } | null>(null);

  // Built-in create: pages pickers create a page (carrying the effective
  // class filters), classes pickers create a class. Callers override via
  // onCreateNew. A source/agent family filter reroutes to the quick-create
  // modal (citation fields up front); every other filter stays plain.
  const defaultCreateNew = (name: string): Promise<string> | void => {
    if (searchMode === "classes") {
      return client.createClass(name);
    }
    if (onCreateNew === undefined && effectiveClassIds.length > 0) {
      const plan = resolveQuickCreate(client, effectiveClassIds);
      if (plan !== null) {
        setQuickCreate({ plan, name });
        return;
      }
    }
    return client.createObject({
      isEmbedded: false,
      name,
      ...(effectiveClassIds.length > 0 ? { classIds: effectiveClassIds } : {}),
    });
  };

  const resolveCreateResult = (result: ClientNode | string | void): void => {
    if (typeof result === "string") {
      // The worker client answers a just-created id's getNode with undefined
      // until the create's sync push lands (the RPC resolution outruns it) —
      // reading synchronously here dropped the pick entirely: the node was
      // created, the panel closed, and no mention ever inserted. Wait for
      // the node like the date-suggestion path does, then hand it to the pick.
      void waitForNode(client, result).then((node) => {
        if (node !== undefined) handleAdd(node);
      });
    } else if (result !== undefined && typeof result === "object" && "id" in result) {
      handleAdd(result);
    }
  };

  // Create support: default on for page/class pickers. The create row answers
  // the EFFECTIVE query — under a `class:` refine the prefix scopes the
  // search; it must not become part of the created node's title.
  // `noCreate` suppresses the whole affordance (row + the
  // QuickCreateModal route + the alwaysShowCreate upload override): a
  // search-without-match then renders the honest empty state.
  const effectiveQuery = classRefine.query.trim();
  const createEnabled = (allowCreate ?? true) && !noCreate;
  const effectiveCreateNew = onCreateNew ?? defaultCreateNew;
  // The classes picker's create row is a duplicate-class trap: an exact-name
  // hit means the class ALREADY exists (assigned or not), so the row offers
  // nothing but a same-named second class — suppress it (the existing class
  // rides the results, checkmarked when assigned).
  const exactClassNameMatch = useMemo(() => {
    if (searchMode !== "classes" || effectiveQuery === "") return false;
    const q = foldSearchText(effectiveQuery.toLowerCase());
    return client
      .listClasses()
      .some((cls) => foldSearchText((nodeDisplayName(cls) ?? "").toLowerCase()) === q);
  }, [client, searchMode, effectiveQuery]);
  const showCreateOption =
    !!effectiveCreateNew &&
    createEnabled &&
    (alwaysShowCreate || effectiveQuery.length > 0) &&
    !exactClassNameMatch;
  // A bare year the date system does NOT claim (outside the 1900..2200
  // date-node window — 1711, 1066…) still gets a plain create, but labeled
  // as a year so it reads as a year page rather than a numbered page.
  // (Inside the window the date suggestion row already offers the journal.)
  const createRowLabel =
    createLabel ??
    (isPlainYearQuery(effectiveQuery)
      ? `Create year "${effectiveQuery}"`
      : `Create "${effectiveQuery}"`);

  const handleCreateNew = () => {
    if (effectiveCreateNew === undefined) return;
    // Empty-query create is only meaningful for override flows (upload,
    // quick-create modals): the built-in create needs a title, so the row
    // stays inert without a query unless the caller overrode it.
    if (effectiveQuery === "" && onCreateNew === undefined) return;
    const result = effectiveCreateNew(effectiveQuery);
    const onCreated = (created: ClientNode | string | void): void => {
      resolveCreateResult(created);
    };
    if (result instanceof Promise) {
      result.then(onCreated).catch(() => {});
    } else {
      onCreated(result);
    }
    if (trigger === "pill-row") {
      setIsPickerOpen(false);
    }
    setSearchQuery("");
  };

  // Parse the query for date formats and offer the date-page suggestion
  // (hidden in the classes picker — the original boundary).
  const parsedDate = useMemo(() => {
    if (searchMode === "classes") return null;
    return parseDate(inlineFilters.query.trim());
  }, [inlineFilters.query, searchMode]);

  // The chain ids are pure (derived from the iso date); existence is read
  // live each render so the suggestion label tracks graph changes under an
  // open picker (the chain can appear while the popup is up).
  const dateTarget = useMemo(() => {
    if (!parsedDate) return null;
    const iso =
      parsedDate.type === "day" && parsedDate.month !== undefined && parsedDate.day !== undefined
        ? toIso(parsedDate.year, parsedDate.month, parsedDate.day)
        : parsedDate.type === "month" && parsedDate.month !== undefined
          ? toIso(parsedDate.year, parsedDate.month, 1)
          : toIso(parsedDate.year, 1, 1);
    const ids = chainNodeIds(iso);
    return {
      iso,
      refId:
        parsedDate.type === "year" ? ids.year : parsedDate.type === "month" ? ids.month : ids.day,
    };
  }, [parsedDate]);
  const dateTargetExists =
    dateTarget !== null && client.getNodeRaw(dateTarget.refId) !== undefined;

  const dateSuggestion = useMemo(() => {
    if (!parsedDate || dateTarget === null) return undefined;
    const dateTypeLabel =
      parsedDate.type === "day" ? "daily" : parsedDate.type === "month" ? "monthly" : "yearly";
    const label = dateTargetExists
      ? `Link to ${dateTypeLabel} page: ${parsedDate.label}`
      : `Create ${dateTypeLabel} page: ${parsedDate.label}`;
    return {
      key: `${dateTarget.iso}:${dateTarget.refId}`,
      label,
      onSelect: () => {
        void (async () => {
          await client.ensureDateChain(dateTarget.iso);
          // The chain lands through the projection's async notify — reading
          // the node synchronously after the RPC resolves can answer with
          // undefined (the worker's sync push has not arrived), which dropped
          // the pick and left the row flipped to "Link to" (create-and-link
          // is ONE gesture: the mention inserts on this same click). Wait
          // for the node to appear, then hand it to the pick.
          const node = await waitForNode(client, dateTarget.refId);
          if (node !== undefined) handleAdd(node);
        })();
      },
    };
  }, [parsedDate, dateTarget, dateTargetExists, client]); // eslint-disable-line react-hooks/exhaustive-deps -- handleAdd reads stable state setters only.

  // Scope-tab filter: Main keeps classes plus every document-chrome node
  // (top-level or present-as-main children); Blocks keeps only parented
  // non-class children with the render bit unset. The two are exhaustive
  // over non-class nodes, and classes live in Main.
  const matchesScopeTab = (node: ClientNode): boolean => {
    if (!scopeTabs || searchMode === "classes") return true;
    return scope === "main"
      ? node.isClass || rendersWithDocumentChrome(node, parentRenderFacts(client, node))
      : rendersAsInlineBlock(node, parentRenderFacts(client, node));
  };

  // The worker-backed client answers reads synchronously from a cache that
  // converges through a "changed" notify: a first search of a new query
  // returns [] and the real hits land a macrotask later. Without a
  // subscription the picker never re-renders on that landing — the hits sat
  // in the cache until the NEXT keystroke re-ran the memo (the reported
  // "results only appear after I change the query"). Subscribe and bump a
  // version the search memo depends on, so the landing re-renders the picker
  // on its own. Clients without subscribe (the outliner's context client)
  // are synchronous and degrade to the pre-fix behavior.
  const [dataVersion, setDataVersion] = useState(0);
  useEffect(() => {
    // Called as a method (client.subscribe) — WorkspaceClient binds `this`.
    const sub = client as { subscribe?: (listener: () => void) => () => void };
    if (typeof sub.subscribe !== "function") return;
    return sub.subscribe(() => setDataVersion((v) => v + 1));
  }, [client]);

  // Coalesce keystrokes before the query hits the ranked index — async
  // clients only (see SEARCH_DEBOUNCE_MS). Sync clients mirror immediately:
  // their search is a local call, and tests + small workspaces expect the
  // results to track the input synchronously.
  const isAsyncSearch = client.searchPending !== undefined;
  useEffect(() => {
    if (!isAsyncSearch) {
      setDebouncedQuery(searchQuery);
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery, isAsyncSearch]);

  // Search results through the client. Classes are matched by name over the
  // class list (name filtering is the better picker behavior for short
  // queries); object/block hits go through the ranked FTS index — the
  // class appliers reindex too, so "all"-mode search surfaces classes as
  // well. A `class:` refine narrows the candidates to the refined
  // class's members; "blocks" mode keeps only inline-body blocks — the
  // `((` block-linking candidate set. `dataVersion` is in the deps so the
  // async client's landing notify re-computes the hits from the warmed
  // cache (see the subscription above).
  const searchResults = useMemo(() => {
    const q = foldSearchText(classRefine.query.trim().toLowerCase());
    if (searchMode === "classes") {
      const classes = client.listClasses().filter((node) => {
        if (!matchesInlineFilters(node)) return false;
        if (q === "") return true;
        const name = nodeDisplayName(node) ?? node.id;
        return foldSearchText(name.toLowerCase()).includes(q);
      });
      return classes;
    }
    const hits = q === "" ? [] : client.search(classRefine.query.trim());
    const filtered = hits.filter((node) => {
      if (searchMode === "pages" && !rendersWithDocumentChrome(node, parentRenderFacts(client, node)))
        return false;
      if (searchMode === "blocks" && !rendersAsInlineBlock(node, parentRenderFacts(client, node)))
        return false;
      if (!matchesInlineFilters(node)) return false;
      if (!matchesScopeTab(node)) return false;
      if (effectiveClassIds.length > 0) {
        if (!node.classIds.some((id) => effectiveClassIds.includes(id))) return false;
      }
      return true;
    });
    if (q !== "") return filtered;
    // An empty effective query in a class-scoped picker lists the target
    // classes' members (the picker's natural candidate set); unfiltered
    // pickers wait for input — EXCEPT when an inline filter prefix is live:
    // `daily:` alone must list the matching pool (the filter IS the query).
    const inlineActive =
      inlineFilters.filters.daily !== null ||
      inlineFilters.filters.page !== null ||
      inlineFilters.filters.cls !== null;
    if (inlineActive && searchMode !== "blocks") {
      const pool =
        searchMode === "all" ? [...client.listPages(), ...client.listClasses()] : client.listPages();
      return pool.filter(matchesInlineFilters).filter(matchesScopeTab);
    }
    if (effectiveClassIds.length > 0) {
      const seen = new Set<string>();
      return effectiveClassIds
        .flatMap((id) => client.getClassMembers(id))
        .filter((node) => {
          if (seen.has(node.id)) return false;
          seen.add(node.id);
          return true;
        })
        .filter(matchesInlineFilters)
        .filter(matchesScopeTab)
        .filter((node) => searchMode !== "blocks" || rendersAsInlineBlock(node, parentRenderFacts(client, node)));
    }
    // The empty-query default (owner 2026-10-19): the device's recently
    // used nodes, MRU order, scoped like any other candidate set — the
    // picker opens to "Recently used" instead of an empty list, and the
    // first keystroke replaces the list with search hits. Class-scoped
    // pickers keep the member listing above; the classes picker never
    // reaches here. The mode filter mirrors the search-hit branch, so a
    // blocks-mode picker never lists page recents.
    return readRecentIds()
      .map((id) => client.getNode(id))
      .filter((node): node is ClientNode => node !== undefined)
      .filter((node) => {
        if (searchMode === "pages" && !rendersWithDocumentChrome(node, parentRenderFacts(client, node)))
          return false;
        if (searchMode === "blocks" && !rendersAsInlineBlock(node, parentRenderFacts(client, node)))
          return false;
        return true;
      })
      .filter(matchesScopeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchesInlineFilters derives from inlineFilters (debouncedQuery); matchesScopeTab derives from scope/scopeTabs/searchMode.
  }, [client, debouncedQuery, searchMode, classRefine, effectiveClassIds, scopeTabs, scope, dataVersion]);

  // The classes picker's disabled-class matches (owner ruling 2026-10-22):
  // the query names an ARCHIVED system class — listClasses() filters
  // active, so the dimmed Enable row rides the archived read. The row
  // enables via the gallery pick semantics (the F4 inverse for family
  // bases), then assigns like any pick.
  const archivedMatches = useMemo(() => {
    if (searchMode !== "classes" || effectiveQuery === "") return [] as ClientNode[];
    if (client.listArchivedClasses === undefined) return [] as ClientNode[];
    const q = foldSearchText(effectiveQuery.toLowerCase());
    return client
      .listArchivedClasses()
      .filter((cls) => foldSearchText((nodeDisplayName(cls) ?? "").toLowerCase()).includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataVersion rides the async landing notify like the search memo.
  }, [client, searchMode, effectiveQuery, dataVersion]);

  const handleEnableArchived = (node: ClientNode): void => {
    if (client.listArchivedClasses === undefined) return;
    const key = systemClassNameForId(node.id) as SystemClassName | null;
    if (key === null) return;
    void enableArchivedSystemClass(client, key)
      .then(() => handleAdd(node))
      .catch(() => {});
  };

  const handleBrowseAllTypes = (): void => {
    if (onBrowseAllTypes === undefined) return;
    const result = onBrowseAllTypes(effectiveQuery);
    if (result instanceof Promise) {
      result.then((created) => {
        if (created !== undefined) resolveCreateResult(created);
      }).catch(() => {});
    }
    if (trigger === "pill-row") setIsPickerOpen(false);
    setSearchQuery("");
  };

  // "Searching…" state: on an async client the current query's read may be
  // in flight while the memo already returned the empty default — without
  // this the picker showed "No matches found" for results that were simply
  // still loading. Sync clients have no pending concept and never search.
  const searchText = classRefine.query.trim();
  const searching =
    searchText !== "" &&
    searchMode !== "classes" &&
    (client.searchPending?.(searchText) ?? false);
  // The empty state speaks for the SETTLED query only: while keystrokes are
  // still coalescing (async clients) the memo answers the previous query,
  // and "No matches found" for a search that hasn't run yet is a lie.
  const querySettled = debouncedQuery === searchQuery;

  const filteredResults = useMemo(
    () =>
      searchResults
        // Assigned nodes hide while browsing (the picker's candidate set is
        // the UNASSIGNED pool); a non-empty query surfaces them again —
        // marked selected (the row checkmark) — so an exact search for an
        // already-assigned class/tag acknowledges the pick instead of
        // dead-ending into the create row (the class picker's create row
        // would open the create-class modal for an existing class).
        .filter((node) => !assignedIds.has(node.id) || effectiveQuery !== "")
        .filter((node) => node.id !== excludeNodeId)
        .filter((node) => canAdd === undefined || canAdd(node)),
    [searchResults, assignedIds, effectiveQuery, excludeNodeId, canAdd],
  );

  const visibleResults = useMemo(
    () => filteredResults.slice(0, displayLimit),
    [filteredResults, displayLimit],
  );
  const showMoreOption = filteredResults.length > visibleResults.length;
  /**
   * The recents listing is live: an empty effective query with no filter
   * prefix and no class scope in a non-classes picker. Names the caption
   * above the rows (and nothing else — selection math is unchanged).
   */
  const recentsActive =
    searchMode !== "classes" &&
    classRefine.query.trim() === "" &&
    inlineFilters.filters.daily === null &&
    inlineFilters.filters.page === null &&
    inlineFilters.filters.cls === null &&
    effectiveClassIds.length === 0;

  /** The pinned escape owns index 0 only while the query is empty. */
  const emptyQueryOptionActive =
    emptyQueryOption !== undefined && classRefine.query.trim() === "";

  // Assigned-row gesture hint: rides the picker's bottom while a checkmarked
  // row is on screen (the gestures apply to it). Callers with onAssignedPick
  // own the assigned-row semantics (the editor's `+` toggle); everywhere
  // else a checkmarked pick acknowledges idempotently.
  const assignedHintFooter = visibleResults.some((node) => assignedIds.has(node.id)) ? (
    <div className="node-selector__assigned-hint">
      {onAssignedPick !== undefined ? "↵ remove · ⌃↵ convert to link" : "✓ already assigned"}
    </div>
  ) : null;

  // Position the pill-row / anchored picker (fixed, flips above, clamped).
  const position = useViewportPosition(
    isAnchored ? anchorRef : buttonRef,
    isPickerOpen,
    { popupRef: pickerRef, edgePadding: PICKER_EDGE_PADDING },
  );

  const handleClosePicker = () => {
    if (isAnchored) {
      onClose?.();
    } else if (trigger !== "inline") {
      // Inline mode is permanent — there is no picker to close and the
      // always-visible search field keeps its query on outside press.
      setIsPickerOpen(false);
      setSearchQuery("");
    }
  };

  // Dismissal rides the shared layer (usePopupDismissal), replacing
  // the hand-rolled outside-click/Escape pair: Escape closes unless it
  // originated inside the popup (the search input's own keydown closes via
  // the list nav), and a pointer-down outside closes with the trigger
  // exempted — clicking the add button / a real anchor toggles instead of
  // dismissing. The virtual rect anchor (editor caret popups) has no
  // element, so any outside press closes, exactly the old contract.
  // While the class-aware quick-create modal is open it owns the
  // interaction (its backdrop is outside the picker): the picker's
  // dismissal stands down so a backdrop press or Escape reaches only the
  // modal's own overlay stack.
  usePopupDismissal({
    popupRef: pickerRef,
    anchorRefs: isAnchored ? (anchorEl != null ? [dismissalAnchorRef] : []) : [buttonRef],
    isOpen: isPickerOpen && quickCreate === null,
    onClose: handleClosePicker,
  });

  // Focus the search input once the open picker is positioned. The popup
  // renders visibility:hidden until measured, and browsers refuse focus
  // inside a hidden subtree — keying on `position` (set by the positioning
  // layout effect) guarantees the panel is visible before focus() runs, so
  // typing reaches the popup instead of staying in the edited block.
  useEffect(() => {
    if (isPickerOpen && position !== null && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen, position]);

  // Total selectable items. The optional empty-query escape rides before the
  // date suggestion; both offset the ordinary result list.
  const leadingOffset = (emptyQueryOptionActive ? 1 : 0) + (dateSuggestion ? 1 : 0);
  const archivedCount = archivedMatches.length;
  // Row order: results, then the archived-class Enable rows, the create row,
  // the browse-all-types row, and the show-more pager.
  const createIndex = leadingOffset + visibleResults.length + archivedCount;
  const showBrowseAll = searchMode === "classes" && onBrowseAllTypes !== undefined;
  const browseAllIndex = createIndex + (showCreateOption ? 1 : 0);
  const showMoreIndex = browseAllIndex + (showBrowseAll ? 1 : 0);
  const totalItems =
    visibleResults.length +
    leadingOffset +
    archivedCount +
    (showCreateOption ? 1 : 0) +
    (showBrowseAll ? 1 : 0) +
    (showMoreOption ? 1 : 0);

  const handleSelectByIndex = (index: number, modifiers: { ctrlKey: boolean; metaKey: boolean }) => {
    if (emptyQueryOptionActive && index === 0) {
      emptyQueryOption.onPick();
      return;
    }
    if (dateSuggestion && index === (emptyQueryOptionActive ? 1 : 0)) {
      dateSuggestion.onSelect();
      return;
    }
    const adjusted = index - leadingOffset;
    if (adjusted < visibleResults.length) {
      const node = visibleResults[adjusted]!;
      handleAdd(node, modifiers.ctrlKey || modifiers.metaKey);
    } else if (adjusted < visibleResults.length + archivedCount) {
      handleEnableArchived(archivedMatches[adjusted - visibleResults.length]!);
    } else if (showCreateOption && adjusted === visibleResults.length + archivedCount) {
      handleCreateNew();
    } else if (
      showBrowseAll &&
      adjusted === visibleResults.length + archivedCount + (showCreateOption ? 1 : 0)
    ) {
      handleBrowseAllTypes();
    } else if (
      showMoreOption &&
      adjusted ===
        visibleResults.length + archivedCount + (showCreateOption ? 1 : 0) + (showBrowseAll ? 1 : 0)
    ) {
      setDisplayLimit((prev) => prev + 20);
    }
  };

  // 'inline' mode is always active; other modes are active when open.
  const isNavActive = trigger === "inline" || isPickerOpen;
  const { selectedIndex, setSelectedIndex, listRef, handleKeyDown } = useKeyboardListNav({
    totalItems,
    onSelect: handleSelectByIndex,
    onClose: handleClosePicker,
    isOpen: isNavActive,
  });

  // Build parent page path (e.g. "Root / Parent /") for a document-chrome node.
  const buildParentPath = (node: ClientNode): string => {
    if (node.parentId === null) return "";
    const segments: string[] = [];
    let currentId: string | null = node.parentId;
    let guard = 0;
    while (currentId !== null && guard < 64) {
      const parent: ClientNode | undefined = client.getNode(currentId);
      if (!parent || !rendersWithDocumentChrome(parent)) break;
      segments.unshift(nodeDisplayName(parent) || "Untitled");
      currentId = parent.parentId;
      guard += 1;
    }
    if (segments.length === 0) return "";
    const fullPath = segments.join(" / ") + " /";
    if (fullPath.length <= 36) return fullPath;
    const parts = [...segments];
    while (parts.length > 1) {
      parts.shift();
      const candidate = ".../ " + parts.join(" / ") + " /";
      if (candidate.length <= 36) return candidate;
    }
    const last = parts[0]!;
    return ".../ " + (last.length > 26 ? last.slice(0, 23) + "..." : last) + " /";
  };

  // Containing-page breadcrumb for a block hit: the nearest
  // document-chrome ancestor's path plus the page itself — the label that
  // tells a "…" block result apart from same-named pages.
  const buildContainingPagePath = (node: ClientNode): string => {
    let currentId = node.parentId;
    let guard = 0;
    while (currentId !== null && guard < 64) {
      const parent = client.getNode(currentId);
      if (parent === undefined) break;
      if (rendersWithDocumentChrome(parent)) {
        const ancestors = buildParentPath(parent);
        const name = nodeDisplayName(parent) || "Untitled";
        return ancestors !== "" ? `${ancestors} ${name}` : name;
      }
      currentId = parent.parentId;
      guard += 1;
    }
    return "";
  };

  // Get display classes for a node (class names as small pills).
  const getDisplayClasses = (node: ClientNode): Array<{ nodeUuid: string; name: string }> => {
    if (node.classIds.length === 0) return [];
    return node.classIds
      .map((classUuid) => {
        const classNode = client.getNode(classUuid);
        if (!classNode) return null;
        const name = nodeDisplayName(classNode);
        if (!name) return null;
        return { nodeUuid: classUuid, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
  };

  const handleSearchChange = (newQuery: string) => {
    setSearchQuery(newQuery);
    setDisplayLimit(DEFAULT_DISPLAY_LIMIT);
  };

  // The loading-timing rule (<300ms nothing): a fast worker round-trip never
  // flashes the spinner — results just land.
  const spinnerVisible = useDelayedVisible(searching);

  /** Switch the Main/Blocks scope: re-page results and keep typing in the search box. */
  const handleScopeChange = (next: "main" | "blocks") => {
    setScope(next);
    setDisplayLimit(DEFAULT_DISPLAY_LIMIT);
    searchInputRef.current?.focus();
  };

  const renderResults = (emptyClassName: string, createIconSize: number) => (
    <>
      {emptyQueryOptionActive && emptyQueryOption !== undefined && (
        <NodeResultItem
          key="__empty-query-option"
          node={{ name: emptyQueryOption.label }}
          isHighlighted={selectedIndex === 0}
          onClick={emptyQueryOption.onPick}
          onMouseEnter={() => setSelectedIndex(0)}
          className="node-result-item--empty-query"
          iconOverride={
            <Icon path={emptyQueryOption.icon ?? "mdi-file-outline"} size={createIconSize} />
          }
        />
      )}
      {recentsActive && visibleResults.length > 0 && (
        <div className="node-selector__recent-caption" aria-hidden="true">
          Recently used
        </div>
      )}
      {dateSuggestion && (
        <NodeResultItem
          key={dateSuggestion.key}
          node={{ name: dateSuggestion.label }}
          isHighlighted={selectedIndex === (emptyQueryOptionActive ? 1 : 0)}
          onClick={dateSuggestion.onSelect}
          onMouseEnter={() => setSelectedIndex(emptyQueryOptionActive ? 1 : 0)}
          className="node-result-item--date"
          iconOverride={<Icon path="mdi-calendar" size={0.7} />}
        />
      )}
      {visibleResults.map((node, index) => {
        const globalIndex = leadingOffset + index;
        return (
          <NodeResultItem
            key={node.id}
            node={node}
            parentPath={
              rendersWithDocumentChrome(node, parentRenderFacts(client, node))
                ? buildParentPath(node)
                : buildContainingPagePath(node)
            }
            displayClasses={getDisplayClasses(node)}
            isHighlighted={globalIndex === selectedIndex}
            isSelected={assignedIds.has(node.id)}
            onClick={() => handleAdd(node)}
            onCtrlClick={() => handleAdd(node, true)}
            onMouseEnter={() => setSelectedIndex(globalIndex)}
          />
        );
      })}
      {archivedMatches.map((node, index) => {
        const globalIndex = leadingOffset + visibleResults.length + index;
        const name = nodeDisplayName(node) ?? node.id;
        return (
          <NodeResultItem
            key={node.id}
            node={node}
            isHighlighted={globalIndex === selectedIndex}
            onClick={() => handleEnableArchived(node)}
            onMouseEnter={() => setSelectedIndex(globalIndex)}
            className="node-selector__archived-match"
            after={
              <span className="node-selector__enable-badge">
                <Icon path="mdi-archive-arrow-up-outline" size={0.7} />
                Enable
              </span>
            }
            iconOverride={
              <span title={`${name} is disabled`}>
                <Icon path={node.icon ?? "mdi-shape-outline"} size={createIconSize} />
              </span>
            }
          />
        );
      })}
      {showCreateOption && (
        <NodeResultItem
          key="__create"
          node={{ name: createRowLabel }}
          isHighlighted={selectedIndex === createIndex}
          onClick={handleCreateNew}
          onMouseEnter={() => setSelectedIndex(createIndex)}
          className="node-result-item--create"
          iconOverride={<Icon path="mdi-plus" size={createIconSize} />}
        />
      )}
      {showBrowseAll && (
        <button
          type="button"
          className={`node-selector__browse-all ${selectedIndex === browseAllIndex ? "node-selector__browse-all--highlighted" : ""}`}
          onClick={handleBrowseAllTypes}
          onMouseEnter={() => setSelectedIndex(browseAllIndex)}
        >
          <Icon path="mdi-shape-outline" size={0.7} />
          Browse all types…
        </button>
      )}
      {showMoreOption && (
        <button
          type="button"
          className={`node-selector__show-more ${selectedIndex === showMoreIndex ? "node-selector__show-more--highlighted" : ""}`}
          onClick={() => setDisplayLimit((prev) => prev + 20)}
          onMouseEnter={() => setSelectedIndex(showMoreIndex)}
        >
          Show more results
        </button>
      )}
      {searching && spinnerVisible && (
        <div className="node-selector__searching">
          <Spinner size="sm" label="Searching…" centered />
        </div>
      )}
      {totalItems === 0 && !searching && querySettled && (
        <div className={emptyClassName}>
          {searchQuery ? "No matches found" : "Start typing to search"}
        </div>
      )}
    </>
  );

  /**
   * Search input + results. With scopeTabs the body wraps in a Tabs root:
   * the tablist scopes the results (the shared search input sits between
   * list and panel), and the active tab's panel hosts the results list so
   * tab aria-controls resolves to the region it actually controls.
   */
  const renderBody = (createIconSize: number) =>
    scopeTabs && searchMode !== "classes" ? (
      <Tabs value={scope} onChange={handleScopeChange} className="node-selector__scope-tabs">
        <Tabs.List variant="ghost" className="node-selector__scope-tablist">
          <Tabs.Tab value="main">Main</Tabs.Tab>
          <Tabs.Tab value="blocks">Blocks</Tabs.Tab>
        </Tabs.List>
        {hint !== undefined && hint !== "" && (
          <div className="node-selector__mode-hint">{hint}</div>
        )}
        <SearchField
          ref={searchInputRef}
          className="node-selector__search-field"
          size="sm"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onClear={() => handleSearchChange("")}
        />
        <Tabs.Panel value={scope}>
          <div className="node-selector__options" ref={listRef}>
            {renderResults("node-selector__no-results", createIconSize)}
          </div>
        </Tabs.Panel>
        {assignedHintFooter}
      </Tabs>
    ) : (
      <>
        {hint !== undefined && hint !== "" && (
          <div className="node-selector__mode-hint">{hint}</div>
        )}
        <SearchField
          ref={searchInputRef}
          className="node-selector__search-field"
          size="sm"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onClear={() => handleSearchChange("")}
        />
        <div className="node-selector__options" ref={listRef}>
          {renderResults("node-selector__no-results", createIconSize)}
        </div>
        {assignedHintFooter}
      </>
    );

  // ── inline mode: always-expanded search + results ─────────────────────
  if (trigger === "inline") {
    return (
      <div id={id} className={`node-selector node-selector--inline ${className}`} data-editor-companion>
        {renderBody(0.7)}
        {quickCreate !== null && (
          <QuickCreateModal
            isOpen
            client={client}
            kind={quickCreate.plan.kind}
            defaultClassId={quickCreate.plan.defaultClassId}
            initialName={quickCreate.name}
            onClose={() => setQuickCreate(null)}
            onCreated={(createdId) => resolveCreateResult(createdId)}
          />
        )}
      </div>
    );
  }

  // ── anchored mode: only the picker panel, portaled ────────────────────
  if (isAnchored) {
    return (
      <>
        {createPortal(
          <div
            className="node-selector__picker"
            ref={pickerRef}
            role="dialog"
            aria-label="Select node"
            data-editor-companion
            style={
              position
                ? { top: position.top, left: position.left, visibility: "visible" }
                : { visibility: "hidden" }
            }
          >
            {renderBody(0.55)}
          </div>,
          document.body,
        )}
        {quickCreate !== null && (
          <QuickCreateModal
            isOpen
            client={client}
            kind={quickCreate.plan.kind}
            defaultClassId={quickCreate.plan.defaultClassId}
            initialName={quickCreate.name}
            onClose={() => setQuickCreate(null)}
            onCreated={(createdId) => resolveCreateResult(createdId)}
          />
        )}
      </>
    );
  }

  // ── pill-row mode (default) ───────────────────────────────────────────
  const showAddButton = !!onAdd || !!onChange;

  return (
    <div id={id} className={`node-selector ${className}`}>
      {nodes.map((node) => (
        <NodePill
          key={node.id}
          node={node}
          onClick={() => onNodeClick?.(node)}
          onRemove={onRemove || onChange ? () => handleRemove(node) : undefined}
          onColorChange={onColorChange ? (color) => onColorChange(node, color) : undefined}
          readOnly={readOnly}
          rightIconHoverReveal={rightIconHoverReveal}
        />
      ))}

      {showAddButton && !readOnly && (
        <div className="node-selector__add-wrapper" ref={buttonRef}>
          <button
            type="button"
            className="node-selector__add-btn"
            onClick={() => setIsPickerOpen((prev) => !prev)}
            onKeyDown={(e) => {
              // Prevent space/enter from closing the picker when it's already open.
              if (isPickerOpen && (e.key === " " || e.key === "Enter")) {
                e.preventDefault();
              }
            }}
            title={emptyText}
            aria-label={emptyText || "Add"}
          >
            <Icon path="mdi-plus" size={0.6} />
          </button>

          {isPickerOpen && (
            <div
              className="node-selector__picker"
              ref={pickerRef}
              role="dialog"
              aria-label="Select node"
              data-editor-companion
              style={
                position
                  ? { top: position.top, left: position.left, visibility: "visible" }
                  : { visibility: "hidden" }
              }
            >
              {renderBody(0.55)}
            </div>
          )}
        </div>
      )}
      {quickCreate !== null && (
        <QuickCreateModal
          isOpen
          client={client}
          kind={quickCreate.plan.kind}
          defaultClassId={quickCreate.plan.defaultClassId}
          initialName={quickCreate.name}
          onClose={() => setQuickCreate(null)}
          onCreated={(createdId) => resolveCreateResult(createdId)}
        />
      )}
    </div>
  );
}
