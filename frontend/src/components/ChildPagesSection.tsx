/**
 * ChildPagesSection - Displays child pages of a parent page
 * 
 * Uses NodeCollection to display pages. NodeViewSection wrapping is handled by NodeView.
 * Supports list, table, and card view modes.
 */
import { useCallback, useState } from 'react';
import { NodeCollection } from './nodes/NodeCollection';
import { useNodesStore } from '@/stores';
import { useCreateNode } from '@/hooks';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

interface ChildPagesSectionProps {
  pageId: number;
  /** Child pages to display */
  childPages?: Node[];
  /** Default view mode */
  defaultViewMode?: NodeCollectionViewMode;
}

export function ChildPagesSection({ 
  pageId,
  childPages,
  defaultViewMode = 'list',
}: ChildPagesSectionProps) {
  const { openNode, addSidebarCard } = useNodesStore();
  const createNode = useCreateNode();
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>(defaultViewMode);
  const count = childPages?.length ?? 0;
  
  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id, 'page');
  }, [openNode]);
  
  const handleNodeShiftClick = useCallback((node: Node) => {
    addSidebarCard(node.id, 'page');
  }, [addSidebarCard]);
  
  const handleAddChildPage = useCallback(() => {
    createNode.mutate({ name: '', is_page: true, parent_id: pageId }, {
      onSuccess: (newPage) => {
        openNode(newPage.id, 'page');
      }
    });
  }, [createNode, pageId, openNode]);
  
  // Don't render if no child pages
  if (count === 0) {
    return null;
  }

  return (
    <NodeCollection
      nodes={childPages ?? []}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      availableViewModes={['list', 'table', 'card']}
      sortable={false}
      pagesOnly={true}
      onNodeClick={handleNodeClick}
      onNodeShiftClick={handleNodeShiftClick}
      showAddButton={true}
      onAdd={handleAddChildPage}
    />
  );
}

export default ChildPagesSection;
