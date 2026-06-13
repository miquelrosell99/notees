/**
 * Whiteboards View - displays all whiteboard pages with card/list/table support.
 *
 * Uses NodeCollection with a default card view and the ability to switch
 * to list or table. Includes a button to create new whiteboards.
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { useSystemClasses } from '@/hooks/usePageClass';
import { useNodesWithClass, useCreateNode } from '@/hooks/useNodes';
import { nodeKeys } from '@/hooks/queryKeys';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { Node } from '@/types';
import './WhiteboardsView.css';

interface WhiteboardsViewProps {
  className?: string;
}

export function WhiteboardsView({ className = '' }: WhiteboardsViewProps) {
  const { openNode } = useNavigationStore();
  const queryClient = useQueryClient();
  const { systemClassIds, isLoading: classesLoading } = useSystemClasses();
  const whiteboardClassId = systemClassIds?.whiteboard ?? null;
  const pageClassId = systemClassIds?.page ?? null;

  const {
    data: whiteboards = [],
    isLoading: whiteboardsLoading,
    error,
  } = useNodesWithClass(whiteboardClassId);

  const createNode = useCreateNode();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('kanban');

  const handleCreateWhiteboard = useCallback(async () => {
    if (!whiteboardClassId || !pageClassId) return;

    const classes = [pageClassId];
    if (!classes.includes(whiteboardClassId)) {
      classes.push(whiteboardClassId);
    }

    const newNode = await createNode.mutateAsync({
      name: 'New Whiteboard',
      classes,
    });

    // Invalidate the whiteboards list so the new one appears
    queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(whiteboardClassId) });

    // Open the newly created whiteboard
    openNode(newNode.id);
  }, [whiteboardClassId, pageClassId, createNode, queryClient, openNode]);

  const handleNodeClick = useCallback(
    (node: Node) => {
      openNode(node.id);
    },
    [openNode],
  );

  const handleNodeShiftClick = useCallback(
    (node: Node) => {
      // Shift+click opens in sidebar as a page card
      useNavigationStore.getState().addSidebarCard(node.id, 'page');
    },
    [],
  );

  const isLoading = classesLoading || whiteboardsLoading;

  return (
    <article className={`node-view node-view--page whiteboards-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header whiteboards-view__header">
            <h1 className="page-header__title">Whiteboards</h1>
            <Button
              variant="primary"
              size="sm"
              icon={"mdi mdi-plus"}
              onClick={handleCreateWhiteboard}
              disabled={!whiteboardClassId || createNode.isPending}
              title="New whiteboard"
            >
              New whiteboard
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="whiteboards-view__content">
        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={whiteboards.length === 0}
          errorTitle="Failed to load whiteboards."
          emptyTitle="No whiteboards yet"
          emptyDescription="Whiteboards are free-form canvases for notes, shapes, and images."
          skeletonRows={4}
        >
          <NodeCollection
            nodes={whiteboards}
            viewMode={viewMode}
            availableViewModes={['kanban', 'list', 'table']}
            onViewModeChange={setViewMode}
            onNodeClick={handleNodeClick}
            onNodeShiftClick={handleNodeShiftClick}
            pagesOnly
            editable={false}
            showAddButton
            onAdd={handleCreateWhiteboard}
            can_create={!!whiteboardClassId}
            emptyMessage="Create a whiteboard to get started"
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default WhiteboardsView;
