/**
 * TypedNodesSection - Shows nodes that have a specific type assigned
 * and allows creating new nodes with that type
 * 
 * Renders just the content - NodeViewSection wrapping is done by NodeView.
 */
import { useState, useMemo, useCallback } from 'react';
import './TypedNodesSection.css';
import { useNodesWithType, useCreateNode, useAddType } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import { mdiPlus } from '@mdi/js';
import { NodeCollection } from './nodes/NodeCollection';
import { Button } from './core/Button';

// Types that can only be applied to pages, not blocks
const PAGE_ONLY_TYPES = ['type', 'day', 'month', 'year'];

interface TypedNodesViewProps {
  typeId: number;
  typeName?: string;
}

export function TypedNodesView({ typeId, typeName }: TypedNodesViewProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newNodeName, setNewNodeName] = useState('');
  
  const { data: nodes, isLoading, error } = useNodesWithType(typeId);
  const createNode = useCreateNode();
  const addType = useAddType();
  const { openNode, addSidebarCard } = useNodesStore();

  // Check if this type is page-only
  const isPageOnlyType = useMemo(() => {
    if (!typeName) return false;
    return PAGE_ONLY_TYPES.includes(typeName.toLowerCase());
  }, [typeName]);

  // Build pageMap from nodes that are pages (for grouping blocks by their parent page)
  const pageMap = useMemo(() => {
    if (!nodes) return new Map<number, Node>();
    const map = new Map<number, Node>();
    for (const node of nodes) {
      if (node.is_page) {
        map.set(node.id, node);
      }
    }
    return map;
  }, [nodes]);

  // View mode state for NodeCollection
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');

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

  const count = nodes?.length ?? 0;

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
          nodes={nodes ?? []}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          availableViewModes={['list', 'table', 'card']}
          sortable={false}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          showGroupBy={true}
          pageMap={pageMap}
        />
      )}
    </div>
  );
}

export default TypedNodesView;
