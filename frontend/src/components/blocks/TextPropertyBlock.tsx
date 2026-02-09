/**
 * TextPropertyBlock - Component for text-type properties that behave as block nodes
 * 
 * Text properties are stored as node references (blocks), displayed using the bullet component.
 * - Single block with child block support
 * - Normal block editor functionality
 * - Draggable to other locations (clears property on drag)
 * - Shift-click opens in sidebar
 * - Empty state shows "+ Add text" button
 * 
 * NOTE: The bullet for the main text block is rendered by PropertiesSection, not here.
 * This component only renders the content and any child blocks (which do have bullets).
 */
import { useState, useCallback, useRef } from 'react';
import { 
  useNode, 
  useCreateNode, 
  useUpdateNode, 
  useMoveNode 
} from '@/hooks';
import { mdiPlus } from '@mdi/js';
import type { Property } from '@/types/api';
import { ASTBlockEditor as BlockEditor } from './ASTBlockEditor';
import { Block } from './Block';
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
  
  // Fetch the block node if it exists
  const { data: blockNode, isLoading: blockLoading } = useNode(blockNodeId, {
    include_children: true,
  });
  
  const createNode = useCreateNode();
  const updateNode = useUpdateNode();
  const moveNode = useMoveNode();
  
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
  
  // Handle content change
  const handleContentChange = useCallback((content: string) => {
    if (!blockNodeId || readOnly) return;
    
    updateNode.mutate({
      id: blockNodeId,
      data: { name: content },
    });
  }, [blockNodeId, readOnly, updateNode]);
  
  // Handle shift-click to open in sidebar
  const handleShiftClick = useCallback((blockId: number) => {
    onOpenInSidebar?.(blockId);
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
  // Note: No bullet here - the bullet is rendered by PropertiesSection
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
  
  // Check if block has children
  const hasChildren = blockNode.children && blockNode.children.length > 0;
  
  // Handle child block content change
  const handleChildContentChange = useCallback((childId: number, content: string) => {
    updateNode.mutate({ 
      id: childId, 
      data: { name: content } 
    });
  }, [updateNode]);
  
  // Handle child bullet click (open focused view)
  const handleChildBulletClick = useCallback((childId: number) => {
    onBulletClick?.(childId);
  }, [onBulletClick]);
  
  // Show the block editor (no bullet - it's rendered by PropertiesSection)
  return (
    <div 
      ref={containerRef}
      className="text-property-block"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Main block content - no bullet here */}
      <div className="text-property-block__row">
        <div className="text-property-block__content">
          <BlockEditor
            nodeId={blockNode.id}
            content={blockNode.name || ''}
            onChange={handleContentChange}
            readOnly={readOnly}
          />
        </div>
      </div>
      
      {/* Show child blocks with full Block component (with bullets) */}
      {hasChildren && (
        <div className="text-property-block__children">
          {blockNode.children!.map((child) => (
            <Block
              key={child.id}
              block={child}
              children={child.children}
              siblings={blockNode.children}
              parentId={blockNode.id}
              parentBlock={blockNode}
              onContentChange={handleChildContentChange}
              onBulletClick={handleChildBulletClick}
              onShiftClick={handleShiftClick}
              canEdit={!readOnly}
              canMove={!readOnly}
              canSelect={false}
              backlinkCount={child.backlink_count}
              onOpenBacklinks={() => handleShiftClick?.(child.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default TextPropertyBlock;
