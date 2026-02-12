/**
 * All Pages View - displays all root pages as a pseudo-page
 * 
 * Uses QuerySection with all_pages view type.
 */
import { useCallback } from 'react';
import { QuerySection } from '../components/nodes/QuerySection';
import { SearchBox } from '../components/SearchBox';
import { PageIcon } from '../components/icons';
import { useAppStore } from '@/stores';
import type { Node } from '@/types';
import './AllPagesView.css';

interface AllPagesViewProps {
  className?: string;
}

export function AllPagesView({ className = '' }: AllPagesViewProps) {
  const { openNode } = useAppStore();
  
  // Special pseudo-node ID and UUID for all_pages view
  const PSEUDO_NODE_ID = 0;
  const PSEUDO_NODE_UUID = '00000000-0000-0000-0000-000000000000';
  
  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  return (
    <article className={`node-view node-view--page all-pages-view ${className}`}>
      {/* Page Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header">
            <h1 className="page-header__title">All Pages</h1>
          </div>
        </div>
      </div>
      
      {/* Search */}
      <div className="all-pages-view__search">
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleSearchSelect}
        />
      </div>
      
      {/* Pages Section - use QuerySection with all_pages view type */}
      <QuerySection
        nodeId={PSEUDO_NODE_ID}
        nodeUuid={PSEUDO_NODE_UUID}
        viewType="all_pages"
        title="Pages"
        icon={<PageIcon size="sm" />}
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={(targetNodeId) => openNode(targetNodeId, 'page')}
      />
    </article>
  );
}

export default AllPagesView;