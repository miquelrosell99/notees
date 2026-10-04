/**
 * NodeSelector — universal node selection component.
 *
 * Trigger modes:
 * - 'pill-row': row of node pills with an add button (for tags/types/classes)
 * - 'inline': always-expanded search + results list, no toggle
 * - anchored (anchorEl + onClose): only the picker panel, portaled and
 *   anchored below the given element — for embedding the picker under a
 *   custom trigger.
 *
 * All modes render the shared NodeResultItem rows; keyboard navigation,
 * date suggestions, and create-from-query are built in. With `scopeTabs`
 * the picker adds Main/Blocks tabs scoping the results to document-chrome
 * nodes vs inline child blocks. `searchMode="blocks"` (M8) is the block-
 * linking candidate set — inline blocks only, each labeled with its
 * containing-page path. A leading `class:<name>` prefix in the query (M7)
 * refines any non-classes mode to that class's members; the create row
 * answers the rest of the query and carries the refined class. Data wiring
 * goes through the workspace client (search/list/create/class-assign).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { chainNodeIds, parseDateNodeId, rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";
import { displayNameForSettings } from "../../dateDisplay.js";
import { Icon } from "../../Icon.js";
import { parseDate } from "./dateParser.js";
import { NodePill } from "./NodePill.js";
import { NodeResultItem } from "./NodeResultItem.js";
import { useKeyboardListNav } from "./useKeyboardListNav.js";
import { useViewportPosition } from "./useViewportPosition.js";
import { QuickCreateModal } from "../modals/QuickCreateModal.js";
import type { QuickCreateClient, QuickCreatePlan } from "../modals/quickCreate.js";
import { resolveQuickCreate } from "../modals/quickCreate.js";
import { Tabs } from "../ui/Tabs.js";
import { Checkbox } from "../ui/Checkbox.js";
import "./NodeSelector.css";

/**
 * The client surface the picker drives — structural, so both full clients
 * (in-process WorkspaceClient, WorkerClient proxy) and the outliner's
 * context client satisfy it. Extends the quick-create surface: the picker's
 * built-in create row opens the class-aware QuickCreateModal when the class
 * filter resolves to a family (§34.19 :1172).
 */
export interface NodeSelectorClient extends QuickCreateClient {
  getNode(id: string): ClientNode | undefined;
  getNodeRaw(id: string): ClientNode | undefined;
  /** The document-chrome node pool (filter-prefix listings, §34.19). */
  listPages(): ClientNode[];
  search(query: string): ClientNode[];
  createClass(name: string, opts?: { icon?: string; color?: string }): Promise<string>;
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
  /** Callback when clicking a pill. */
  onNodeClick?: ((node: ClientNode) => void) | undefined;
  /** Callback when removing a node (shows the pill's remove button). */
  onRemove?: ((node: ClientNode) => void) | undefined;
  /** Callback when changing a node's color via the pill's right-click menu. */
  onColorChange?: ((node: ClientNode, color: string | null) => void) | undefined;
  /** Callback when adding a node from the picker (receives the pick context). */
  onAdd?: ((node: ClientNode, context: NodePickContext) => void) | undefined;
  /** Callback when the value changes (value-based API). */
  onChange?: ((value: string | string[] | null) => void) | undefined;
  /** Callback when creating a new node (overrides the built-in create). */
  onCreateNew?: ((name: string) => void | Promise<ClientNode | string | void>) | undefined;
  /** Whether to show the "Create" option when a query is typed (default true). */
  allowCreate?: boolean;
  /** Always show the create row, even with an empty query (e.g. upload flows). */
  alwaysShowCreate?: boolean;
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
   * §34.19 multi-select checkbox mode: row clicks toggle a picked set
   * (checked rows accumulate at the top), an Apply footer commits them all
   * through `onApplyMulti`. The picker stays open across toggles.
   */
  multiSelect?: boolean | undefined;
  /** Commits a multi-select session with the picked nodes (pick order). */
  onApplyMulti?: ((nodes: ClientNode[]) => void | Promise<unknown>) | undefined;
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
  onNodeClick,
  onRemove,
  onColorChange,
  onAdd,
  onChange,
  onCreateNew,
  allowCreate,
  alwaysShowCreate = false,
  canAdd,
  excludeNodeId,
  readOnly = false,
  initialSearchQuery = "",
  className = "",
  anchorEl,
  anchorRect,
  onClose,
  createLabel,
  multiSelect = false,
  onApplyMulti,
  id,
  rightIconHoverReveal = false,
}: NodeSelectorProps) {
  const isAnchored = anchorEl != null || anchorRect != null;
  const [isPickerOpen, setIsPickerOpen] = useState(isAnchored);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_DISPLAY_LIMIT);
  /** Multi-select (§34.19): picked ids in pick order. */
  const [pickedIds, setPickedIds] = useState<string[]>([]);
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
    if (assignedIds.has(node.id)) return;
    if (multiSelect) {
      // Checkbox mode: a pick toggles the set; the picker stays open.
      togglePicked(node);
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

  // Inline filter prefixes (§34.19 suggestion-popup row, the v1 popup's
  // filter family): `daily:` (bare = daily pages only), `is_daily:`,
  // `is_page:` and `is_class:` booleans refine any non-classes search. The
  // tokens are stripped from the search text before FTS/name matching (and
  // before the create row, so a filter never becomes a page title).
  const inlineFilters = useMemo(() => {
    const filters: { daily: boolean | null; page: boolean | null; cls: boolean | null } = {
      daily: null,
      page: null,
      cls: null,
    };
    const stripped = searchQuery
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
  }, [searchQuery]);

  /** The filter predicates over one candidate node (daily reads the deterministic date id). */
  const matchesInlineFilters = (node: ClientNode): boolean => {
    const { daily, page, cls } = inlineFilters.filters;
    if (daily !== null && (parseDateNodeId(node.id)?.precision === "day") !== daily) return false;
    if (page !== null && rendersWithDocumentChrome(node) !== page) return false;
    if (cls !== null && node.isClass !== cls) return false;
    return true;
  };

  // Class refine (§34.30 M7): a leading `class:<name>` prefix scopes the
  // search to that class's members. The name is resolved greedily over the
  // class list — the LONGEST display-name prefix wins, so spaced names
  // ("class:My Class ada") parse unambiguously; an unknown name leaves the
  // query untouched (the raw text just searches).
  const classRefine = useMemo((): { classId: string | null; query: string } => {
    if (searchMode === "classes") return { classId: null, query: inlineFilters.query };
    const raw = inlineFilters.query.trim();
    if (!/^class:/i.test(raw)) return { classId: null, query: inlineFilters.query };
    const rest = raw.slice("class:".length).trimStart();
    const restLower = rest.toLowerCase();
    const hit = client
      .listClasses()
      .map((cls) => ({ cls, name: (displayNameForSettings(cls) || "").toLowerCase() }))
      .filter((entry) => entry.name !== "" && (restLower === entry.name || restLower.startsWith(entry.name + " ")))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (hit === undefined) return { classId: null, query: inlineFilters.query };
    return { classId: hit.cls.id, query: rest.slice(hit.name.length) };
  }, [client, inlineFilters.query, searchMode]);

  // Effective class ids: caller-side classFilters plus the refined class —
  // the create row and the empty-query member listing both honor them.
  const effectiveClassIds = useMemo(() => {
    const ids = new Set<string>(classFilters ?? []);
    if (classRefine.classId !== null) ids.add(classRefine.classId);
    return [...ids];
  }, [classFilters, classRefine]);

  /**
   * §34.19 :1172 — the class-aware create request: when the picker's create
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
      presentAsMain: true,
      name,
      ...(effectiveClassIds.length > 0 ? { classIds: effectiveClassIds } : {}),
    });
  };

  const resolveCreateResult = (result: ClientNode | string | void): void => {
    if (typeof result === "string") {
      const node = client.getNode(result);
      if (node) handleAdd(node);
    } else if (result !== undefined && typeof result === "object" && "id" in result) {
      handleAdd(result);
    }
  };

  // Create support: default on for page/class pickers. The create row answers
  // the EFFECTIVE query — under a `class:` refine the prefix scopes the
  // search; it must not become part of the created node's title (M7).
  const effectiveQuery = classRefine.query.trim();
  const createEnabled = allowCreate ?? true;
  const effectiveCreateNew = onCreateNew ?? defaultCreateNew;
  const showCreateOption =
    !!effectiveCreateNew && createEnabled && (alwaysShowCreate || effectiveQuery.length > 0);

  const handleCreateNew = (applyAfter = false) => {
    if (effectiveCreateNew === undefined) return;
    // Empty-query create is only meaningful for override flows (upload,
    // quick-create modals): the built-in create needs a title, so the row
    // stays inert without a query unless the caller overrode it.
    if (effectiveQuery === "" && onCreateNew === undefined) return;
    const result = effectiveCreateNew(effectiveQuery);
    const onCreated = (created: ClientNode | string | void): void => {
      if (multiSelect) {
        // The created node joins the picked set; Enter's fast path commits.
        const node =
          typeof created === "string"
            ? client.getNode(created)
            : created !== undefined && typeof created === "object" && "id" in created
              ? (created as ClientNode)
              : undefined;
        if (node === undefined) return;
        const next = pickedIds.includes(node.id) ? pickedNodes : [...pickedNodes, node];
        setPickedIds(next.map((n) => n.id));
        if (applyAfter) applyMulti(next);
        return;
      }
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
  // (hidden in multi-select mode — the v1 boundary).
  const parsedDate = useMemo(() => {
    if (searchMode === "classes" || multiSelect) return null;
    return parseDate(inlineFilters.query.trim());
  }, [inlineFilters.query, searchMode, multiSelect]);

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
          const node = client.getNode(dateTarget.refId);
          if (node) handleAdd(node);
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
      ? node.isClass || rendersWithDocumentChrome(node)
      : rendersAsInlineBlock(node);
  };

  // Search results through the client. Classes are matched by name over the
  // class list (name filtering is the better picker behavior for short
  // queries); object/block hits go through the M2-ranked FTS index — the
  // class appliers reindex too, so "all"-mode search surfaces classes as
  // well. A `class:` refine (M7) narrows the candidates to the refined
  // class's members; "blocks" mode (M8) keeps only inline-body blocks — the
  // `((` block-linking candidate set.
  const searchResults = useMemo(() => {
    const q = classRefine.query.trim().toLowerCase();
    if (searchMode === "classes") {
      const classes = client.listClasses().filter((node) => {
        if (!matchesInlineFilters(node)) return false;
        if (q === "") return true;
        const name = displayNameForSettings(node) ?? node.id;
        return name.toLowerCase().includes(q);
      });
      return classes;
    }
    const hits = q === "" ? [] : client.search(classRefine.query.trim());
    const filtered = hits.filter((node) => {
      if (searchMode === "pages" && !rendersWithDocumentChrome(node)) return false;
      if (searchMode === "blocks" && !rendersAsInlineBlock(node)) return false;
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
        .filter((node) => searchMode !== "blocks" || rendersAsInlineBlock(node));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchesInlineFilters derives from inlineFilters (searchQuery); matchesScopeTab derives from scope/scopeTabs/searchMode.
  }, [client, searchQuery, searchMode, classRefine, effectiveClassIds, scopeTabs, scope]);

  const filteredResults = useMemo(
    () =>
      searchResults
        .filter((node) => !assignedIds.has(node.id))
        .filter((node) => !multiSelect || !pickedIds.includes(node.id))
        .filter((node) => node.id !== excludeNodeId)
        .filter((node) => canAdd === undefined || canAdd(node)),
    [searchResults, assignedIds, multiSelect, pickedIds, excludeNodeId, canAdd],
  );

  // Multi-select (§34.19): picked nodes resolved in pick order; toggling a
  // row never closes the picker; Apply commits the whole set at once.
  const pickedNodes = useMemo(
    () =>
      pickedIds
        .map((pickedId) => client.getNode(pickedId))
        .filter((node): node is ClientNode => node !== undefined),
    [client, pickedIds],
  );
  const togglePicked = (node: ClientNode): void => {
    setPickedIds((prev) =>
      prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id],
    );
  };
  const resetMulti = (): void => setPickedIds([]);
  /**
   * Commit a multi-select session. `explicit` overrides the picked set (the
   * Enter fast path picks a row AND commits in one gesture). The picker
   * closes first: the editor's close handler returns the caret to the block,
   * then the apply strips the trigger and re-places the caret at the splice.
   */
  const applyMulti = (explicit?: ClientNode[]): void => {
    const commit = explicit ?? pickedNodes;
    if (commit.length === 0) return;
    if (isAnchored) {
      onClose?.();
    } else {
      setIsPickerOpen(false);
      setSearchQuery("");
    }
    resetMulti();
    const result = onApplyMulti?.(commit);
    if (result instanceof Promise) result.catch(() => {});
  };

  const visibleResults = useMemo(
    () => filteredResults.slice(0, displayLimit),
    [filteredResults, displayLimit],
  );
  const showMoreOption = filteredResults.length > visibleResults.length;

  // Position the pill-row / anchored picker (fixed, flips above, clamped).
  const position = useViewportPosition(
    isAnchored ? anchorRef : buttonRef,
    isPickerOpen,
    { popupRef: pickerRef, edgePadding: PICKER_EDGE_PADDING },
  );

  // Close picker when clicking outside. While the class-aware quick-create
  // modal is open it owns the interaction (its backdrop is outside the
  // picker): the picker's dismissal handlers stand down so a backdrop click
  // or Escape reaches only the modal's own overlay stack.
  useEffect(() => {
    if (!isPickerOpen || quickCreate !== null) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const pickerElement = pickerRef.current;
      if (pickerElement !== null && pickerElement.contains(target)) return;
      // Anchored pickers: a real anchor swallows clicks on itself; the
      // virtual rect anchor has no element, so any outside click closes.
      const triggerElement = isAnchored ? (anchorEl ?? null) : buttonRef.current;
      if (triggerElement !== null && triggerElement.contains(target)) return;
      if (isAnchored) {
        onClose?.();
      } else {
        setIsPickerOpen(false);
        setSearchQuery("");
      }
      resetMulti();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isAnchored) {
          onClose?.();
        } else {
          setIsPickerOpen(false);
          setSearchQuery("");
        }
        resetMulti();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isPickerOpen, isAnchored, anchorEl, onClose, quickCreate]);

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

  const handleClosePicker = () => {
    resetMulti();
    if (isAnchored) {
      onClose?.();
    } else {
      setIsPickerOpen(false);
      setSearchQuery("");
    }
  };

  // Total selectable items (date suggestion offsets the list by one;
  // multi-select puts the picked rows first).
  const dateOffset = dateSuggestion ? 1 : 0;
  const pickedOffset = multiSelect ? pickedNodes.length : 0;
  const createIndex = pickedOffset + dateOffset + visibleResults.length;
  const showMoreIndex = createIndex + (showCreateOption ? 1 : 0);
  const totalItems =
    pickedOffset +
    visibleResults.length +
    dateOffset +
    (showCreateOption ? 1 : 0) +
    (showMoreOption ? 1 : 0);

  const handleSelectByIndex = (index: number, modifiers: { ctrlKey: boolean; metaKey: boolean }) => {
    if (multiSelect) {
      // Ctrl/Cmd+Enter commits the accumulated set from anywhere.
      if (modifiers.ctrlKey || modifiers.metaKey) {
        applyMulti();
        return;
      }
      // Enter on an already-picked row un-picks it (the session stays open).
      if (index < pickedNodes.length) {
        togglePicked(pickedNodes[index]!);
        return;
      }
    }
    if (dateSuggestion && index === 0) {
      dateSuggestion.onSelect();
      return;
    }
    const adjusted = index - pickedOffset - dateOffset;
    if (adjusted < visibleResults.length) {
      const node = visibleResults[adjusted]!;
      if (multiSelect) {
        // Enter = the fast single-assign path (the pre-multi contract): the
        // row joins the picked set and the whole set commits at once.
        // Checkbox clicks accumulate without committing instead.
        const next = pickedIds.includes(node.id) ? pickedNodes : [...pickedNodes, node];
        applyMulti(next);
        return;
      }
      handleAdd(node, modifiers.ctrlKey || modifiers.metaKey);
    } else if (showCreateOption && adjusted === visibleResults.length) {
      handleCreateNew(multiSelect);
    } else if (showMoreOption && adjusted === showMoreIndex - pickedOffset - dateOffset) {
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
      segments.unshift(displayNameForSettings(parent) || "Untitled");
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

  // Containing-page breadcrumb for a block hit (§34.30 M8): the nearest
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
        const name = displayNameForSettings(parent) || "Untitled";
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
        const name = displayNameForSettings(classNode);
        if (!name) return null;
        return { nodeUuid: classUuid, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
  };

  const handleSearchChange = (newQuery: string) => {
    setSearchQuery(newQuery);
    setDisplayLimit(DEFAULT_DISPLAY_LIMIT);
  };

  /** Switch the Main/Blocks scope: re-page results and keep typing in the search box. */
  const handleScopeChange = (next: "main" | "blocks") => {
    setScope(next);
    setDisplayLimit(DEFAULT_DISPLAY_LIMIT);
    searchInputRef.current?.focus();
  };

  const renderResults = (emptyClassName: string, createIconSize: number) => (
    <>
      {/* Multi-select (§34.19): picked rows ride the top of the list. */}
      {multiSelect &&
        pickedNodes.map((node, index) => (
          <NodeResultItem
            key={`picked:${node.id}`}
            node={node}
            isHighlighted={index === selectedIndex}
            isSelected
            onClick={() => togglePicked(node)}
            onMouseEnter={() => setSelectedIndex(index)}
            before={
              <span className="node-selector__multi-check" aria-hidden="true">
                <Checkbox size="sm" checked readOnly tabIndex={-1} aria-label="" />
              </span>
            }
          />
        ))}
      {dateSuggestion && (
        <NodeResultItem
          key={dateSuggestion.key}
          node={{ name: dateSuggestion.label }}
          isHighlighted={selectedIndex === pickedOffset}
          onClick={dateSuggestion.onSelect}
          onMouseEnter={() => setSelectedIndex(pickedOffset)}
          className="node-result-item--date"
          iconOverride={<Icon path="mdi-calendar" size={0.7} />}
        />
      )}
      {visibleResults.map((node, index) => {
        const globalIndex = pickedOffset + dateOffset + index;
        return (
          <NodeResultItem
            key={node.id}
            node={node}
            parentPath={
              rendersWithDocumentChrome(node) ? buildParentPath(node) : buildContainingPagePath(node)
            }
            displayClasses={getDisplayClasses(node)}
            isHighlighted={globalIndex === selectedIndex}
            isSelected={!multiSelect && assignedIds.has(node.id)}
            onClick={() => handleAdd(node)}
            onCtrlClick={() => handleAdd(node, true)}
            onMouseEnter={() => setSelectedIndex(globalIndex)}
            before={
              multiSelect ? (
                <span className="node-selector__multi-check" aria-hidden="true">
                  <Checkbox size="sm" checked={false} readOnly tabIndex={-1} aria-label="" />
                </span>
              ) : undefined
            }
          />
        );
      })}
      {showCreateOption && (
        <NodeResultItem
          key="__create"
          node={{ name: createLabel ?? `Create "${effectiveQuery}"` }}
          isHighlighted={selectedIndex === createIndex}
          onClick={handleCreateNew}
          onMouseEnter={() => setSelectedIndex(createIndex)}
          className="node-result-item--create"
          iconOverride={<Icon path="mdi-plus" size={createIconSize} />}
        />
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
      {totalItems === 0 && (
        <div className={emptyClassName}>
          {searchQuery ? "No matches found" : "Start typing to search"}
        </div>
      )}
    </>
  );

  /** Multi-select footer: picked count + Apply + keyboard hints. */
  const multiFooter = multiSelect ? (
    <div className="node-selector__multi-footer">
      <span className="node-selector__multi-count">{pickedNodes.length} picked</span>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={pickedNodes.length === 0}
        onClick={() => applyMulti()}
      >
        Apply{pickedNodes.length > 0 ? ` ${pickedNodes.length}` : ""}
      </button>
      <span className="node-selector__multi-hint">↵ toggle · ⌃↵ apply</span>
    </div>
  ) : null;

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
        <input
          ref={searchInputRef}
          type="text"
          className="node-selector__search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Tabs.Panel value={scope}>
          <div className="node-selector__options" ref={listRef}>
            {renderResults("node-selector__no-results", createIconSize)}
          </div>
        </Tabs.Panel>
        {multiFooter}
      </Tabs>
    ) : (
      <>
        <input
          ref={searchInputRef}
          type="text"
          className="node-selector__search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="node-selector__options" ref={listRef}>
          {renderResults("node-selector__no-results", createIconSize)}
        </div>
        {multiFooter}
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
