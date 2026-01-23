/**
 * TypedNodesSection - Shows nodes that have a specific type assigned
 * and allows creating new nodes with that type
 * 
 * Renders just the content - NodeViewSection wrapping is done by NodeView.
 * 
 * The toolbar can be rendered externally via TypedNodesSectionToolbar component
 * for placement in NodeViewSection headers.
 */
import { useState, useMemo, useCallback } from 'react';
import { useQueries } from '@tanstack/react-query';
import './TypedNodesSection.css';
import { useNodesWithType, useCreateNode, useAddType } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection, NodeCollectionToolbar } from './nodes/NodeCollection';
import { Button } from './core/Button';

// Types that can only be applied to pages, not blocks
const PAGE_ONLY_TYPES = ['type', 'day', 'month', 'year'];

/**
 * State and callbacks for TypedNodesSection toolbar
 * Extracted so toolbar can be rendered in NodeViewSection header
 */
export interface TypedNodesSectionToolbarState {
  viewMode: NodeCollectionViewMode;
  setViewMode: (mode: NodeCollectionViewMode) => void;
  groupBy: NodeCollectionGroupBy;
  setGroupBy: (value: NodeCollectionGroupBy) => void;
  isCreating: boolean;
  setIsCreating: (value: boolean) => void;
  hasItems: boolean;
}

/**
 * Hook to manage TypedNodesSection view state
 * Use this when you need to render the toolbar externally
 */
export function useTypedNodesSectionState(typeId: number): TypedNodesSectionToolbarState {
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');
  const [isCreating, setIsCreating] = useState(false);
  const { data: nodes } = useNodesWithType(typeId);
  
  return {
    viewMode,
    setViewMode,
    groupBy,
    setGroupBy,
    isCreating,
    setIsCreating,
    hasItems: (nodes?.length ?? 0) > 0,
  };
}

/**
 * Standalone toolbar for TypedNodesSection
 * Render this in NodeViewSection headerActions when using hideToolbar=true
 */
export function TypedNodesSectionToolbar({
  state,
  className = '',
}: {
  state: TypedNodesSectionToolbarState;
  className?: string;
}) {
  return (
    <NodeCollectionToolbar
      viewMode={state.viewMode}
      availableViewModes={['list', 'table', 'card']}
      onViewModeChange={state.setViewMode}
      showGroupBy={true}
      groupBy={state.groupBy}
      onGroupByChange={state.setGroupBy}
      showAddButton={true}
      onAdd={() => state.setIsCreating(true)}
      className={className}
    />
  );
}

interface TypedNodesViewProps {
  typeId: number;
  typeName?: string;
  /** When true, hides the internal toolbar (use TypedNodesSectionToolbar externally) */
  hideToolbar?: boolean;
  /** External state for toolbar control (required when hideToolbar=true) */
  toolbarState?: TypedNodesSectionToolbarState;
}

export function TypedNodesView({ typeId, typeName, hideToolbar = false, toolbarState }: TypedNodesViewProps) {
  // Internal creating state when not using external toolbar
  const [internalIsCreating, setInternalIsCreating] = useState(false);
  const [newNodeName, setNewNodeName] = useState('');
  
  const { data: nodes = [], isLoading, error } = useNodesWithType(typeId);
  
  const createNode = useCreateNode();
  const addType = useAddType();
  const { openNode, addSidebarCard } = useNodesStore();

  // Check if this type is page-only
  const isPageOnlyType = useMemo(() => {
    if (!typeName) return false;
    return PAGE_ONLY_TYPES.includes(typeName.toLowerCase());
  }, [typeName]);

  // Find page IDs that are needed for grouping but aren't in the nodes list
  const missingPageIds = useMemo(() => {
    const pageIdsInNodes = new Set(nodes.filter(n => n.is_page).map(n => n.id));
    const neededPageIds = new Set<number>();
    for (const node of nodes) {
      if (!node.is_page && node.page_id && !pageIdsInNodes.has(node.page_id)) {
        neededPageIds.add(node.page_id);
      }
    }
    return Array.from(neededPageIds);
  }, [nodes]);

  // Fetch missing pages for grouping
  const missingPagesQueries = useQueries({
    queries: missingPageIds.map(pageId => ({
      queryKey: ['nodes', 'metadata', pageId],
      queryFn: () => import('@/api/nodes').then(m => m.getNode(pageId)),
      staleTime: 1000 * 60 * 10, // 10 minutes
    })),
  });

  // Build pageMap from nodes that are pages AND from fetched missing pages
  const pageMap = useMemo(() => {
    const map = new Map<number, Node>();
    // Add pages from the typed nodes themselves
    for (const node of nodes) {
      if (node.is_page) {
        map.set(node.id, node);
      }
    }
    // Add fetched missing pages
    for (const query of missingPagesQueries) {
      if (query.data) {
        map.set(query.data.id, query.data);
      }
    }
    return map;
  }, [nodes, missingPagesQueries]);

  // View mode state for NodeCollection (internal state when not using external toolbar)
  const [internalViewMode, setInternalViewMode] = useState<NodeCollectionViewMode>('list');
  const [internalGroupBy, setInternalGroupBy] = useState<NodeCollectionGroupBy>('page');
  
  // Use external state if provided, otherwise use internal
  const viewMode = toolbarState?.viewMode ?? internalViewMode;
  const setViewMode = toolbarState?.setViewMode ?? setInternalViewMode;
  const groupBy = toolbarState?.groupBy ?? internalGroupBy;
  const setGroupBy = toolbarState?.setGroupBy ?? setInternalGroupBy;
  const isCreating = toolbarState?.isCreating ?? internalIsCreating;
  const setIsCreating = toolbarState?.setIsCreating ?? setInternalIsCreating;

  const handleNodeClick = useCallback((node: Node) => {
    openNode(node.id, node.is_page ? 'page' : 'block');
  }, [openNode]);

  const handleNodeShiftClick = useCallback((node: Node) => {
    addSidebarCard(node.id, node.is_page ? 'page' : 'block');
  }, [addSidebarCard]);

  const handleCreateNode = async () => {
    if (!newNodeName.trim()) return;
    
    try {
      if (isPageOnlyType) {
        // Create a new page and add the type
        const newPage = await createNode.mutateAsync({ name: newNodeName.trim(), is_page: true });
        await addType.mutateAsync({ nodeId: newPage.id, typeId });
        openNode(newPage.id, 'page');
      } else {
        // Create a new node as a child of the type page
        const newNode = await createNode.mutateAsync({ 
          name: newNodeName.trim(),
          parent_id: typeId,  // Create as child of the type page
        });
        
        // Add the type to the new node
        await addType.mutateAsync({ nodeId: newNode.id, typeId });
        
        // Open in sidebar for editing
        addSidebarCard(newNode.id, 'block');
      }
      
      // Reset form
      setNewNodeName('');
      setIsCreating(false);
    } catch (err) {
      console.error('Failed to create typed node:', err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreateNode();
    } else if (e.key === 'Escape') {
      setNewNodeName('');
      setIsCreating(false);
    }
  };

  const count = nodes.length;

  if (isLoading) {
    return <div className="typed-nodes-loading">Loading...</div>;
  }

  if (error) {
    return <div className="typed-nodes-error">Failed to load nodes</div>;
  }

  return (
    <div className="typed-nodes-view">
      {isCreating && (
        <div className="typed-node-create-form">
          <input
            type="text"
            value={newNodeName}
            onChange={(e) => setNewNodeName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`New ${typeName || (isPageOnlyType ? 'page' : 'node')} name...`}
            autoFocus
            className="typed-node-name-input"
          />
          <div className="typed-node-create-actions">
            <Button 
              variant="primary"
              size="sm"
              onClick={handleCreateNode}
              disabled={!newNodeName.trim() || createNode.isPending}
            >
              Create
            </Button>
            <Button 
              variant="ghost"
              size="sm"
              onClick={() => { setNewNodeName(''); setIsCreating(false); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {count === 0 && !isCreating ? (
        <div className="typed-nodes-empty">
          <p>No nodes with this type yet</p>
          <Button 
            icon={mdiPlus}
            variant="ghost"
            size="sm"
            onClick={() => setIsCreating(true)}
            title={`Create first ${typeName || 'node'}`}
          >
            Create first {typeName || 'node'}
          </Button>
        </div>
      ) : (
        <NodeCollection
          nodes={nodes}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          availableViewModes={['list', 'table', 'card']}
          sortable={false}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          showGroupBy={!hideToolbar}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          pageMap={pageMap}
          showAddButton={!hideToolbar}
          onAdd={() => setIsCreating(true)}
          hideToolbar={hideToolbar}
        />
      )}
    </div>
  );
}
