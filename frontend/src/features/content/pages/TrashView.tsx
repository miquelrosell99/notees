/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Fetches directly from the /trash endpoint instead of using query system.
 */
import { nodeNameToText } from '@/features/queries';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { TrashIcon } from '@/components/ui/icons';
import { TrashNodeContextMenu } from '@/features/content/components/nodes/TrashNodeContextMenu';
import { useNavigationStore } from '@/stores';
import { useTrash, useTrashMutations } from '@/features/content';
import type { Node } from '@/types';
import { copyToClipboard } from '@/utils/clipboardManager';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { DataStateView } from '@/components/ui/DataStateView';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('table');
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);
  const [showDeleteSelectedConfirm, setShowDeleteSelectedConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: nodes, isLoading, error, refetch } = useTrash();
  const { restore, permanentDelete, emptyTrash: emptyTrashMutation, batchDelete: batchDeleteMutation } = useTrashMutations();

  // Handle empty trash confirmation
  const handleEmptyTrashConfirm = useCallback(async () => {
    await emptyTrashMutation.mutateAsync(undefined);
    setShowEmptyConfirm(false);
  }, [emptyTrashMutation]);
  
  // Toggle node selection (shift+click)
  const handleNodeShiftClick = useCallback((node: Node) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(node.uuid)) {
        next.delete(node.uuid);
      } else {
        next.add(node.uuid);
      }
      return next;
    });
  }, []);

  // Select/deselect all
  const handleToggleSelectAll = useCallback(() => {
    if (!nodes) return;
    setSelectedIds(prev => {
      if (prev.size === nodes.length) return new Set();
      return new Set(nodes.map(n => n.uuid));
    });
  }, [nodes]);
  
  const allSelected = useMemo(() => {
    return nodes != null && nodes.length > 0 && selectedIds.size === nodes.length;
  }, [nodes, selectedIds]);
  
  // Generate context menu items for trash nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    const isSelected = selectedIds.has(node.uuid);
    return [
      {
        id: 'select',
        label: isSelected ? 'Deselect' : 'Select',
        icon: isSelected ? "mdi mdi-checkbox-marked-outline" : "mdi mdi-checkbox-blank-outline",
        onClick: () => {
          handleNodeShiftClick(node);
          closeMenu();
        },
      },
      {
        id: 'restore',
        label: 'Restore',
        onClick: () => {
          restore.mutate(node.uuid);
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
          setDeleteTarget(node);
          closeMenu();
        },
      },
    ];
  }, [restore, selectedIds, handleNodeShiftClick]);
  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      <PageViewHeader
        className="trash-view__header"
        title={<h1>Trash</h1>}
        actions={
          <>
            {!isLoading && nodes && nodes.length > 0 && selectedIds.size > 0 && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowDeleteSelectedConfirm(true)}
                disabled={batchDeleteMutation.isPending}
                loading={batchDeleteMutation.isPending}
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
                  loading={emptyTrashMutation.isPending}
                >
                  {emptyTrashMutation.isPending ? 'Emptying...' : 'Empty Trash'}
                </Button>
              </>
            )}
          </>
        }
      />
      
      {/* Trash Collection */}
      <div className="trash-view__content">
        <div className="trash-view__toolbar">
          <NodeCollectionToolbar
            viewMode={viewMode}
            availableViewModes={['list', 'table', 'kanban']}
            onViewModeChange={setViewMode}
            groupBy="none"
            onGroupByChange={() => {}}
          />
        </div>
        
        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={nodes?.length === 0}
          onRetry={refetch}
          errorTitle="Failed to load trash"
          emptyTitle="Trash is empty"
          emptyDescription="Deleted pages and blocks appear here. Restore them or delete them permanently."
          emptyIcon={<TrashIcon size="lg" />}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            groupBy="none"
            customContextMenu={TrashNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.uuid)}
            onNodeShiftClick={handleNodeShiftClick}
          />
        </DataStateView>
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
        onConfirm={async () => {
          await batchDeleteMutation.mutateAsync([...selectedIds]);
          setSelectedIds(new Set());
          setShowDeleteSelectedConfirm(false);
        }}
        onCancel={() => setShowDeleteSelectedConfirm(false)}
      />

      {/* Permanent Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={deleteTarget !== null}
        title="Delete Permanently"
        message={`Permanently delete "${deleteTarget ? nodeNameToText(deleteTarget.name) || 'Untitled' : ''}"?`}
        secondaryMessage="This action cannot be undone."
        confirmLabel="Delete Permanently"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={async () => {
          if (deleteTarget) {
            await permanentDelete.mutateAsync(deleteTarget.uuid);
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </article>
  );
}

export default TrashView;
