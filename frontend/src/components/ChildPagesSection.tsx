/**
 * ChildPagesSection - Displays child pages of a parent page
 * 
 * Uses NodeSet with NodeViewSection for consistent collapsible UI.
 * Supports list, table, and card view types.
 */
import { useState, useMemo, useCallback } from 'react';
import { NodeSet, SelectionSwitch, type NodeSetItem, type NodeSetViewType } from './NodeSet';
import { NodeViewSection } from './NodeViewSection';
import { PageIcon } from './icons';
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
  const [viewType, setViewType] = useState<NodeSetViewType>(defaultViewType);
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
    <NodeViewSection
      title="Child Pages"
      icon={<PageIcon size="sm" />}
      count={count}
      defaultExpanded={true}
      headerActions={
        <SelectionSwitch
          value={viewType}
          onChange={setViewType}
          options={['list', 'table', 'card']}
        />
      }
    >
      <NodeSet
        items={items}
        showHeader={false}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        viewType={viewType}
        viewTypes={['list', 'table', 'card']}
        showViewToggle={false}
        showGroupBySettings={false}
        groupByOptions={['none']}
        defaultGroupBy="none"
      />
    </NodeViewSection>
  );
}

export default ChildPagesSection;
