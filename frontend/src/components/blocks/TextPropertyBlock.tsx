/**
 * TextPropertyBlock - Component for text-type properties that behave as block nodes
 * 
 * Text properties are stored as node references (blocks), displayed using a
 * full Lexical BlockEditor embedded in the property value section.
 * 
 * The text property block acts as a miniature "focused block view":
 * - Shows a parent block (the text property value) with its own content
 * - Allows child blocks to be created inside it (nested editing)
 * - Uses NodeCollection → ListView → BlockEditor for consistent UX
 * - Supports drag & drop, shift-click sidebar, and all editor features
 * 
 * Supports multi-value text properties: renders one row per block node,
 * with an "Add text" button at the end to add more blocks.
 * 
 * NOTE: The bullet for the main text block is rendered by PropertiesSection, not here.
 */
import { useState, useCallback, useRef } from 'react';
import { 
  useNode, 
  useCreateNode, 
  useMoveNode,
  useContentSave,
  useNodeNavigation,
} from '@/hooks';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { mdiPlus } from '@mdi/js';
import type { Property } from '@/types/api';
import type { Node } from '@/types/api';
import { NodeCollection } from '../nodes/NodeCollection';
import { Button } from '../core/Button';

interface TextPropertyBlockProps {
  /** The property definition */
  property: Property;
  /** The node ID that has this property */
  nodeId: number;
  /** The block node ID stored as the text property value (null if empty) — for single mode */
  blockNodeId: number | null;
  /** Array of block node IDs — for multi mode */
  blockNodeIds?: number[];
  /** Whether the component is read-only */
  readOnly?: boolean;
  /** Callback when the block is shift-clicked */
  onOpenInSidebar?: (blockId: number) => void;
  /** Callback when property value changes (single mode) */
  onPropertyChange: (propertyId: number, value: number | number[] | null) => void;
  /** Callback when bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
}

/**
 * Single text block row - renders one block with its NodeCollection editor
 */
function SingleTextBlock({
  blockNodeId,
  readOnly,
  onOpenInSidebar,
  onEnterAtRoot,
}: {
  blockNodeId: number;
  readOnly: boolean;
  onOpenInSidebar?: (blockId: number) => void;
  onEnterAtRoot?: () => void;
}) {
  const { data: blockNode, isLoading } = useNode(blockNodeId, {
    include_children: true,
  });
  const { handleNodeClick } = useNodeNavigation();
  const { handleContentChange } = useContentSave();
  useBlockPersist();

  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onOpenInSidebar?.(clickedNode.id);
  }, [onOpenInSidebar]);

  if (isLoading) {
    return (
      <div className="text-property-block text-property-block--loading">
        <span className="text-property-block__spinner">Loading...</span>
      </div>
    );
  }

  if (!blockNode) return null;

  return (
    <div className="text-property-block__editor">
      <NodeCollection
        nodes={[blockNode]}
        viewMode="list"
        availableViewModes={['list']}
        editable={!readOnly}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        onContentChange={handleContentChange}
        pageId={blockNode.id}
        pageUuid={blockNode.uuid}
        hideToolbar={true}
        onEnterAtRoot={onEnterAtRoot}
      />
    </div>
  );
}

/**
 * TextPropertyBlock Component
 */
export function TextPropertyBlock({
  property,
  nodeId,
  blockNodeId,
  blockNodeIds,
  readOnly = false,
  onOpenInSidebar,
  onPropertyChange,
  onBulletClick,
}: TextPropertyBlockProps) {
  const [isCreating, setIsCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const isMulti = property.multi;
  const ids = isMulti ? (blockNodeIds ?? []) : (blockNodeId != null ? [blockNodeId] : []);
  
  // For single mode, still fetch the node for legacy compatibility
  const { data: singleBlockNode, isLoading: blockLoading } = useNode(
    !isMulti ? blockNodeId : null, 
    { include_children: true }
  );
  
  const createNode = useCreateNode();
  const moveNode = useMoveNode();
  const { handleNodeClick } = useNodeNavigation();
  const { handleContentChange } = useContentSave();

  useBlockPersist();
  
  // Handle creating a new text block
  const handleAddText = useCallback(async () => {
    if (readOnly || isCreating) return;
    
    setIsCreating(true);
    try {
      createNode.mutate({
        name: '',
        parent_id: nodeId,
      }, {
        onSuccess: (newBlock) => {
          if (isMulti) {
            // Multi: append new block ID to the array
            const newIds = [...ids, newBlock.id];
            onPropertyChange(property.id, newIds);
          } else {
            // Single: set the property value to the new block's ID
            onPropertyChange(property.id, newBlock.id);
          }
          setIsCreating(false);
        },
        onError: () => {
          setIsCreating(false);
        }
      });
    } catch (error) {
      console.error('Failed to create text block:', error);
      setIsCreating(false);
    }
  }, [readOnly, isCreating, createNode, nodeId, property.id, onPropertyChange, isMulti, ids]);
  
  // Handle shift-click to open in sidebar
  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onOpenInSidebar?.(clickedNode.id);
  }, [onOpenInSidebar]);
  
  // Handle drop on this property (to receive a block)
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (readOnly) return;
    
    const data = e.dataTransfer.getData('application/x-notees-block');
    if (!data) return;
    
    try {
      const { blockId } = JSON.parse(data);
      
      // Don't allow dropping on self
      if (ids.includes(blockId)) return;
      
      // Move the block to be a child of this node
      moveNode.mutate({
        id: blockId,
        parentId: nodeId,
      });
      
      if (isMulti) {
        // Multi: append dropped block to the array
        const newIds = [...ids, blockId];
        onPropertyChange(property.id, newIds);
      } else {
        // Single: set this property to the dropped block
        onPropertyChange(property.id, blockId);
      }
    } catch (error) {
      console.error('Failed to handle drop:', error);
    }
  }, [readOnly, ids, nodeId, property.id, moveNode, onPropertyChange, isMulti]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly) return;
    
    if (e.dataTransfer.types.includes('application/x-notees-block')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, [readOnly]);

  // === Multi mode rendering ===
  if (isMulti) {
    if (ids.length === 0) {
      return (
        <div 
          className="text-property-block text-property-block--empty"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <Button
            icon={mdiPlus}
            className="text-property-block__add-btn"
            onClick={handleAddText}
            disabled={readOnly || isCreating}
            title="Add text"
            size="xs"
            variant="ghost"
          >
            {isCreating ? 'Creating...' : 'Add text'}
          </Button>
        </div>
      );
    }

    return (
      <div 
        ref={containerRef}
        className="text-property-block text-property-block--has-content text-property-block--multi"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {ids.map((id) => (
          <SingleTextBlock
            key={id}
            blockNodeId={id}
            readOnly={readOnly}
            onOpenInSidebar={onOpenInSidebar}
            onEnterAtRoot={handleAddText}
          />
        ))}
      </div>
    );
  }

  // === Single mode rendering (legacy) ===

  // Show loading state
  if (blockLoading && blockNodeId) {
    return (
      <div className="text-property-block text-property-block--loading">
        <span className="text-property-block__spinner">Loading...</span>
      </div>
    );
  }
  
  // Show empty state with "Add text" button
  if (!blockNodeId || !singleBlockNode) {
    return (
      <div 
        className="text-property-block text-property-block--empty"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <Button
          icon={mdiPlus}
          className="text-property-block__add-btn"
          onClick={handleAddText}
          disabled={readOnly || isCreating}
          title="Add text"
          size="xs"
          variant="ghost"
        >
          {isCreating ? 'Creating...' : 'Add text'}
        </Button>
      </div>
    );
  }
  
  // Show the block with a full Lexical-based editor (like FocusedBlockContent)
  return (
    <div 
      ref={containerRef}
      className="text-property-block text-property-block--has-content"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="text-property-block__editor">
        <NodeCollection
          nodes={[singleBlockNode]}
          viewMode="list"
          availableViewModes={['list']}
          editable={!readOnly}
          onNodeClick={handleNodeClick}
          onNodeShiftClick={handleNodeShiftClick}
          onContentChange={handleContentChange}
          pageId={singleBlockNode.id}
          pageUuid={singleBlockNode.uuid}
          hideToolbar={true}
        />
      </div>
    </div>
  );
}

export default TextPropertyBlock;
