/**
 * Trash View - displays soft-deleted nodes that can be restored or permanently deleted
 * 
 * Uses DynamicNodeViewSection with trash view type.
 */
import { useCallback } from 'react';
import { DynamicNodeViewSection } from '../components/nodes/DynamicNodeViewSection';
import { TrashIcon } from '../components/icons';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import './TrashView.css';

interface TrashViewProps {
  className?: string;
}

export function TrashView({ className = '' }: TrashViewProps) {
  const { openNode } = useNodesStore();
  
  // Special pseudo-node ID and UUID for trash view
  const PSEUDO_NODE_ID = -1;
  const PSEUDO_NODE_UUID = '00000000-0000-0000-0000-000000000001';

  
  return (
    <article className={`node-view node-view--page trash-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <TrashIcon size="lg" />
            <h1 className="page-header__title">Trash</h1>
          </div>
        </div>
        <div className="page-header-section__subtitle">
          Deleted items can be restored or permanently deleted
        </div>
      </div>
      
      {/* Trash Section - use DynamicNodeViewSection with trash view type */}
      <DynamicNodeViewSection
        nodeId={PSEUDO_NODE_ID}
        nodeUuid={PSEUDO_NODE_UUID}
        viewType="trash"
        title="Deleted Items"
        icon={<TrashIcon size="sm" />}
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={(targetNodeId, isPage) => openNode(targetNodeId, isPage ? 'page' : 'block')}
      />
    </article>
  );
}

export default TrashView;
