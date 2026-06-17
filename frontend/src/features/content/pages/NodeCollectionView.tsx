/**
 * NodeCollectionView — Temporary full-page view for query results.
 *
 * Used by the Command Palette to open ad-hoc node collections
 * (e.g. "Broken links", or full search results via Ctrl+Enter).
 */
import { useState, useCallback, useEffect } from 'react';
import { QueryNodeCollection } from '@/features/content/components/nodes/QueryNodeCollection';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { useCollectionNavigation } from '@/features/layout/hooks/useNavigationSelectors';
import { Button } from '@/components/ui/Button';
import type { QueryAST } from '@/types/queryAST';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import './NodeCollectionView.css';

const AVAILABLE_VIEW_MODES: NodeCollectionViewMode[] = [
  'list',
  'table',
  'kanban',
  'gantt',
  'calendar',
  'chart',
  'graph',
  'timeline',
];

interface NodeCollectionViewProps {
  title: string;
  queryAST?: QueryAST | null;
  nodes?: Node[] | null;
}

export function NodeCollectionView({ title, queryAST, nodes }: NodeCollectionViewProps) {
  const { openNode, closeNodeCollection, addSidebarCard } = useCollectionNavigation();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [resultCount, setResultCount] = useState<number | null>(null);

  useEffect(() => {
    if (nodes) {
      setResultCount(nodes.length);
    }
  }, [nodes]);

  const handleNodeClick = useCallback(
    (nodeId: number) => {
      openNode(nodeId);
    },
    [openNode],
  );

  const handleBlockCreated = useCallback(
    (nodeId: number) => {
      addSidebarCard(nodeId, 'block');
    },
    [addSidebarCard],
  );

  return (
    <article className="node-view node-view--page node-collection-view">
      {/* Header — title + close button */}
      <header className="node-collection-view__header">
        <h1 className="node-collection-view__title">
          {title}
          {resultCount !== null && resultCount > 0 && (
            <span className="node-collection-view__count"> ({resultCount})</span>
          )}
        </h1>
        <Button aria-label="Close"
          variant="ghost"
          size="sm"
          icon="mdi mdi-close"
          onClick={closeNodeCollection}
          title="Close"
        />
      </header>

      {/* Query results */}
      <div className="node-collection-view__results">
        {queryAST ? (
          <QueryNodeCollection
            nodeId={0}
            nodeUuid="00000000-0000-0000-0000-000000000000"
            viewType="all_pages"
            queryAST={queryAST}
            onNodeClick={handleNodeClick}
            onBlockCreated={handleBlockCreated}
            onCountChange={setResultCount}
            hideViewManagement
            can_create={false}
            showClasses={true}
            showAddButton={false}
          >
            {({ results }) => results}
          </QueryNodeCollection>
        ) : nodes ? (
          <NodeCollection
            nodes={nodes}
            viewMode={viewMode}
            availableViewModes={AVAILABLE_VIEW_MODES}
            onViewModeChange={setViewMode}
            onNodeClick={(node) => openNode(node.id)}
            onNodeShiftClick={(node) => addSidebarCard(node.id, node.is_page ? 'page' : 'block')}
            showAddButton={false}
          />
        ) : (
          <div className="empty-state">No results to display</div>
        )}
      </div>
    </article>
  );
}
