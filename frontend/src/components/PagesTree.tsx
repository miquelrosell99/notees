/**
 * PagesTree - Unified component for displaying pages in a hierarchical tree
 * 
 * Used by:
 * - AllPagesView: Shows all pages with search/filter (no activeNodeId)
 * - ChildPagesSection: Shows child hierarchy of a specific page (with activeNodeId)
 * 
 * Uses Bullet component for consistent appearance with blocks.
 */
import { useState, useMemo, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { usePages, useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { Bullet } from './blocks/Bullet';
import { BlockContent } from './blocks/BlockContent';
import './PagesTree.css';

// ============== Page Tree Item ==============

interface PageTreeItemProps {
  page: Node;
  level: number;
  onShiftClick?: (page: Node) => void;
  highlightedNodeId?: number | null;
  onRegisterRef?: (nodeId: number, el: HTMLDivElement | null) => void;
}

function PageTreeItem({ page, level, onShiftClick, highlightedNodeId, onRegisterRef }: PageTreeItemProps) {
  const { openNode, addSidebarCard, currentNodeId } = useNodesStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  
  // Register ref with parent for scroll-to functionality
  useEffect(() => {
    if (onRegisterRef) {
      onRegisterRef(page.id, rowRef.current);
      return () => onRegisterRef(page.id, null);
    }
  }, [page.id, onRegisterRef]);
  
  const isHighlighted = highlightedNodeId === page.id;
  
  // Always fetch children to know if expand button should show, but only render them when expanded
  const { data: pageWithChildren } = useNode(
    !page.children?.length ? page.id : null,
    { include_children: true }
  );
  
  const children = pageWithChildren?.children || page.children;
  // Filter to only show child pages (not blocks)
  const childPages = useMemo(() => 
    children?.filter(child => child.is_page) || [],
    [children]
  );
  const hasChildren = childPages.length > 0;
  
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openNode(page.id, 'page');
  }, [openNode, page.id]);
  
  const handleShiftClick = useCallback(() => {
    if (onShiftClick) {
      onShiftClick(page);
    } else {
      addSidebarCard(page.id, 'page');
    }
  }, [onShiftClick, page, addSidebarCard]);
  
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCollapsed(!isCollapsed);
  }, [isCollapsed]);
  
  return (
    <div 
      className="pages-tree-item" 
      style={{ '--indent-level': level } as React.CSSProperties}
    >
      <div 
        ref={rowRef}
        className={`pages-tree-row ${page.id === currentNodeId ? 'active' : ''} ${isHighlighted ? 'highlighted-flash' : ''}`}
      >
        <Bullet
          nodeId={page.id}
          icon={page.icon}
          isPage={true}
          interactive={true}
          hasChildren={hasChildren}
          collapsed={isCollapsed}
          isHovered={isHighlighted}
          onClick={handleBulletClick}
          onShiftClick={handleShiftClick}
          onCollapseToggle={handleCollapseToggle}
        />
        <span 
          className="pages-tree-page-content"
          title={page.name || 'Untitled'}
        >
          <BlockContent
            content={page.name || 'Untitled'}
            blockId={page.id}
            className="pages-tree-content"
          />
        </span>
      </div>
      
      {/* Recursively render child pages */}
      {hasChildren && !isCollapsed && (
        <div className="pages-tree-children">
          {childPages.map(child => (
            <PageTreeItem
              key={child.id}
              page={child}
              level={level + 1}
              onShiftClick={onShiftClick}
              highlightedNodeId={highlightedNodeId}
              onRegisterRef={onRegisterRef}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============== Pages Tree ==============

export interface PagesTreeRef {
  scrollToNode: (nodeId: number) => void;
}

export interface PagesTreeProps {
  /** 
   * Active node ID to show children of. 
   * If not provided, shows all root pages.
   */
  activeNodeId?: number | null;
  /** 
   * Child pages to display (used when activeNodeId is set and pages are already loaded).
   * If not provided, will fetch from API.
   */
  childPages?: Node[];
  /** Callback when a page is shift-clicked */
  onShiftClick?: (page: Node) => void;
  /** Additional CSS class */
  className?: string;
  /** Whether to show header with title and count */
  showHeader?: boolean;
  /** Whether to show search filter */
  showSearch?: boolean;
  /** Custom header title */
  headerTitle?: string;
  /** Custom search component to render instead of default filter */
  searchComponent?: React.ReactNode;
}

export const PagesTree = forwardRef<PagesTreeRef, PagesTreeProps>(function PagesTree({ 
  activeNodeId,
  childPages,
  onShiftClick,
  className = '',
  showHeader = false,
  showSearch = false,
  headerTitle = 'Pages',
  searchComponent,
}, ref) {
  const [searchFilter, setSearchFilter] = useState('');
  const [highlightedNodeId, setHighlightedNodeId] = useState<number | null>(null);
  const nodeRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Register/unregister node refs
  const handleRegisterRef = useCallback((nodeId: number, el: HTMLDivElement | null) => {
    if (el) {
      nodeRefs.current.set(nodeId, el);
    } else {
      nodeRefs.current.delete(nodeId);
    }
  }, []);
  
  // Find the scrollable parent container
  const getScrollableParent = useCallback((element: HTMLElement | null): HTMLElement | null => {
    if (!element) return null;
    let parent = element.parentElement;
    while (parent) {
      const style = getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }, []);
  
  // Scroll to a specific node with animation and flash effect
  const scrollToNode = useCallback((nodeId: number) => {
    const element = nodeRefs.current.get(nodeId);
    const scrollContainer = getScrollableParent(containerRef.current);
    
    if (element && scrollContainer) {
      // Smooth scroll with bezier easing (slow, fast, slow)
      const containerRect = scrollContainer.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const scrollTop = scrollContainer.scrollTop;
      const targetScroll = scrollTop + (elementRect.top - containerRect.top) - (containerRect.height / 2) + (elementRect.height / 2);
      
      // Custom bezier scroll animation
      const startScroll = scrollContainer.scrollTop;
      const distance = targetScroll - startScroll;
      const duration = 600; // ms
      let startTime: number | null = null;
      
      // Simplified easeInOutCubic for smooth slow-fast-slow
      const easeInOutCubic = (t: number) => {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      };
      
      const animateScroll = (currentTime: number) => {
        if (!startTime) startTime = currentTime;
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeInOutCubic(progress);
        
        scrollContainer.scrollTop = startScroll + (distance * easedProgress);
        
        if (progress < 1) {
          requestAnimationFrame(animateScroll);
        } else {
          // Trigger flash animation after scroll completes
          setHighlightedNodeId(nodeId);
          // Remove highlight after animation (2 flashes * 600ms each = 1200ms)
          setTimeout(() => setHighlightedNodeId(null), 1200);
        }
      };
      
      requestAnimationFrame(animateScroll);
    }
  }, [getScrollableParent]);
  
  // Expose scrollToNode method to parent
  useImperativeHandle(ref, () => ({
    scrollToNode,
  }), [scrollToNode]);
  
  // Fetch all pages (for all-pages mode)
  const { data: allPages, isLoading: allPagesLoading, error: allPagesError } = usePages();
  
  // Fetch node with children (for child-pages mode when childPages not provided)
  const { data: nodeWithChildren, isLoading: nodeLoading } = useNode(
    activeNodeId && !childPages ? activeNodeId : null,
    { include_children: true }
  );
  
  // Determine which pages to show
  const pages = useMemo(() => {
    if (activeNodeId) {
      // Child pages mode - show children of the active node
      const children = childPages || nodeWithChildren?.children || [];
      // Filter to only show pages
      return children.filter(child => child.is_page);
    } else {
      // All pages mode - show root pages (pages with no parent)
      return allPages?.filter(page => !page.parent_id) || [];
    }
  }, [activeNodeId, childPages, nodeWithChildren, allPages]);
  
  // Apply search filter
  const filteredPages = useMemo(() => {
    if (!searchFilter) return pages;
    return pages.filter(page => 
      page.name?.toLowerCase().includes(searchFilter.toLowerCase())
    );
  }, [pages, searchFilter]);
  
  // Loading state
  const isLoading = activeNodeId ? nodeLoading : allPagesLoading;
  
  if (isLoading) {
    return (
      <div className={`pages-tree loading ${className}`}>
        Loading pages...
      </div>
    );
  }
  
  // Error state (only for all-pages mode)
  if (!activeNodeId && allPagesError) {
    return (
      <div className={`pages-tree error ${className}`}>
        Failed to load pages
      </div>
    );
  }
  
  // Empty state for child pages - return null to hide section
  if (activeNodeId && filteredPages.length === 0) {
    return null;
  }
  
  return (
    <div className={`pages-tree ${activeNodeId ? 'child-mode' : 'all-mode'} ${className}`}>
      {showHeader && (
        <div className="pages-tree-header">
          <h2 className="pages-tree-title">{headerTitle}</h2>
          <span className="pages-tree-count">
            {activeNodeId ? filteredPages.length : (allPages?.length || 0)} pages
          </span>
        </div>
      )}
      
      {showSearch && (
        <div className="pages-tree-search">
          {searchComponent || (
            <input
              type="text"
              className="pages-tree-search-input"
              placeholder="Filter pages..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
            />
          )}
        </div>
      )}
      
      <div ref={containerRef} className="pages-tree-list">
        {filteredPages.length > 0 ? (
          filteredPages.map(page => (
            <PageTreeItem
              key={page.id}
              page={page}
              level={0}
              onShiftClick={onShiftClick}
              highlightedNodeId={highlightedNodeId}
              onRegisterRef={handleRegisterRef}
            />
          ))
        ) : (
          <div className="pages-tree-empty">
            {searchFilter ? 'No pages match your filter' : 'No pages yet'}
          </div>
        )}
      </div>
    </div>
  );
});

export default PagesTree;
