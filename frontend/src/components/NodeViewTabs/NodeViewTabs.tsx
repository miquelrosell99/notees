/**
 * NodeViewTabs Component
 * 
 * Tabbed interface for switching between NodeViews.
 * Used within NodeCollection to manage different views of node data.
 */
import { useState, useCallback, useMemo } from 'react';
import {
  mdiPlus,
  mdiCog,
  mdiPlayCircleOutline,
} from '@mdi/js';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { InlineConfirmButton } from '../core/InlineConfirmButton';
import { QueryBlockBuilder } from '../queries';
import { DeleteIcon } from '../icons';
import {
  useNodeViews,
  useCreateNodeView,
  useUpdateQueryBlockTree,
  useDeleteNodeView,
  useNodeViewQuery,
} from '@/hooks/useNodeViews';
import type { NodeView, QueryBlockTree } from '@/types/query';
import { createEmptyBlockTree } from '@/types/query';
import './NodeViewTabs.css';

// ==================== Types ====================

export type ViewType = 'linked_references' | 'backlinks' | 'child_pages' | 'typed_nodes' | 'main_content' | 'custom';

interface NodeViewTabsProps {
  /** The node ID to fetch views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The view type filter */
  viewType: ViewType;
  /** Callback when query results change */
  onQueryResults?: (results: unknown[]) => void;
  /** Additional CSS class */
  className?: string;
}

interface TabItemProps {
  view: NodeView;
  isActive: boolean;
  onClick: () => void;
  onEdit: () => void;
}

// ==================== Sub-Components ====================

function TabItem({ view, isActive, onClick, onEdit }: TabItemProps) {
  return (
    <div 
      className={`node-view-tabs__tab ${isActive ? 'node-view-tabs__tab--active' : ''}`}
      onClick={onClick}
    >
      <span className="node-view-tabs__tab-name">{view.name}</span>
      <Button
        icon={mdiCog}
        iconOnly
        variant="ghost"
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="node-view-tabs__tab-edit"
      />
    </div>
  );
}

// ==================== Main Component ====================

export function NodeViewTabs({
  nodeId,
  nodeUuid,
  viewType,
  onQueryResults,
  className = '',
}: NodeViewTabsProps) {
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [editingView, setEditingView] = useState<NodeView | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [editedBlockTree, setEditedBlockTree] = useState<QueryBlockTree | null>(null);

  // Fetch views for this node and view type
  const { data: views = [], isLoading: viewsLoading } = useNodeViews(nodeId, { viewType });
  
  // Mutations
  const createMutation = useCreateNodeView();
  const updateBlockTreeMutation = useUpdateQueryBlockTree();
  const deleteMutation = useDeleteNodeView();

  // Get active view
  const activeView = useMemo(() => {
    if (activeViewId) {
      return views.find(v => v.id === activeViewId) ?? views[0] ?? null;
    }
    return views.find(v => v.is_default) ?? views[0] ?? null;
  }, [views, activeViewId]);

  // Query for active view
  const { 
    data: queryResults,
    isLoading: queryLoading,
    refetch: refetchQuery,
  } = useNodeViewQuery(
    activeView?.id ?? 0,
    { 
      runtimeParams: { current_node_uuid: nodeUuid },
      enabled: !!activeView,
    }
  );

  // Notify parent of query results
  useMemo(() => {
    if (queryResults && onQueryResults) {
      onQueryResults(queryResults);
    }
  }, [queryResults, onQueryResults]);

  // Handlers
  const handleCreateView = useCallback(async () => {
    if (!newViewName.trim()) return;

    try {
      await createMutation.mutateAsync({
        node_id: nodeId,
        name: newViewName.trim(),
        view_type: viewType,
        is_default: views.length === 0,
      });
      setNewViewName('');
      setIsCreateModalOpen(false);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  }, [newViewName, nodeId, viewType, views.length, createMutation]);

  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    // Initialize with empty tree - actual query block tree would come from query node's property
    setEditedBlockTree(createEmptyBlockTree());
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editedBlockTree) return;

    try {
      await updateBlockTreeMutation.mutateAsync({
        viewId: editingView.id,
        blockTree: editedBlockTree,
      });
      setEditingView(null);
      setEditedBlockTree(null);
    } catch (error) {
      console.error('Failed to save query:', error);
    }
  }, [editingView, editedBlockTree, updateBlockTreeMutation]);

  const handleDeleteView = useCallback(async (view: NodeView) => {
    try {
      await deleteMutation.mutateAsync(view.id);
      if (activeViewId === view.id) {
        setActiveViewId(null);
      }
    } catch (error) {
      console.error('Failed to delete view:', error);
    }
  }, [activeViewId, deleteMutation]);

  const handleRunQuery = useCallback(() => {
    refetchQuery();
  }, [refetchQuery]);

  if (viewsLoading) {
    return <div className="node-view-tabs node-view-tabs--loading">Loading views...</div>;
  }

  return (
    <div className={`node-view-tabs ${className}`}>
      {/* Tab bar */}
      <div className="node-view-tabs__bar">
        <div className="node-view-tabs__tabs">
          {views.map((view) => (
            <TabItem
              key={view.id}
              view={view}
              isActive={activeView?.id === view.id}
              onClick={() => setActiveViewId(view.id)}
              onEdit={() => handleEditView(view)}
            />
          ))}
        </div>
        <div className="node-view-tabs__actions">
          <Button
            icon={mdiPlus}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={() => setIsCreateModalOpen(true)}
            title="Add view"
          />
          {activeView && (
            <Button
              icon={mdiPlayCircleOutline}
              iconOnly
              variant="ghost"
              size="xs"
              onClick={handleRunQuery}
              title="Run query"
              disabled={queryLoading}
            />
          )}
        </div>
      </div>

      {/* Query results count */}
      {activeView && queryResults && (
        <div className="node-view-tabs__results-info">
          {queryLoading ? 'Running query...' : `${queryResults.length} results`}
        </div>
      )}

      {/* Create view modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create View"
        size="sm"
      >
        <div className="node-view-tabs__create-form">
          <label>
            View name
            <input
              type="text"
              value={newViewName}
              onChange={(e) => setNewViewName(e.target.value)}
              placeholder="My custom view"
              autoFocus
            />
          </label>
          <div className="node-view-tabs__create-actions">
            <Button variant="ghost" onClick={() => setIsCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateView}
              disabled={!newViewName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Edit view modal */}
      <Modal
        isOpen={!!editingView}
        onClose={() => {
          setEditingView(null);
          setEditedBlockTree(null);
        }}
        title={`Edit "${editingView?.name}" Query`}
        size="lg"
        className="node-view-tabs__edit-modal"
      >
        {editingView && editedBlockTree && (
          <div className="node-view-tabs__edit-form">
            <QueryBlockBuilder
              blockTree={editedBlockTree}
              onChange={setEditedBlockTree}
            />
            <div className="node-view-tabs__edit-actions">
              <InlineConfirmButton
                onConfirm={() => handleDeleteView(editingView)}
                variant="danger"
                size="sm"
                title="Delete view"
                confirmTitle="Confirm delete"
                className="node-view-tabs__delete-btn"
              >
                <DeleteIcon size="sm" />
              </InlineConfirmButton>
              <div className="node-view-tabs__edit-spacer" />
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingView(null);
                  setEditedBlockTree(null);
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
    </div>
  );
}

export default NodeViewTabs;
