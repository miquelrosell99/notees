/**
 * Whiteboards View - displays all whiteboard pages with card/list/table support.
 *
 * Uses NodeCollection with a default card view and the ability to switch
 * to list or table. Includes a button to create new whiteboards.
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NodeCollection } from '@/components/nodes/NodeCollection';
import { Button } from '@/components/core/Button';
import { Spinner } from '@/components/core/Spinner';
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
    isError,
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
        {isLoading ? (
          <div className="whiteboards-view__loading">
            <Spinner size="lg" centered />
          </div>
        ) : isError ? (
          <div className="whiteboards-view__empty">
            <p>Failed to load whiteboards.</p>
          </div>
        ) : (
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
            emptyMessage="No whiteboards yet. Create your first whiteboard!"
          />
        )}
      </div>
    </article>
  );
}

export default WhiteboardsView;
