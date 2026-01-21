/**
 * All pages view - displays all pages as bullet elements with hierarchy
 * 
 * Uses PagesTree component in "all pages" mode (no activeNodeId).
 * SearchBox allows selecting a page to scroll to and highlight.
 */
import { useRef, useCallback } from 'react';
import { PagesTree, type PagesTreeRef } from '../components/PagesTree';
import { SearchBox } from '../components/SearchBox';
import type { Node } from '@/types';

interface AllPagesViewProps {
  className?: string;
  onPageShiftClick?: (page: Node) => void;
}

export function AllPagesView({ className = '', onPageShiftClick }: AllPagesViewProps) {
  const pagesTreeRef = useRef<PagesTreeRef>(null);
  
  const handleSearchSelect = useCallback((node: Node) => {
    // Scroll to the selected page in the tree
    if (pagesTreeRef.current) {
      pagesTreeRef.current.scrollToNode(node.id);
    }
  }, []);
  
  return (
    <PagesTree
      ref={pagesTreeRef}
      className={className}
      onShiftClick={onPageShiftClick}
      showHeader={true}
      showSearch={true}
      headerTitle="All Pages"
      searchComponent={
        <SearchBox
          placeholder="Search pages..."
          onSelect={handleSearchSelect}
        />
      }
    />
  );
}

export default AllPagesView;

