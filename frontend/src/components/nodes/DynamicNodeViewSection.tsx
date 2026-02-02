/**
 * DynamicNodeViewSection Component
 * 
 * A section component that dynamically loads and displays NodeViews.
 * Uses the query system to execute queries and show results.
 * 
 * This component:
 * 1. Ensures default views exist for the node (lazy init)
 * 2. Loads views for the specified view_type
 * 3. Uses SelectionButton for view selection when multiple views exist
 * 4. Executes the active view's query with runtime parameters
 * 5. Renders results using NodeCollection
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  useNodeViews, 
  useEnsureDefaultViews,
  useNodeViewQuery,
  useQuery_,
  useCreateNodeView,
  useUpdateQueryAST,
  useUpdateNodeView,
  useDeleteNodeView,
  useResetNodeViews,
} from '@/hooks/useNodeViews';
import { useCreateNode, usePageClass, useNodes } from '@/hooks/useNodes';
import type { NodeView, NodeViewType } from '@/types/query';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import type { Node } from '@/types/api';
import { createEmptyQueryAST, countConditions, isEmptyQuery } from '@/types/queryAST';
import { NodeCollection, NodeCollectionToolbar } from './NodeCollection';
import { NodeViewSection } from './NodeViewSection';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { Badge } from '../core/Badge';
import { SelectionButton } from '../core/SelectionButton';
import { InlineConfirmButton } from '../core/InlineConfirmButton';
import { TextField } from '../core/TextField';
import { ViewBuilder } from '../queries';
import { ProseScopeSelector } from '../queries/ProseScopeSelector';
import { QuerySQLPreview } from '../queries/QuerySQLPreview';
import { ProseRenderer } from '../queries/ProseRenderer';
import { DeleteIcon } from '../icons';
import { validateQueryAST, canSaveQuery, getValidationSummary } from '@/lib/queryValidation';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { getQueryIntent } from '@/lib/astProseRenderer';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { useNodesStore } from '@/stores';
import { mdiPlusBox, mdiFilterOutline, mdiRefresh, mdiEyeOutline, mdiClose, mdiContentCopy } from '@mdi/js';
import './DynamicNodeViewSection.css';
import './QueryPreview.css';

// ==================== Types ====================

export interface DynamicNodeViewSectionProps {
  /** The node ID to display views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The view type (e.g., 'linked_references', 'child_pages') */
  viewType: NodeViewType | string;
  /** Section title */
  title: string;
  /** Icon for the section header */
  icon?: React.ReactNode;
  /** Whether to hide section when no results */
  hideWhenEmpty?: boolean;
  /** Default expanded state */
  defaultExpanded?: boolean;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  /** Callback when a block is created (for opening in sidebar) */
  onBlockCreated?: (nodeId: number) => void;
  /** Additional CSS class */
  className?: string;
  /** When true, calls children with {controls, results} for custom layout */
  split?: boolean;
  /** Render prop for split mode - receives {controls, results} */
  children?: (result: { controls: React.ReactNode; results: React.ReactNode } | null) => React.ReactNode;
}

// ==================== Main Component ====================

export function DynamicNodeViewSection({
  nodeId,
  nodeUuid,
  viewType,
  title,
  icon,
  hideWhenEmpty = true,
  defaultExpanded = true,
  onNodeClick,
  onBlockCreated,
  className = '',
  headless = false,
  split = false,
  children,
}: DynamicNodeViewSectionProps): React.JSX.Element | { controls: React.ReactNode; results: React.ReactNode } | null {
  // State
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [editingView, setEditingView] = useState<NodeView | null>(null);
  const [editViewName, setEditViewName] = useState('');
  // AST is the source of truth for editing
  const [editAST, setEditAST] = useState<QueryAST | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [showProseModal, setShowProseModal] = useState(false);

  // Handle copying AST to clipboard
  const handleCopyAST = useCallback(() => {
    if (editAST) {
      const astJson = JSON.stringify(editAST, null, 2);
      navigator.clipboard.writeText(astJson);
    }
  }, [editAST]);
  
  // Get persisted view mode from store
  const getNodeViewMode = useNodesStore(state => state.getNodeViewMode);
  const setNodeViewMode = useNodesStore(state => state.setNodeViewMode);
  const persistedViewMode = getNodeViewMode(nodeId);
  
  const [collectionViewMode, setCollectionViewMode] = useState<NodeCollectionViewMode>(
    persistedViewMode ?? 'list'
  );
  
  // Update store when view mode changes
  const handleViewModeChange = (mode: NodeCollectionViewMode) => {
    setCollectionViewMode(mode);
    setNodeViewMode(nodeId, mode);
  };
  
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Check if this is a pseudo-node (nodeId <= 0, used for all_pages view)
  const isPseudoNode = nodeId <= 0;

  // Ensure default views exist
  const ensureDefaultViews = useEnsureDefaultViews();
  
  useEffect(() => {
    if (nodeId > 0) {
      ensureDefaultViews.mutate(
        { nodeId, viewTypes: [viewType] },
        { onSettled: () => setHasInitialized(true) }
      );
    } else {
      // For pseudo-nodes, mark as initialized immediately
      setHasInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation is stable
  }, [nodeId, viewType]);

  // Track if we're still initializing views (mutation pending or not yet started)
  const isInitializing = !hasInitialized;

  // Fetch views for this node and view type
  // Wait for initialization to complete before enabling the query
  const { 
    data: views = [], 
    isLoading: viewsLoading,
    refetch: refetchViews,
  } = useNodeViews(nodeId, { 
    viewType, 
    enabled: nodeId > 0 && hasInitialized,
  });

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateQueryMutation = useUpdateQueryAST();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();
  const resetViewsMutation = useResetNodeViews();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { addSidebarCard, openNode } = useNodesStore();

  // Load all pages for node name lookup in prose renderer
  const { data: allPages = [] } = useNodes({ pages_only: true });
  
  // Create a map of UUID -> Node for quick lookup
  const nodesMap = useMemo(() => {
    const map = new Map<string, Node>();
    allPages.forEach(node => {
      map.set(node.uuid, node);
    });
    return map;
  }, [allPages]);

  // Determine active view
  const activeView = useMemo(() => {
    if (activeViewId) {
      return views.find(v => v.id === activeViewId) ?? views[0] ?? null;
    }
    // Find default or first view
    return views.find(v => v.is_default) ?? views[0] ?? null;
  }, [views, activeViewId]);

  // Load property columns from active view
  useEffect(() => {
    if (activeView?.shown_properties) {
      const sortedProperties = [...activeView.shown_properties]
        .sort((a, b) => a.sequence - b.sequence)
        .map(p => p.uuid);
      setSelectedPropertyUuids(sortedProperties);
    }
  }, [activeView]);

  const handlePropertyColumnsChange = (propertyUuids: string[]) => {
    setSelectedPropertyUuids(propertyUuids);
    
    if (activeView) {
      const shown_properties = propertyUuids.map((uuid, index) => ({
        uuid,
        sequence: index + 1,
      }));
      
      updateViewMutation.mutate({
        viewId: activeView.id,
        data: { shown_properties },
      });
    }
  };

  // Count conditions for badge display
  const filterBlockCount = useMemo(() => {
    if (!activeView?.query_ast) return 0;
    
    // System views (default views for linked_references, child_pages) don't show badge
    const isSystemView = activeView.is_default && (
      activeView.view_type === 'linked_references' ||
      activeView.view_type === 'child_pages' ||
      activeView.view_type === 'main_content'
    );
    if (isSystemView) return 0;
    
    try {
      let ast = activeView.query_ast;
      // Hide badge for system queries
      if (ast.is_system) return 0;
      
      // Apply auto-fix to ensure system conditions have proper capabilities marked
      // This is needed because backend doesn't preserve capabilities
      ast = autoFixSystemQuery(ast, viewType, {
        nodeUuid: nodeUuid,
        parentUuid: nodeUuid,
      });
      
      return countConditions(ast);
    } catch {
      return 0;
    }
  }, [activeView?.query_ast, activeView?.is_default, activeView?.view_type, viewType, nodeUuid]);

  // Create SelectionButton options from views
  const viewOptions = useMemo(() => {
    return views.map(v => ({
      value: String(v.id),
      icon: mdiEyeOutline,
      label: v.name,
    }));
  }, [views]);

  // Default query AST for pseudo-nodes (like all_pages)
  const pseudoNodeAST = useMemo(() => {
    if (!isPseudoNode) return null;
    
    // Define default query for each pseudo view type
    const defaultQueries: Record<string, QueryAST> = {
      'all_pages': {
        type: 'query',
        version: '1.0',
        scope: {
          type: 'scope',
          scope_type: 'pages',  // Use pages scope
        },
        root_group: {
          type: 'group',
          logic: 'AND',
          children: [
            // No parent (top-level pages only)
            { 
              type: 'condition', 
              condition_type: 'property', 
              property_name: 'parent_id', 
              property_type: 'node', 
              operator: 'is_empty', 
              value: null 
            },
          ],
        },
      },
    };
    
    return defaultQueries[viewType] ?? createEmptyQueryAST();
  }, [isPseudoNode, viewType]);

  // Execute query for active view (normal nodes)
  const {
    data: queryResults,
    isLoading: queryLoading,
    refetch: refetchQuery,
  } = useNodeViewQuery(activeView?.id ?? 0, {
    runtimeParams: { 
      current_node_uuid: nodeUuid,
      current_node_id: nodeId,
    },
    // Include children for linked_references, child_pages, and views that need nested content
    includeChildren: viewType === 'linked_references' || viewType === 'child_pages',
    // Always include properties to support cover images in card view
    includeProperties: true,
    enabled: !!activeView && nodeId > 0,
  });

  // Execute ad-hoc query for pseudo-nodes (like all_pages)
  const {
    data: pseudoQueryResults,
    isLoading: pseudoQueryLoading,
    refetch: refetchPseudoQuery,
  } = useQuery_(
    {
      query_ast: pseudoNodeAST ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
      },
      // Include children recursively for all_pages view
      include_children: viewType === 'all_pages',
      // Always include properties to support cover images in card view
      include_properties: true,
    },
    {
      enabled: isPseudoNode && !!pseudoNodeAST,
      queryKey: ['pseudo-node-query', viewType, nodeId],
    }
  );

  // Use appropriate results based on node type
  // If query is empty (no conditions), return empty array instead of all nodes
  const rawResults = isPseudoNode ? (pseudoQueryResults ?? []) : (queryResults ?? []);
  const activeAST = isPseudoNode ? pseudoNodeAST : activeView?.query_ast;
  const resultNodes = (activeAST && isEmptyQuery(activeAST)) ? [] : rawResults;
  const isQueryLoading = isPseudoNode ? pseudoQueryLoading : queryLoading;
  const handleRefetchQuery = isPseudoNode ? refetchPseudoQuery : refetchQuery;

  // Preview query for edit modal - execute editAST in real-time
  const {
    data: previewResults,
    isLoading: previewLoading,
  } = useQuery_(
    {
      query_ast: editAST ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
      },
      include_children: viewType === 'all_pages',
      include_properties: true,
    },
    {
      enabled: !!editAST,
      queryKey: ['preview-query', nodeId, editAST],
    }
  );

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    
    const queryId = `view-${view.id}-${view.uuid}`;
    let ast: QueryAST;
    
    // Use query_ast directly from view, or create empty one
    if (view.query_ast && typeof view.query_ast === 'object' && view.query_ast.type === 'query') {
      ast = view.query_ast;
      // Ensure it has an ID
      if (!ast.id) {
        ast.id = queryId;
      }
    } else {
      // No AST, create empty one
      ast = createEmptyQueryAST();
      ast.id = queryId;
    }
    
    // Auto-fix: Restore missing system conditions and ensure capabilities are set
    // Always run this to ensure system nodes have proper capabilities
    ast = autoFixSystemQuery(ast, viewType, {
      nodeUuid: nodeUuid,
      parentUuid: nodeUuid,
      // For classed_nodes, nodeUuid IS the class we're filtering by
    });
    
    // Set created_at if not already set
    if (!ast.created_at) {
      ast.created_at = view.create_date;
    }
    
    setEditAST(ast);
    
    // Validate immediately
    const validationResult = validateQueryAST(ast);
    setValidation(validationResult);
  }, [viewType, nodeUuid]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editAST) return;
    
    // Check validation before saving
    if (validation && !canSaveQuery(validation)) {
      console.warn('Cannot save invalid query');
      return;
    }
    
    try {
      // Auto-fix: Ensure system conditions are present before saving
      const fixedAST = autoFixSystemQuery(editAST, viewType, {
        nodeUuid: nodeUuid,
        parentUuid: nodeUuid,
        typeUuid: undefined,
      });
      
      // Save name if changed
      if (editViewName !== editingView.name) {
        await updateViewMutation.mutateAsync({
          viewId: editingView.id,
          data: { name: editViewName },
        });
      }
      
      await updateQueryMutation.mutateAsync({
        viewId: editingView.id,
        queryAST: fixedAST,
      });
      
      // Refetch views to get updated query data
      await refetchViews();
      
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
      refetchQuery();
    } catch (error) {
      console.error('Failed to save view:', error);
    }
  }, [editingView, editAST, validation, editViewName, viewType, nodeUuid, updateQueryMutation, updateViewMutation, refetchQuery, refetchViews]);

  // Handle deleting view
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
  }, [editingView, deleteViewMutation, activeViewId]);
  
  // Handle resetting all views to defaults
  const handleResetViews = useCallback(async () => {
    if (!nodeId || nodeId <= 0) return;
    
    try {
      await resetViewsMutation.mutateAsync(nodeId);
      // Reset active view selection to let default view take over
      setActiveViewId(null);
      // The mutation onSuccess already invalidates queries, which will trigger refetch
      // But we can also explicitly refetch the query to ensure data is fresh
      setTimeout(() => {
        refetchQuery();
      }, 100);
    } catch (error) {
      console.error('Failed to reset views:', error);
    }
  }, [nodeId, resetViewsMutation, refetchQuery]);

  const handleAddView = useCallback(async () => {
    try {
      const newView = await createViewMutation.mutateAsync({
        node_id: nodeId,
        name: 'New View',
        view_type: viewType,
        order_index: views.length,
        is_default: views.length === 0,
      });
      // Switch to new view and open editor
      setActiveViewId(newView.id);
      handleEditView(newView);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  }, [nodeId, viewType, views.length, createViewMutation, handleEditView]);

  // Handle adding a node to the collection
  const handleAddNode = useCallback(async () => {
    try {
      // Determine what kind of node to create based on viewType
      if (!pageClassId) {
        console.error('Page class not found');
        return;
      }

      let nodeData: { name: string; classes?: number[]; parent_id?: number } = {
        name: '',
      };

      switch (viewType) {
        case 'child_pages':
          // Create a child page under the current node
          nodeData = {
            name: '',
            classes: [pageClassId],
            parent_id: nodeId,
          };
          break;
        
        case 'classed_nodes':
          // Create a block that is a child of this class page and has the class assigned
          nodeData = {
            name: '',
            parent_id: nodeId,
          };
          break;
        
        case 'all_pages':
          // Create a new page
          nodeData = {
            name: '',
            classes: [pageClassId],
          };
          break;
        
        default:
          // Default: create a block
          nodeData = {
            name: '',
          };
      }

      const newNode = await createNodeMutation.mutateAsync(nodeData);
      
      // Route new node based on type:
      // - blocks open in sidebar, pages open in main view
      if (newNode.is_page) {
        onNodeClick?.(newNode.id, true);
      } else {
        onBlockCreated?.(newNode.id);
      }
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [viewType, nodeId, createNodeMutation, onNodeClick, onBlockCreated]);

  // Loading state - wait for views to load AND ensure defaults to complete
  if (viewsLoading || isInitializing) {
    return null; // Don't render section while loading
  }

  // Calculate values for UI logic
  const resultCount = resultNodes.length;

  // Header actions - view selector and toolbar
  const headerActions = (
    <div className="dynamic-section__header-actions">
      {/* View selection (only when multiple views) */}
      {views.length > 1 && (
        <SelectionButton
          options={viewOptions}
          value={String(activeView?.id ?? '')}
          onChange={(value) => setActiveViewId(Number(value))}
          size="sm"
        />
      )}
      
      {/* Edit query button with badge showing filter count */}
      {activeView && (
        <div className="dynamic-section__filter-btn-wrapper">
          <Button
            icon={mdiFilterOutline}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={() => handleEditView(activeView)}
            title="Edit view"
          />
          {filterBlockCount > 0 && (
            <Badge variant="primary" size="xs" className="dynamic-section__filter-badge">
              {filterBlockCount}
            </Badge>
          )}
        </div>
      )}
      
      {/* Add view button */}
      <Button
        icon={mdiPlusBox}
        iconOnly
        variant="ghost"
        size="xs"
        onClick={handleAddView}
        title="Add view"
      />
      
      {/* Collection toolbar */}
      <NodeCollectionToolbar
        viewMode={collectionViewMode}
        availableViewModes={['list', 'table', 'card']}
        onViewModeChange={handleViewModeChange}
        showGroupBy={collectionViewMode === 'list'}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        selectedPropertyUuids={selectedPropertyUuids}
        onPropertyColumnsChange={handlePropertyColumnsChange}
        showAddButton={viewType !== 'linked_references'}
        onAdd={handleAddNode}
        onResetViews={nodeId > 0 ? handleResetViews : undefined}
      />
      
      {/* Refresh button */}
      <Button
        icon={mdiRefresh}
        iconOnly
        variant="ghost"
        size="xs"
        onClick={() => handleRefetchQuery()}
        title="Refresh results"
        disabled={isQueryLoading}
      />
    </div>
  );

  // Shared content component
  const content = isQueryLoading ? (
    <div className="dynamic-section__loading">Loading...</div>
  ) : (
    <NodeCollection
      nodes={resultNodes}
      viewId={activeView?.id}
      view={activeView}
      viewMode={collectionViewMode}
      availableViewModes={['list', 'table', 'card']}
      onViewModeChange={handleViewModeChange}
      editable={true}
      hideToolbar={true}
      showGroupBy={collectionViewMode === 'list'}
      groupBy={groupBy}
      onGroupByChange={setGroupBy}
      pagesOnly={viewType === 'all_pages' || viewType === 'child_pages'}
      selectedPropertyUuids={selectedPropertyUuids}
      onPropertyColumnsChange={handlePropertyColumnsChange}
      onNodeClick={(node) => onNodeClick?.(node.id, node.is_page)}
      emptyMessage={filterBlockCount > 0 ? "No results match the query filters" : "No results found"}
    />
  );

  // Split mode: return controls + results separately for external layout
  // Modals are rendered here, then result passed to children render prop
  if (split && children) {
    const splitResult = {
      controls: headerActions,
      results: content,
    };
    
    return (
      <>
        {/* Modals must be rendered in React tree for portals/context */}
        <Modal
          isOpen={!!editingView}
          onClose={() => {
            setEditingView(null);
            setEditAST(null);
            setEditViewName('');
          }}
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Button
                icon={mdiEyeOutline}
                iconOnly
                variant="ghost"
                size="xs"
                onClick={() => setShowProseModal(true)}
                title="Show query as prose"
              />
              <span>Query</span>
            </div>
          }
          size="xl"
          className="dynamic-section__edit-modal"
          footer={editingView && (
            <div className="dynamic-section__modal-footer">
              {/* Scope Selector - Left side */}
              <div className="view-builder__footer-left">
                <ProseScopeSelector
                  scope={editAST?.scope || { type: 'scope', scope_type: 'current_page' }}
                  onChange={(newScope) => {
                    if (editAST) {
                      setEditAST({
                        ...editAST,
                        scope: newScope,
                      });
                    }
                  }}
                  readOnly={['linked_references', 'child_pages', 'classed_nodes'].includes(viewType)}
                />
              </div>
              
              {/* Result count */}
              {previewResults && (
                <div className="view-builder__result-preview">
                  {previewLoading ? (
                    <span className="view-builder__result-loading">Calculating…</span>
                  ) : (
                    <span className="view-builder__result-count">
                      <span className="view-builder__result-dot">●</span>
                      {previewResults.length} node{previewResults.length !== 1 ? 's' : ''} found
                    </span>
                  )}
                </div>
              )}
              
              <div className="dynamic-section__footer-spacer" />
              
              {/* Delete button - only for non-default views */}
              {!editingView?.is_default && (
                <InlineConfirmButton
                  buttonProps={{
                    variant: 'ghost',
                    size: 'sm',
                    icon: <DeleteIcon size="sm" />,
                    iconOnly: true,
                    title: 'Delete view',
                    className: 'dynamic-section__delete-btn',
                  }}
                  confirmText="Delete view?"
                  onConfirm={handleDeleteView}
                />
              )}
              
              {/* Save button */}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveEdit}
                disabled={validation ? !canSaveQuery(validation) : false}
              >
                Save
              </Button>
            </div>
          )}
        >
          {editingView && editAST && (
            <div className="dynamic-section__edit-content">
              {/* View name editor */}
              <div className="dynamic-section__view-name">
                <TextField
                  value={editViewName}
                  onChange={(e) => setEditViewName(e.target.value)}
                  placeholder="View name"
                  size="sm"
                />
              </div>
              
              {/* Query builder with inline validation */}
              <ViewBuilder
                ast={editAST}
                onChange={handleASTChange}
                resultCount={previewResults?.length ?? 0}
                isLoading={previewLoading}
                hideFooter={true}
              />
            </div>
          )}
        </Modal>

        {/* Prose query preview modal */}
        <Modal
          isOpen={showProseModal}
          onClose={() => setShowProseModal(false)}
          title="Query Preview"
          size="xl"
          className="query-preview-modal"
        >
          {editAST && (
            <div className="query-preview">
              {/* Prose description */}
              <div>
                <h4 className="query-preview__section-header">Natural Language</h4>
                <div className="query-preview__prose">
                  <ProseRenderer text={getQueryIntent(editAST, nodesMap)} />
                </div>
              </div>

              {/* AST Section */}
              <div>
                <div className="query-preview__ast-header">
                  <h4 className="query-preview__section-header">Query Structure</h4>
                  <Button
                    icon={mdiContentCopy}
                    onClick={handleCopyAST}
                    variant="ghost"
                    size="xs"
                  >
                    Copy
                  </Button>
                </div>
                <pre className="query-preview__ast">
                  {JSON.stringify(editAST, null, 2)}
                </pre>
              </div>

              {/* SQL Section */}
              <div>
                <div className="query-preview__sql-header">
                  <h4 className="query-preview__section-header">Execution Preview</h4>
                  <span className="query-preview__sql-note">(informational only)</span>
                </div>
                <QuerySQLPreview ast={editAST} />
              </div>
            </div>
          )}
        </Modal>

        {/* Call children render prop with split result */}
        {children(splitResult)}
      </>
    );
  }

  // Headless mode: render just controls and content without section wrapper
  if (false) {
    return (
      <>
        <div className={`dynamic-node-view-section--headless ${className}`}>
          {/* Controls toolbar */}
          <div className="dynamic-section__controls">{headerActions}</div>
          
          {/* Results content */}
          <div className="dynamic-section__content">{content}</div>
        </div>

        {/* Edit modal is still needed */}
        <Modal
          isOpen={!!editingView}
          onClose={() => {
            setEditingView(null);
            setEditAST(null);
            setEditViewName('');
          }}
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Button
                icon={mdiEyeOutline}
                iconOnly
                variant="ghost"
                size="xs"
                onClick={() => setShowProseModal(true)}
                title="Show query as prose"
              />
              <span>Query</span>
            </div>
          }
          size="xl"
          className="dynamic-section__edit-modal"
          footer={editingView && (
            <div className="dynamic-section__modal-footer">
              {/* Scope Selector - Left side */}
              <div className="view-builder__footer-left">
                <ProseScopeSelector
                  scope={editAST?.scope || { type: 'scope', scope_type: 'current_page' }}
                  onChange={(newScope) => {
                    if (editAST) {
                      setEditAST({
                        ...editAST,
                        scope: newScope,
                      });
                    }
                  }}
                  readOnly={['linked_references', 'child_pages', 'classed_nodes'].includes(viewType)}
                />
              </div>
              
              {/* Result count */}
              {previewResults && (
                <div className="view-builder__result-preview">
                  {previewLoading ? (
                    <span className="view-builder__result-loading">Calculating…</span>
                  ) : (
                    <span className="view-builder__result-count">
                      <span className="view-builder__result-dot">●</span>
                      {previewResults.length} node{previewResults.length !== 1 ? 's' : ''} found
                    </span>
                  )}
                </div>
              )}
              
              <div className="dynamic-section__footer-spacer" />
              
              {/* Delete button - only for non-default views */}
              {!editingView?.is_default && (
                <InlineConfirmButton
                  buttonProps={{
                    variant: 'ghost',
                    size: 'sm',
                    icon: <DeleteIcon size="sm" />,
                    iconOnly: true,
                    title: 'Delete view',
                    className: 'dynamic-section__delete-btn',
                  }}
                  confirmText="Delete view?"
                  onConfirm={handleDeleteView}
                />
              )}
              
              {/* Save button */}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveEdit}
                disabled={validation ? !canSaveQuery(validation) : false}
              >
                Save
              </Button>
            </div>
          )}
        >
          {editingView && editAST && (
            <div className="dynamic-section__edit-content">
              {/* View name editor */}
              <div className="dynamic-section__view-name">
                <TextField
                  value={editViewName}
                  onChange={(e) => setEditViewName(e.target.value)}
                  placeholder="View name"
                  size="sm"
                />
              </div>
              
              {/* Query builder with inline validation */}
              <ViewBuilder
                ast={editAST}
                onChange={handleASTChange}
                resultCount={previewResults?.length ?? 0}
                isLoading={previewLoading}
                hideFooter={true}
              />
              
              {/* SQL Preview */}
              <QuerySQLPreview 
                ast={editAST}
                runtime_params={{
                  current_node_uuid: nodeUuid,
                  current_node_id: nodeId,
                }}
              />
            </div>
          )}
        </Modal>
        
        {/* Query preview popover */}
        <Modal
          isOpen={showProseModal}
          onClose={() => setShowProseModal(false)}
          title="Query Preview"
          size="sm"
        >
          {editAST && (
            <div className="query-preview__content">
              <div className="query-preview__intent">
                <ProseRenderer text={getQueryIntent(editAST, nodesMap)} />
              </div>
              <div className="query-preview__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={mdiContentCopy}
                  onClick={handleCopyAST}
                >
                  Copy AST
                </Button>
              </div>
            </div>
          )}
        </Modal>
      </>
    );
  }

  return (
    <>
      <NodeViewSection
        title={title}
        icon={icon}
        count={resultCount}
        defaultExpanded={defaultExpanded}
        hideWhenEmpty={hideWhenEmpty}
        headerActions={headerActions}
        className={`dynamic-node-view-section ${className}`}
      >
        {content}
      </NodeViewSection>

      {/* Unified Edit view modal */}
      <Modal
        isOpen={!!editingView}
        onClose={() => {
          setEditingView(null);
          setEditAST(null);
          setEditViewName('');
        }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Button
              icon={mdiEyeOutline}
              iconOnly
              variant="ghost"
              size="xs"
              onClick={() => setShowProseModal(true)}
              title="Show query as prose"
            />
            <span>Query</span>
          </div>
        }
        size="xl"
        className="dynamic-section__edit-modal"
        footer={editingView && (
          <div className="dynamic-section__modal-footer">
            {/* Scope Selector - Left side */}
            <div className="view-builder__footer-left">
              <ProseScopeSelector
                scope={editAST?.scope || { type: 'scope', scope_type: 'current_page' }}
                onChange={(newScope) => {
                  if (editAST) {
                    setEditAST({
                      ...editAST,
                      scope: newScope,
                    });
                  }
                }}
                readOnly={['linked_references', 'child_pages', 'classed_nodes'].includes(viewType)}
              />
            </div>
            
            {/* Result count */}
            {previewResults && (
              <div className="view-builder__result-preview">
                {previewLoading ? (
                  <span className="view-builder__result-loading">Calculating…</span>
                ) : (
                  <span className="view-builder__result-count">
                    <span className="view-builder__result-dot">●</span>
                    {previewResults.length} node{previewResults.length !== 1 ? 's' : ''} found
                  </span>
                )}
              </div>
            )}
            
            <div className="dynamic-section__footer-spacer" />
            
            {/* Only show delete button if there are multiple views of this type */}
            {views.filter(v => v.view_type === editingView.view_type).length > 1 && (
              <InlineConfirmButton
                onConfirm={handleDeleteView}
                variant="danger"
                size="sm"
                title="Delete view"
                confirmTitle="Confirm delete"
                className="dynamic-section__delete-btn"
              >
                <DeleteIcon size="sm" />
              </InlineConfirmButton>
            )}
            <TextField
              id="view-name"
              value={editViewName}
              onChange={(e) => setEditViewName(e.target.value)}
              placeholder="View name..."
              size="sm"
              className="dynamic-section__view-name-field"
            />
            <Button
              variant="ghost"
              onClick={() => {
                setEditingView(null);
                setEditAST(null);
                setValidation(null);
                setEditViewName('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveEdit}
              disabled={
                updateQueryMutation.isPending || 
                updateViewMutation.isPending || 
                (validation ? !canSaveQuery(validation) : false)
              }
              title={validation && !canSaveQuery(validation) ? getValidationSummary(validation) : undefined}
            >
              {(updateQueryMutation.isPending || updateViewMutation.isPending) ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      >
        {editingView && editAST && (
          <div className="dynamic-section__edit-form">
            {/* ViewBuilder - prose-based AST editing */}
            <ViewBuilder
              ast={editAST}
              onChange={(updatedAST) => {
                setEditAST(updatedAST);
                setValidation(validateQueryAST(updatedAST));
              }}
              resultCount={!previewLoading ? previewResults?.length : undefined}
              isLoading={previewLoading}
              hideFooter={true}
            />
          </div>
        )}
      </Modal>

      {/* Prose query preview modal */}
      <Modal
        isOpen={showProseModal}
        onClose={() => setShowProseModal(false)}
        title="Query Preview"
        size="xl"
        className="query-preview-modal"
      >
        {editAST && (
          <div className="query-preview">
            {/* Prose description */}
            <div>
              <h4 className="query-preview__section-header">Natural Language</h4>
              <div className="query-preview__prose">
                <ProseRenderer text={getQueryIntent(editAST, nodesMap)} />
              </div>
            </div>

            {/* AST Section */}
            <div>
              <div className="query-preview__ast-header">
                <h4 className="query-preview__section-header">Query Structure</h4>
                <Button
                  icon={mdiContentCopy}
                  onClick={handleCopyAST}
                  variant="ghost"
                  size="xs"
                >
                  Copy
                </Button>
              </div>
              <pre className="query-preview__ast">
                {JSON.stringify(editAST, null, 2)}
              </pre>
            </div>

            {/* SQL Section */}
            <div>
              <div className="query-preview__sql-header">
                <h4 className="query-preview__section-header">Execution Preview</h4>
                <span className="query-preview__sql-note">(informational only)</span>
              </div>
              <QuerySQLPreview ast={editAST} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

export default DynamicNodeViewSection;
