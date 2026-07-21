/**
 * QueryNodeCollection Component
 * 
 * A unified component for displaying query-based node collections.
 * Handles view management, query execution, and result display.
 * 
 * Used by:
 * - Query blocks (inline mode with headless=true)
 * - Page sections (wrapped in NodeViewSection)
 */
import type React from 'react';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@/components/ui/Spinner';
import { 
  useNodeViews, 
  useNodeViewQuery,
  useQuery_,
  useCreateNodeView,
  useUpdateQueryAST,
  useUpdateNodeView,
  useDeleteNodeView,
  useDuplicateNodeView,
  useReorderNodeViews,
  useResetNodeViews,
  batchEnsureDefaults,
} from '@/features/content/hooks/useNodeViews';
import { useCreateNode, usePageClass, useAddClass } from '@/features/content/hooks/useNodes';
import { useClasses, useLinkedReferences } from '@/features/content/hooks/useNodeQueries';
import { nodeNameToText } from '@/features/queries';

import { useContentSave } from '@/features/editor';

import type { NodeView, NodeViewType, NodeViewSettings } from '@/types/nodeView';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import { createEmptyQueryAST, countConditions, isEmptyQuery } from '@/types/queryAST';
import { NodeCollection } from './NodeCollection';
import type { Node, Property } from '@/types';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { validateQueryAST } from '@/lib/queryValidation';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { normalizeAST } from '@/lib/astNormalizer';
import { QueryEditModal } from './QueryNodeCollection/QueryEditModal';
import { QueryPreviewModal } from './QueryNodeCollection/QueryPreviewModal';
import { ViewTabs } from './QueryNodeCollection/ViewTabs';
import type { NodeCollectionViewMode, NodeCollectionGroupBy, SortEntry, ChartConfig } from '@/types/nodeCollection';
import { useNavigationStore, useAppStore, useSettingsStore } from '@/stores';
import type { CardLayoutMode } from '@/stores/appStore';
import { useProperties } from '@/features/properties';
import './QueryNodeCollection.css';

import { applyCollapseLevelToChildren, extractUuidsFromAST } from './QueryNodeCollection/helpers';
import { dedupeNodesByUuid } from '@/utils/nodeTree';
import { queryKeys } from '@/hooks/queryKeys';

const PSEUDO_NODE_UUID = '00000000-0000-0000-0000-000000000000';



// ==================== Types ====================

export interface QueryNodeCollectionProps {
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The node name (used to include the active node in graph views) */
  nodeName?: string;
  /** The view type (e.g., 'linked_references', 'child_pages') */
  viewType: NodeViewType | string;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeUuid: string, isPage?: boolean) => void;
  /** Callback when a block is created (for opening in sidebar) */
  onBlockCreated?: (nodeUuid: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Whether to hide the toolbar completely (for inline/headless use like query blocks) */
  hideToolbar?: boolean;
  /** Whether to show add button in toolbar */
  showAddButton?: boolean;
  /** Element to render at the left side of the toolbar (e.g., block element, collapsible header) */
  leftElement?: React.ReactNode | ((count: number) => React.ReactNode);
  /** Hide toolbar controls while keeping leftElement visible */
  hideToolbarControls?: boolean;
  /** Hide the content area while keeping toolbar visible */
  hideContent?: boolean;
  /** Hide view management controls (view selector, filter button, add view button) */
  hideViewManagement?: boolean;
  /** Whether to show class pills in list view (default: true) */
  showClasses?: boolean;
  /** Whether to show the trailing "add block" ghost bullet in list view (default: true) */
  showNewBlock?: boolean;

  // ==================== Capability Props ====================
  
  /** Whether new items can be created (default: true). Controls add buttons in toolbar and card view. */
  can_create?: boolean;
  /** Whether items can be edited (default: true). Controls editability of content. */
  can_edit?: boolean;
  /** Whether items can be deleted (default: true). Controls delete actions in context menus. */
  can_delete?: boolean;

  // ==================== Inline Mode Props ====================

  /**
   * When provided, bypasses the NodeView system entirely.
   * The QueryAST is read directly from the node's `name` AST field (query block approach).
   * Use together with `onQueryASTChange` for inline query blocks.
   */
  queryAST?: QueryAST;
  /** Called when the user saves an edited query in inline mode. */
  onQueryASTChange?: (ast: QueryAST) => void;
  /** Called when the result count changes. */
  onCountChange?: (count: number) => void;

  /** Render prop - receives controls and results */
  children: (result: QueryNodeCollectionResult) => React.ReactNode;
}

export interface QueryNodeCollectionResult {
  /** Toolbar/header actions */
  controls: React.ReactNode;
  /** The results (NodeCollection) */
  results: React.ReactNode;
  /** Number of results */
  count: number;
  /** Whether loading */
  isLoading: boolean;
}

// ==================== Main Component ====================

export function QueryNodeCollection({ 
      nodeUuid,
      nodeName,
      viewType,
      onNodeClick,
      onBlockCreated,
      hideToolbar = false,
      showAddButton = true,
      leftElement,
      hideToolbarControls = false,
      hideContent = false,
      hideViewManagement = false,
      showClasses = true,
      showNewBlock = true,
      can_create = true,
      can_edit = true,
      can_delete = true,
      queryAST: inlineQueryAST,
      onQueryASTChange,
      onCountChange,
      children }: QueryNodeCollectionProps): React.ReactNode {
  // Inline mode: query AST comes directly, not from a NodeView.
  // onQueryASTChange is optional — when absent the inline query is read-only.
  const isInlineMode = inlineQueryAST !== undefined;
  // Compute effective capabilities
  // can_create controls both toolbar add button and card view add card
  const effectiveCanCreate = can_create && showAddButton;
  
  // Use content save hook for editable collections
  const { handleContentChange: saveContent } = useContentSave();
  
  // State
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editingView, setEditingView] = useState<NodeView | null>(null);
  const [editViewName, setEditViewName] = useState('');
  const [editAST, setEditAST] = useState<QueryAST | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [showProseModal, setShowProseModal] = useState(false);

  // Handle AST changes during editing
  const handleASTChange = useCallback((newAST: QueryAST) => {
    setEditAST(newAST);
    const validationResult = validateQueryAST(newAST);
    setValidation(validationResult);
  }, []);
  const storeCardLayout = useAppStore(state => state.cardLayout);
  const setStoreCardLayout = useAppStore(state => state.setCardLayout);
  const storeGanttStartUuid = useAppStore(state => state.ganttStartDatePropertyUuid);
  const storeGanttEndUuid = useAppStore(state => state.ganttEndDatePropertyUuid);
  const setStoreGanttStartUuid = useAppStore(state => state.setGanttStartDatePropertyUuid);
  const setStoreGanttEndUuid = useAppStore(state => state.setGanttEndDatePropertyUuid);
  const storeGanttTimeScale = useAppStore(state => state.ganttTimeScale);
  const setStoreGanttTimeScale = useAppStore(state => state.setGanttTimeScale);
  const openNode = useNavigationStore(state => state.openNode);
  const { data: allProperties = [] } = useProperties();

  /** Default view modes per section — used when a view has no explicit mode. */
  function getDefaultViewMode(type: string): NodeCollectionViewMode {
    switch (type) {
      case 'classed_nodes':
        return 'table';
      case 'child_pages':
      case 'linked_references':
      case 'unlinked_references':
      case 'all_pages':
      case 'extended_by':
      default:
        return 'list';
    }
  }

  const defaultViewMode = getDefaultViewMode(viewType);

  // Session-only mode for collections without a persistable view
  // (inline query blocks, pseudo-nodes like all_pages).
  const [sessionViewMode, setSessionViewMode] = useState<NodeCollectionViewMode | null>(null);
  useEffect(() => {
    setSessionViewMode(null);
  }, [nodeUuid, viewType]);

  // Document mode is only meaningful in main content view, not query views
  const queryAvailableViewModes: NodeCollectionViewMode[] =
    viewType === 'classed_nodes'
      ? ['list', 'table', 'kanban', 'graph']
      : ['list', 'table', 'kanban', 'gantt', 'calendar', 'chart', 'pivot', 'graph', 'timeline'];

  const queryPagesOnly = viewType === 'all_pages' || viewType === 'child_pages' || viewType === 'extended_by';

  // Default to 'page' — group by page automatically in list view.
  // Child pages already filters to a single parent, so grouping by page is redundant.
  const defaultGroupBy: NodeCollectionGroupBy = viewType === 'child_pages' ? 'none' : 'page';
  // Property column selection state (for table view)
  // Default to Created and Modified columns (matches default table columns)
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Check if this is a pseudo-node (used for all_pages view)
  const isPseudoNode = nodeUuid === PSEUDO_NODE_UUID;
  // Pseudo-nodes are not real persisted parents; never show a ghost block under them.
  const effectiveShowNewBlock = isPseudoNode ? false : showNewBlock;

  // In inline mode the AST comes directly from the node's name — no NodeViews needed.
  // Ensure default views exist for normal mode — uses microtask batching so all
  // QuerySections that mount in the same render tick are merged into ONE API call.
  useEffect(() => {
    if (isInlineMode) {
      setHasInitialized(true);
      return;
    }
    if (!isPseudoNode) {
      batchEnsureDefaults(nodeUuid, viewType as string).then(
        () => setHasInitialized(true),
        () => setHasInitialized(true)
      );
    } else {
      setHasInitialized(true);
    }
  }, [nodeUuid, viewType, isInlineMode, isPseudoNode]);

  const isInitializing = !hasInitialized;

  // Add class mutation
  const addClass = useAddClass();
  const handleAddClass = useCallback((blockId: string, classId: string) => {
    // The core-backed addClass mutation applies the class assignment immediately,
    // so no separate optimistic runtime update is needed.
    addClass.mutate({ nodeUuid: blockId, classId });
  }, [addClass]);

  // Fetch views for this node and view type (skipped in inline mode)
  const { 
    data: viewsRaw, 
    isLoading: viewsLoading,
    refetch: refetchViews,
  } = useNodeViews(nodeUuid, { 
    viewType, 
    enabled: !isInlineMode && !isPseudoNode && hasInitialized,
  });
  const views = useMemo(() => viewsRaw ?? [], [viewsRaw]);

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateQueryMutation = useUpdateQueryAST();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();
  const duplicateViewMutation = useDuplicateNodeView();
  const reorderViewsMutation = useReorderNodeViews();
  const resetNodeViewsMutation = useResetNodeViews();
  const createNodeMutation = useCreateNode();
  const { pageClassUuid } = usePageClass();
  
  // Fetch all classes for prose rendering
  const { data: allClasses = [] } = useClasses();

  // Determine active view
  // In inline mode, create a synthetic view from the provided queryAST
  const syntheticInlineView = useMemo((): NodeView | null => {
    if (!isInlineMode) return null;
    return {
      uuid: '',
      node_uuid: nodeUuid,
      name: '',
      view_type: viewType as string,
      order_index: 0,
      is_default: true,
      active: true,
      shown_properties: [],
      group_by: null,
      view_mode: null,
      sort_entries: [],
      settings: {},
      create_date: '',
      write_date: '',
      query_ast: inlineQueryAST,
    };
  }, [isInlineMode, nodeUuid, viewType, inlineQueryAST]);

  const activeView = useMemo(() => {
    if (isInlineMode) return syntheticInlineView;
    if (activeViewId) {
      return views.find(v => v.uuid === activeViewId) ?? views[0] ?? null;
    }
    const defaultView = views.find(v => v.is_default);
    return defaultView ?? views[0] ?? null;
  }, [isInlineMode, syntheticInlineView, views, activeViewId]);

  // ---- Per-view presentation state (persisted on the NodeView) ----
  // Inline query blocks and pseudo-nodes have no persistable view; they use
  // session state instead.
  const canPersistViewState = !isInlineMode && !!activeView;

  const collectionViewMode: NodeCollectionViewMode = canPersistViewState
    ? (activeView!.view_mode ?? defaultViewMode)
    : (sessionViewMode ?? defaultViewMode);

  const handleViewModeChange = useCallback((mode: NodeCollectionViewMode) => {
    if (canPersistViewState && activeView) {
      updateViewMutation.mutate({ viewId: activeView.uuid, data: { view_mode: mode } });
    } else {
      setSessionViewMode(mode);
    }
  }, [canPersistViewState, activeView, updateViewMutation]);

  // View modes that actually render nested children
  const childrenFriendlyViewModes: NodeCollectionViewMode[] = ['list', 'table', 'kanban'];
  const needsChildren = childrenFriendlyViewModes.includes(collectionViewMode);

  // Group-by is persisted per view ('none'/'page'/property UUID, or array for multi-level)
  const groupBy: NodeCollectionGroupBy = activeView?.group_by ?? defaultGroupBy;
  const effectiveGroupBy: NodeCollectionGroupBy = viewType === 'child_pages' ? 'none' : groupBy;
  const setGroupBy = useCallback((value: NodeCollectionGroupBy) => {
    if (!activeView || isInlineMode) return;
    updateViewMutation.mutate({ viewId: activeView.uuid, data: { group_by: value } });
  }, [activeView, isInlineMode, updateViewMutation]);

  const handleSortChange = useCallback((entries: SortEntry[]) => {
    if (!activeView || isInlineMode) return;
    updateViewMutation.mutate({ viewId: activeView.uuid, data: { sort_entries: entries } });
  }, [activeView, isInlineMode, updateViewMutation]);

  // Per-mode layout settings — persisted per view; appStore globals are kept in
  // sync as "last used" seeds for new views.
  const viewSettings = activeView?.settings;

  const handleSettingsChange = useCallback((patch: NodeViewSettings) => {
    if (!activeView || isInlineMode) return;
    updateViewMutation.mutate({
      viewId: activeView.uuid,
      data: { settings: { ...(activeView.settings ?? {}), ...patch } },
    });
  }, [activeView, isInlineMode, updateViewMutation]);

  const handleCardLayoutChange = useCallback((layout: CardLayoutMode) => {
    setStoreCardLayout(layout);
    handleSettingsChange({ cardLayout: layout });
  }, [setStoreCardLayout, handleSettingsChange]);

  const ganttStartDateProperty = useMemo(
    () => allProperties.find(p => p.uuid === (viewSettings?.ganttStartDatePropertyUuid ?? storeGanttStartUuid)),
    [allProperties, viewSettings?.ganttStartDatePropertyUuid, storeGanttStartUuid]
  );
  const ganttEndDateProperty = useMemo(
    () => allProperties.find(p => p.uuid === (viewSettings?.ganttEndDatePropertyUuid ?? storeGanttEndUuid)),
    [allProperties, viewSettings?.ganttEndDatePropertyUuid, storeGanttEndUuid]
  );

  const handleGanttStartDatePropertyChange = useCallback((property: Property | undefined) => {
    const uuid = property?.uuid ?? '';
    setStoreGanttStartUuid(uuid);
    handleSettingsChange({ ganttStartDatePropertyUuid: uuid });
  }, [setStoreGanttStartUuid, handleSettingsChange]);

  const handleGanttEndDatePropertyChange = useCallback((property: Property | undefined) => {
    const uuid = property?.uuid ?? '';
    setStoreGanttEndUuid(uuid);
    handleSettingsChange({ ganttEndDatePropertyUuid: uuid });
  }, [setStoreGanttEndUuid, handleSettingsChange]);

  const handleGanttTimeScaleChange = useCallback((scale: 'day' | 'week' | 'month') => {
    setStoreGanttTimeScale(scale);
    handleSettingsChange({ ganttTimeScale: scale });
  }, [setStoreGanttTimeScale, handleSettingsChange]);

  const chartConfig = useMemo((): ChartConfig => ({
    chartType: viewSettings?.chartType,
    groupByField: viewSettings?.chartGroupByField,
    measure: viewSettings?.chartMeasure,
  }), [viewSettings?.chartType, viewSettings?.chartGroupByField, viewSettings?.chartMeasure]);

  const handleChartConfigChange = useCallback((patch: ChartConfig) => {
    const settingsPatch: NodeViewSettings = {};
    if (patch.chartType !== undefined) settingsPatch.chartType = patch.chartType;
    if (patch.groupByField !== undefined) settingsPatch.chartGroupByField = patch.groupByField;
    if (patch.measure !== undefined) settingsPatch.chartMeasure = patch.measure;
    handleSettingsChange(settingsPatch);
  }, [handleSettingsChange]);

  // Count filter blocks for badge (excludes system query blocks)
  const filterBlockCount = useMemo(() => {
    const ast = activeView?.query_ast;
    if (!ast || typeof ast !== 'object' || ast.type !== 'query') return 0;
    // Apply auto-fix to ensure system conditions have proper capabilities marked
    // before counting (capabilities may be lost after backend round-trip)
    const fixedAST = autoFixSystemQuery(ast, viewType, { nodeUuid });
    return countConditions(fixedAST);
  }, [activeView, viewType, nodeUuid]);

  // Pseudo-node query AST for all_pages
  const pseudoNodeAST = useMemo((): QueryAST | undefined => {
    if (!isPseudoNode) return undefined;
    
    const defaultQueries: Record<string, QueryAST> = {
      all_pages: {
        type: 'query',
        version: '1.0',
        id: 'all_pages_query',
        scope: { type: 'scope', scope_type: 'pages' },
        root_group: {
          type: 'group',
          logic: 'AND',
          children: [
            {
              type: 'condition',
              condition_type: 'class',
              operator: 'is_any_of',
              class_uuids: [],
            } as any,
          ],
        },
      },
    };
    
    return defaultQueries[viewType] ?? createEmptyQueryAST();
  }, [isPseudoNode, viewType]);

  // Execute query for active view
  const {
    data: queryResults,
    isLoading: queryLoading,
  } = useNodeViewQuery(activeView?.uuid ?? '', {
    runtimeParams: {
      current_node_uuid: nodeUuid,
      current_node_id: nodeUuid,
      current_node_name: nodeNameToText(nodeName),
    },
    includeChildren: needsChildren,
    includeAllChildren: collectionViewMode === 'kanban',
    pagesOnly: queryPagesOnly,
    includeProperties: true,
    enabled: !!activeView && !isPseudoNode && viewType !== 'linked_references',
    ast: activeView?.query_ast ?? undefined,
  });

  // Pagination for linked references
  const LINKED_REFS_PAGE_SIZE = 50;
  const [linkedRefsOffset, setLinkedRefsOffset] = useState(0);

  // For linked_references, use dedicated API to get full metadata
  const {
    data: linkedReferencesData,
    isLoading: linkedReferencesLoading,
    isFetching: linkedRefsFetching,
  } = useLinkedReferences(
    viewType === 'linked_references' ? nodeUuid : null,
    { limit: LINKED_REFS_PAGE_SIZE, offset: linkedRefsOffset }
  );

  // Get collapse level setting for linked references
  const linkedRefsCollapseLevel = useSettingsStore(state => state.linkedRefsCollapseLevel);

  // Deduplicate by source_node.id as a safety net (backend should already
  // deduplicate, but this prevents any duplicate display in the UI).
  const dedupedLinkedRefs = useMemo(() => {
    if (!linkedReferencesData) return [];
    const seen = new Set<string>();
    return linkedReferencesData.linked_references.filter((ref) => {
      if (seen.has(ref.source_node.uuid)) return false;
      seen.add(ref.source_node.uuid);
      return true;
    });
  }, [linkedReferencesData]);

  // Extract nodes from linked references and attach metadata
  // Show page collapsed only when link comes from a property on a PAGE
  // For links in blocks (including text properties of blocks), show the block
  const { linkedReferencesBlocks, linkedReferencesPages } = useMemo(() => {
    if (!dedupedLinkedRefs.length) return { linkedReferencesBlocks: [] as Node[], linkedReferencesPages: [] as Node[] };
    
    const isListView = collectionViewMode === 'list';
    
    const blocks: Node[] = [];
    const pages: Node[] = [];
    // Deduplicate property-referencing pages by ID so each source
    // page appears once even if multiple blocks on it have a property pointing to this node.
    const seenPropertyPageIds = new Set<string>();
    
    for (const ref of dedupedLinkedRefs) {
      // Check if link has property context (direct property link or text link in text property)
      const isPropertyLink = ref.link_type === 'property';
      const hasPropertyInBreadcrumbs = ref.breadcrumb_path?.some(seg => seg.is_property) ?? false;
      const isPropertyContext = isPropertyLink || hasPropertyInBreadcrumbs;
      
      // In card/non-list view, property-context links (direct property links or text links inside
      // a text property) show as PAGE cards rather than individual block cards. The whole source
      // page is the meaningful unit ("a card for the entire page when the link comes from a
      // property"), and multiple refs from the same page are deduplicated into one card.
      if (!isListView && isPropertyContext) {
        const pageNode = ref.source_node.is_page
          ? ref.source_node
          : ref.source_page ?? ref.source_node;
        if (seenPropertyPageIds.has(pageNode.uuid)) continue;
        seenPropertyPageIds.add(pageNode.uuid);
        const node: Node = {
          ...pageNode,
          _linkedRefMetadata: {
            linkType: ref.link_type,
            propertyUuid: ref.property_uuid,
            propertyName: ref.property_name,
            targetNodeUuid: nodeUuid,
            sourceNodeUuid: ref.source_node.uuid,
          },
        };
        blocks.push(applyCollapseLevelToChildren(node, linkedRefsCollapseLevel, 0));
        continue;
      }

      const displayNode = ref.source_node;

      // For non-page-collapsed cases, add page info for breadcrumbs / card grouping
      const showPageCollapsed = isPropertyContext && ref.source_node.is_page;
      const pageInfo = (!showPageCollapsed && ref.source_page) ? {
        page_name: ref.source_page.name,
        page_uuid: ref.source_page.uuid,
      } : {};

      const node: Node = {
        ...displayNode,
        ...pageInfo,
        // Attach metadata for property references
        _linkedRefMetadata: {
          linkType: ref.link_type,
          propertyUuid: ref.property_uuid,
          propertyName: ref.property_name,
          targetNodeUuid: nodeUuid,
          // Store the actual source node UUID (for fetching properties in PropertyReferencesDisplay)
          sourceNodeUuid: ref.source_node.uuid,
        },
      };
      
      // Apply collapse level to children based on settings (independent of page's collapsed state)
      // This ensures that when a page is expanded, its children are collapsed according to the settings
      const nodeWithCollapsedChildren = applyCollapseLevelToChildren(node, linkedRefsCollapseLevel, 0);
      
      // Separate blocks and pages for list view
      if (isListView) {
        if (displayNode.is_page) {
          // Deduplicate property-context pages (same page may have multiple links)
          if (isPropertyContext) {
            if (seenPropertyPageIds.has(displayNode.uuid)) continue;
            seenPropertyPageIds.add(displayNode.uuid);
          }
          pages.push(nodeWithCollapsedChildren);
        } else {
          blocks.push(nodeWithCollapsedChildren);
        }
      } else {
        // For non-list views, keep everything together as blocks
        blocks.push(nodeWithCollapsedChildren);
      }
    }
    
    return { linkedReferencesBlocks: blocks, linkedReferencesPages: pages };
  }, [dedupedLinkedRefs, nodeUuid, collectionViewMode, linkedRefsCollapseLevel]);

  // Execute ad-hoc query for pseudo-nodes
  const {
    data: pseudoQueryResults,
    isLoading: pseudoQueryLoading,
  } = useQuery_(
    {
      query_ast: pseudoNodeAST ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeUuid,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: isPseudoNode && !!pseudoNodeAST,
      queryKey: queryKeys.pseudoNodeQuery(viewType, nodeUuid, collectionViewMode),
    }
  );

  // Execute ad-hoc query for inline mode
  const {
    data: inlineQueryResults,
    isLoading: inlineQueryLoading,
  } = useQuery_(
    {
      query_ast: inlineQueryAST,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeUuid,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: isInlineMode && !!inlineQueryAST,
      queryKey: queryKeys.inlineQuery(nodeUuid, inlineQueryAST, collectionViewMode),
    }
  );

  const rawResults = useMemo(() => {
    if (viewType === 'linked_references') {
      return [...linkedReferencesBlocks, ...linkedReferencesPages];
    }
    if (isInlineMode) return inlineQueryResults ?? [];
    if (isPseudoNode) return pseudoQueryResults ?? [];
    return queryResults ?? [];
  }, [viewType, linkedReferencesBlocks, linkedReferencesPages, isInlineMode, inlineQueryResults, isPseudoNode, pseudoQueryResults, queryResults]);
  const activeAST = isInlineMode ? inlineQueryAST
    : (isPseudoNode ? pseudoNodeAST : activeView?.query_ast);
  const resultNodes = useMemo(() => {
    const nodes = (activeAST && isEmptyQuery(activeAST)) ? [] : rawResults;
    return dedupeNodesByUuid(nodes, `QueryNodeCollection:${viewType}`);
  }, [activeAST, rawResults, viewType]);
  const isQueryLoading = viewType === 'linked_references' 
    ? linkedReferencesLoading 
    : isInlineMode ? inlineQueryLoading
    : (isPseudoNode ? pseudoQueryLoading : queryLoading);

  // Distinguish initial load (no data yet) from background refresh.
  // With placeholderData keeping previous results, we only want to show the
  // full spinner replacement on first load — not on every refetch.
  const isInitialLoading = isQueryLoading && resultNodes.length === 0;

  // Virtualization: for large result sets (>500 nodes), render in windows
  // to keep DOM size manageable and perceived latency <100ms
  const WINDOW_SIZE = 500;
  const [renderWindow, setRenderWindow] = useState(WINDOW_SIZE);
  
  // Reset window when results change
  const prevResultLenRef = useRef(0);
  useEffect(() => {
    if (resultNodes.length !== prevResultLenRef.current) {
      prevResultLenRef.current = resultNodes.length;
      setRenderWindow(WINDOW_SIZE);
    }
  }, [resultNodes.length]);

  // Reset linked refs pagination when node changes
  useEffect(() => {
    setLinkedRefsOffset(0);
  }, [nodeUuid]);
  
  // Windowed result set — bypass windowing in immersive/visualization modes
  // (gantt, graph, timeline) so all items are available for rendering.
  const windowedResultNodes = useMemo(() => {
    if (collectionViewMode === 'gantt' || collectionViewMode === 'graph' || collectionViewMode === 'timeline' || collectionViewMode === 'chart' || collectionViewMode === 'pivot') {
      return resultNodes;
    }
    if (resultNodes.length <= WINDOW_SIZE) return resultNodes;
    return resultNodes.slice(0, renderWindow);
  }, [resultNodes, renderWindow, collectionViewMode]);

  const hasMoreResults = !(collectionViewMode === 'gantt' || collectionViewMode === 'graph' || collectionViewMode === 'timeline' || collectionViewMode === 'chart' || collectionViewMode === 'pivot') && renderWindow < resultNodes.length;

  const handleLoadMore = useCallback(() => {
    if (viewType === 'linked_references') {
      setLinkedRefsOffset(prev => prev + LINKED_REFS_PAGE_SIZE);
    } else {
      setRenderWindow(prev => Math.min(prev + WINDOW_SIZE, resultNodes.length));
    }
  }, [viewType, resultNodes.length]);

  const linkedRefsTotalCount = linkedReferencesData?.total_count ?? 0;
  const hasMoreLinkedRefs = viewType === 'linked_references' && linkedRefsOffset + LINKED_REFS_PAGE_SIZE < linkedRefsTotalCount;

  // Always separate blocks and pages
  // In list/document view they render as separate sections; other views show all together
  // Skip separation for page-scope queries (results are all pages anyway)
  const { resultBlocks, resultPages } = useMemo(() => {
    const nodesForDisplay = windowedResultNodes;
    if (activeAST?.scope?.scope_type === 'pages') {
      return { resultBlocks: nodesForDisplay, resultPages: [] as Node[] };
    }
    const blocks: Node[] = [];
    const pages: Node[] = [];
    for (const node of nodesForDisplay) {
      if (node.is_page) {
        pages.push(node);
      } else {
        blocks.push(node);
      }
    }
    return { resultBlocks: blocks, resultPages: pages };
  }, [windowedResultNodes, activeAST?.scope?.scope_type]);

  // Only render blocks/pages as separate sections in list view when BOTH exist
  // When only blocks or only pages, show everything in a single section (no PAGES header needed)
  const isListView = collectionViewMode === 'list';
  const showPageSeparation = isListView && resultBlocks.length > 0 && resultPages.length > 0;

  // Show the PAGES section when there are both blocks and pages to display
  const showPagesSection = showPageSeparation;

  // Preview query for edit modal — debounced to avoid excessive backend calls
  const previewAST = useMemo(() => editAST ? normalizeAST(editAST) : undefined, [editAST]);

  // Debounce the preview AST (300ms) so rapid condition changes don't hammer the backend
  const [debouncedPreviewAST, setDebouncedPreviewAST] = useState(previewAST);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedPreviewAST(previewAST), 300);
    return () => clearTimeout(handle);
  }, [previewAST]);

  const {
    data: previewResults,
    isLoading: previewLoading,
  } = useQuery_(
    {
      query_ast: debouncedPreviewAST,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeUuid,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: !!debouncedPreviewAST,
      queryKey: queryKeys.previewQuery(nodeUuid, debouncedPreviewAST, collectionViewMode),
    }
  );

  const queryClient = useQueryClient();

  // Build nodesMap for prose rendering
  const nodesMap = useMemo(() => {
    const map = new Map<string, Node>();
    // Add preview results
    if (previewResults) {
      previewResults.forEach(node => {
        map.set(node.uuid, node);
      });
    }
    // Add all classes/types so they can be referenced by UUID
    allClasses.forEach(node => {
      map.set(node.uuid, node);
    });
    // Scan query cache for any nodes referenced in the AST
    const astUuids = extractUuidsFromAST(editAST);
    astUuids.forEach(nodeUuid => {
      if (map.has(nodeUuid)) return;
      const cached = queryClient.getQueryData<Node>(['nodes', 'uuid', nodeUuid]);
      if (cached) {
        map.set(nodeUuid, cached);
      }
    });
    return map;
  }, [previewResults, allClasses, editAST, queryClient]);

  // Handle clicking on a node link in prose preview
  const handleNodeLinkClick = useCallback((nodeUuid: string) => {
    const node = nodesMap.get(nodeUuid);
    if (node) {
      openNode(node.uuid);
    }
  }, [nodesMap, openNode]);

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    
    const queryId = `view-${view.node_uuid}-${view.uuid}`;
    let ast: QueryAST;
    
    if (view.query_ast && typeof view.query_ast === 'object' && view.query_ast.type === 'query') {
      ast = view.query_ast;
      if (!ast.id) {
        ast.id = queryId;
      }
    } else {
      ast = createEmptyQueryAST();
      ast.id = queryId;
    }
    
    ast = autoFixSystemQuery(ast, viewType, { nodeUuid });
    
    setEditAST(ast);
    const validationResult = validateQueryAST(ast);
    setValidation(validationResult);
  }, [viewType, nodeUuid]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editAST) return;
    
    try {
      const normalizedAST = normalizeAST(editAST);

      if (isInlineMode && onQueryASTChange) {
        // Inline mode: write back to node name instead of NodeView
        onQueryASTChange(normalizedAST);
      } else {
        await Promise.all([
          updateQueryMutation.mutateAsync({
            viewId: editingView.uuid,
            queryAST: normalizedAST,
          }),
          editViewName !== editingView.name && updateViewMutation.mutateAsync({
            viewId: editingView.uuid,
            data: { name: editViewName },
          }),
        ].filter(Boolean));
        refetchViews();
      }
      
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
    } catch (error) {
      console.error('Failed to save view:', error);
    }
  }, [editingView, editAST, editViewName, isInlineMode, onQueryASTChange, updateQueryMutation, updateViewMutation, refetchViews]);

  const handleDeleteView = useCallback(async (view?: NodeView) => {
    const target = view ?? editingView;
    if (!target) return;
    try {
      await deleteViewMutation.mutateAsync(target.uuid);
      if (editingView?.uuid === target.uuid) {
        setEditingView(null);
        setEditAST(null);
        setValidation(null);
        setEditViewName('');
      }
      if (activeViewId === target.uuid) {
        setActiveViewId(null);
      }
    } catch (error) {
      console.error('Failed to delete view:', error);
    }
  }, [editingView, activeViewId, deleteViewMutation]);

  const handleResetViews = useCallback(async () => {
    try {
      await resetNodeViewsMutation.mutateAsync(nodeUuid);
      setEditingView(null);
      setEditAST(null);
      setEditViewName('');
    } catch (error) {
      console.error('Failed to reset views:', error);
    }
  }, [nodeUuid, resetNodeViewsMutation]);

  const handlePropertyColumnsChange = useCallback((propertyUuids: string[]) => {
    setSelectedPropertyUuids(propertyUuids);
  }, []);

  const handleAddView = useCallback(async () => {
    try {
      const newView = await createViewMutation.mutateAsync({
        node_uuid: nodeUuid,
        name: 'New View',
        view_type: viewType,
        order_index: views.length,
        is_default: views.length === 0,
      });
      setActiveViewId(newView.uuid);
      handleEditView(newView);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  }, [nodeUuid, viewType, views.length, createViewMutation, handleEditView]);

  const handleDuplicateView = useCallback(async (view: NodeView) => {
    try {
      const copy = await duplicateViewMutation.mutateAsync(view.uuid);
      setActiveViewId(copy.uuid);
    } catch (error) {
      console.error('Failed to duplicate view:', error);
    }
  }, [duplicateViewMutation]);

  const handleSetDefaultView = useCallback((view: NodeView) => {
    updateViewMutation.mutate({ viewId: view.uuid, data: { is_default: true } });
  }, [updateViewMutation]);

  const handleReorderViews = useCallback((viewUuids: string[]) => {
    reorderViewsMutation.mutate({ nodeUuid, viewType: viewType as string, viewIds: viewUuids });
  }, [nodeUuid, viewType, reorderViewsMutation]);

  const handleAddNode = useCallback(async () => {
    try {
      if (!pageClassUuid) {
        console.error('Page class not found');
        return;
      }

      let nodeData: { name: string; class_uuids?: string[]; parent_uuid?: string } = {
        name: '',
      };

      switch (viewType) {
        case 'child_pages':
          nodeData = {
            name: '',
            class_uuids: [pageClassUuid],
            parent_uuid: nodeUuid,
          };
          break;

        case 'classed_nodes':
          nodeData = {
            name: '',
            parent_uuid: nodeUuid,
            class_uuids: [nodeUuid],
          };
          break;
        
        case 'all_pages':
          nodeData = {
            name: '',
            class_uuids: [pageClassUuid],
          };
          break;
        
        default:
          nodeData = { name: '' };
      }

      const newNode = await createNodeMutation.mutateAsync(nodeData);
      
      if (newNode.is_page) {
        onNodeClick?.(newNode.uuid, true);
      } else {
        onBlockCreated?.(newNode.uuid);
      }
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [viewType, nodeUuid, pageClassUuid, createNodeMutation, onNodeClick, onBlockCreated]);

  const resultCount = resultNodes.length;

  // Notify parent when result count changes
  useEffect(() => {
    onCountChange?.(resultCount);
  }, [resultCount, onCountChange]);

  // Loading state - return empty result only when we truly have no data yet.
  // With placeholderData, viewsLoading may be true during refetch but viewsRaw
  // still holds previous data. We only block when initializing or on first fetch.
  if (!isInlineMode && (isInitializing || (viewsLoading && viewsRaw === undefined))) {
    return children({
      controls: null,
      results: null,
      count: 0,
      isLoading: true,
    });
  }

  // Resolve leftElement (can be static or function)
  const resolvedLeftElement = typeof leftElement === 'function' 
    ? leftElement(resultCount) 
    : leftElement;

  // Toolbar prefix - view selector, filter button, add view button
  // When hideToolbar=true (query blocks), this is portaled to the block header;
  // NodeCollection's own toolbar (NodeCollectionToolbar) handles the view mode switcher inside results.
  // When hideToolbar=false (page sections), this is passed through to NodeCollectionToolbar as toolbarPrefix.
  const toolbarPrefix = (
    <>
      {!hideViewManagement && (
        <>
          {/* View selection (only when multiple views) */}
          {views.length > 1 && (
            <ViewTabs
              views={views}
              activeViewUuid={activeView?.uuid}
              onSelect={setActiveViewId}
              onReorder={handleReorderViews}
              onRename={handleEditView}
              onDuplicate={handleDuplicateView}
              onSetDefault={handleSetDefaultView}
              onDelete={(view) => handleDeleteView(view)}
            />
          )}
          
          {/* Hide add view button for pseudo-nodes and inline mode (query blocks manage AST directly) */}
          {!isPseudoNode && !isInlineMode && (
            <Button aria-label="Add view"
              icon={"mdi mdi-plus-box"}
              variant="ghost"
              size="xs"
              onClick={handleAddView}
              title="Add view"
            />
          )}

          {activeView && (
            <div className="query-section__filter-btn-wrapper">
              <Button aria-label="Edit view"
                icon={"mdi mdi-filter-outline"}
                variant="ghost"
                size="xs"
                onClick={() => handleEditView(activeView)}
                title="Edit view"
              />
              {filterBlockCount > 0 && (
                <Badge variant="primary" size="xs" className="query-section__filter-badge">
                  {filterBlockCount}
                </Badge>
              )}
            </div>
          )}
        </>
      )}
    </>
  );

  // Results with integrated toolbar
  const results = (
    <>
      {isInitialLoading ? (
        <div className="query-section__loading"><Spinner size="sm" /></div>
      ) : (
        <>
          {/* Subtle refresh indicator — keeps previous results visible during refetch */}
          {isQueryLoading && (
            <div className="query-section__refreshing" aria-label="Refreshing results">
              <Spinner size="sm" />
            </div>
          )}
          {/* Main results - blocks only when separating, all results otherwise */}
          <NodeCollection
            nodes={showPageSeparation ? resultBlocks : windowedResultNodes}
            viewUuid={activeView?.uuid}
            view={activeView ?? undefined}
            viewMode={collectionViewMode}
            availableViewModes={queryAvailableViewModes}
            onViewModeChange={handleViewModeChange}
            editable={can_edit}
            onContentChange={saveContent}
            hideToolbar={false}
            toolbarPrefix={hideToolbar ? undefined : toolbarPrefix}
            leftElement={resolvedLeftElement}
            hideToolbarControls={hideToolbarControls}
            hideContent={hideContent}
            showGroupBy={!hideViewManagement && (collectionViewMode === 'list' || collectionViewMode === 'kanban' || collectionViewMode === 'gantt') && viewType !== 'all_pages' && viewType !== 'child_pages'}
            groupBy={effectiveGroupBy}
            onGroupByChange={setGroupBy}
            sort={canPersistViewState ? (activeView!.sort_entries ?? []) : undefined}
            onSortChange={handleSortChange}
            cardLayout={viewSettings?.cardLayout ?? storeCardLayout}
            onCardLayoutChange={handleCardLayoutChange}
            ganttStartDateProperty={ganttStartDateProperty}
            ganttEndDateProperty={ganttEndDateProperty}
            onGanttStartDatePropertyChange={handleGanttStartDatePropertyChange}
            onGanttEndDatePropertyChange={handleGanttEndDatePropertyChange}
            ganttTimeScale={viewSettings?.ganttTimeScale ?? storeGanttTimeScale}
            onGanttTimeScaleChange={handleGanttTimeScaleChange}
            chartConfig={chartConfig}
            onChartConfigChange={handleChartConfigChange}
            showAddButton={effectiveCanCreate && viewType !== 'linked_references'}
            onAdd={effectiveCanCreate ? handleAddNode : undefined}
            can_create={can_create}
            can_edit={can_edit}
            can_delete={can_delete}
            pagesOnly={queryPagesOnly}
            showClasses={showClasses}
            showNewBlock={effectiveShowNewBlock}
            selectedPropertyUuids={selectedPropertyUuids}
            onPropertyColumnsChange={handlePropertyColumnsChange}
            onNodeClick={(node) => onNodeClick?.(node.uuid, node.is_page)}
            emptyMessage={filterBlockCount > 0 ? "No items match the filters" : "No items found"}
            showEmpty={!showPagesSection}
            autoCollapse={true}
            containerCard={showPagesSection ? false : viewType !== 'all_pages'}
            defaultSort={viewType === 'all_pages' ? [{ key: 'name', direction: 'asc' }] : undefined}
            activeNode={nodeName ? { nodeUuid: nodeUuid, uuid: nodeUuid, name: nodeName } : undefined}
            onAddClass={handleAddClass}
            showBreadcrumbs={viewType !== 'all_pages' && viewType !== 'child_pages'}
            hideProperties={viewType === 'all_pages' || viewType === 'child_pages'}
            queryAst={activeAST}
          />

          {/* Load more button for windowed results (hidden in gantt mode — filtering happens inside GanttView) */}
          {!hideContent && hasMoreResults && (
            <div className="query-section__load-more">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
              >
                Show more ({resultNodes.length - renderWindow} remaining)
              </Button>
            </div>
          )}
          {/* Load more button for paginated linked references */}
          {!hideContent && hasMoreLinkedRefs && (
            <div className="query-section__load-more">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
                disabled={linkedRefsFetching}
              >
                Show more ({linkedRefsTotalCount - linkedRefsOffset - LINKED_REFS_PAGE_SIZE} remaining)
              </Button>
            </div>
          )}

          {/* Pages section - shows when there are pages OR property ref items */}
          {showPagesSection && !hideContent && (
            <>
              <div className={`linked-references__pages-header ${
                resultBlocks.length === 0 ? 'linked-references__pages-header--no-blocks' : ''
              }`}>PAGES</div>

              {resultPages.length > 0 && <NodeCollection
                nodes={resultPages}
                viewUuid={activeView?.uuid}
                view={activeView ?? undefined}
                viewMode={collectionViewMode}
                availableViewModes={queryAvailableViewModes}
                onViewModeChange={handleViewModeChange}
                editable={can_edit}
                onContentChange={saveContent}
                hideToolbar={true}
                showGroupBy={false}
                groupBy="none"
                can_create={can_create}
                can_edit={can_edit}
                can_delete={can_delete}
                showClasses={showClasses}
                showNewBlock={effectiveShowNewBlock}
                selectedPropertyUuids={selectedPropertyUuids}
                onPropertyColumnsChange={handlePropertyColumnsChange}
                onNodeClick={(node) => onNodeClick?.(node.uuid, node.is_page)}
                showEmpty={false}
                autoCollapse={true}
                containerCard={false}
                onAddClass={handleAddClass}
                showBreadcrumbs={viewType !== 'all_pages' && viewType !== 'child_pages'}
                queryAst={activeAST}
              />}
            </>
          )}
        </>
      )}

      <QueryEditModal
        editingView={editingView}
        editAST={editAST}
        editViewName={editViewName}
        validation={validation}
        viewType={viewType}
        previewResults={previewResults}
        previewLoading={previewLoading}
        onClose={() => {
          setEditingView(null);
          setEditAST(null);
          setEditViewName('');
        }}
        onSave={handleSaveEdit}
        onDelete={handleDeleteView}
        onASTChange={handleASTChange}
        onViewNameChange={setEditViewName}
        onResetViews={handleResetViews}
        onShowProse={() => setShowProseModal(true)}
      />

      <QueryPreviewModal
        isOpen={showProseModal}
        editAST={editAST}
        nodesMap={nodesMap}
        onClose={() => setShowProseModal(false)}
        onNodeLinkClick={handleNodeLinkClick}
      />
    </>
  );

  return children({
    controls: toolbarPrefix,
    results,
    count: resultCount,
    isLoading: isQueryLoading,
  });
}

