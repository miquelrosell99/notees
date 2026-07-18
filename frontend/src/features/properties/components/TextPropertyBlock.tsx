/**
 * TextPropertyBlock - Component for text-type properties that behave as block nodes
 * 
 * Text properties are stored as node references (blocks), displayed using a
 * full block editor embedded in the property value section.
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
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { useNode, useCreateNode, useNodeNavigation } from '@/features/content';

import { useContentSave } from '@/features/editor';
import { isApiError } from '@/api/client';
import type { Property, Node } from '@/types/api';
import { NodeCollection } from '@/features/content';
import { Button } from '@/components/ui/Button';


interface TextPropertyBlockProps {
  /** The property definition */
  property: Property;
  /** The node ID that has this property */
  nodeUuid: string;
  /** The block node UUID stored as the text property value (null if empty) — for single mode */
  blockNodeId: string | null;
  /** Array of block node UUIDs — for multi mode */
  blockNodeIds?: string[];
  /** Whether the component is read-only */
  readOnly?: boolean;
  /** Callback when the block is shift-clicked */
  onOpenInSidebar?: (blockId: string) => void;
  /** Callback when property value changes (single mode) */
  onPropertyChange: (propertyId: string, value: string | string[] | null) => void;
  /** Callback when bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: string) => void;
}

/**
 * Single text block row - renders one block with its NodeCollection editor
 */
function SingleTextBlock({
  blockNodeId,
  readOnly,
  onOpenInSidebar,
  onOpenNode,
  onEnterAtRoot,
  onMissing,
}: {
  blockNodeId: string;
  readOnly: boolean;
  onOpenInSidebar?: (blockId: string) => void;
  onOpenNode?: (blockId: string) => void;
  onEnterAtRoot?: () => void;
  onMissing?: (blockId: string) => void;
}) {
  const { data: blockNode, isLoading, error } = useNode(blockNodeId, {
    include_children: true,
    meta: { skipGlobalError: true },
  });

  useEffect(() => {
    if (error && isApiError(error) && error.response?.status === 404) {
      onMissing?.(blockNodeId);
    }
  }, [error, blockNodeId, onMissing]);
  const { handleNodeClick } = useNodeNavigation();
  const { handleContentChange } = useContentSave();

  const handleNodeShiftClick = useCallback((clickedNode: Node) => {
    onOpenInSidebar?.(clickedNode.uuid);
  }, [onOpenInSidebar]);

  // Detach the property block from its owner before rendering it in its own
  // NodeCollection. If we kept the real parent_uuid, the runtime would treat
  // the block as a child of the owning page/block and the main block list
  // would resurrect it as a runtime-only row.
  const detachedBlockNode = useMemo<Node | null>(
    () => (blockNode ? { ...blockNode, parent_uuid: null } : null),
    [blockNode]
  );

  if (isLoading) {
    return (
      <div className="text-property-block text-property-block--loading">
        <Spinner size="sm" />
      </div>
    );
  }

  if (!detachedBlockNode) return null;

  return (
    <div className="text-property-block__editor">
      <div className="text-property-block__nav-actions hover-reveal">
        {onOpenInSidebar && (
          <Button aria-label="Open in sidebar"
            icon={"mdi mdi-dock-right"}
            variant="ghost"
            size="xs"
            title="Open in sidebar"
            onClick={(e) => {
              e.stopPropagation();
              onOpenInSidebar(blockNodeId);
            }}
          />
        )}
        {onOpenNode && (
          <Button aria-label="Open"
            icon={"mdi mdi-arrow-right"}
            variant="ghost"
            size="xs"
            title="Open"
            onClick={(e) => {
              e.stopPropagation();
              onOpenNode(blockNodeId);
            }}
          />
        )}
      </div>
      <NodeCollection
        nodes={[detachedBlockNode]}
        viewMode="list"
        availableViewModes={['list']}
        groupBy="none"
        editable={!readOnly}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        onContentChange={handleContentChange}
        pageId={detachedBlockNode.uuid}
        nodeUuid={detachedBlockNode.uuid}
        hideToolbar={true}
        showClasses={true}
        onEnterAtRoot={onEnterAtRoot}
        inPropertyEditor={true}
        showNewBlock={false}
        hideRootBullet={true}
      />
    </div>
  );
}

/**
 * TextPropertyBlock Component
 */
export function TextPropertyBlock({
      property,
      nodeUuid,
      blockNodeId,
      blockNodeIds,
      readOnly = false,
      onOpenInSidebar,
      onPropertyChange,
      onBulletClick: _onBulletClick }: TextPropertyBlockProps) {
  const [isCreating, setIsCreating] = useState(false);

  const isMulti = property.multi;
  const ids = useMemo(
    () => (isMulti ? (blockNodeIds ?? []) : (blockNodeId != null ? [blockNodeId] : [])),
    [isMulti, blockNodeIds, blockNodeId]
  );

  // For single mode, still fetch the node for legacy compatibility
  const { data: singleBlockNode, isLoading: blockLoading, error: singleBlockError } = useNode(
    !isMulti ? blockNodeId : null, 
    { include_children: true, meta: { skipGlobalError: true } }
  );

  // Auto-clear the property value when the referenced block has been deleted
  useEffect(() => {
    if (
      singleBlockError &&
      isApiError(singleBlockError) &&
      singleBlockError.response?.status === 404 &&
      blockNodeId != null &&
      !isMulti &&
      !readOnly
    ) {
      onPropertyChange(property.uuid, null);
    }
  }, [singleBlockError, blockNodeId, isMulti, readOnly, property.uuid, onPropertyChange]);
  
  const createNode = useCreateNode();
  const { handleNodeClick } = useNodeNavigation();
  
  // Handle creating a new text block
  const handleAddText = useCallback(async () => {
    if (readOnly || isCreating) return;
    
    setIsCreating(true);
    try {
      createNode.mutate({
        name: '',
        parent_uuid: nodeUuid,
      }, {
        onSuccess: (newBlock) => {
          if (isMulti) {
            // Multi: append new block ID to the array
            const newIds = [...ids, newBlock.uuid];
            onPropertyChange(property.uuid, newIds);
          } else {
            // Single: set the property value to the new block's ID
            onPropertyChange(property.uuid, newBlock.uuid);
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
  }, [readOnly, isCreating, createNode, nodeUuid, property.uuid, onPropertyChange, isMulti, ids]);
  
  // TODO: Drag-and-drop into text properties was wired through the legacy
  // DragCoordinator, which has been removed. Re-implement with @dnd-kit or
  // local drag state if this feature is still required.

  const dropZoneClass = '';

  // === Multi mode rendering ===
  if (isMulti) {
    if (ids.length === 0) {
      return (
        <div className={`text-property-block text-property-block--empty${dropZoneClass}`}>
          <Button
            className="text-property-block__add-btn"
            onClick={handleAddText}
            disabled={readOnly || isCreating}
            title="Add text"
            size="xs"
            variant="ghost"
          >
            {isCreating ? 'Creating…' : <span className="property-placeholder">Empty</span>}
          </Button>
        </div>
      );
    }

    return (
      <div className={`text-property-block text-property-block--has-content text-property-block--multi${dropZoneClass}`}>
        {ids.map((id) => (
          <SingleTextBlock
            key={id}
            blockNodeId={id}
            readOnly={readOnly}
            onOpenInSidebar={onOpenInSidebar}
            onOpenNode={(blockId) => handleNodeClick({ uuid: blockId } as unknown as Node)}
            onEnterAtRoot={handleAddText}
            onMissing={(missingId) => {
              if (!readOnly) {
                onPropertyChange(property.uuid, ids.filter((i) => i !== missingId));
              }
            }}
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
        <Spinner size="sm" />
      </div>
    );
  }
  
  // Show empty state with "Add text" button
  if (!blockNodeId || !singleBlockNode) {
    return (
      <div className={`text-property-block text-property-block--empty${dropZoneClass}`}>
        <Button
          className="text-property-block__add-btn"
          onClick={handleAddText}
          disabled={readOnly || isCreating}
          title="Add text"
          size="xs"
          variant="ghost"
        >
          {isCreating ? 'Creating…' : <span className="property-placeholder">Empty</span>}
        </Button>
      </div>
    );
  }
  
  // Show the block with a full inline editor (like FocusedBlockContent)
  return (
    <div className={`text-property-block text-property-block--has-content${dropZoneClass}`}>
      <SingleTextBlock
        blockNodeId={blockNodeId}
        readOnly={readOnly}
        onOpenInSidebar={onOpenInSidebar}
        onOpenNode={(blockId) => handleNodeClick({ uuid: blockId } as unknown as Node)}
      />
    </div>
  );
}

