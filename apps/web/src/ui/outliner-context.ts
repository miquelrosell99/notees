/**
 * Outliner editing context — provided by PageView and ClassView, consumed by
 * BlockRow / BlockTextEditor / TitleEditor. `client` is the structural write
 * surface, satisfied by both WorkspaceClient and the WorkerClient proxy.
 */

import { createContext, useCallback, useContext, useRef, useState } from "react";

import type { CaretPlacement } from "@/editor/caret.js";
import type { OutlinePositionMap } from "@/editor/outline.js";
import { buildOutlinePositions } from "@/editor/outline.js";
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
} from "@/core/workspace-client.js";

import { displayNameFromClient } from "./dateDisplay.js";

export interface OutlinerClient {
  getNode(id: string): ClientNode | undefined;
  effectiveNodeColor(node: Pick<ClientNode, "color" | "classIds">): string | null;
  createObject(partial: CreateObjectInput): Promise<string>;
  updateObject(id: string, fields: UpdateObjectInput): Promise<void>;
  deleteObject(id: string, opts?: DeleteObjectOptions): Promise<void>;
  /**
   * Reparent seam for indent/outdent/Enter placement (`object.move`).
   * `afterId` lands the node immediately after that sibling; `beforeId`
   * immediately before (W1 — the Enter-at-start / first-child placement);
   * omit both to append at the end (Tab indent).
   */
  moveObject(id: string, parentId: string | null, afterId?: string, beforeId?: string): Promise<void>;
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
 * Local read surface consumed by view projections (EmbedView, ClassView):
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
   * Session-local display collapse (never persisted, never written to the
   * store): ids of blocks whose entire subtree is hidden from rendering.
   */
  collapsed: ReadonlySet<string>;
  toggleCollapse: (blockId: string) => void;
  /**
   * Shift+click "peek" target: opens the node as an independent card in the
   * right sidebar instead of the main view. Defaults to a no-op where the
   * host shell has no right sidebar.
   */
  openInSidebar: (nodeId: string) => void;
  /**
   * §34.19 block multi-selection — session-local display state (never an
   * op): the selected block-id set plus the anchor the range gestures
   * extend from. `selectionEnabled` is a view-level opt-in (the main page
   * body enables it; embedded feeds and read-only projections don't), so a
   * surface without the action bar never accumulates a selection.
   */
  selectionEnabled: boolean;
  selection: ReadonlySet<string>;
  selectionAnchor: string | null;
  setSelectionAnchor: (blockId: string | null) => void;
  replaceSelection: (blockIds: ReadonlySet<string>, anchor?: string | null) => void;
  toggleSelected: (blockId: string) => void;
  clearSelection: () => void;
  /** Document-order inclusive id range between two rows ([] when either id is outside this tree). */
  rangeBetween: (a: string, b: string) => string[];
  /** The drag-selection surface sets a one-shot flag on drag end so the trailing click doesn't enter edit mode. */
  signalDragClick: () => void;
  consumeDragClick: () => boolean;
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
   * §34.25 T3: the template family's idempotent self-heal (template class
   * node + has-template/generated-from schemas), invoked by the slash
   * template flow before instantiation. The full client lives at the view
   * level (PageView), which provides the seam; shells without it skip the
   * heal (the provenance write itself is schema-independent).
   */
  ensureTemplateFamily?: (() => Promise<void>) | undefined;
}

/**
 * Builds the OutlinerContext value for a view rooted at `rootId` — shared by
 * PageView (block tree) and ClassView (page chrome + panels). The block-tree
 * facts (positions, focus hand-off, collapse) are inert for ClassView, which
 * renders no editable rows but reuses chrome (TitleEditor) that consumes the
 * context. `options.openNode` wires render-cascade navigation for projections
 * that navigate (query result lists); it defaults to a no-op.
 */
export function useOutlinerValue(
  client: OutlinerClient & OutlinerReader,
  rootId: string,
  options?: {
    openNode?: (nodeId: string) => void;
    openInSidebar?: (nodeId: string) => void;
    ensureTemplateFamily?: () => Promise<void>;
    /** Block multi-selection opt-in (the main page body sets it). */
    selection?: boolean;
  },
): OutlinerContextValue {
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleCollapse = useCallback((blockId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const replaceSelection = useCallback((blockIds: ReadonlySet<string>, anchor?: string | null) => {
    setSelectedIds(new Set(blockIds));
    if (anchor !== undefined) setSelectionAnchor(anchor);
  }, []);
  const toggleSelected = useCallback((blockId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set<string>());
    setSelectionAnchor(null);
  }, []);
  const dragClickRef = useRef(false);
  const signalDragClick = useCallback(() => {
    dragClickRef.current = true;
  }, []);
  const consumeDragClick = useCallback(() => {
    if (!dragClickRef.current) return false;
    dragClickRef.current = false;
    return true;
  }, []);

  const tree = client.getBlockTree(rootId);
  const positions = buildOutlinePositions(tree, rootId);
  // Document-order id list for the range gestures (shift+click / drag).
  const orderedIds: string[] = [];
  const flattenIds = (nodes: readonly BlockTreeNode[]): void => {
    for (const entry of nodes) {
      orderedIds.push(entry.node.id);
      flattenIds(entry.children);
    }
  };
  flattenIds(tree);
  const rangeBetween = (a: string, b: string): string[] => {
    const ia = orderedIds.indexOf(a);
    const ib = orderedIds.indexOf(b);
    if (ia === -1 || ib === -1) return [];
    const [from, to] = ia <= ib ? [ia, ib] : [ib, ia];
    return orderedIds.slice(from, to + 1);
  };

  return {
    client,
    rootId,
    openNode: options?.openNode ?? (() => {}),
    openInSidebar: options?.openInSidebar ?? (() => {}),
    selectionEnabled: options?.selection ?? false,
    selection: selectedIds,
    selectionAnchor,
    setSelectionAnchor,
    replaceSelection,
    toggleSelected,
    clearSelection,
    rangeBetween,
    signalDragClick,
    consumeDragClick,
    positions,
    focusRequest,
    requestFocus: (blockId: string, caret: CaretPlacement = "end") =>
      setFocusRequest({ id: blockId, caret }),
    acknowledgeFocus: () => setFocusRequest(null),
    collapsed: collapsedIds,
    toggleCollapse,
    capture: {
      /**
       * `@` mention candidates, by DISPLAY NAME (SCHEMA.md derivation). The
       * FTS index covers content plaintext AND stored names, so FTS hits are
       * unioned with pages + classes and filtered client-side by display name
       * (the filter keeps the name matches and drops nothing the pools did
       * not already surface).
       */
      searchNodes: (query) => {
        const q = query.trim().toLowerCase();
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
          return (displayNameFromClient(client, node.id) ?? "").toLowerCase().includes(q);
        });
      },
      listClasses: () => client.listClasses(),
      displayName: (id) => displayNameFromClient(client, id),
    },
    ensureTemplateFamily: options?.ensureTemplateFamily,
  };
}

export const OutlinerContext = createContext<OutlinerContextValue | null>(null);

export function useOutliner(): OutlinerContextValue {
  const context = useContext(OutlinerContext);
  if (context === null) {
    throw new Error("useOutliner must be used inside a view's OutlinerContext (PageView or ClassView)");
  }
  return context;
}
