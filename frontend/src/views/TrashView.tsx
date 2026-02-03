/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Fetches directly from the /trash endpoint instead of using query system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { NodeCollection, NodeCollectionToolbar } from '../components/nodes/NodeCollection';
import { TrashIcon } from '../components/icons';
import { TrashNodeContextMenu } from '../components/nodes/TrashNodeContextMenu';
import { useNodesStore } from '@/stores';
import { getTrash, restoreNode, permanentDeleteNode, emptyTrash } from '@/api/nodes';
import { nodeKeys } from '@/hooks/useNodes';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/core/ContextMenu';
import { useState, useCallback } from 'react';
import { Button } from '../components/core/Button';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const { openNode } = useNodesStore();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('table');
  const queryClient = useQueryClient();
  
  // Fetch trash directly from API
  const { data: nodes, isLoading, error } = useQuery({
    queryKey: ['trash'],
    queryFn: getTrash,
  });
  
  // Mutations for restore and delete
  const restoreMutation = useMutation({
    mutationFn: restoreNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
  
  const permanentDeleteMutation = useMutation({
    mutationFn: permanentDeleteNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
  
  const emptyTrashMutation = useMutation({
    mutationFn: emptyTrash,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
    },
  });
  
  // Handle empty trash with confirmation
  const handleEmptyTrash = useCallback(() => {
    const trashCount = nodes?.length ?? 0;
    if (trashCount === 0) return;
    
    const message = `Permanently delete all ${trashCount} item${trashCount > 1 ? 's' : ''} from trash? This cannot be undone.`;
    if (confirm(message)) {
      emptyTrashMutation.mutate();
    }
  }, [nodes?.length, emptyTrashMutation]);
  
  // Generate context menu items for trash nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    return [
      {
        id: 'restore',
        label: 'Restore',
        onClick: () => {
          restoreMutation.mutate(node.id);
          closeMenu();
        },
      },
      {
        id: 'copy-uuid',
        label: 'Copy UUID',
        onClick: () => {
          navigator.clipboard.writeText(node.uuid);
          closeMenu();
        }
      },
      { id: 'sep-1', label: '', separator: true },
      {
        id: 'permanent-delete',
        label: 'Delete Permanently',
        danger: true,
        onClick: () => {
          if (confirm(`Permanently delete "${node.name || 'Untitled'}"? This cannot be undone.`)) {
            permanentDeleteMutation.mutate(node.id);
          }
          closeMenu();
        },
      },
    ];
  }, [restoreMutation, permanentDeleteMutation]);
  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">
              <TrashIcon size="lg" /> Trash
            </h1>
            {!isLoading && nodes && nodes.length > 0 && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleEmptyTrash}
                disabled={emptyTrashMutation.isPending}
              >
                {emptyTrashMutation.isPending ? 'Emptying...' : 'Empty Trash'}
              </Button>
            )}
          </div>
        </div>
      </div>
      
      {/* Trash Collection */}
      <div className="trash-view__content">
        <div className="trash-view__toolbar">
          <NodeCollectionToolbar
            viewMode={viewMode}
            availableViewModes={['list', 'table', 'card']}
            onViewModeChange={setViewMode}
            groupBy="none"
            onGroupByChange={() => {}}
          />
        </div>
        
        {isLoading && <div className="trash-view__loading">Loading...</div>}
        {error && <div className="trash-view__error">Failed to load trash</div>}
        {!isLoading && !error && (
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showTypes={true}
            hideToolbar={true}
            customContextMenu={TrashNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.id, node.is_page ? 'page' : 'block')}
          />
        )}
      </div>
    </article>
  );
}

export default TrashView;
