/**
 * Whiteboards View - displays all whiteboard pages with card/list/table support.
 *
 * Uses NodeCollection with a default card view and the ability to switch
 * to list or table. Includes a button to create new whiteboards.
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NodeCollection, PageViewHeader, useSystemClasses, useNodesWithClass, useCreateNode } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { useOpenNode } from '@/features/layout';
import { nodeKeys } from '@/hooks/queryKeys';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { Node } from '@/types';
import './WhiteboardsView.css';

interface WhiteboardsViewProps {
  className?: string;
}

export function WhiteboardsView({ className = '' }: WhiteboardsViewProps) {
  const openNode = useOpenNode();
  const queryClient = useQueryClient();
  const { systemClassUuids, isLoading: classesLoading } = useSystemClasses();
  const whiteboardClassUuid = systemClassUuids?.whiteboard ?? null;
  const pageClassUuid = systemClassUuids?.page ?? null;

  const {
    data: whiteboards = [],
    isLoading: whiteboardsLoading,
    error,
  } = useNodesWithClass(whiteboardClassUuid);

  const createNode = useCreateNode();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('kanban');

  const handleCreateWhiteboard = useCallback(async () => {
    if (!whiteboardClassUuid || !pageClassUuid) return;

    const classes = [pageClassUuid];
    if (!classes.includes(whiteboardClassUuid)) {
      classes.push(whiteboardClassUuid);
    }

    const newNode = await createNode.mutateAsync({
      name: 'New Whiteboard',
      class_uuids: classes,
    });

    // Invalidate the whiteboards list so the new one appears
    queryClient.invalidateQueries({ queryKey: nodeKeys.byClass(whiteboardClassUuid) });

    // Open the newly created whiteboard
    openNode(newNode.uuid);
  }, [whiteboardClassUuid, pageClassUuid, createNode, queryClient, openNode]);

  const handleNodeClick = useCallback(
    (node: Node) => {
      openNode(node.uuid);
    },
    [openNode],
  );

  const handleNodeShiftClick = useCallback(
    (node: Node) => {
      // Shift+click opens in sidebar as a page card
      useNavigationStore.getState().addSidebarCard(node.uuid, 'page');
    },
    [],
  );

  const isLoading = classesLoading || whiteboardsLoading;

  return (
    <article className={`node-view node-view--page whiteboards-view ${className}`}>
      <PageViewHeader
        className="whiteboards-view__header"
        title={<h1>Whiteboards</h1>}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={"mdi mdi-plus"}
            onClick={handleCreateWhiteboard}
            disabled={!whiteboardClassUuid || createNode.isPending}
            title="New whiteboard"
          >
            New whiteboard
          </Button>
        }
      />

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
            groupBy="none"
            showAddButton
            onAdd={handleCreateWhiteboard}
            can_create={!!whiteboardClassUuid}
            emptyMessage="Create a whiteboard to get started"
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default WhiteboardsView;
