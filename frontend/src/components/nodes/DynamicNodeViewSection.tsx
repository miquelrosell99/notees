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
  useUpdateQueryBlockTree,
  useUpdateNodeView,
  useDeleteNodeView,
  useResetNodeViews,
} from '@/hooks/useNodeViews';
import { useCreateNode, usePageClass } from '@/hooks/useNodes';
import type { NodeView, QueryBlockTree, NodeViewType } from '@/types/query';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
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
import { DeleteIcon } from '../icons';
import { createEmptyBlockTree } from '@/types/query';
import { createEmptyQueryAST, countConditions } from '@/types/queryAST';
import { blockTreeToAST, astToBlockTree } from '@/lib/queryConverter';
import { validateQueryAST, canSaveQuery, getValidationSummary } from '@/lib/queryValidation';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { isSystemBlock } from '../queries/constants';
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
}

// ==================== Helper Functions ====================

/**
 * Count the number of user-defined filter blocks (excluding system blocks)
 */
function countMainFilterBlocks(tree: QueryBlockTree | null): number {
  if (!tree || !tree.blocks) return 0;
  
  // Count only non-system blocks
  return tree.blocks.filter(block => !isSystemBlock(block)).length;
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
}: DynamicNodeViewSectionProps): React.JSX.Element | null {
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
    includeQueryBlockTree: true,
    enabled: nodeId > 0 && hasInitialized,
  });

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateBlockTreeMutation = useUpdateQueryBlockTree();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();
  const resetViewsMutation = useResetNodeViews();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { addSidebarCard, openNode } = useNodesStore();

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
    if (!activeView?.query_block_tree) return 0;
    
    // System views (default views for linked_references, child_pages) don't show badge
    const isSystemView = activeView.is_default && (
      activeView.view_type === 'linked_references' ||
      activeView.view_type === 'child_pages' ||
      activeView.view_type === 'main_content'
    );
    if (isSystemView) return 0;
    
    try {
      const ast = blockTreeToAST(activeView.query_block_tree, undefined, isSystemView);
      // Hide badge for system queries
      if (ast.is_system) return 0;
      return countConditions(ast);
    } catch {
      return countMainFilterBlocks(activeView.query_block_tree);
    }
  }, [activeView?.query_block_tree, activeView?.is_default, activeView?.view_type]);

  // Create SelectionButton options from views
  const viewOptions = useMemo(() => {
    return views.map(v => ({
      value: String(v.id),
      icon: mdiEyeOutline,
      label: v.name,
    }));
  }, [views]);

  // Default block tree for pseudo-nodes (like all_pages)
  const pseudoNodeBlockTree = useMemo(() => {
    if (!isPseudoNode) return null;
    
    // Define default query for each pseudo view type
    const defaultQueries: Record<string, QueryBlockTree> = {
      'all_pages': {
        type: 'AND_CONTAINER',
        blocks: [
          // No filters needed - scope handles page filtering
          { type: 'PROPERTY', property_name: 'parent_id', property_type: 'node', operator: 'is_empty', value: null },
        ],
        scope: {
          scope_type: 'pages',  // Use pages scope instead of class filter
        },
      },
    };
    
    return defaultQueries[viewType] ?? { type: 'AND_CONTAINER', blocks: [] };
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
      block_tree: pseudoNodeBlockTree ?? undefined,
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
      enabled: isPseudoNode && !!pseudoNodeBlockTree,
      queryKey: ['pseudo-node-query', viewType, nodeId],
    }
  );

  // Use appropriate results based on node type
  const resultNodes = isPseudoNode ? (pseudoQueryResults ?? []) : (queryResults ?? []);
  const isQueryLoading = isPseudoNode ? pseudoQueryLoading : queryLoading;
  const handleRefetchQuery = isPseudoNode ? refetchPseudoQuery : refetchQuery;

  // Preview query for edit modal - execute editAST in real-time
  const editASTBlockTree = useMemo(() => {
    if (!editAST) return null;
    try {
      return astToBlockTree(editAST);
    } catch (error) {
      console.warn('Failed to convert editAST to block tree:', error);
      return null;
    }
  }, [editAST]);

  const {
    data: previewResults,
    isLoading: previewLoading,
  } = useQuery_(
    {
      block_tree: editASTBlockTree ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
      },
      include_children: viewType === 'all_pages',
      include_properties: true,
    },
    {
      enabled: !!editAST && !!editASTBlockTree,
      queryKey: ['preview-query', nodeId, editAST],
    }
  );

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    
    const queryId = `view-${view.id}-${view.uuid}`;
    let ast: QueryAST;
    let isFromBackendAST = false;
    
    // Check if query_block_tree is actually a QueryAST (backend stores AST in query_json)
    const data = view.query_block_tree;
    if (data && typeof data === 'object' && 'type' in data && data.type === 'query' && 'root_group' in data) {
      // It's already a QueryAST, use it directly
      ast = data as QueryAST;
      // Ensure it has an ID
      if (!ast.id) {
        ast.id = queryId;
      }
      isFromBackendAST = true;
    } else {
      // It's a QueryBlockTree (or null/empty), convert it
      const blockTree = data ?? createEmptyBlockTree();
      ast = blockTreeToAST(blockTree, queryId, false); // false = not system
    }
    
    // Auto-fix: Restore missing system conditions (marks them with isSystemNode)
    // Skip for default views that already have proper AST from backend
    if (!isFromBackendAST || !view.is_default) {
      ast = autoFixSystemQuery(ast, viewType, {
        nodeUuid: nodeUuid,
        parentUuid: nodeUuid,
        // For classed_nodes, nodeUuid IS the class we're filtering by
      });
    }
    
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
      
      // Convert AST back to BlockTree for backend
      const blockTree = astToBlockTree(fixedAST);
      
      // Save block tree
      await updateBlockTreeMutation.mutateAsync({
        viewId: editingView.id,
        blockTree,
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
  }, [editingView, editAST, validation, editViewName, viewType, nodeUuid, updateBlockTreeMutation, updateViewMutation, refetchQuery, refetchViews]);

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
        {isQueryLoading ? (
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
        )}
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
                scope={editAST?.scope || { type: 'scope', scope_type: 'current' }}
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
                updateBlockTreeMutation.isPending || 
                updateViewMutation.isPending || 
                (validation ? !canSaveQuery(validation) : false)
              }
              title={validation && !canSaveQuery(validation) ? getValidationSummary(validation) : undefined}
            >
              {(updateBlockTreeMutation.isPending || updateViewMutation.isPending) ? 'Saving...' : 'Save'}
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
              resultCount={previewResults?.length}
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
        size="lg"
      >
        {editAST && (
          <div className="query-preview">
            {/* Prose description */}
            <div>
              <h4 className="query-preview__section-header">Natural Language</h4>
              <div className="query-preview__prose">
                {getQueryIntent(editAST)}
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
