/**
 * Archived Pages View
 * 
 * Displays pages that have been archived (active = false).
 * Fetches directly from the /archived endpoint instead of using query system.
 */
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { NodeCollectionToolbar } from '@/features/content/components/nodes/NodeCollectionToolbar';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { ArchivedNodeContextMenu } from '@/features/content/components/nodes/ArchivedNodeContextMenu';
import { ArchiveIcon } from '@/components/ui/icons';
import { useNavigationStore } from '@/stores';
import { useArchivedPages, useArchivedPagesMutations } from '@/features/content';
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
  const openNode = useNavigationStore((state) => state.openNode);
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ type: 'unarchive' | 'delete'; node: Node } | null>(null);

  const { data: nodes, isLoading, error, refetch } = useArchivedPages();
  const { unarchive: unarchiveMutation, deleteNode: deleteMutation, deleteAll: deleteAllMutation } = useArchivedPagesMutations();

  // Generate context menu items for archived nodes
  const generateContextMenuItems = useCallback((node: Node, closeMenu: () => void): ContextMenuItem[] => {
    return [
      {
        id: 'unarchive',
        label: 'Unarchive',
        icon: "mdi mdi-archive-arrow-up",
        onClick: () => {
          setPendingAction({ type: 'unarchive', node });
          closeMenu();
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: "mdi mdi-delete",
        onClick: () => {
          setPendingAction({ type: 'delete', node });
          closeMenu();
        },
        danger: true,
      },
    ];
  }, []);
  
  return (
    <article className={`node-view node-view--page archived-pages-view ${className}`}>
      <PageViewHeader
        className="archived-pages-view__header"
        title={<h1>Archived Pages</h1>}
        actions={
          !isLoading && nodes && nodes.length > 0 ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowDeleteAllConfirm(true)}
              disabled={deleteAllMutation.isPending}
              loading={deleteAllMutation.isPending}
            >
              {deleteAllMutation.isPending ? 'Deleting...' : 'Delete All'}
            </Button>
          ) : undefined
        }
      />
      
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
          emptyDescription="Archived pages are hidden from your workspace. Right-click a page and select Archive to move it here."
          emptyIcon={<ArchiveIcon size="lg" />}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={nodes ?? []}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            groupBy="none"
            customContextMenu={ArchivedNodeContextMenu}
            customContextMenuItems={generateContextMenuItems}
            onNodeClick={(node) => openNode(node.uuid)}
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
        onConfirm={async () => {
          await deleteAllMutation.mutateAsync((nodes ?? []).map((n) => n.uuid));
          setShowDeleteAllConfirm(false);
        }}
        onCancel={() => setShowDeleteAllConfirm(false)}
      />

      {/* Per-Page Action Confirmation Modal */}
      <ConfirmationModal
        isOpen={pendingAction !== null}
        title={pendingAction?.type === 'delete' ? 'Delete Page' : 'Unarchive Page'}
        message={
          pendingAction?.type === 'delete'
            ? 'Delete this page permanently?'
            : 'Unarchive this page?'
        }
        secondaryMessage={pendingAction?.type === 'delete' ? 'This action cannot be undone.' : undefined}
        confirmLabel={pendingAction?.type === 'delete' ? 'Delete' : 'Unarchive'}
        cancelLabel="Cancel"
        variant={pendingAction?.type === 'delete' ? 'danger' : 'primary'}
        onConfirm={async () => {
          if (pendingAction?.type === 'delete') {
            await deleteMutation.mutateAsync(pendingAction.node.uuid);
          } else if (pendingAction) {
            await unarchiveMutation.mutateAsync(pendingAction.node.uuid);
          }
          setPendingAction(null);
        }}
        onCancel={() => setPendingAction(null)}
      />
    </article>
  );
}

export default ArchivedPagesView;
