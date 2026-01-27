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
} from '@/hooks/useNodeViews';
import type { NodeView, QueryBlockTree, NodeViewType } from '@/types/query';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import { NodeCollection, NodeCollectionToolbar } from './NodeCollection';
import { NodeViewSection } from './NodeViewSection';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { Badge } from '../core/Badge';
import { SelectionButton } from '../core/SelectionButton';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { InlineConfirmButton } from '../core/InlineConfirmButton';
import { TextField } from '../core/TextField';
import { QueryBuilder } from '../queries';
import { QuerySQLPreview } from '../queries/QuerySQLPreview';
import { DeleteIcon } from '../icons';
import { createEmptyBlockTree } from '@/types/query';
import { createEmptyQueryAST, countConditions } from '@/types/queryAST';
import { blockTreeToAST, astToBlockTree } from '@/lib/queryConverter';
import { validateQueryAST, canSaveQuery, getValidationSummary } from '@/lib/queryValidation';
import { isSystemBlock } from '../queries/constants';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { useNodesStore } from '@/stores';
import { mdiPlusBox, mdiFilterOutline, mdiRefresh, mdiEyeOutline } from '@mdi/js';
import './DynamicNodeViewSection.css';

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
  /** Additional CSS class */
  className?: string;
}

// ==================== Helper Functions ====================

/**
 * Count the number of user-defined filter blocks (excluding system blocks)
 */
function countMainFilterBlocks(tree: QueryBlockTree | null): number {
  if (!tree || !tree.blocks) return 0;
  
  let count = 0;
  for (const block of tree.blocks) {
    if (!isSystemBlock(block)) {
      count++;
    }
  }
  return count;
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
  className = '',
}: DynamicNodeViewSectionProps) {
  // State
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [editingView, setEditingView] = useState<NodeView | null>(null);
  const [editViewName, setEditViewName] = useState('');
  // AST is the source of truth for editing
  const [editAST, setEditAST] = useState<QueryAST | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [editMode, setEditMode] = useState<'blocks' | 'sql'>('blocks');
  const [editSqlQuery, setEditSqlQuery] = useState('');
  const [showSqlResetConfirm, setShowSqlResetConfirm] = useState(false);
  
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
  const { 
    data: views = [], 
    isLoading: viewsLoading,
  } = useNodeViews(nodeId, { 
    viewType, 
    includeQueryBlockTree: true,
    enabled: nodeId > 0,
  });

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateBlockTreeMutation = useUpdateQueryBlockTree();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();

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
          { type: 'TYPE', value: 'page' },
          // Only get root pages - children will be loaded via include_children
          { type: 'PROPERTY', property_name: 'parent_id', operator: 'is_empty', value: null },
        ],
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

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    // System views (default views for certain types) cannot be edited
    const isSystemView = view.is_default && (
      view.view_type === 'linked_references' ||
      view.view_type === 'child_pages' ||
      view.view_type === 'main_content'
    );
    
    if (isSystemView) {
      console.info('Cannot edit system-generated queries');
      return;
    }
    
    setEditingView(view);
    setEditViewName(view.name);
    
    // Convert QueryBlockTree to AST with query identity
    const blockTree = view.query_block_tree ?? createEmptyBlockTree();
    const queryId = `view-${view.id}-${view.uuid}`;
    const ast = blockTreeToAST(blockTree, queryId, false); // false = not system
    
    // Set created_at if not already set
    if (!ast.created_at) {
      ast.created_at = view.create_date;
    }
    
    setEditAST(ast);
    
    // Validate immediately
    const validationResult = validateQueryAST(ast);
    setValidation(validationResult);
    
    setEditMode('blocks');
    setEditSqlQuery('');
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editAST) return;
    
    // Check validation before saving
    if (validation && !canSaveQuery(validation)) {
      console.warn('Cannot save invalid query');
      return;
    }
    
    try {
      // Save name if changed
      if (editViewName !== editingView.name) {
        await updateViewMutation.mutateAsync({
          viewId: editingView.id,
          data: { name: editViewName },
        });
      }
      
      // Convert AST back to BlockTree for backend
      const blockTree = astToBlockTree(editAST);
      
      // Save block tree
      await updateBlockTreeMutation.mutateAsync({
        viewId: editingView.id,
        blockTree,
      });
      
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
      refetchQuery();
    } catch (error) {
      console.error('Failed to save view:', error);
    }
  }, [editingView, editAST, validation, editViewName, updateBlockTreeMutation, updateViewMutation, refetchQuery]);

  // Handle switching from SQL to blocks mode (requires confirmation)
  const handleModeSwitch = useCallback((toSql: boolean) => {
    if (toSql) {
      // Switching to SQL mode is safe
      setEditMode('sql');
    } else {
      // Switching back to blocks will reset the query - confirm first
      setShowSqlResetConfirm(true);
    }
  }, []);

  const confirmSqlReset = useCallback(() => {
    const emptyAST = createEmptyQueryAST();
    setEditAST(emptyAST);
    setValidation(validateQueryAST(emptyAST));
    setEditSqlQuery('');
    setEditMode('blocks');
    setShowSqlResetConfirm(false);
  }, []);

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

  // Loading state - wait for views to load AND ensure defaults to complete
  if (viewsLoading || isInitializing) {
    console.log(`[DynamicNodeViewSection] ${viewType} still loading/initializing:`, { viewsLoading, isInitializing, nodeId, hasInitialized });
    return null; // Don't render section while loading
  }

  // Calculate values for UI logic
  const resultCount = resultNodes.length;
  const isSystemQuery = activeView?.is_default && filterBlockCount === 0;
  
  console.log(`[DynamicNodeViewSection] ${viewType} render:`, { 
    nodeId, 
    resultCount, 
    hideWhenEmpty, 
    activeViewId: activeView?.id,
    queryLoading: isQueryLoading,
    isPseudoNode,
    views: views.length 
  });

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
            editable={false}
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
        title="Edit View"
        size="xl"
        className="dynamic-section__edit-modal"
        footer={editingView && (
          <div className="dynamic-section__modal-footer">
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
            <div className="dynamic-section__footer-spacer" />
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
                (validation && !canSaveQuery(validation))
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
            {/* Subtitle explaining purpose */}
            <p className="dynamic-section__subtitle">
              This query dynamically defines which nodes appear in this view.
            </p>

            {/* Validation messages */}
            {validation && validation.issues.length > 0 && (
              <div className="dynamic-section__validation">
                {validation.issues.map((issue, idx) => (
                  <div 
                    key={idx} 
                    className={`dynamic-section__validation-issue dynamic-section__validation-issue--${issue.severity}`}
                  >
                    <span className="dynamic-section__validation-message">{issue.message}</span>
                    {issue.suggestion && (
                      <span className="dynamic-section__validation-suggestion">{issue.suggestion}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Mode toggle: Builder vs Advanced SQL */}
            <div className="dynamic-section__mode-toggle-section">
              <ToggleSwitch
                leftLabel="Builder"
                rightLabel="Advanced (SQL)"
                checked={editMode === 'sql'}
                onChange={handleModeSwitch}
                size="sm"
              />
              {editMode === 'sql' && (
                <span className="dynamic-section__mode-warning">
                  Switching to SQL disables the visual builder.
                </span>
              )}
            </div>

            {/* Query editor - blocks or SQL */}
            {editMode === 'blocks' ? (
              <div className="dynamic-section__builder-mode">
                {/* QueryBuilder - native AST editing */}
                <QueryBuilder
                  ast={editAST}
                  onChange={(updatedAST) => {
                    setEditAST(updatedAST);
                    setValidation(validateQueryAST(updatedAST));
                  }}
                />

                {/* Live result count */}
                {resultNodes.length > 0 && (
                  <div className="dynamic-section__result-preview">
                    <span className="dynamic-section__result-count">
                      {resultNodes.length} node{resultNodes.length !== 1 ? 's' : ''} match this query
                    </span>
                  </div>
                )}

                {/* SQL Preview */}
                <QuerySQLPreview 
                  ast={editAST} 
                  disabled={validation ? !canSaveQuery(validation) : false}
                />
              </div>
            ) : (
              <div className="dynamic-section__sql-editor">
                <textarea
                  className="dynamic-section__sql-textarea"
                  value={editSqlQuery}
                  onChange={(e) => setEditSqlQuery(e.target.value)}
                  placeholder="Enter raw SQL query..."
                  spellCheck={false}
                />
                <p className="dynamic-section__sql-hint">
                  SQL mode is not yet connected to the backend. This is a placeholder for future functionality.
                </p>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Confirmation modal for SQL to blocks switch */}
      <ConfirmationModal
        isOpen={showSqlResetConfirm}
        title="Switch to Block Editor?"
        message="Switching from SQL to block mode will reset the query. Any custom SQL will be lost. Are you sure?"
        confirmLabel="Reset Query"
        cancelLabel="Keep SQL"
        variant="danger"
        onConfirm={confirmSqlReset}
        onCancel={() => setShowSqlResetConfirm(false)}
      />
    </>
  );
}

export default DynamicNodeViewSection;
