/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Shows nodes where is_deleted=true, ordered by deleted_at descending.
 */
import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { TrashIcon, RestoreIcon, DeleteIcon } from '../components/icons';
import { nodeKeys } from '@/hooks/useNodes';
import { Button } from '../components/core/Button';
import { getTrash, restoreNode, permanentDeleteNode } from '@/api/nodes';
import type { Node } from '@/types';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const queryClient = useQueryClient();
  const [selectedNodes, setSelectedNodes] = useState<Set<number>>(new Set());
  
  // Fetch deleted nodes
  const { data: trashData, isLoading } = useQuery({
    queryKey: ['trash'],
    queryFn: getTrash,
  });
  
  // Restore mutation
  const restoreMutation = useMutation({
    mutationFn: restoreNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      setSelectedNodes(new Set());
    },
  });
  
  // Permanent delete mutation
  const permanentDeleteMutation = useMutation({
    mutationFn: permanentDeleteNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      setSelectedNodes(new Set());
    },
  });
  
  const handleRestore = useCallback((nodeId: number) => {
    if (confirm('Restore this node?')) {
      restoreMutation.mutate(nodeId);
    }
  }, [restoreMutation]);
  
  const handlePermanentDelete = useCallback((nodeId: number) => {
    if (confirm('Permanently delete this node? This cannot be undone!')) {
      permanentDeleteMutation.mutate(nodeId);
    }
  }, [permanentDeleteMutation]);
  
  const handleRestoreAll = useCallback(() => {
    if (selectedNodes.size === 0) return;
    if (confirm(`Restore ${selectedNodes.size} selected node(s)?`)) {
      selectedNodes.forEach(nodeId => restoreMutation.mutate(nodeId));
    }
  }, [selectedNodes, restoreMutation]);
  
  const handleDeleteAll = useCallback(() => {
    if (selectedNodes.size === 0) return;
    if (confirm(`Permanently delete ${selectedNodes.size} selected node(s)? This cannot be undone!`)) {
      selectedNodes.forEach(nodeId => permanentDeleteMutation.mutate(nodeId));
    }
  }, [selectedNodes, permanentDeleteMutation]);
  
  const toggleSelection = useCallback((nodeId: number) => {
    setSelectedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);
  
  const nodes = trashData?.nodes || [];
  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <TrashIcon size="lg" />
            <h1 className="page-header__title">Trash</h1>
          </div>
        </div>
        <div className="page-header-section__subtitle">
          {nodes.length === 0 ? 'No deleted items' : `${nodes.length} deleted item(s)`}
        </div>
      </div>
      
      {/* Bulk Actions */}
      {selectedNodes.size > 0 && (
        <div className="trash-view__bulk-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={handleRestoreAll}
            disabled={restoreMutation.isPending}
          >
            <RestoreIcon size="sm" />
            Restore Selected ({selectedNodes.size})
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDeleteAll}
            disabled={permanentDeleteMutation.isPending}
          >
            <DeleteIcon size="sm" />
            Delete Permanently ({selectedNodes.size})
          </Button>
        </div>
      )}
      
      {/* Deleted Nodes List */}
      {isLoading ? (
        <div className="trash-view__loading">Loading...</div>
      ) : nodes.length === 0 ? (
        <div className="trash-view__empty">
          <TrashIcon size="xl" />
          <p>Trash is empty</p>
        </div>
      ) : (
        <div className="trash-view__list">
          {nodes.map((node: Node) => (
            <div
              key={node.id}
              className={`trash-item ${selectedNodes.has(node.id) ? 'trash-item--selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedNodes.has(node.id)}
                onChange={() => toggleSelection(node.id)}
                className="trash-item__checkbox"
              />
              <div className="trash-item__content">
                <div className="trash-item__name">{node.name || 'Untitled'}</div>
                <div className="trash-item__meta">
                  {node.deleted_at && (
                    <span className="trash-item__deleted-date">
                      Deleted: {new Date(node.deleted_at).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="trash-item__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRestore(node.id)}
                  disabled={restoreMutation.isPending}
                  title="Restore"
                >
                  <RestoreIcon size="sm" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handlePermanentDelete(node.id)}
                  disabled={permanentDeleteMutation.isPending}
                  title="Delete Permanently"
                >
                  <DeleteIcon size="sm" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export default TrashView;
