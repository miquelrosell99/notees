/**
 * All Pages View - displays all root pages as a pseudo-page
 * 
 * Uses the same UI structure as NodeView with ChildPagesSection
 * to maintain consistent look and feel across the app.
 */
import { useCallback, useState } from 'react';
import { ChildPagesSection, ChildPagesSectionToolbar } from '../components/ChildPagesSection';
import { NodeViewSection } from '../components/nodes/NodeViewSection';
import { SearchBox } from '../components/SearchBox';
import { PageIcon } from '../components/icons';
import { usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import './AllPagesView.css';

interface AllPagesViewProps {
  className?: string;
}

/**
 * Hook to manage AllPagesView toolbar state
 * Mirrors useChildPagesSectionState but without create functionality
 */
function useAllPagesToolbarState(pages?: Node[]) {
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  
  return {
    viewMode,
    setViewMode,
    onAdd: () => {}, // No-op for all pages view
    hasItems: (pages?.length ?? 0) > 0,
  };
}

export function AllPagesView({ className = '' }: AllPagesViewProps) {
  const { openNode } = useNodesStore();
  // Fetch root pages with children included
  const { data: rootPages, isLoading, error } = usePages({ includeChildren: true, rootOnly: true });
  
  // Toolbar state for the pages section
  const toolbarState = useAllPagesToolbarState(rootPages);
  
  const handleSearchSelect = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  if (isLoading) {
    return (
      <article className={`node-view node-view--page all-pages-view ${className}`}>
        <div className="loading-state">Loading...</div>
      </article>
    );
  }
  
  if (error) {
    return (
      <article className={`node-view node-view--page all-pages-view ${className}`}>
        <div className="error-state">Failed to load pages</div>
      </article>
    );
  }
  
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
      
      {/* Pages Section - same as ChildPagesSection in NodeView */}
      <NodeViewSection
        title="Pages"
        icon={<PageIcon size="sm" />}
        count={rootPages?.length ?? 0}
        defaultExpanded={true}
        headerActions={
          <ChildPagesSectionToolbar 
            state={toolbarState} 
          />
        }
      >
        <ChildPagesSection 
          pageId={0}
          childPages={rootPages ?? []} 
          hideToolbar={true}
          toolbarState={toolbarState}
        />
      </NodeViewSection>
      
      {/* Footer */}
      <footer className="node-view-footer">
        <div className="node-view-metadata">
          <span>{rootPages?.length ?? 0} root pages</span>
        </div>
      </footer>
    </article>
  );
}

export default AllPagesView;

