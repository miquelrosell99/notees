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
 * with a trailing ghost block to add more blocks.
 *
 * NOTE: The bullet for the main text block is rendered by PropertiesSection, not here.
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '@/components/ui/Spinner';
import { useNode, useNodeNavigation, useCoreBlockMutations } from '@/features/content';

import { useContentSave, flushAllContentSaves } from '@/features/editor';
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
 * Ghost placeholder for an empty text property.
 *
 * Reuses BlockRow ghost classes so the empty state looks like the trailing
 * ghost block in the normal block list view.
 */
function TextPropertyGhostBlock({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="text-property-block__ghost block-row--ghost">
      <button
        type="button"
        className="block-row__content-fallback block-row__content-fallback--ghost"
        onClick={onClick}
        disabled={disabled}
        aria-label={label ?? 'Add block'}
      >
        <span className="block-row__ghost-text">+ {label ?? 'Add block'}</span>
      </button>
    </div>
  );
}

/**
 * Single text block row - renders one block with its NodeCollection editor
 */
function SingleTextBlock({
  blockNodeId,
  readOnly,
  onOpenInSidebar,
  onOpenNode,
  onMissing,
}: {
  blockNodeId: string;
  readOnly: boolean;
  onOpenInSidebar?: (blockId: string) => void;
  onOpenNode?: (blockId: string) => void;
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

  if (isLoading) {
    return (
      <div className="text-property-block text-property-block--loading">
        <Spinner size="sm" />
      </div>
    );
  }

  if (!blockNode) return null;

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
        nodes={[blockNode]}
        viewMode="list"
        availableViewModes={['list']}
        groupBy="none"
        editable={!readOnly}
        onNodeClick={handleNodeClick}
        onNodeShiftClick={handleNodeShiftClick}
        onContentChange={handleContentChange}
        pageId={blockNode.uuid}
        nodeUuid={blockNode.uuid}
        hideToolbar={true}
        showClasses={true}
        inPropertyEditor={true}
        showNewBlock={true}
        hideRootBullet={true}
        rootIsBlock={true}
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
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const mutations = useCoreBlockMutations(workspaceId);

  const isMulti = property.multi;
  const ids = useMemo(
    () => (isMulti ? (blockNodeIds ?? []) : (blockNodeId != null ? [blockNodeId] : [])),
    [isMulti, blockNodeIds, blockNodeId]
  );

  const { openNode } = useNodeNavigation();

  // Open the text-property block in focused view, preserving the property
  // context so breadcrumbs show which property the block came from.
  const handleOpenNode = useCallback(async (blockId: string) => {
    await flushAllContentSaves().catch(() => {
      // Navigation proceeds even if the flush fails.
    });
    openNode(blockId, { propertyUuid: property.uuid, propertyName: property.name });
  }, [openNode, property.uuid, property.name]);

  // Create a new block to back the text property value. It is created as a
  // child of the owning node so the core store keeps it in the owner's child
  // order. The main block list then filters it out via filterTextPropertyBlocks
  // because the owner's properties_uuid references it under a text property.
  const handleAddText = useCallback(async () => {
    if (readOnly || isCreating || !workspaceId) return;

    setIsCreating(true);
    try {
      const newBlockId = await mutations.createBlock({
        parentId: nodeUuid,
        contentAST: [],
      });
      if (isMulti) {
        onPropertyChange(property.uuid, [...ids, newBlockId]);
      } else {
        onPropertyChange(property.uuid, newBlockId);
      }
    } catch (error) {
      console.error('Failed to create text block:', error);
    } finally {
      setIsCreating(false);
    }
  }, [readOnly, isCreating, workspaceId, mutations, nodeUuid, isMulti, ids, property.uuid, onPropertyChange]);

  // TODO: Drag-and-drop into text properties was wired through the legacy
  // DragCoordinator, which has been removed. Re-implement with @dnd-kit or
  // local drag state if this feature is still required.

  const dropZoneClass = '';

  const ghostLabel = isCreating ? 'Creating…' : 'Add text';

  // === Multi mode rendering ===
  if (isMulti) {
    if (ids.length === 0) {
      return (
        <div className={`text-property-block text-property-block--empty${dropZoneClass}`}>
          <TextPropertyGhostBlock
            onClick={handleAddText}
            disabled={readOnly || isCreating}
            label={ghostLabel}
          />
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
            onOpenNode={handleOpenNode}
            onMissing={(missingId) => {
              if (!readOnly) {
                onPropertyChange(property.uuid, ids.filter((i) => i !== missingId));
              }
            }}
          />
        ))}
        <TextPropertyGhostBlock
          onClick={handleAddText}
          disabled={readOnly || isCreating}
          label={ghostLabel}
        />
      </div>
    );
  }

  // === Single mode rendering ===

  // Show empty state with a ghost block
  if (!blockNodeId) {
    return (
      <div className={`text-property-block text-property-block--empty${dropZoneClass}`}>
        <TextPropertyGhostBlock
          onClick={handleAddText}
          disabled={readOnly || isCreating}
          label={ghostLabel}
        />
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
        onOpenNode={handleOpenNode}
        onMissing={() => {
          if (!readOnly) {
            onPropertyChange(property.uuid, null);
          }
        }}
      />
    </div>
  );
}
