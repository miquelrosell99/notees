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
  /** The block node ID stored as the text property value (null if empty) */
  blockNodeId: number | null;
  /** Whether the component is read-only */
  readOnly?: boolean;
  /** Callback when the block is shift-clicked */
  onOpenInSidebar?: (blockId: number) => void;
  /** Callback when property value changes */
  onPropertyChange: (propertyId: number, value: number | null) => void;
  /** Callback when bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
}

/**
 * TextPropertyBlock Component
 */
export function TextPropertyBlock({
  property,
  nodeId,
  blockNodeId,
  readOnly = false,
  onOpenInSidebar,
  onPropertyChange,
  onBulletClick,
}: TextPropertyBlockProps) {
  const [isCreating, setIsCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Fetch the block node if it exists (with children for nested blocks)
  const { data: blockNode, isLoading: blockLoading } = useNode(blockNodeId, {
    include_children: true,
  });
  
  const createNode = useCreateNode();
  const moveNode = useMoveNode();
  const { handleNodeClick } = useNodeNavigation();
  const { handleContentChange } = useContentSave();

  // Ensure blocks created via the Add Block button get persisted
  useBlockPersist();
  
  // Handle creating a new text block
  const handleAddText = useCallback(async () => {
    if (readOnly || isCreating) return;
    
    setIsCreating(true);
    try {
      // Create a new block node as child of the current node
      createNode.mutate({
        name: '',
        parent_id: nodeId,
      }, {
        onSuccess: (newBlock) => {
          // Set the property value to the new block's ID
          onPropertyChange(property.id, newBlock.id);
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
  }, [readOnly, isCreating, createNode, nodeId, property.id, onPropertyChange]);
  
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
      if (blockId === blockNodeId) return;
      
      // Move the block to be a child of this node
      moveNode.mutate({
        id: blockId,
        parentId: nodeId,
      });
      
      // Set this property to the dropped block
      onPropertyChange(property.id, blockId);
    } catch (error) {
      console.error('Failed to handle drop:', error);
    }
  }, [readOnly, blockNodeId, nodeId, property.id, moveNode, onPropertyChange]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly) return;
    
    if (e.dataTransfer.types.includes('application/x-notees-block')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }, [readOnly]);

  // Show loading state
  if (blockLoading && blockNodeId) {
    return (
      <div className="text-property-block text-property-block--loading">
        <span className="text-property-block__spinner">Loading...</span>
      </div>
    );
  }
  
  // Show empty state with "Add text" button
  if (!blockNodeId || !blockNode) {
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
  // NodeCollection → ListView → BlockEditor handles runtime sync, projection, and editing
  return (
    <div 
      ref={containerRef}
      className="text-property-block text-property-block--has-content"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
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
        />
      </div>
    </div>
  );
}

export default TextPropertyBlock;
