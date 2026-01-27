/**
 * NodeCard Component
 * 
 * Individual card component for displaying a node in card view.
 * Uses the Card core component and handles:
 * - Cover images
 * - Header with editable Block title
 * - Navigation button (visible on hover)
 * - Children rendered recursively via Block components
 * - Top-level children start collapsed (temporary state, not persisted)
 * - Context menu
 * - Selection checkbox
 * - Drag initiation from header
 */
import { useCallback, useMemo, useState, useEffect } from 'react';
import type { Node } from '@/types';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { getNodeColorStylesAuto } from '@/utils/color';
import { Block } from '../../blocks/Block';
import { Button } from '../../core/Button';
import { mdiChevronRight, mdiPlus } from '@mdi/js';
import { Card } from '../../core/Card';
import { Checkbox } from '../../core/Checkbox';
import { AddCoverButton } from '../../core/AddCoverButton';
import { AssetActions } from '../../assets/AssetActions';
import { AssetUploadModal } from '../../assets/AssetUploadModal';
import { PageContextMenu, BlockContextMenu } from '../NodeContextMenu';
import type { Asset } from '@/api/assets';
import { useProperties, useSetNodeProperty, useNode, useCreateNode } from '@/hooks/useNodes';
import { useContentSave } from '@/hooks/useContentSave';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { getAssetUrl } from '@/api/assets';

export interface NodeCardProps {
  node: Node;
  index: number;
  maxDepth: number;
  depth: number;
  layout: 'no-cover' | 'cover-top' | 'cover-bottom' | 'cover-left' | 'cover-right';
  sortable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  editable?: boolean;
  allClasses?: Node[];
  isSelected?: boolean;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  onDragStart?: (index: number) => void;
  onSelectionChange?: (nodeId: number, selected: boolean) => void;
}

export function NodeCard({
  node,
  index,
  layout,
  sortable,
  isDragging,
  isDropTarget,
  editable = true,
  allClasses,
  isSelected = false,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onDragStart,
  onSelectionChange,
}: NodeCardProps) {
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  
  // Track temporary collapsed states (for system-initiated collapses)
  // Only applies to direct children - they start collapsed but this isn't persisted
  const [tempCollapsedChildren, setTempCollapsedChildren] = useState<Set<number>>(() => {
    // Initialize all direct children as collapsed (temporary)
    return new Set(children.map(child => child.id));
  });
  
  // Reset temporary collapsed state when node changes
  useEffect(() => {
    setTempCollapsedChildren(new Set(children.map(child => child.id)));
  }, [node.id]);
  
  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  
  // Cover hover state
  const [isCoverHovered, setIsCoverHovered] = useState(false);
  
  // Asset upload state for cover
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  
  // Get all properties to find cover property ID
  const { data: allProperties } = useProperties();
  const setNodeProperty = useSetNodeProperty();
  const queryClient = useQueryClient();
  const createNode = useCreateNode();
  
  // Content save hook for debounced saves
  const { handleContentChange } = useContentSave();
  
  // Find cover property
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);
  
  // Get cover image ID from properties
  const coverImageId = useMemo(() => {
    const coverValue = node?.properties?.cover;
    return typeof coverValue === 'number' ? coverValue : null;
  }, [node?.properties]);
  
  // Fetch the asset node to get its UUID for the image URL
  const { data: assetNode } = useNode(coverImageId, { include_children: false });
  
  // Get the image URL from the asset node's uuid
  const coverUrl = useMemo(() => {
    if (coverImageId && assetNode?.uuid) {
      return getAssetUrl(assetNode.uuid);
    }
    return null;
  }, [coverImageId, assetNode]);
  
  // Get effective icon (from node or inherited from class)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);
  
  // Determine if we should show the bullet in the header
  // Show bullet only if there's an effective icon (from node or type)
  const showBullet = !!effectiveIcon;
  
  // Use the layout as-is - the layout determines if cover should be shown
  // If no cover exists, the AddCoverButton will be shown in layouts that expect a cover
  const effectiveLayout = layout;
  
  // Handle click
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onNodeShiftClick) {
      e.preventDefault();
      onNodeShiftClick(node);
    } else if (onNodeClick) {
      onNodeClick(node);
    }
  }, [node, onNodeClick, onNodeShiftClick]);
  
  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);
  
  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPos(null);
  }, []);
  
  // Handle checkbox change
  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelectionChange?.(node.id, e.target.checked);
  }, [node.id, onSelectionChange]);
  
  // Stop checkbox click from triggering card click
  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  // Handle creating a new child block
  const handleAddChild = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Don't create if node has negative ID (optimistic)
    if (node.id < 0) {
      console.warn('Cannot create child under optimistic node');
      return;
    }
    
    // Create new child block at the end
    const maxSequence = children.length > 0 
      ? Math.max(...children.map(c => c.sequence))
      : -1;
    
    createNode.mutate({
      name: '',
      parent_id: node.id,
      sequence: maxSequence + 1,
    });
  }, [node.id, children, createNode]);
  
  const handleRemove = useCallback(() => {
    if (!coverProperty) return;
    setNodeProperty.mutate({
      nodeId: node.id,
      propertyId: coverProperty.id,
      value: null
    });
  }, [node.id, coverProperty, setNodeProperty]);
  
  const handleCoverUploaded = useCallback(async (asset: Asset) => {
    setIsAssetUploadOpen(false);
    
    // Set the asset as the cover property
    if (coverProperty) {
      try {
        await setNodeProperty.mutateAsync({
          nodeId: node.id,
          propertyId: coverProperty.id,
          value: asset.node_id,
        });
        
        // Invalidate node queries to refetch and show the cover
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
        
        // Also invalidate the parent page query so it refetches children with updated properties
        if (node.page_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.page_id) });
        }
      } catch (error) {
        console.error('Failed to set cover property:', error);
      }
    }
  }, [coverProperty, node.id, node.page_id, setNodeProperty, queryClient]);

  // Handle drag start from header
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start drag if clicking on the header itself (empty zone), not on interactive elements
    const target = e.target as HTMLElement;
    if (target.closest('.block-preview, a, button, input')) {
      return;
    }
    if (sortable) {
      e.preventDefault();
      onDragStart?.(index);
    }
  }, [index, sortable, onDragStart]);
  
  // Card style based on node color - uses gradient border + tint pattern (same as NodeView)
  const cardStyle = useMemo(() => {
    if (!node.color) return undefined;
    return getNodeColorStylesAuto(node.color);
  }, [node.color]);

  const cardClassName = [
    'node-card',
    `node-card--${effectiveLayout}`,
    node.color && 'node-card--colored',
    isDragging && 'node-card--dragging',
    isDropTarget && 'node-card--drop-target',
    isSelected && 'node-card--selected',
  ].filter(Boolean).join(' ');

  // Choose appropriate context menu based on node type
  const ContextMenuComponent = node.is_page ? PageContextMenu : BlockContextMenu;

  return (
    <>
      <Card 
        className={cardClassName}
        style={cardStyle}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        padding={false}
        elevation="none"
        variant="default"
      >
        {/* Selection checkbox - shown on hover */}
        {onSelectionChange && (
          <div className="node-card__checkbox" onClick={handleCheckboxClick}>
            <Checkbox
              size="sm"
              checked={isSelected}
              onChange={handleCheckboxChange}
              aria-label={`Select ${node.name || 'Untitled'}`}
            />
          </div>
        )}
        

        {/* Cover image or Add Cover button */}
        {effectiveLayout !== 'no-cover' && (
          <div 
            className="node-card__cover" 
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={() => setIsCoverHovered(true)}
            onMouseLeave={() => setIsCoverHovered(false)}
          >
            {coverUrl ? (
              <>
                <img src={coverUrl} alt="" className="node-card__cover-image" />
                {editable && (
                  <AssetActions
                    onEdit={() => setIsAssetUploadOpen(true)}
                    onRemove={handleRemove}
                    visible={isCoverHovered}
                    position="bottom-right"
                    compact
                  />
                )}
              </>
            ) : (
              <AddCoverButton onClick={() => setIsAssetUploadOpen(true)} size="sm" />
            )}
          </div>
        )}
        
        {/* Card header - similar to sidebar cards, also serves as drag zone */}
        <div 
          className={`node-card__header${sortable ? ' node-card__header--sortable' : ''}`}
          onMouseDown={handleHeaderMouseDown}
        >
          <div className="node-card__title-wrapper">
            <div className="node-card__title-block">
              <Block
                block={node}
                parentId={node.parent_id}
                showBullet={showBullet}
                showChildren={false}
                canMove={false}
                canSelect={false}
                canEdit={editable}
                suppressColor={true}
                onContentChange={handleContentChange}
              />
            </div>
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleAddChild}
                icon={mdiPlus}
                className="node-card__action-button"
                aria-label="Add child block"
              />
            )}
            {editable && onNodeClick && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onNodeClick(node);
                }}
                icon={mdiChevronRight}
                className="node-card__action-button"
                aria-label="Navigate to node"
              />
            )}
          </div>
        </div>
        
        {/* Card body with children - render all recursively */}
        {hasChildren && (
          <div className="node-card__body">
            <div className="node-card__children">
              {children.map((child) => {
                // Check if this child has a persisted collapsed state
                const hasPersistedCollapse = child.collapsed !== null && child.collapsed !== undefined;
                
                // Use persisted collapse if it exists, otherwise use temporary state
                const effectiveCollapsed = hasPersistedCollapse 
                  ? child.collapsed 
                  : tempCollapsedChildren.has(child.id);
                
                // Create a modified child node with the effective collapsed state
                const childWithCollapse = hasPersistedCollapse 
                  ? child 
                  : { ...child, collapsed: effectiveCollapsed };
                
                return (
                  <Block
                    key={child.id}
                    block={childWithCollapse}
                    children={child.children}
                    parentId={node.id}
                    depth={1}
                    canMove={false}
                    canSelect={false}
                    canEdit={editable}
                    showBullet={true}
                    showChildren={true}
                    onContentChange={onContentChange}
                    onBulletClick={onNodeClick ? () => onNodeClick(child) : undefined}
                    onShiftClick={onNodeShiftClick ? () => onNodeShiftClick(child) : undefined}
                  />
                );
              })}
            </div>
          </div>
        )}
      </Card>
      
      {/* Context menu */}
      {contextMenuPos && (
        <ContextMenuComponent
          node={node}
          position={contextMenuPos}
          onClose={handleCloseContextMenu}
        />
      )}
      
      {/* Asset Upload Modal for cover */}
      <AssetUploadModal
        isOpen={isAssetUploadOpen}
        onClose={() => setIsAssetUploadOpen(false)}
        onUpload={handleCoverUploaded}
        acceptedTypes={['image']}
      />
    </>
  );
}
