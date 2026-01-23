/**
 * DynamicNodeViewSection Component
 * 
 * A section component that dynamically loads and displays NodeViews.
 * Uses the query system to execute queries and show results.
 * 
 * This component:
 * 1. Ensures default views exist for the node (lazy init)
 * 2. Loads views for the specified view_type
 * 3. Displays tabs if multiple views exist
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
  useDeleteNodeView,
} from '@/hooks/useNodeViews';
import type { NodeView, QueryBlockTree, NodeViewType } from '@/types/query';
import { NodeCollection, NodeCollectionToolbar } from './NodeCollection';
import { NodeViewSection } from './NodeViewSection';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { QueryBlockBuilder } from '../QueryBlockBuilder';
import { createEmptyBlockTree } from '@/types/query';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { mdiPlus, mdiPencil, mdiPlayCircleOutline } from '@mdi/js';
import Icon from '@mdi/react';
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

interface ViewTabProps {
  view: NodeView;
  isActive: boolean;
  onClick: () => void;
  onEdit?: () => void;
}

// ==================== Sub-Components ====================

function ViewTab({ view, isActive, onClick, onEdit }: ViewTabProps) {
  return (
    <button
      type="button"
      className={`dynamic-section__tab ${isActive ? 'dynamic-section__tab--active' : ''}`}
      onClick={onClick}
    >
      <span className="dynamic-section__tab-name">{view.name}</span>
      {onEdit && (
        <span 
          className="dynamic-section__tab-edit"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
        >
          <Icon path={mdiPencil} size={0.5} />
        </span>
      )}
    </button>
  );
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
  const [editBlockTree, setEditBlockTree] = useState<QueryBlockTree | null>(null);
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
  const deleteViewMutation = useDeleteNodeView();

  // Determine active view
  const activeView = useMemo(() => {
    if (activeViewId) {
      return views.find(v => v.id === activeViewId) ?? views[0] ?? null;
    }
    // Find default or first view
    return views.find(v => v.is_default) ?? views[0] ?? null;
  }, [views, activeViewId]);

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
    enabled: !!activeView && nodeId > 0,
  });

  // Query results are already Node[] from the API
  const resultNodes = queryResults ?? [];

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditBlockTree(view.query_block_tree ?? createEmptyBlockTree());
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editBlockTree) return;
    
    try {
      await updateBlockTreeMutation.mutateAsync({
        viewId: editingView.id,
        blockTree: editBlockTree,
      });
      setEditingView(null);
      setEditBlockTree(null);
      refetchQuery();
    } catch (error) {
      console.error('Failed to save query:', error);
    }
  }, [editingView, editBlockTree, updateBlockTreeMutation, refetchQuery]);

  const handleDeleteView = useCallback(async () => {
    if (!editingView) return;
    if (!window.confirm(`Delete view "${editingView.name}"?`)) return;
    
    try {
      await deleteViewMutation.mutateAsync(editingView.id);
      setEditingView(null);
      setEditBlockTree(null);
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

  // Header actions - tabs and toolbar
  const headerActions = (
    <div className="dynamic-section__header-actions">
      {/* View tabs (only when multiple views) */}
      {views.length > 1 && (
        <div className="dynamic-section__tabs">
          {views.map(view => (
            <ViewTab
              key={view.id}
              view={view}
              isActive={activeView?.id === view.id}
              onClick={() => setActiveViewId(view.id)}
              onEdit={() => handleEditView(view)}
            />
          ))}
        </div>
      )}
      
      {/* Edit query button (always visible when there's an active view) */}
      {activeView && views.length <= 1 && (
        <Button
          icon={mdiPencil}
          iconOnly
          variant="ghost"
          size="xs"
          onClick={() => handleEditView(activeView)}
          title="Edit query"
        />
      )}
      
      {/* Add view button */}
      <Button
        icon={mdiPlus}
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
        icon={mdiPlayCircleOutline}
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
        ) : resultNodes.length === 0 ? (
          <div className="dynamic-section__empty">No results</div>
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
          />
        )}
      </NodeViewSection>

      {/* Edit view modal */}
      <Modal
        isOpen={!!editingView}
        onClose={() => {
          setEditingView(null);
          setEditBlockTree(null);
        }}
        title={`Edit "${editingView?.name}" Query`}
        size="lg"
      >
        {editingView && editBlockTree && (
          <div className="dynamic-section__edit-form">
            <QueryBlockBuilder
              blockTree={editBlockTree}
              onChange={setEditBlockTree}
            />
            <div className="dynamic-section__edit-actions">
              <Button
                variant="ghost"
                onClick={handleDeleteView}
                className="dynamic-section__delete-btn"
              >
                Delete view
              </Button>
              <div className="dynamic-section__edit-spacer" />
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingView(null);
                  setEditBlockTree(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveEdit}
                disabled={updateBlockTreeMutation.isPending}
              >
                {updateBlockTreeMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

export default DynamicNodeViewSection;
