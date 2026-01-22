/**
 * LinkedReferences component for displaying references to a node
 * 
 * Shows linked references using two NodeCollections:
 * - Linked Pages: Pages that reference this node via properties
 * - Linked Blocks: Blocks that mention this node via [[links]] or ((refs))
 * 
 * NodeViewSection wrapping is handled by NodeView.
 * 
 * The toolbar can be rendered externally via the renderToolbar prop or
 * LinkedReferencesToolbar component for placement in NodeViewSection headers.
 */
import { useState, useMemo, useCallback } from 'react';
import './LinkedReferences.css';
import { useLinkedReferences, usePropertyBacklinks, useUpdateNode } from '@/hooks';
import type { Node } from '@/types/api';
import { NodeCollection, NodeCollectionToolbar } from './nodes/NodeCollection';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';

interface LinkedReferencesProps {
  nodeId: number;
  className?: string;
  onLinkClick?: (nodeId: number, pageId?: number | null, isPage?: boolean) => void;
  showContext?: boolean;
  /** When true, hides the internal toolbar (use LinkedReferencesToolbar externally) */
  hideToolbar?: boolean;
}

/**
 * State and callbacks for LinkedReferences toolbar
 * Extracted so toolbar can be rendered in NodeViewSection header
 */
export interface LinkedReferencesToolbarState {
  blocksViewMode: NodeCollectionViewMode;
  setBlocksViewMode: (mode: NodeCollectionViewMode) => void;
  groupBy: NodeCollectionGroupBy;
  setGroupBy: (value: NodeCollectionGroupBy) => void;
  hasBlocks: boolean;
}

/**
 * Hook to manage LinkedReferences view state
 * Use this when you need to render the toolbar externally
 */
export function useLinkedReferencesState(nodeId: number): LinkedReferencesToolbarState {
  const { data: refs } = useLinkedReferences(nodeId);
  const [blocksViewMode, setBlocksViewMode] = useState<NodeCollectionViewMode>('list');
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');
  
  return {
    blocksViewMode,
    setBlocksViewMode,
    groupBy,
    setGroupBy,
    hasBlocks: (refs?.length ?? 0) > 0,
  };
}

/**
 * Standalone toolbar for LinkedReferences
 * Render this in NodeViewSection headerActions when using hideToolbar=true
 */
export function LinkedReferencesToolbar({
  state,
  className = '',
}: {
  state: LinkedReferencesToolbarState;
  className?: string;
}) {
  if (!state.hasBlocks) {
    return null;
  }
  
  return (
    <NodeCollectionToolbar
      viewMode={state.blocksViewMode}
      availableViewModes={['list', 'card', 'table']}
      onViewModeChange={state.setBlocksViewMode}
      showGroupBy={true}
      groupBy={state.groupBy}
      onGroupByChange={state.setGroupBy}
      className={className}
    />
  );
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
 * When using external toolbar (hideToolbar=true), pass toolbarState to control
 * view mode and groupBy from the parent component.
 */
export function LinkedReferences({
  nodeId,
  className = '',
  onLinkClick,
  hideToolbar = false,
  toolbarState,
}: LinkedReferencesProps & {
  /** External state for toolbar control (required when hideToolbar=true) */
  toolbarState?: LinkedReferencesToolbarState;
}) {
  const { data: refs, isLoading: refsLoading } = useLinkedReferences(nodeId);
  const { data: propertyBacklinks, isLoading: propLoading } = usePropertyBacklinks(nodeId);
  const updateNode = useUpdateNode();

  // View mode state for each section (internal state when not using external toolbar)
  const [pagesViewMode, setPagesViewMode] = useState<NodeCollectionViewMode>('list');
  const [internalBlocksViewMode, setInternalBlocksViewMode] = useState<NodeCollectionViewMode>('list');
  const [internalGroupBy, setInternalGroupBy] = useState<NodeCollectionGroupBy>('page');

  // Use external state if provided, otherwise use internal state
  const blocksViewMode = toolbarState?.blocksViewMode ?? internalBlocksViewMode;
  const setBlocksViewMode = toolbarState?.setBlocksViewMode ?? setInternalBlocksViewMode;
  const groupBy = toolbarState?.groupBy ?? internalGroupBy;
  const setGroupBy = toolbarState?.setGroupBy ?? setInternalGroupBy;

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
      uuid: pb.source_page.uuid || '',
      name: pb.source_page.name || 'Untitled',
      icon: pb.source_page.icon || null,
      color: pb.source_page.color || null,
      is_page: true,
      parent_id: null,
      page_id: null,
      sequence: 0,
      active: true,
      create_date: pb.source_page.create_date || '',
      write_date: pb.source_page.write_date || '',
      types: pb.source_page.types || [],
      tags: pb.source_page.tags || [],
      collapsed: false,
      children: [],
    }));
  }, [propertyBacklinks]);

  // Convert linked references to block nodes for NodeCollection
  const blockNodes: Node[] = useMemo(() => {
    if (!refs) return [];
    return refs.map(ref => ({
      id: ref.source_node.id,
      uuid: ref.source_node.uuid || '',
      name: ref.source_node.name || 'Untitled',
      icon: ref.source_node.icon || null,
      color: ref.source_node.color || null,
      is_page: ref.source_node.is_page || false,
      parent_id: ref.source_node.parent_id ?? null,
      page_id: ref.source_page?.id ?? null,
      sequence: ref.source_node.sequence || 0,
      active: ref.source_node.active ?? true,
      create_date: ref.source_node.create_date || '',
      write_date: ref.source_node.write_date || '',
      types: ref.source_node.types || [],
      tags: ref.source_node.tags || [],
      collapsed: ref.source_node.collapsed || false,
      children: ref.source_node.children || [],
    }));
  }, [refs]);

  // Build pageMap from linked references for grouping
  const pageMap = useMemo(() => {
    if (!refs) return new Map<number, Node>();
    const map = new Map<number, Node>();
    for (const ref of refs) {
      if (ref.source_page && !map.has(ref.source_page.id)) {
        map.set(ref.source_page.id, {
          id: ref.source_page.id,
          uuid: ref.source_page.uuid || '',
          name: ref.source_page.name || 'Untitled',
          icon: ref.source_page.icon || null,
          color: ref.source_page.color || null,
          is_page: true,
          is_daily: ref.source_page.is_daily || false,
          is_monthly: ref.source_page.is_monthly || false,
          is_yearly: ref.source_page.is_yearly || false,
          parent_id: null,
          page_id: null,
          sequence: 0,
          active: true,
          create_date: ref.source_page.create_date || '',
          write_date: ref.source_page.write_date || '',
          collapsed: false,
        });
      }
    }
    return map;
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
        {/* Linked Pages */}
        {pageCount > 0 && (
          <NodeCollection
            nodes={pageNodes}
            viewMode={pagesViewMode}
            availableViewModes={['list', 'card', 'table']}
            onViewModeChange={setPagesViewMode}
            editable={false}
            onNodeClick={handleNodeClick}
            showEmpty={false}
            className="linked-references__collection"
            hideToolbar={hideToolbar}
          />
        )}

        {/* Linked Blocks */}
        {blockCount > 0 && (
          <NodeCollection
            nodes={blockNodes}
            viewMode={blocksViewMode}
            availableViewModes={['list', 'card', 'table']}
            onViewModeChange={setBlocksViewMode}
            editable={true}
            onNodeClick={handleNodeClick}
            onContentChange={handleContentChange}
            showEmpty={false}
            showGroupBy={true}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            pageMap={pageMap}
            className="linked-references__collection"
            isolatedBlockState={true}
            hideToolbar={hideToolbar}
          />
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
