/**
 * Archived Pages View
 * 
 * Displays pages that have been archived (active = false).
 * Fetches directly from the /archived endpoint instead of using query system.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { ArchivedNodeContextMenu } from '@/features/content/components/nodes/ArchivedNodeContextMenu';
import { ArchiveIcon } from '@/components/ui/icons';
import { useNavigationStore } from '@/stores';
import api from '@/api/client';
import { isFavorite, removeFavorite } from '@/hooks/useFavorites';
import { removeRecent } from '@/hooks/useRecents';
import { unarchiveNode, deleteNode, batchDeleteNodes } from '@/api/nodes';
import type { Node } from '@/types/api';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { DataStateView } from '@/components/ui/DataStateView';
import './ArchivedPagesView.css';

interface ArchivedPagesViewProps {
  className?: string;
}

export function ArchivedPagesView({ className = '' }: ArchivedPagesViewProps) {
  const { openNode } = useNavigationStore();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const queryClient = useQueryClient();
  
  // Mutation for unarchiving nodes
  const unarchiveMutation = useMutation({
    mutationFn: unarchiveNode,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archived-pages'] });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'active' });
    },
  });
  
  // Mutation for deleting nodes
  const deleteMutation = useMutation({
    mutationFn: deleteNode,
    onSuccess: (_data, nodeId) => {
      queryClient.invalidateQueries({ queryKey: ['archived-pages'] });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'active' });
      if (isFavorite(nodeId)) {
        removeFavorite(nodeId).catch(() => {});
      }
      removeRecent(nodeId);
    },
  });

  // Mutation for deleting all archived nodes
  const deleteAllMutation = useMutation({
    mutationFn: () => {
      const uuids = (nodes ?? []).map(n => n.uuid);
      return batchDeleteNodes({ uuids });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archived-pages'] });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'linked-refs'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'property-backlinks'], refetchType: 'active' });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'backlinks'], refetchType: 'active' });
      setShowDeleteAllConfirm(false);
      for (const node of nodes ?? []) {
        if (isFavorite(node.id)) {
          removeFavorite(node.id).catch(() => {});
        }
        removeRecent(node.id);
      }
    },
  });
  
  // Generate context menu items for archived nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    return [
      {
        id: 'unarchive',
        label: 'Unarchive',
        icon: "mdi mdi-archive-arrow-up",
        onClick: () => {
          if (confirm('Unarchive this page?')) {
            unarchiveMutation.mutate(node.id);
          }
          closeMenu();
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: "mdi mdi-delete",
        onClick: () => {
          if (confirm('Delete this page permanently? This action cannot be undone.')) {
            deleteMutation.mutate(node.id);
          }
          closeMenu();
        },
        danger: true,
      },
    ];
  }, [unarchiveMutation, deleteMutation]);
  
  // Fetch archived pages directly from API
  const { data: nodes, isLoading, error, refetch } = useQuery({
    queryKey: ['archived-pages'],
    queryFn: async () => {
      const response = await api.get<{ pages: Node[] }>('/nodes/archived');
      return response.data.pages;
    },
  });
  
  return (
    <article className={`node-view node-view--page archived-pages-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">
              Archived Pages
            </h1>
            <div className="page-header__actions">
              {!isLoading && nodes && nodes.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setShowDeleteAllConfirm(true)}
                  disabled={deleteAllMutation.isPending}
                >
                  {deleteAllMutation.isPending ? 'Deleting...' : 'Delete All'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Archived Collection */}
      <div className="archived-pages-view__content">
        <div className="archived-pages-view__toolbar">
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
          errorTitle="Failed to load archived pages"
          emptyTitle="No archived pages"
          emptyDescription="Archived pages are hidden from your workspace but kept safe here. Right-click any page and select Archive to move it here."
          emptyIcon={<ArchiveIcon size="lg" />}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            customContextMenu={ArchivedNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.id)}
          />
        </DataStateView>
      </div>
      
      {/* Delete All Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteAllConfirm}
        title="Delete All Archived Pages"
        message={`Delete ${nodes?.length ?? 0} archived page${(nodes?.length ?? 0) !== 1 ? 's' : ''}?`}
        secondaryMessage="These pages will be moved to trash."
        confirmLabel="Delete All"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => deleteAllMutation.mutate()}
        onCancel={() => setShowDeleteAllConfirm(false)}
      />
    </article>
  );
}

export default ArchivedPagesView;
