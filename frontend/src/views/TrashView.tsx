/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Fetches directly from the /trash endpoint instead of using query system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '../components/nodes/NodeCollectionToolbar';
import { TrashIcon } from '../components/core/icons';
import { TrashNodeContextMenu } from '../components/nodes/TrashNodeContextMenu';
import { useNavigationStore } from '@/stores';
import { getTrash, restoreNode, permanentlyDeleteNode, emptyTrash, batchPermanentlyDeleteNodes } from '@/api/nodes';
import { nodeKeys } from '@/hooks/useNodes';
import type { Node } from '@/types';
import { mdiCheckboxMarkedOutline, mdiCheckboxBlankOutline } from '@mdi/js';
import { copyToClipboard } from '@/utils/clipboardManager';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/core/ContextMenu';
import { useState, useCallback, useMemo } from 'react';
import { Button } from '../components/core/Button';
import { ConfirmationModal } from '../components/core/ConfirmationModal';
import { LoadingSkeleton } from '../components/core/LoadingSkeleton';
import { EmptyState } from '../components/core/EmptyState';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const { openNode } = useNavigationStore();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('table');
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);
  const [showDeleteSelectedConfirm, setShowDeleteSelectedConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();
  
  // Fetch trash directly from API
  const { data: nodes, isLoading, error, refetch } = useQuery({
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
    mutationFn: permanentlyDeleteNode,
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
      setShowEmptyConfirm(false);
    },
  });
  
  const batchDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => batchPermanentlyDeleteNodes({ ids }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
      setSelectedIds(new Set());
      setShowDeleteSelectedConfirm(false);
    },
  });
  
  // Handle empty trash confirmation
  const handleEmptyTrashConfirm = useCallback(() => {
    emptyTrashMutation.mutate();
  }, [emptyTrashMutation]);
  
  // Toggle node selection (shift+click)
  const handleNodeShiftClick = useCallback((node: Node) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }, []);
  
  // Select/deselect all
  const handleToggleSelectAll = useCallback(() => {
    if (!nodes) return;
    setSelectedIds(prev => {
      if (prev.size === nodes.length) return new Set();
      return new Set(nodes.map(n => n.id));
    });
  }, [nodes]);
  
  const allSelected = useMemo(() => {
    return nodes != null && nodes.length > 0 && selectedIds.size === nodes.length;
  }, [nodes, selectedIds]);
  
  // Generate context menu items for trash nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    const isSelected = selectedIds.has(node.id);
    return [
      {
        id: 'select',
        label: isSelected ? 'Deselect' : 'Select',
        icon: isSelected ? mdiCheckboxMarkedOutline : mdiCheckboxBlankOutline,
        onClick: () => {
          handleNodeShiftClick(node);
          closeMenu();
        },
      },
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
          copyToClipboard(node.uuid);
          closeMenu();
        }
      },
      { id: 'sep-1', label: '', separator: true },
      {
        id: 'permanent-delete',
        label: 'Delete Permanently',
        danger: true,
        onClick: () => {
          if (confirm(`Permanently delete "${nodeNameToText(node.name) || 'Untitled'}"? This cannot be undone.`)) {
            permanentDeleteMutation.mutate(node.id);
          }
          closeMenu();
        },
      },
    ];
  }, [restoreMutation, permanentDeleteMutation, selectedIds, handleNodeShiftClick]);
  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">
              <TrashIcon size="lg" /> Trash
            </h1>
            <div className="page-header__actions">
              {!isLoading && nodes && nodes.length > 0 && selectedIds.size > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setShowDeleteSelectedConfirm(true)}
                  disabled={batchDeleteMutation.isPending}
                >
                  {batchDeleteMutation.isPending ? 'Deleting...' : `Delete Selected (${selectedIds.size})`}
                </Button>
              )}
              {!isLoading && nodes && nodes.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleToggleSelectAll}
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setShowEmptyConfirm(true)}
                    disabled={emptyTrashMutation.isPending}
                  >
                    {emptyTrashMutation.isPending ? 'Emptying...' : 'Empty Trash'}
                  </Button>
                </>
              )}
            </div>
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
        
        {isLoading && (
          <LoadingSkeleton rows={4} className="trash-view__loading" />
        )}
        {error && (
          <EmptyState
            title="Failed to load trash"
            description="There was a problem fetching deleted pages."
            actionLabel="Try again"
            onAction={() => refetch()}
          />
        )}
        {!isLoading && !error && nodes?.length === 0 && (
          <EmptyState
            icon={<TrashIcon size="lg" />}
            title="Trash is empty"
            description="Deleted pages and blocks appear here. You can restore them or delete permanently."
          />
        )}
        {!isLoading && !error && !!nodes?.length && (
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            customContextMenu={TrashNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.id)}
            onNodeShiftClick={handleNodeShiftClick}
          />
        )}
      </div>
      
      {/* Empty Trash Confirmation Modal */}
      <ConfirmationModal
        isOpen={showEmptyConfirm}
        title="Empty Trash"
        message={`Permanently delete ${nodes?.length ?? 0} item${(nodes?.length ?? 0) !== 1 ? 's' : ''} from trash?`}
        secondaryMessage="This action cannot be undone."
        confirmLabel="Empty Trash"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleEmptyTrashConfirm}
        onCancel={() => setShowEmptyConfirm(false)}
      />
      
      {/* Delete Selected Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteSelectedConfirm}
        title="Delete Selected"
        message={`Permanently delete ${selectedIds.size} item${selectedIds.size !== 1 ? 's' : ''} from trash?`}
        secondaryMessage="This action cannot be undone."
        confirmLabel="Delete Selected"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => batchDeleteMutation.mutate([...selectedIds])}
        onCancel={() => setShowDeleteSelectedConfirm(false)}
      />
    </article>
  );
}

export default TrashView;
