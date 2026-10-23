/**
 * Outliner editing context — provided by PageView and ClassView, consumed by
 * BlockRow (body blocks and the page title row) and BlockTextEditor.
 * `client` is the structural write surface, satisfied by both
 * WorkspaceClient and the WorkerClient proxy.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { foldSearchText } from "@notees/store";

import type { CaretPlacement } from "@/editor/caret.js";
import type { OutlinePositionMap } from "@/editor/outline.js";
import { buildOutlinePositions } from "@/editor/outline.js";
import type { UndoHistoryEntry, UndoUiState } from "@/core/undo-journal.js";
import type {
  BlockTreeNode,
  ClassBinding,
  ClientNode,
  ClientPropertySchema,
  CreateObjectInput,
  CreatePropertySchemaInput,
  DeleteObjectOptions,
  EffectiveProperty,
  QueryAggregateResult,
  QueryRunResult,
  SetClassPropertyInput,
  UpdateObjectInput,
  UpdatePropertySchemaInput,
} from "@/core/workspace-client/index.js";

import { displayNameFromClient } from "./dateDisplay.js";

export interface OutlinerClient {
  getNode(id: string): ClientNode | undefined;
  effectiveNodeColor(node: Pick<ClientNode, "color" | "classIds">): string | null;
  /** Class effectiveColor (the extends-chain walk): tints class-link underlines. */
  effectiveClassColor(classId: string): string | null;
  createObject(partial: CreateObjectInput): Promise<string>;
  updateObject(id: string, fields: UpdateObjectInput): Promise<void>;
  deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void>;
  /**
   * The session undo journal (in-memory, per tab): availability +
   * labels, undo, redo. Every write above is journaled as it applies; undo
   * composes existing ops through the same write path. View-level surfaces
   * (menus, chords) reach the journal here without app-shell plumbing.
   */
  undoState(): Promise<UndoUiState>;
  /** The browsable history (labels + timestamps + affected ids). */
  undoHistory(): Promise<UndoHistoryEntry[]>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /**
   * Reparent seam for indent/outdent/Enter placement (`object.move`).
   * `afterId` lands the node immediately after that sibling; `beforeId`
   * immediately before (W1 — the Enter-at-start / first-child placement);
   * omit both to append at the end (Tab indent).
   */
  moveObject(id: string, parentId: string | null, afterId?: string, beforeId?: string): Promise<void>;
  /**
   * Uncached children read (raw RPC on the worker; fresh alias in-process).
   * Write-compositions that plan reparents from the child list
   * (extractBlockToPage) ride this — a cached read can answer a cold key
   * with the empty default and silently drop the planned moves.
   */
  getChildrenFresh(id: string): Promise<ClientNode[]> | ClientNode[];
  /**
   * OR-set class membership add — the `#` / `+` "set" gesture. No-op when
   * the class is already assigned; otherwise appends to the node's class_ids
   * (read-modify-write over the node's current class_ids).
   */
  assignClass(id: string, classId: string): Promise<void>;
  /**
   * OR-set class membership remove — the class chip's × gesture
   * (`class.unassign`). No-op when the class is not assigned. The effective
   * read drops the class's derived defaults automatically; authored values
   * survive.
   */
  unassignClass(id: string, classId: string): Promise<void>;
  /** User-defined class order (class.reorder). */
  reorderClasses(id: string, classIds: string[]): Promise<void>;
  /**
   * OR-set tag membership add — the `#` capture gesture. Tags are any page
   * and attach to pages AND blocks (owner rule). No-op when already assigned.
   */
  assignTag(id: string, tagId: string): Promise<void>;
  /** OR-set tag membership remove — the tag pill's × gesture. */
  unassignTag(id: string, tagId: string): Promise<void>;
  /**
   * Author a property value (property.set) — the slash template flow's
   * provenance write (generatedFrom on the instantiated block) plus future
   * capture gestures that carry values.
   */
  setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Replace a class's full extends parent set (`class.setExtends`, m2m
   * replace semantics). The store fails loud on cycles (CycleError) — the
   * Class View surfaces that as a transient message.
   */
  setClassExtends(classId: string, parentClassIds: string[]): Promise<void>;
  /** Create a class node (`class.create`) — the `+` picker's create row. */
  createClass(name: string, opts?: { icon?: string; color?: string; id?: string }): Promise<string>;
  /**
   * Clear an authored property value (`property.set` with a null value) — the
   * task-cycle chord's Done -> cleared transition unsets the status at its
   * row idx.
   */
  unsetProperty(objectId: string, propertySchemaId: string, idx?: number): Promise<void>;
  /** Assign a property without a value (property.assign — owner ruling
   *  2026-10-23): the clone/menu write surface rides it. */
  assignProperty(objectId: string, propertySchemaId: string): Promise<void>;
  /**
   * Patch a property schema's metadata (`propertySchema.update`) — the
   * task-cycle chord's family ensure rides the status-restyle pass.
   */
  updatePropertySchema(
    propertySchemaId: string,
    fields: UpdatePropertySchemaInput,
  ): Promise<void>;
  /**
   * Declare a property schema (`propertySchema.create`) — the class-aware
   * quick-create's citation self-heal. The context value is always the full
   * client; these two declarations exist so pickers reached from the editor
   * (the `@` capture flow) type-check without widening the runtime surface.
   */
  createPropertySchema(input: CreatePropertySchemaInput): Promise<string>;
  /** Bind a schema to a class (`class.property.set`) — the citation self-heal. */
  setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void>;
  /** Raw store read (no projection) — the date suggestion's existence check. */
  getNodeRaw(id: string): ClientNode | undefined;
  /** Ensure the year/month/day journal chain; returns the three node ids. */
  ensureDateChain(isoDate: string): Promise<{ year: string; month: string; day: string }>;
}

export interface FocusRequest {
  id: string;
  caret: CaretPlacement;
}

/**
 * Local read surface consumed by view projections (EmbedView, the class
 * variant's section stack):
 * the live node, its subtree, name resolution, class facts (parents /
 * members / seed-derived bindings), the page/class lists and FTS search for
 * capture + pickers, plus the notify subscription that keeps a projection
 * live. Satisfied by both WorkspaceClient and the WorkerClient proxy (same
 * surface) — only the local cache is read, never the network.
 */
export interface OutlinerReader {
  getNode(id: string): ClientNode | undefined;
  getBlockTree(nodeId: string, depth?: number): BlockTreeNode[];
  getDisplayName(id: string): string | null;
  listPages(): ClientNode[];
  /** Top-level pages only (parentless non-class) — shell hubs + export enumerator. */
  roots(): ClientNode[];
  listClasses(): ClientNode[];
  /**
   * The narrow id → icon read behind the UI icon maps — prefer this
   * over `classIconMap(client.listClasses())`; both client classes satisfy it.
   */
  classIcons(): ReadonlyMap<string, string | null>;
  /**
   * The chain-resolved variant for DISPLAY: a class's own icon, else the
   * first icon found walking its extends chain (#1 follow-up) — the map
   * `nodeIcon` should read when rendering row/list icons.
   */
  effectiveClassIcons(): ReadonlyMap<string, string | null>;
  search(query: string): ClientNode[];
  getClassParents(classId: string): string[];
  getClassMembers(classId: string): ClientNode[];
  getClassBindings(classId: string): ClassBinding[];
  subscribe(listener: () => void): () => void;
  /** Live-query bridge for `query` content tokens (QueryBlockView). */
  runQueryAst(rawAst: unknown): QueryRunResult | Promise<QueryRunResult>;
  /** Aggregation bridge for `query` tokens carrying an `aggregation`. */
  runAggregateAst(rawAst: unknown): QueryAggregateResult | Promise<QueryAggregateResult>;
  /** Direct children in child order (export-on-query's nested-bullets read). */
  getChildren(id: string): ClientNode[];
  /** Effective properties (export-on-query's frontmatter read). */
  getEffectiveProperties(id: string): EffectiveProperty[];
  listPropertySchemas(): ClientPropertySchema[];
}

export interface OutlinerContextValue {
  client: OutlinerClient & OutlinerReader;
  /** The view root id (PageView: the page) — anchors the query builder's "this page" scope. */
  rootId: string;
  /** Render-cascade navigation: a class id opens the Class View, anything else the Page View. */
  openNode: (nodeId: string) => void;
  /** Sibling/parent facts for the current tree (keyboard gestures). */
  positions: OutlinePositionMap;
  /** Pending focus request, consumed by the targeted BlockRow. */
  focusRequest: FocusRequest | null;
  requestFocus: (blockId: string, caret?: CaretPlacement) => void;
  acknowledgeFocus: () => void;
  /**
   * Keyboard navigation in VISIBLE document order (the arrow-handoff
   * contract): the next/previous rendered block around `blockId` — folded
   * subtrees contribute no rows, so an answer is always a visible row.
   * `firstBlockId` is the first visible row of the tree (the title row's
   * Down/Right-at-end target). The view's own root (a page's title row, the
   * focused block view's root block) is never in the order — hosts handle
   * those edges themselves. Null when no such row exists.
   */
  nextBlockId: (blockId: string) => string | null;
  previousBlockId: (blockId: string) => string | null;
  firstBlockId: () => string | null;
  /**
   * Display collapse — DEVICE-PERSISTED per page (owner 2026-10-14: the
   * folds must survive reloads; device state stays out of the op log, so it
   * rides localStorage keyed by the page id, never the store): ids of
   * blocks whose entire subtree is hidden from rendering.
   */
  collapsed: ReadonlySet<string>;
  toggleCollapse: (blockId: string) => void;
  /**
   * The condensed layer's stretch state (owner 2026-10-15) — DEVICE-PERSISTED
   * per page like the folds (`notees.stretched.v1.<rootId>`): ids of blocks
   * rendered at FULL content while the condensed layer is on (the layer's
   * default is the one-line excerpt, so the set stores the exceptions).
   * View state only, never an op; inert ids (deleted blocks) never match a
   * rendered row and drop on the next rewrite. `clearStretched` is the
   * condense-all reset.
   */
  stretched: ReadonlySet<string>;
  toggleStretched: (blockId: string) => void;
  clearStretched: () => void;
  /**
   * Shift+click "peek" target: opens the node as an independent card in the
   * right sidebar instead of the main view. Defaults to a no-op where the
   * host shell has no right sidebar.
   */
  openInSidebar: (nodeId: string) => void;
  /**
   * Focus mode (#12): the device-local "only the editor" flag, provided by
   * the view and read by BlockRow — the row hides its reference/property
   * chrome (backlink gutter + panel, property icon buttons, the collapsed
   * properties section). Text editing is unchanged.
   */
  focusMode: boolean;
  /**
   * Block multi-selection — session-local display state (never an
   * op): the selected block-id set plus the anchor the range gestures
   * extend from. The stack is LEVEL-CAPPED (owner rule): every write maps
   * its raw ids to their ancestors at the stack's shallowest depth, so a
   * selection can never mix a block with a descendant of its sibling
   * ("14" stands in for its whole subtree — dragging the range onto the
   * child selects the ancestor instead). The exposed `selection` stays
   * whole-subtree — the roots' descendants close in implicitly — so the
   * visual stays one contiguous card. `selectionEnabled` is a view-level opt-in (the main page
   * body enables it; embedded feeds and read-only projections don't), so a
   * surface without the action bar never accumulates a selection.
   */
  selectionEnabled: boolean;
  /** The selected block ids — always closed over subtrees (see above). */
  selection: ReadonlySet<string>;
  /**
   * The level-capped selection stack itself: the shallowest-level roots the
   * gestures resolved to (never a block whose ancestor is also in the set).
   * The block-drag machinery drags these — the whole stack moves, internal
   * structure preserved.
   */
  selectionRoots: ReadonlySet<string>;
  selectionAnchor: string | null;
  setSelectionAnchor: (blockId: string | null) => void;
  replaceSelection: (blockIds: ReadonlySet<string>, anchor?: string | null) => void;
  toggleSelected: (blockId: string) => void;
  clearSelection: () => void;
  /** Document-order inclusive id range between two rows ([] when either id is outside this tree). */
  rangeBetween: (a: string, b: string) => string[];
  /** The drag-selection surface arms a one-shot swallow for the RELEASE row's
   *  trailing click (the click that ends the drag must not enter edit mode);
   *  clicks on any OTHER row are deliberate and edit normally. */
  signalDragClick: (endRowId: string) => void;
  consumeDragClick: (clickedRowId: string) => boolean;
  /**
   * Capture-gesture reads ([[ mention, # chip): filtered node search, the
   * class list, and name resolution for candidate rows. Provided from the
   * full client surface (in-process or worker proxy).
   */
  capture: {
    searchNodes(query: string): ClientNode[];
    listClasses(): ClientNode[];
    displayName(id: string): string | null;
  };
  /**
   * The template family's idempotent self-heal (template class
   * node + has-template/generated-from schemas), invoked by the slash
   * template flow before instantiation. The full client lives at the view
   * level (PageView), which provides the seam; shells without it skip the
   * heal (the provenance write itself is schema-independent).
   */
  ensureTemplateFamily?: (() => Promise<void>) | undefined;
}

/**
 * Builds the OutlinerContext value for a view rooted at `rootId` — shared by
 * PageView (block tree + header title row) and ClassView (page chrome +
 * panels). The block-tree facts (positions, focus hand-off, collapse) are
 * inert for ClassView, which renders no editable rows but reuses chrome
 * (the title row) that consumes the context. `options.openNode` wires
 * render-cascade navigation for projections that navigate (query result
 * lists); it defaults to a no-op.
 */
/**
 * Collapse persistence (owner 2026-10-14) — the fold set survives reloads,
 * device-locally. Device state never becomes an op, so this rides
 * localStorage keyed by the page id (`notees.collapse.v1.<rootId>`); node
 * ids are UUIDv7-globally-unique, so no workspace scoping is needed. Stale
 * ids (deleted blocks) are inert — `collapsed.has` only matches rendered
 * rows — and are dropped the next time the set is rewritten.
 */
const COLLAPSE_STORAGE_PREFIX = "notees.collapse.v1.";

/**
 * Stretch persistence — the condensed layer's (stretchtext) twin of the
 * collapse set: the ids of blocks stretched to their FULL content while the
 * layer is on (the default under the layer is excerpted, so the set stores
 * the exceptions). Same device-local ruling (`notees.stretched.v1.<rootId>`,
 * never an op), same inert-id semantics (deleted blocks never match a
 * rendered row; stale ids drop the next time the set is rewritten).
 */
const STRETCHED_STORAGE_PREFIX = "notees.stretched.v1.";

function loadIdSet(prefix: string, rootId: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(prefix + rootId);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function persistIdSet(prefix: string, rootId: string, ids: ReadonlySet<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(prefix + rootId, JSON.stringify([...ids]));
  } catch {
    // Storage full / blocked: the set stays session-local, never loud.
  }
}

function loadCollapsedState(rootId: string): Set<string> {
  return loadIdSet(COLLAPSE_STORAGE_PREFIX, rootId);
}

function persistCollapsedState(rootId: string, ids: ReadonlySet<string>): void {
  persistIdSet(COLLAPSE_STORAGE_PREFIX, rootId, ids);
}

/** Node-identity tree compare — the structural-sharing test (a fresh read
 *  with every node identical to the previous one reuses the previous tree). */
function sameBlockTreeList(a: readonly BlockTreeNode[], b: readonly BlockTreeNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!sameBlockTreeNode(a[i]!, b[i]!)) return false;
  }
  return true;
}

function sameBlockTreeNode(a: BlockTreeNode, b: BlockTreeNode): boolean {
  if (a.node !== b.node || a.children.length !== b.children.length) return false;
  return sameBlockTreeList(a.children, b.children);
}

export function useOutlinerValue(
  client: OutlinerClient & OutlinerReader,
  rootId: string,
  options?: {
    openNode?: (nodeId: string) => void;
    openInSidebar?: (nodeId: string) => void;
    ensureTemplateFamily?: () => Promise<void>;
    /** Block multi-selection opt-in (the main page body sets it). */
    selection?: boolean;
    /** Focus mode (#12) — hides block-level reference/property chrome. */
    focusMode?: boolean;
    /**
     * Read-only collection projections (the flat outline list, owner
     * 2026-10-21): ids in this set render COLLAPSED until the user expands
     * them — pages-with-children default folded in the node-collection
     * outline. The expansion override is SESSION-LOCAL (never persisted);
     * the persisted fold set keeps storing only explicit folds.
     */
    defaultCollapsed?: ReadonlySet<string> | undefined;
  },
): OutlinerContextValue {
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => loadCollapsedState(rootId));
  // Mirror for the toggle (computes the next set outside the state updater,
  // where the persistence write would be an impure side effect).
  const collapsedRef = useRef<ReadonlySet<string>>(collapsedIds);
  // The default-collapsed overrides (owner 2026-10-21): rows a read-only
  // collection projection folds by default (pages with children) read
  // collapsed until the user expands them. The override is session-local —
  // device state, never persisted — so the "collapsed by default" ruling
  // re-applies on the next session.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const expandedRef = useRef<ReadonlySet<string>>(expandedIds);
  const defaultCollapsedRef = useRef(options?.defaultCollapsed);
  defaultCollapsedRef.current = options?.defaultCollapsed;
  // The passthrough callbacks ride latest-value refs: hosts hand fresh
  // inline identities per render (the App's navigation funnels do), and
  // memo-depending on them would rebuild the whole context value every
  // render — re-rendering every row through context regardless of the
  // prop-level memo. The ref indirection always invokes the LATEST option,
  // so no stale closure is possible.
  const openNodeRef = useRef(options?.openNode);
  openNodeRef.current = options?.openNode;
  const openInSidebarRef = useRef(options?.openInSidebar);
  openInSidebarRef.current = options?.openInSidebar;
  const ensureTemplateFamilyRef = useRef(options?.ensureTemplateFamily);
  ensureTemplateFamilyRef.current = options?.ensureTemplateFamily;
  const isEffectivelyCollapsed = useCallback((blockId: string): boolean => {
    if (collapsedRef.current.has(blockId)) return true;
    const defaults = defaultCollapsedRef.current;
    return defaults !== undefined && defaults.has(blockId) && !expandedRef.current.has(blockId);
  }, []);
  const toggleCollapse = useCallback(
    (blockId: string) => {
      const next = new Set(collapsedRef.current);
      const nextExpanded = new Set(expandedRef.current);
      if (isEffectivelyCollapsed(blockId)) {
        next.delete(blockId);
        // A default-collapsed row expands via the SESSION override only —
        // it never enters the persisted fold set.
        if (defaultCollapsedRef.current?.has(blockId) === true) nextExpanded.add(blockId);
        else nextExpanded.delete(blockId);
      } else {
        nextExpanded.delete(blockId);
        next.add(blockId);
      }
      collapsedRef.current = next;
      setCollapsedIds(next);
      persistCollapsedState(rootId, next);
      expandedRef.current = nextExpanded;
      setExpandedIds(nextExpanded);
    },
    [rootId, isEffectivelyCollapsed],
  );
  // The stretched set — the condensed layer's exceptions (blocks rendered
  // full while the layer is on). Same persistence shape and toggle pattern
  // as the collapse set; `clearStretched` is the condense-all reset.
  const [stretchedIds, setStretchedIds] = useState<ReadonlySet<string>>(() =>
    loadIdSet(STRETCHED_STORAGE_PREFIX, rootId),
  );
  const stretchedRef = useRef<ReadonlySet<string>>(stretchedIds);
  const toggleStretched = useCallback(
    (blockId: string) => {
      const next = new Set(stretchedRef.current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      stretchedRef.current = next;
      setStretchedIds(next);
      persistIdSet(STRETCHED_STORAGE_PREFIX, rootId, next);
    },
    [rootId],
  );
  const clearStretched = useCallback(() => {
    const next = new Set<string>();
    stretchedRef.current = next;
    setStretchedIds(next);
    persistIdSet(STRETCHED_STORAGE_PREFIX, rootId, next);
  }, [rootId]);

  const [selectedRoots, setSelectedRoots] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  // Latest-value subtree map: the selection cap/toggle callbacks are stable
  // ([]) and must read the CURRENT tree, not the render that created them.
  const subtreeOfRef = useRef<Map<string, string[]>>(new Map());
  // Latest-value positions mirror — the cap rule reads parent chains live.
  const positionsRef = useRef<OutlinePositionMap>(new Map());
  // Latest-value document order mirrors (the range/arrow closures read them
  // per call — the context value stays tree-independent).
  const orderedIdsRef = useRef<string[]>([]);
  const visibleOrderRef = useRef<string[]>([]);
  // Depth within this tree: top-level rows are 0 (their parent is the page,
  // which is not itself a row). Ids without facts (stale) read as depth 0 —
  // they cap nothing and map to themselves.
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>();
    let current = positionsRef.current.get(id)?.parentId;
    while (typeof current === "string" && !seen.has(current)) {
      if (positionsRef.current.get(current) === undefined) break; // the page root
      seen.add(current);
      depth += 1;
      current = positionsRef.current.get(current)?.parentId;
    }
    return depth;
  };
  const isDescendantOf = (id: string, ancestorId: string): boolean => {
    const seen = new Set<string>();
    let current = positionsRef.current.get(id)?.parentId;
    while (typeof current === "string" && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      current = positionsRef.current.get(current)?.parentId;
    }
    return false;
  };
  /**
   * The level cap (owner rule): a selection stack is capped at its
   * shallowest level — every raw id maps to its ancestor at the stack's
   * min depth, so a range can never mix "14" (depth 0) with its child
   * "el hecho de proteger…" (depth 1): dragging onto the child selects
   * "14" instead. The result is the capped ROOT set; subtree closure is
   * implicit (`selection` derives from these).
   */
  const capSelection = (raw: ReadonlySet<string>): Set<string> => {
    if (raw.size === 0) return new Set();
    let cap = Number.POSITIVE_INFINITY;
    const depths = new Map<string, number>();
    for (const id of raw) {
      const depth = depthOf(id);
      depths.set(id, depth);
      cap = Math.min(cap, depth);
    }
    const capped = new Set<string>();
    for (const id of raw) {
      const depth = depths.get(id)!;
      if (depth <= cap) {
        capped.add(id);
        continue;
      }
      let mapped = id;
      for (let level = depth; level > cap; level -= 1) {
        const parent = positionsRef.current.get(mapped)?.parentId;
        if (typeof parent !== "string") break;
        mapped = parent;
      }
      capped.add(mapped);
    }
    return capped;
  };
  const replaceSelection = useCallback((blockIds: ReadonlySet<string>, anchor?: string | null) => {
    setSelectedRoots(capSelection(blockIds));
    if (anchor !== undefined) setSelectionAnchor(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capSelection reads the latest tree through positionsRef.
  }, []);
  const toggleSelected = useCallback((blockId: string) => {
    setSelectedRoots((prev) => {
      if (prev.has(blockId)) {
        const next = new Set(prev);
        next.delete(blockId);
        return next;
      }
      // Inside an already-selected subtree the ancestor is the selected
      // entity — toggling the row would open a deeper level in the stack,
      // which the cap rule forbids. No-op.
      for (const root of prev) {
        if (isDescendantOf(blockId, root)) return prev;
      }
      return capSelection(new Set([...prev, blockId]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same derivation as replaceSelection.
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedRoots(new Set<string>());
    setSelectionAnchor(null);
  }, []);
  const dragClickRef = useRef<string | null>(null);
  const signalDragClick = useCallback((endRowId: string) => {
    dragClickRef.current = endRowId;
  }, []);
  const consumeDragClick = useCallback((clickedRowId: string) => {
    const endRowId = dragClickRef.current;
    dragClickRef.current = null; // one-shot either way
    return endRowId !== null && endRowId === clickedRowId;
  }, []);

  /**
   * Structural sharing on node identity: the revision-cached read rebuilds
   * its tree (new wrapper objects) per notification, but unchanged rows KEEP
   * their node identity (mapNodeCached's column-stamp cache). The shared
   * array keeps the context value stable across notifications that rebuilt
   * nothing (the render-phase setState is the sanctioned derived-state
   * pattern). The tree-derived derivations below ride latest-value refs
   * (this file's established pattern) rather than the context value's
   * identity: making the value depend on the tree would rebuild it per
   * on-page edit and re-render EVERY row through context — the memoized
   * row cannot bail a context consumer.
   */
  const nextTree = client.getBlockTree(rootId);
  const [tree, setTree] = useState(nextTree);
  if (!sameBlockTreeList(tree, nextTree)) setTree(nextTree);
  // Effective collapse: the persisted folds plus the un-overridden
  // default-collapsed rows (the read-only collection projections).
  const effectiveCollapsed = useMemo(() => {
    if (options?.defaultCollapsed === undefined) return collapsedIds;
    const next = new Set(collapsedIds);
    for (const id of options.defaultCollapsed) {
      if (!expandedIds.has(id)) next.add(id);
    }
    return next;
  }, [collapsedIds, expandedIds, options?.defaultCollapsed]);

  // Per-render latest-value mirrors: the derivations stay fresh for the
  // closures/getters without entering the context value's memo deps.
  positionsRef.current = buildOutlinePositions(tree, rootId);
  const subtreeOf = new Map<string, string[]>();
  const collectSubtrees = (nodes: readonly BlockTreeNode[]): string[] => {
    const all: string[] = [];
    for (const entry of nodes) {
      const ids = [entry.node.id, ...collectSubtrees(entry.children)];
      subtreeOf.set(entry.node.id, ids);
      all.push(...ids);
    }
    return all;
  };
  collectSubtrees(tree);
  subtreeOfRef.current = subtreeOf;
  // Document-order id list for the range gestures (shift+click / drag).
  const orderedIds: string[] = [];
  const flattenIds = (nodes: readonly BlockTreeNode[]): void => {
    for (const entry of nodes) {
      orderedIds.push(entry.node.id);
      flattenIds(entry.children);
    }
  };
  flattenIds(tree);
  orderedIdsRef.current = orderedIds;
  // The VISIBLE document order (the arrow-handoff reads): a collapsed block
  // contributes its own row and nothing under it — the next/previous answer
  // is always a rendered row. Effective collapse: the persisted folds plus
  // the un-overridden default-collapsed rows (the read-only projections).
  const visibleOrder: string[] = [];
  const flattenVisible = (nodes: readonly BlockTreeNode[]): void => {
    for (const entry of nodes) {
      visibleOrder.push(entry.node.id);
      if (!effectiveCollapsed.has(entry.node.id)) flattenVisible(entry.children);
    }
  };
  flattenVisible(tree);
  visibleOrderRef.current = visibleOrder;

  // The selection closure: memoized per (selectedRoots × current subtree
  // map) so the identity stays stable across renders that touch neither —
  // rows read `selection.has(id)` per render, so a churning identity would
  // re-render the tree through context.
  const selectionCacheRef = useRef<{
    roots: ReadonlySet<string>;
    map: Map<string, string[]>;
    value: Set<string>;
  } | null>(null);
  const selectionFor = useCallback((roots: ReadonlySet<string>): Set<string> => {
    const cache = selectionCacheRef.current;
    if (cache !== null && cache.roots === roots && cache.map === subtreeOfRef.current) {
      return cache.value;
    }
    // The stored stack is level-capped roots; the exposed set is whole-subtree
    // (selecting a block also exposes its children — the visual is one card
    // around the contiguous range, and a partial subtree would break the
    // rectangle). Stale ids (not in this tree) are kept verbatim.
    const value = new Set<string>();
    for (const id of roots) {
      const subtree = subtreeOfRef.current.get(id);
      if (subtree === undefined) value.add(id);
      else for (const each of subtree) value.add(each);
    }
    selectionCacheRef.current = { roots, map: subtreeOfRef.current, value };
    return value;
  }, []);

  /**
   * The context value: memoized on the STATE it derives from (collapse /
   * stretch / selection / focus pieces, the option flags, the stable
   * callbacks) — never on the tree. Tree-derived members expose freshness
   * through the latest-value refs above (the navigation closures read them
   * per call; `positions` and `selection` are lazy getters), so an on-page
   * content edit changes no dep here and unchanged rows bail on the prop
   * memo.
   */
  const value = useMemo<OutlinerContextValue>(() => {
    return {
      client,
      rootId,
      openNode: (nodeId) => openNodeRef.current?.(nodeId),
      openInSidebar: (nodeId) => openInSidebarRef.current?.(nodeId),
      focusMode: options?.focusMode ?? false,
      selectionEnabled: options?.selection ?? false,
      get selection() {
        return selectionFor(selectedRoots);
      },
      selectionRoots: selectedRoots,
      selectionAnchor,
      setSelectionAnchor,
      replaceSelection,
      toggleSelected,
      clearSelection,
      rangeBetween: (a, b) => rangeOverOrderedIds(orderedIdsRef.current, a, b),
      signalDragClick,
      consumeDragClick,
      get positions() {
        return positionsRef.current;
      },
      focusRequest,
      requestFocus: (blockId: string, caret: CaretPlacement = "end") =>
        setFocusRequest({ id: blockId, caret }),
      acknowledgeFocus: () => setFocusRequest(null),
      nextBlockId: (blockId) => stepVisibleOrder(visibleOrderRef.current, blockId, 1),
      previousBlockId: (blockId) => stepVisibleOrder(visibleOrderRef.current, blockId, -1),
      firstBlockId: () => visibleOrderRef.current[0] ?? null,
      collapsed: effectiveCollapsed,
      toggleCollapse,
      stretched: stretchedIds,
      toggleStretched,
      clearStretched,
      capture: {
        /**
         * `@` mention candidates, by DISPLAY NAME (SCHEMA.md derivation). The
         * FTS index covers content plaintext AND stored names, so FTS hits are
         * unioned with pages + classes and filtered client-side by display name
         * (the filter keeps the name matches and drops nothing the pools did
         * not already surface).
         */
        searchNodes: (query) => {
          const q = foldSearchText(query.trim().toLowerCase());
          const pool = [
            ...client.listPages(),
            ...client.listClasses(),
            ...(q === "" ? [] : client.search(query)),
          ];
          const seen = new Set<string>();
          return pool.filter((node) => {
            if (seen.has(node.id)) return false;
            seen.add(node.id);
            if (q === "") return true;
            // Diacritics fold on both sides (the store search mirror): `@video`
            // surfaces the class "Vídeo".
            return foldSearchText((displayNameFromClient(client, node.id) ?? "").toLowerCase()).includes(
              q,
            );
          });
        },
        listClasses: () => client.listClasses(),
        displayName: (id) => displayNameFromClient(client, id),
      },
      ensureTemplateFamily: () => {
        const ensure = ensureTemplateFamilyRef.current;
        return ensure === undefined ? Promise.resolve() : ensure();
      },
    };
  }, [
    client,
    rootId,
    selectedRoots,
    selectionAnchor,
    selectionFor,
    effectiveCollapsed,
    stretchedIds,
    focusRequest,
    replaceSelection,
    toggleSelected,
    clearSelection,
    signalDragClick,
    consumeDragClick,
    toggleCollapse,
    toggleStretched,
    clearStretched,
    options?.selection,
    options?.focusMode,
  ]);

  return value;
}

/** The shift+click / drag range over the document-order ids (pure). */
function rangeOverOrderedIds(ids: readonly string[], a: string, b: string): string[] {
  const ia = ids.indexOf(a);
  const ib = ids.indexOf(b);
  if (ia === -1 || ib === -1) return [];
  const [from, to] = ia <= ib ? [ia, ib] : [ib, ia];
  return ids.slice(from, to + 1);
}

/** The arrow-handoff step over the VISIBLE order (pure): null at the edge. */
function stepVisibleOrder(ids: readonly string[], blockId: string, delta: 1 | -1): string | null {
  const index = ids.indexOf(blockId);
  const next = index + delta;
  return index >= 0 && next >= 0 && next < ids.length ? ids[next]! : null;
}

export const OutlinerContext = createContext<OutlinerContextValue | null>(null);

export function useOutliner(): OutlinerContextValue {
  const context = useContext(OutlinerContext);
  if (context === null) {
    throw new Error("useOutliner must be used inside a view's OutlinerContext (a NodeView-rendered view)");
  }
  return context;
}
