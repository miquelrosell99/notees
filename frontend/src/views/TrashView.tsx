/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Fetches directly from the /trash endpoint instead of using query system.
 */
import { useQuery } from '@tanstack/react-query';
import { NodeCollection, NodeCollectionToolbar } from '../components/nodes/NodeCollection';
import { TrashIcon } from '../components/icons';
import { useNodesStore } from '@/stores';
import { getTrash } from '@/api/nodes';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { useState } from 'react';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const { openNode } = useNodesStore();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  
  // Fetch trash directly from API
  const { data, isLoading, error } = useQuery({
    queryKey: ['trash'],
    queryFn: getTrash,
  });
  
  const nodes = data?.nodes ?? [];
  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">
              <TrashIcon size="lg" /> Trash
            </h1>
          </div>
        </div>
      </div>
      
      {/* Trash Collection */}
      <div className="trash-view__content">
        <NodeCollectionToolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          groupBy="none"
          onGroupByChange={() => {}}
          sortBy="none"
          onSortByChange={() => {}}
          hiddenControls={['group', 'sort']}
        />
        
        {isLoading && <div className="trash-view__loading">Loading...</div>}
        {error && <div className="trash-view__error">Failed to load trash</div>}
        {!isLoading && !error && (
          <NodeCollection
            nodes={nodes}
            viewMode={viewMode}
            editable={false}
            contextMenuType="trash"
            onNodeClick={(nodeId, isPage) => openNode(nodeId, isPage ? 'page' : 'block')}
          />
        )}
      </div>
    </article>
  );
}

export default TrashView;
