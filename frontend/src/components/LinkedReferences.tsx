/**
 * LinkedReferences component for displaying references to a node
 * 
 * Shows linked references using two NodeCollections:
 * - Linked Pages: Pages that reference this node via properties
 * - Linked Blocks: Blocks that mention this node via [[links]] or ((refs))
 * 
 * NodeViewSection wrapping is handled by NodeView.
 */
import { useState, useMemo, useCallback } from 'react';
import './LinkedReferences.css';
import { useLinkedReferences, usePropertyBacklinks, useUpdateNode } from '@/hooks';
import type { Node } from '@/types/api';
import { PageIcon, BulletIcon } from './icons';
import { NodeCollection } from './nodes/NodeCollection';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

interface LinkedReferencesProps {
  nodeId: number;
  className?: string;
  onLinkClick?: (nodeId: number, pageId?: number | null, isPage?: boolean) => void;
  showContext?: boolean;
}

/**
 * Hook to get linked references count for section metadata
 */
export function useLinkedReferencesCount(nodeId: number) {
  const { data: refs, isLoading: refsLoading } = useLinkedReferences(nodeId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(nodeId);
  
  const pageCount = propertyBacklinks?.length ?? 0;
  const blockCount = refs?.length ?? 0;
  const totalCount = pageCount + blockCount;
  
  return {
    count: totalCount,
    isLoading: refsLoading || propLoading,
  };
}

/**
 * Linked references section with surrounding context
 * 
 * Shows where this node is mentioned with two separate NodeCollections:
 * - Linked Pages: Pages referencing via date/node properties
 * - Linked Blocks: Blocks mentioning via [[links]] and ((refs))
 * 
 * Each section is collapsible via NodeViewSection.
 */
export function LinkedReferences({
  nodeId,
  className = '',
  onLinkClick,
}: LinkedReferencesProps) {
  const { data: refs, isLoading: refsLoading } = useLinkedReferences(nodeId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(nodeId);
  const updateNode = useUpdateNode();

  // View mode state for each section
  const [pagesViewMode, setPagesViewMode] = useState<NodeCollectionViewMode>('list');
  const [blocksViewMode, setBlocksViewMode] = useState<NodeCollectionViewMode>('list');

  const isLoading = refsLoading || propLoading;

  // Handle content change for blocks
  const handleContentChange = useCallback((blockId: number, content: string) => {
    updateNode.mutate({ id: blockId, data: { name: content } });
  }, [updateNode]);

  // Convert property backlinks to page nodes for NodeCollection
  const pageNodes: Node[] = useMemo(() => {
    if (!propertyBacklinks) return [];
    return propertyBacklinks.map(pb => ({
      id: pb.source_page.id,
      uuid: '',
      name: pb.source_page.name || 'Untitled',
      icon: pb.source_page.icon || null,
      color: null,
      is_page: true,
      parent_id: null,
      page_id: null,
      sequence: 0,
      active: true,
      create_date: '',
      write_date: '',
      types: [],
      tags: [],
      collapsed: false,
      children: [],
    }));
  }, [propertyBacklinks]);

  // Convert linked references to block nodes for NodeCollection
  const blockNodes: Node[] = useMemo(() => {
    if (!refs) return [];
    return refs.map(ref => ({
      id: ref.source_node.id,
      uuid: '',
      name: ref.source_node.name || 'Untitled',
      icon: ref.source_node.icon || null,
      color: null,
      is_page: false,
      parent_id: null,
      page_id: ref.source_page?.id ?? null,
      sequence: 0,
      active: true,
      create_date: '',
      write_date: '',
      types: [],
      tags: [],
      collapsed: false,
      children: [],
    }));
  }, [refs]);

  const handleNodeClick = useCallback((node: Node) => {
    onLinkClick?.(node.id, node.page_id, node.is_page);
  }, [onLinkClick]);

  if (isLoading) {
    return (
      <div className={`linked-references loading ${className}`}>
        <div className="linked-references-skeleton">Loading references...</div>
      </div>
    );
  }

  const pageCount = pageNodes.length;
  const blockCount = blockNodes.length;
  const totalCount = pageCount + blockCount;
  
  if (totalCount === 0) {
    return null;
  }

  return (
    <div className={`linked-references ${className}`}>
      <div className="linked-references__content">
        {/* Linked Pages Section */}
        {pageCount > 0 && (
          <div className="linked-references__section linked-references__pages">
            <div className="linked-references__section-header">
              <PageIcon size="sm" />
              <span className="linked-references__section-title">Linked Pages</span>
              <span className="linked-references__section-count">({pageCount})</span>
            </div>
            <NodeCollection
              nodes={pageNodes}
              viewMode={pagesViewMode}
              availableViewModes={['list', 'card', 'table']}
              onViewModeChange={setPagesViewMode}
              editable={false}
              onNodeClick={handleNodeClick}
              showEmpty={false}
              className="linked-references__collection"
            />
          </div>
        )}

        {/* Linked Blocks Section */}
        {blockCount > 0 && (
          <div className="linked-references__section linked-references__blocks">
            <div className="linked-references__section-header">
              <BulletIcon size="sm" />
              <span className="linked-references__section-title">Linked Blocks</span>
              <span className="linked-references__section-count">({blockCount})</span>
            </div>
            <NodeCollection
              nodes={blockNodes}
              viewMode={blocksViewMode}
              availableViewModes={['list', 'card', 'table']}
              onViewModeChange={setBlocksViewMode}
              editable={false}
              onNodeClick={handleNodeClick}
              onContentChange={handleContentChange}
              showEmpty={false}
              className="linked-references__collection"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Combined component showing both backlinks and linked references
 * 
 * Uses the new ReferencesView with:
 * - Pages section: References from date/node properties
 * - Blocks section: References from [[links]] and ((refs)) in content
 */
export function References({
  nodeId,
  className = '',
  onLinkClick,
}: LinkedReferencesProps) {
  return (
    <div className={`references ${className}`}>
      <LinkedReferences nodeId={nodeId} onLinkClick={onLinkClick} />
    </div>
  );
}

export default LinkedReferences;
