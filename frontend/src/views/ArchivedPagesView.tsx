/**
 * Archived Pages View
 * 
 * Displays pages that have been archived (active = false).
 * Uses DynamicNodeViewSection with archived view type.
 */
import { useCallback } from 'react';
import { DynamicNodeViewSection } from '../components/nodes/DynamicNodeViewSection';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import './ArchivedPagesView.css';

interface ArchivedPagesViewProps {
  className?: string;
}

export function ArchivedPagesView({ className = '' }: ArchivedPagesViewProps) {
  const { openNode } = useNodesStore();
  
  // Special pseudo-node ID and UUID for archived view
  const PSEUDO_NODE_ID = -2;
  const PSEUDO_NODE_UUID = '00000000-0000-0000-0000-000000000002';
  
  return (
    <article className={`node-view node-view--page archived-pages-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">📦 Archived Pages</h1>
          </div>
        </div>
        <div className="page-header-section__subtitle">
          Archived pages are hidden from normal views but not deleted
        </div>
      </div>
      
      {/* Archived Section - use DynamicNodeViewSection with archived view type */}
      <DynamicNodeViewSection
        nodeId={PSEUDO_NODE_ID}
        nodeUuid={PSEUDO_NODE_UUID}
        viewType="archived"
        title="Archived Pages"
        icon={<span>📦</span>}
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
      />
    </article>
  );
}

export default ArchivedPagesView;
