/**
 * ChildPagesSection - Displays child pages of a parent page
 * 
 * Uses NodeSet with NodeViewSection for consistent collapsible UI.
 * Supports list, table, and card view types.
 */
import { useState, useMemo, useCallback } from 'react';
import { NodeSet, type NodeSetItem, type NodeSetViewType } from './NodeSet';
import { NodeViewSection } from './NodeViewSection';
import { PageIcon } from './icons';
import { SelectionButton } from './core/SelectionButton';
import { mdiFormatListBulleted, mdiTable, mdiViewGrid } from '@mdi/js';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';

// View type icon and label mapping
const VIEW_TYPE_OPTIONS: Record<NodeSetViewType, { icon: string; label: string }> = {
  list: { icon: mdiFormatListBulleted, label: 'List view' },
  table: { icon: mdiTable, label: 'Table view' },
  card: { icon: mdiViewGrid, label: 'Card view' },
};

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
        <SelectionButton
          options={['list', 'table', 'card'].map((opt) => ({
            value: opt,
            icon: VIEW_TYPE_OPTIONS[opt as NodeSetViewType].icon,
            label: VIEW_TYPE_OPTIONS[opt as NodeSetViewType].label,
          }))}
          value={viewType}
          onChange={(val) => setViewType(val as NodeSetViewType)}
          size="sm"
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
