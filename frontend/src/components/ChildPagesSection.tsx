/**
 * ChildPagesSection - Displays child pages of a parent page
 * 
 * Uses NodeSet to display pages. NodeViewSection wrapping is handled by NodeView.
 * Supports list, table, and card view types.
 */
import { useMemo, useCallback } from 'react';
import { NodeSet, type NodeSetItem, type NodeSetViewType } from './nodes/NodeSet';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';

interface ChildPagesSectionProps {
  pageId: number;
  /** Child pages to display */
  childPages?: Node[];
  /** Default view type */
  defaultViewType?: NodeSetViewType;
}

export function ChildPagesSection({ 
  childPages,
  defaultViewType = 'list',
}: ChildPagesSectionProps) {
  const { openNode, addSidebarCard } = useNodesStore();
  const count = childPages?.length ?? 0;
  
  // Convert child pages to NodeSetItem format
  const items = useMemo((): NodeSetItem[] => {
    if (!childPages) return [];
    return childPages.map(page => ({ node: page }));
  }, [childPages]);
  
  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  const handleNodeShiftClick = useCallback((node: Node) => {
    addSidebarCard(node.id, 'page');
  }, [addSidebarCard]);
  
  // Don't render if no child pages
  if (count === 0) {
    return null;
  }

  return (
    <NodeSet
      items={items}
      showHeader={false}
      onNodeClick={handleNodeClick}
      onNodeShiftClick={handleNodeShiftClick}
      viewType={defaultViewType}
      viewTypes={['list', 'table', 'card']}
      showViewToggle={false}
      showGroupBySettings={false}
      groupByOptions={['none']}
      defaultGroupBy="none"
    />
  );
}

export default ChildPagesSection;
