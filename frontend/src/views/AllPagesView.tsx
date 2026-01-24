/**
 * All pages view - displays all pages using NodeCollection
 * 
 * Uses NodeCollection in list mode with hierarchy support.
 * SearchBox allows selecting a page to scroll to and highlight.
 */
import { useCallback, useState, useMemo } from 'react';
import { NodeCollection } from '../components/nodes/NodeCollection';
import { SearchBox } from '../components/SearchBox';
import { usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import './AllPagesView.css';

interface AllPagesViewProps {
  className?: string;
  onPageShiftClick?: (page: Node) => void;
}

export function AllPagesView({ className = '', onPageShiftClick }: AllPagesViewProps) {
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const { openNode, addSidebarCard } = useNodesStore();
  const { data: allPages, isLoading, error } = usePages();
  
  // Filter to root pages (pages with no parent)
  const rootPages = useMemo(() => {
    return allPages?.filter(page => !page.parent_id) ?? [];
  }, [allPages]);
  
  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  const handleNodeShiftClick = useCallback((node: Node) => {
    if (onPageShiftClick) {
      onPageShiftClick(node);
    } else {
      addSidebarCard(node.id, 'page');
    }
  }, [onPageShiftClick, addSidebarCard]);
  
  const handleSearchSelect = useCallback((node: Node) => {
    // Navigate to the selected page
    openNode(node.id, 'page');
  }, [openNode]);
  
  if (isLoading) {
    return (
      <div className={`all-pages-view loading ${className}`}>
        Loading pages...
      </div>
    );
  }
  
  if (error) {
    return (
      <div className={`all-pages-view error ${className}`}>
        Failed to load pages
      </div>
    );
  }
  
  return (
    <div className={`all-pages-view ${className}`}>
      <div className="all-pages-view__header">
        <h2 className="all-pages-view__title">All Pages</h2>
        <span className="all-pages-view__count">{allPages?.length ?? 0} pages</span>
      </div>
      
      <div className="all-pages-view__search">
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleSearchSelect}
        />
      </div>
      
      <NodeCollection
        nodes={rootPages}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        availableViewModes={['list', 'card', 'table']}
        sortable={false}
        pagesOnly={true}
        editable={false}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        emptyMessage="No pages yet"
      />
    </div>
  );
}

export default AllPagesView;

