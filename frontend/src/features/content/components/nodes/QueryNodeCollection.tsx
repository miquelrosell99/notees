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
  useResetNodeViews,
  batchEnsureDefaults,
} from '@/hooks/useNodeViews';
import { useCreateNode, usePageClass, useAddClass } from '@/hooks/useNodes';
import { useClasses, useLinkedReferences } from '@/hooks/useNodeQueries';
import { nodeNameToText } from '@/hooks/useStringifyAST';

import { useContentSave } from '@/hooks';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import type { NodeView, NodeViewType } from '@/types/nodeView';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import { createEmptyQueryAST, countConditions, isEmptyQuery } from '@/types/queryAST';
import { NodeCollection } from './NodeCollection';
import type { Node } from '@/types';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { validateQueryAST } from '@/lib/queryValidation';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { normalizeAST } from '@/lib/astNormalizer';
import { QueryEditModal } from './QueryNodeCollection/QueryEditModal';
import { QueryPreviewModal } from './QueryNodeCollection/QueryPreviewModal';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { useNavigationStore, useAppStore, useSettingsStore } from '@/stores';
import './QueryNodeCollection.css';

import { applyCollapseLevelToChildren, extractUuidsFromAST } from './QueryNodeCollection/helpers';

// ==================== Types ====================

export interface QueryNodeCollectionProps {
  /** The node ID to display views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The node name (used to include the active node in graph views) */
  nodeName?: string;
  /** The view type (e.g., 'linked_references', 'child_pages') */
  viewType: NodeViewType | string;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  /** Callback when a block is created (for opening in sidebar) */
  onBlockCreated?: (nodeId: number) => void;
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
  nodeId,
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
  can_create = true,
  can_edit = true,
  can_delete = true,
  queryAST: inlineQueryAST,
  onQueryASTChange,
  onCountChange,
  children,
}: QueryNodeCollectionProps): React.ReactNode {
  // Inline mode: query AST comes directly, not from a NodeView.
  // onQueryASTChange is optional — when absent the inline query is read-only.
  const isInlineMode = inlineQueryAST !== undefined;
  // Compute effective capabilities
  // can_create controls both toolbar add button and card view add card
  const effectiveCanCreate = can_create && showAddButton;
  
  // Use content save hook for editable collections
  const { handleContentChange: saveContent } = useContentSave();
  
  // State
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
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
  const getNodeGroupBy = useAppStore(state => state.getNodeGroupBy);
  const setNodeGroupBy = useAppStore(state => state.setNodeGroupBy);
  const openNode = useNavigationStore(state => state.openNode);

  /** Define default view modes per view section — never persisted. */
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

  const [collectionViewMode, setCollectionViewMode] = useState<NodeCollectionViewMode>(defaultViewMode);

  // Always reset to the default view mode when the node or section changes.
  useEffect(() => {
    setCollectionViewMode(getDefaultViewMode(viewType));
  }, [nodeId, viewType]);

  const handleViewModeChange = (mode: NodeCollectionViewMode) => {
    setCollectionViewMode(mode);
  };

  // Document mode is only meaningful in main content view, not query views
  const queryAvailableViewModes: NodeCollectionViewMode[] =
    viewType === 'classed_nodes'
      ? ['list', 'table', 'kanban', 'graph']
      : ['list', 'table', 'kanban', 'gantt', 'calendar', 'chart', 'graph', 'timeline'];

  // View modes that actually render nested children
  const childrenFriendlyViewModes: NodeCollectionViewMode[] = ['list', 'table', 'kanban'];
  const needsChildren = childrenFriendlyViewModes.includes(collectionViewMode);
  const queryPagesOnly = viewType === 'all_pages' || viewType === 'child_pages' || viewType === 'extended_by';
  
  // Default to 'page' — group by page automatically in list view
  const defaultGroupBy: NodeCollectionGroupBy = 'page';
  const [groupBy, setGroupByState] = useState<NodeCollectionGroupBy>(
    getNodeGroupBy(nodeId, viewType) ?? defaultGroupBy
  );
  const setGroupBy = (value: NodeCollectionGroupBy) => {
    setGroupByState(value);
    setNodeGroupBy(nodeId, viewType, value);
  };
  // Property column selection state (for table view)
  // Default to Created and Modified columns (matches default table columns)
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Check if this is a pseudo-node (nodeId <= 0, used for all_pages view)
  const isPseudoNode = nodeId <= 0;

  // In inline mode the AST comes directly from the node's name — no NodeViews needed.
  // Ensure default views exist for normal mode — uses microtask batching so all
  // QuerySections that mount in the same render tick are merged into ONE API call.
  useEffect(() => {
    if (isInlineMode) {
      setHasInitialized(true);
      return;
    }
    if (nodeId > 0) {
      batchEnsureDefaults(nodeId, viewType as string).then(
        () => setHasInitialized(true),
        () => setHasInitialized(true)
      );
    } else {
      setHasInitialized(true);
    }
  }, [nodeId, viewType, isInlineMode]);

  const isInitializing = !hasInitialized;

  // Add class mutation
  const addClass = useAddClass();
  const handleAddClass = useCallback((blockId: number, classId: number) => {
    // Optimistically update the runtime for immediate visual feedback
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getAllNodes().find(n => n.serverId === blockId);
    if (graphNode) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        runtime.upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
        }]);
      }
    }
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass]);

  // Fetch views for this node and view type (skipped in inline mode)
  const { 
    data: viewsRaw, 
    isLoading: viewsLoading,
    refetch: refetchViews,
  } = useNodeViews(nodeId, { 
    viewType, 
    enabled: !isInlineMode && nodeId > 0 && hasInitialized,
  });
  const views = useMemo(() => viewsRaw ?? [], [viewsRaw]);

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateQueryMutation = useUpdateQueryAST();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();
  const resetNodeViewsMutation = useResetNodeViews();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  
  // Fetch all classes for prose rendering
  const { data: allClasses = [] } = useClasses();

  // Determine active view
  // In inline mode, create a synthetic view from the provided queryAST
  const syntheticInlineView = useMemo((): NodeView | null => {
    if (!isInlineMode) return null;
    return {
      id: -1,
      uuid: '',
      node_id: nodeId,
      name: '',
      view_type: viewType as string,
      order_index: 0,
      is_default: true,
      active: true,
      shown_properties: [],
      group_by: null,
      create_date: '',
      write_date: '',
      query_ast: inlineQueryAST,
    };
  }, [isInlineMode, nodeId, viewType, inlineQueryAST]);

  const activeView = useMemo(() => {
    if (isInlineMode) return syntheticInlineView;
    if (activeViewId) {
      return views.find(v => v.id === activeViewId) ?? views[0] ?? null;
    }
    const defaultView = views.find(v => v.is_default);
    return defaultView ?? views[0] ?? null;
  }, [isInlineMode, syntheticInlineView, views, activeViewId]);

  // Count filter blocks for badge (excludes system query blocks)
  const filterBlockCount = useMemo(() => {
    const ast = activeView?.query_ast;
    if (!ast || typeof ast !== 'object' || ast.type !== 'query') return 0;
    // Apply auto-fix to ensure system conditions have proper capabilities marked
    // before counting (capabilities may be lost after backend round-trip)
    const fixedAST = autoFixSystemQuery(ast, viewType, { nodeUuid });
    return countConditions(fixedAST);
  }, [activeView, viewType, nodeUuid]);

  // Create SelectionButton options from views
  const viewOptions = useMemo(() => {
    return views.map(v => ({
      value: String(v.id),
      icon: "mdi mdi-eye-outline",
      label: v.name,
    }));
  }, [views]);

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
              condition_type: 'parent',
              operator: 'has_no_parent',
            } as any,
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
  } = useNodeViewQuery(activeView?.id ?? 0, {
    runtimeParams: { 
      current_node_uuid: nodeUuid,
      current_node_id: nodeId,
      current_node_name: nodeNameToText(nodeName),
    },
    includeChildren: needsChildren,
    includeAllChildren: collectionViewMode === 'kanban',
    pagesOnly: queryPagesOnly,
    includeProperties: true,
    enabled: !!activeView && nodeId > 0 && viewType !== 'linked_references',
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
    viewType === 'linked_references' ? nodeId : null,
    { limit: LINKED_REFS_PAGE_SIZE, offset: linkedRefsOffset }
  );

  // Get collapse level setting for linked references
  const linkedRefsCollapseLevel = useSettingsStore(state => state.linkedRefsCollapseLevel);

  // Deduplicate by source_node.id as a safety net (backend should already
  // deduplicate, but this prevents any duplicate display in the UI).
  const dedupedLinkedRefs = useMemo(() => {
    if (!linkedReferencesData) return [];
    const seen = new Set<number>();
    return linkedReferencesData.linked_references.filter((ref) => {
      if (seen.has(ref.source_node.id)) return false;
      seen.add(ref.source_node.id);
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
    const seenPropertyPageIds = new Set<number>();
    
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
        if (seenPropertyPageIds.has(pageNode.id)) continue;
        seenPropertyPageIds.add(pageNode.id);
        const node = {
          ...pageNode,
          _linkedRefMetadata: {
            linkType: ref.link_type,
            propertyId: ref.property_id,
            propertyName: ref.property_name,
            targetNodeId: nodeId,
            sourceNodeId: ref.source_node.id,
          },
        } as Node;
        blocks.push(applyCollapseLevelToChildren(node, linkedRefsCollapseLevel, 0));
        continue;
      }

      // Show page collapsed only when:
      // 1. It's a property-context link AND
      // 2. The source_node is a page (meaning the property is on the page, not on a block)
      const showPageCollapsed = isPropertyContext && ref.source_node.is_page;
      
      const displayNode = ref.source_node;
      
      const shouldCollapse = isListView && showPageCollapsed;
      
      // For non-page-collapsed cases, add page info for breadcrumbs / card grouping
      const pageInfo = (!showPageCollapsed && ref.source_page) ? {
        page_id: ref.source_page.id,
        page_name: ref.source_page.name,
        page_uuid: ref.source_page.uuid,
      } : {};
      
      const node = {
        ...displayNode,
        ...pageInfo,
        // Set collapsed state for pages in list view - always collapsed on load
        collapsed: shouldCollapse ? true : displayNode.collapsed,
        // Attach metadata for property references
        _linkedRefMetadata: {
          linkType: ref.link_type,
          propertyId: ref.property_id,
          propertyName: ref.property_name,
          targetNodeId: nodeId,
          // Store the actual node ID (for fetching properties in PropertyReferencesDisplay)
          sourceNodeId: ref.source_node.id,
        },
      } as Node;
      
      // Apply collapse level to children based on settings (independent of page's collapsed state)
      // This ensures that when a page is expanded, its children are collapsed according to the settings
      const nodeWithCollapsedChildren = applyCollapseLevelToChildren(node, linkedRefsCollapseLevel, 0);
      
      // Separate blocks and pages for list view
      if (isListView) {
        if (displayNode.is_page) {
          // Deduplicate property-context pages (same page may have multiple links)
          if (isPropertyContext) {
            if (seenPropertyPageIds.has(displayNode.id)) continue;
            seenPropertyPageIds.add(displayNode.id);
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
  }, [dedupedLinkedRefs, nodeId, collectionViewMode, linkedRefsCollapseLevel]);

  // Execute ad-hoc query for pseudo-nodes
  const {
    data: pseudoQueryResults,
    isLoading: pseudoQueryLoading,
  } = useQuery_(
    {
      query_ast: pseudoNodeAST ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: isPseudoNode && !!pseudoNodeAST,
      queryKey: ['pseudo-node-query', viewType, nodeId, collectionViewMode],
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
        current_node_id: nodeId,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: isInlineMode && !!inlineQueryAST,
      queryKey: ['inline-query', nodeId, inlineQueryAST, collectionViewMode],
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
    return nodes;
  }, [activeAST, rawResults]);
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
  }, [nodeId]);
  
  // Windowed result set — bypass windowing in immersive/visualization modes
  // (gantt, graph, timeline) so all items are available for rendering.
  const windowedResultNodes = useMemo(() => {
    if (collectionViewMode === 'gantt' || collectionViewMode === 'graph' || collectionViewMode === 'timeline') {
      return resultNodes;
    }
    if (resultNodes.length <= WINDOW_SIZE) return resultNodes;
    return resultNodes.slice(0, renderWindow);
  }, [resultNodes, renderWindow, collectionViewMode]);

  const hasMoreResults = !(collectionViewMode === 'gantt' || collectionViewMode === 'graph' || collectionViewMode === 'timeline') && renderWindow < resultNodes.length;

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
        current_node_id: nodeId,
        current_node_name: nodeNameToText(nodeName),
      },
      include_children: needsChildren,
      include_all_children: collectionViewMode === 'kanban',
      pages_only: queryPagesOnly,
      include_properties: true,
    },
    {
      enabled: !!debouncedPreviewAST,
      queryKey: ['preview-query', nodeId, debouncedPreviewAST, collectionViewMode],
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
    astUuids.forEach(uuid => {
      if (map.has(uuid)) return;
      const cached = queryClient.getQueryData<Node>(['nodes', 'uuid', uuid]);
      if (cached) {
        map.set(uuid, cached);
      }
    });
    return map;
  }, [previewResults, allClasses, editAST, queryClient]);

  // Handle clicking on a node link in prose preview
  const handleNodeLinkClick = useCallback((uuid: string) => {
    const node = nodesMap.get(uuid);
    if (node) {
      openNode(node.id);
    }
  }, [nodesMap, openNode]);

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    
    const queryId = `view-${view.id}-${view.uuid}`;
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
            viewId: editingView.id,
            queryAST: normalizedAST,
          }),
          editViewName !== editingView.name && updateViewMutation.mutateAsync({
            viewId: editingView.id,
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

  const handleDeleteView = useCallback(async () => {
    if (!editingView) return;
    try {
      await deleteViewMutation.mutateAsync(editingView.id);
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
      if (activeViewId === editingView.id) {
        setActiveViewId(null);
      }
    } catch (error) {
      console.error('Failed to delete view:', error);
    }
  }, [editingView, activeViewId, deleteViewMutation]);

  const handleResetViews = useCallback(async () => {
    try {
      await resetNodeViewsMutation.mutateAsync(nodeId);
      setEditingView(null);
      setEditAST(null);
      setEditViewName('');
    } catch (error) {
      console.error('Failed to reset views:', error);
    }
  }, [nodeId, resetNodeViewsMutation]);

  const handlePropertyColumnsChange = useCallback((propertyUuids: string[]) => {
    setSelectedPropertyUuids(propertyUuids);
  }, []);

  const handleAddView = useCallback(async () => {
    try {
      const newView = await createViewMutation.mutateAsync({
        node_id: nodeId,
        name: 'New View',
        view_type: viewType,
        order_index: views.length,
        is_default: views.length === 0,
      });
      setActiveViewId(newView.id);
      handleEditView(newView);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  }, [nodeId, viewType, views.length, createViewMutation, handleEditView]);

  const handleAddNode = useCallback(async () => {
    try {
      if (!pageClassId) {
        console.error('Page class not found');
        return;
      }

      let nodeData: { name: string; classes?: number[]; parent_id?: number } = {
        name: '',
      };

      switch (viewType) {
        case 'child_pages':
          nodeData = {
            name: '',
            classes: [pageClassId],
            parent_id: nodeId,
          };
          break;
        
        case 'classed_nodes':
          nodeData = {
            name: '',
            parent_id: nodeId,
            classes: [nodeId],
          };
          break;
        
        case 'all_pages':
          nodeData = {
            name: '',
            classes: [pageClassId],
          };
          break;
        
        default:
          nodeData = { name: '' };
      }

      const newNode = await createNodeMutation.mutateAsync(nodeData);
      
      if (newNode.is_page) {
        onNodeClick?.(newNode.id, true);
      } else {
        onBlockCreated?.(newNode.id);
      }
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [viewType, nodeId, pageClassId, createNodeMutation, onNodeClick, onBlockCreated]);

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
            <SelectionButton
              options={viewOptions}
              value={String(activeView?.id ?? '')}
              onChange={(value) => setActiveViewId(Number(value))}
              size="sm"
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
            viewId={activeView?.id}
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
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            showAddButton={effectiveCanCreate && viewType !== 'linked_references'}
            onAdd={effectiveCanCreate ? handleAddNode : undefined}
            can_create={can_create}
            can_edit={can_edit}
            can_delete={can_delete}
            pagesOnly={queryPagesOnly}
            showClasses={showClasses}
            selectedPropertyUuids={selectedPropertyUuids}
            onPropertyColumnsChange={handlePropertyColumnsChange}
            onNodeClick={(node) => onNodeClick?.(node.id, node.is_page)}
            emptyMessage={filterBlockCount > 0 ? "No items match the filters" : "No items found"}
            showEmpty={!showPagesSection}
            autoCollapse={true}
            containerCard={showPagesSection ? false : viewType !== 'all_pages'}
            defaultSort={viewType === 'all_pages' ? [{ key: 'name', direction: 'asc' }] : undefined}
            activeNode={nodeName ? { id: nodeId, uuid: nodeUuid, name: nodeName } : undefined}
            onAddClass={handleAddClass}
            showBreadcrumbs={viewType !== 'all_pages' && viewType !== 'child_pages'}
            hideProperties={viewType === 'all_pages' || viewType === 'child_pages'}
          />

          {/* Load more button for windowed results (hidden in gantt mode — filtering happens inside GanttView) */}
          {hasMoreResults && (
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
          {hasMoreLinkedRefs && (
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
                viewId={activeView?.id}
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
                selectedPropertyUuids={selectedPropertyUuids}
                onPropertyColumnsChange={handlePropertyColumnsChange}
                onNodeClick={(node) => onNodeClick?.(node.id, node.is_page)}
                showEmpty={false}
                autoCollapse={true}
                containerCard={false}
                onAddClass={handleAddClass}
                showBreadcrumbs={viewType !== 'all_pages' && viewType !== 'child_pages'}
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

