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
  useCreateNodeView,
  useUpdateQueryBlockTree,
  useUpdateNodeView,
  useDeleteNodeView,
} from '@/hooks/useNodeViews';
import type { NodeView, QueryBlockTree, NodeViewType } from '@/types/query';
import { NodeCollection, NodeCollectionToolbar } from './NodeCollection';
import { NodeViewSection } from './NodeViewSection';
import { QuickPageFilter } from './QuickPageFilter';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { Badge } from '../core/Badge';
import { SelectionButton } from '../core/SelectionButton';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { ConfirmationModal } from '../core/ConfirmationModal';
import { InlineConfirmButton } from '../core/InlineConfirmButton';
import { QueryBlockBuilder } from '../queries';
import { DeleteIcon } from '../icons';
import { createEmptyBlockTree } from '@/types/query';
import { isSystemBlock } from '../queries/constants';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
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
  const [editBlockTree, setEditBlockTree] = useState<QueryBlockTree | null>(null);
  const [editMode, setEditMode] = useState<'blocks' | 'sql'>('blocks');
  const [editSqlQuery, setEditSqlQuery] = useState('');
  const [showSqlResetConfirm, setShowSqlResetConfirm] = useState(false);
  const [collectionViewMode, setCollectionViewMode] = useState<NodeCollectionViewMode>('list');
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');

  // Ensure default views exist
  const ensureDefaultViews = useEnsureDefaultViews();
  
  useEffect(() => {
    if (nodeId > 0) {
      ensureDefaultViews.mutate({ nodeId, viewTypes: [viewType] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation is stable
  }, [nodeId, viewType]);

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

  // Count filter blocks for badge display
  const filterBlockCount = useMemo(() => {
    return countMainFilterBlocks(activeView?.query_block_tree ?? null);
  }, [activeView?.query_block_tree]);

  // Create SelectionButton options from views
  const viewOptions = useMemo(() => {
    return views.map(v => ({
      value: String(v.id),
      icon: mdiEyeOutline,
      label: v.name,
    }));
  }, [views]);

  // Execute query for active view
  const {
    data: queryResults,
    isLoading: queryLoading,
    refetch: refetchQuery,
  } = useNodeViewQuery(activeView?.id ?? 0, {
    runtimeParams: { 
      current_node_uuid: nodeUuid,
      current_node_id: nodeId,
    },
    // Include children for linked_references and any view that needs nested blocks
    includeChildren: viewType === 'linked_references',
    enabled: !!activeView && nodeId > 0,
  });

  // Query results are already Node[] from the API
  const resultNodes = queryResults ?? [];

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    setEditBlockTree(view.query_block_tree ?? createEmptyBlockTree());
    setEditMode('blocks');
    setEditSqlQuery('');
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editBlockTree) return;
    
    try {
      // Save name if changed
      if (editViewName !== editingView.name) {
        await updateViewMutation.mutateAsync({
          viewId: editingView.id,
          data: { name: editViewName },
        });
      }
      // Save block tree
      await updateBlockTreeMutation.mutateAsync({
        viewId: editingView.id,
        blockTree: editBlockTree,
      });
      setEditingView(null);
      setEditBlockTree(null);
      setEditViewName('');
      refetchQuery();
    } catch (error) {
      console.error('Failed to save view:', error);
    }
  }, [editingView, editBlockTree, editViewName, updateBlockTreeMutation, updateViewMutation, refetchQuery]);

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
    setEditBlockTree(createEmptyBlockTree());
    setEditSqlQuery('');
    setEditMode('blocks');
    setShowSqlResetConfirm(false);
  }, []);

  // Handle root logic toggle (AND/OR)
  const handleRootLogicToggle = useCallback((isOr: boolean) => {
    if (!editBlockTree) return;
    setEditBlockTree({
      ...editBlockTree,
      type: isOr ? 'OR_CONTAINER' : 'AND_CONTAINER',
    });
  }, [editBlockTree]);

  const handleDeleteView = useCallback(async () => {
    if (!editingView) return;
    
    try {
      await deleteViewMutation.mutateAsync(editingView.id);
      setEditingView(null);
      setEditBlockTree(null);
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

  // Loading state
  if (viewsLoading) {
    return null; // Don't render section while loading
  }

  // Hide if empty and hideWhenEmpty is true
  const resultCount = resultNodes.length;
  if (hideWhenEmpty && resultCount === 0 && !queryLoading) {
    return null;
  }

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
        onViewModeChange={setCollectionViewMode}
        showGroupBy={collectionViewMode === 'list'}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
      />
      
      {/* Refresh button */}
      <Button
        icon={mdiRefresh}
        iconOnly
        variant="ghost"
        size="xs"
        onClick={() => refetchQuery()}
        title="Refresh results"
        disabled={queryLoading}
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
        {queryLoading ? (
          <div className="dynamic-section__loading">Loading...</div>
        ) : (
          <NodeCollection
            nodes={resultNodes}
            viewMode={collectionViewMode}
            availableViewModes={['list', 'table', 'card']}
            onViewModeChange={setCollectionViewMode}
            editable={false}
            hideToolbar={true}
            showGroupBy={collectionViewMode === 'list'}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            onNodeClick={(node) => onNodeClick?.(node.id, node.is_page)}
            emptyMessage="No results match the query"
          />
        )}
      </NodeViewSection>

      {/* Unified Edit view modal */}
      <Modal
        isOpen={!!editingView}
        onClose={() => {
          setEditingView(null);
          setEditBlockTree(null);
          setEditViewName('');
        }}
        title="Edit View"
        size="lg"
        className="dynamic-section__edit-modal"
      >
        {editingView && editBlockTree && (
          <div className="dynamic-section__edit-form">
            {/* Header with toggles */}
            <div className="dynamic-section__edit-header">
              {/* Quick page filter */}
              <QuickPageFilter
                blockTree={editBlockTree}
                onChange={setEditBlockTree}
                size="sm"
              />
              
              {/* AND/OR toggle */}
              <ToggleSwitch
                leftLabel="AND"
                rightLabel="OR"
                checked={editBlockTree.type === 'OR_CONTAINER'}
                onChange={handleRootLogicToggle}
                size="sm"
              />
              
              <div className="dynamic-section__edit-header-spacer" />
              
              {/* Blocks/SQL toggle */}
              <ToggleSwitch
                leftLabel="Blocks"
                rightLabel="SQL"
                checked={editMode === 'sql'}
                onChange={handleModeSwitch}
                size="sm"
              />
            </div>

            {/* Query editor - blocks or SQL */}
            {editMode === 'blocks' ? (
              <QueryBlockBuilder
                blockTree={editBlockTree}
                onChange={setEditBlockTree}
              />
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

            {/* Footer with name and actions */}
            <div className="dynamic-section__edit-footer">
              <div className="dynamic-section__edit-name">
                <label htmlFor="view-name" className="dynamic-section__edit-name-label">
                  View Name
                </label>
                <input
                  id="view-name"
                  type="text"
                  className="dynamic-section__edit-name-input"
                  value={editViewName}
                  onChange={(e) => setEditViewName(e.target.value)}
                  placeholder="Enter view name..."
                />
              </div>
              
              <div className="dynamic-section__edit-actions">
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
                <div className="dynamic-section__edit-spacer" />
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingView(null);
                    setEditBlockTree(null);
                    setEditViewName('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveEdit}
                  disabled={updateBlockTreeMutation.isPending || updateViewMutation.isPending}
                >
                  {(updateBlockTreeMutation.isPending || updateViewMutation.isPending) ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>
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
