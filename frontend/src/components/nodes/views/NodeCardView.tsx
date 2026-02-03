/**
 * NodeCardView Component
 * 
 * Card grid view for NodeCollection.
 * Displays nodes as cards in a responsive grid layout.
 * 
 * Features:
 * - Responsive grid layout
 * - Card with header section (Block-based title like sidebar)
 * - Optional cover images
 * - Children shown via nested NodeCollection in list view
 * - Editable: allows interaction and navigation
 * - Read-only: display-only cards
 * - Optional drag-and-drop reordering
 * - Context menu on right-click
 * - Selection checkbox on hover
 */
import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import type { Node } from '@/types';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { getNodeColorStylesAuto } from '@/utils/color';
import { Block } from '../../blocks/Block';
import { useClasses, useNodes, useTags, useProperties, useSetNodeProperty, useNode, useCreateNode } from '@/hooks';
import { useContentSave } from '@/hooks/useContentSave';
import { useNodesStore } from '@/stores';
import { Button } from '../../core/Button';
import { Card } from '../../core/Card';
import { Checkbox } from '../../core/Checkbox';
import { NodeClassPill } from '../../NodeClassPill';
import { ImageModal } from '../../core/ImageModal';
import { AddCoverButton } from '../../core/AddCoverButton';
import { FloatingButtonArray } from '../../core/FloatingButtonArray';
import { AssetUploadModal } from '../../assets/AssetUploadModal';
import { PageContextMenu, BlockContextMenu } from '../NodeContextMenu';
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS } from '@/constants';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { getAssetUrlAsync, uploadAsset } from '@/api/assets';
import type { Asset } from '@/api/assets';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { mdiPlus, mdiChevronRight, mdiChevronDown, mdiDockRight, mdiArrowRight, mdiPencil, mdiClose } from '@mdi/js';
import './NodeCardView.css';

// ==================== Internal NodeCard Component ====================

interface NodeCardProps {
  node: Node;
  index: number;
  maxDepth: number;
  depth: number;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
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
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
}

/**
 * CommonCardLayout - Shared layout component for horizontal and no-cover layouts
 * Uses CSS Grid with configurable cover position
 */
interface CommonCardLayoutProps {
  node: Node;
  effectiveIcon: string | null;
  showBullet: boolean;
  editable: boolean;
  classDetails: Node[];
  tagDetails: Node[];
  children: Node[];
  hasChildren: boolean;
  contentExpanded: boolean;
  setContentExpanded: (expanded: boolean) => void;
  sortable?: boolean;
  tempCollapsedChildren: Set<number>;
  isBottomHovered: boolean;
  setIsBottomHovered: (hovered: boolean) => void;
  handleContentChange: (nodeId: number, content: string) => void;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleOpenInSidebar: (e: React.MouseEvent) => void;
  handleOpenInView: (e: React.MouseEvent) => void;
  handleAddChild: (e: React.MouseEvent) => void;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  coverPosition?: 'left' | 'right' | 'top' | 'no';
  coverElement?: React.ReactNode;
}

function CommonCardLayout({
  node,
  effectiveIcon,
  showBullet,
  editable,
  classDetails,
  tagDetails,
  children,
  hasChildren,
  contentExpanded,
  setContentExpanded,
  sortable,
  tempCollapsedChildren,
  isBottomHovered,
  setIsBottomHovered,
  handleContentChange,
  handleHeaderMouseDown,
  handleOpenInSidebar,
  handleOpenInView,
  handleAddChild,
  onNodeClick,
  onNodeShiftClick,
  coverPosition = 'no',
  coverElement,
}: CommonCardLayoutProps) {
  return (
    <>
      {/* Cover image (optional - top, left, right, or none) */}
      {coverPosition !== 'no' && coverElement}
      
      {/* Row 1: Title */}
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
              showClasses={false}
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
              onClick={handleOpenInSidebar}
              icon={mdiDockRight}
              className="node-card__action-button node-card__action-button--always-visible"
              aria-label="Open in sidebar"
            />
          )}
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenInView}
              icon={mdiArrowRight}
              className="node-card__action-button node-card__action-button--always-visible"
              aria-label="Open node"
            />
          )}
        </div>
      </div>
      
      {/* Row 2: Classes */}
      <div className="node-card__metadata-row node-card__classes-row">
        {classDetails.map((cls) => (
          <NodeClassPill
            key={cls.id}
            classNode={cls}
            readOnly={true}
          />
        ))}
        {editable && (
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            className="node-card__add-metadata-btn"
            title="Add class"
          >
            {classDetails.length === 0 ? 'Add class' : ''}
          </Button>
        )}
      </div>
      
      {/* Row 3: Tags */}
      <div className="node-card__metadata-row node-card__tags-row">
        {tagDetails.map((tag) => (
          <NodeClassPill
            key={tag.id}
            classNode={tag}
            readOnly={true}
          />
        ))}
        {editable && (
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            className="node-card__add-metadata-btn"
            title="Add tag"
          >
            {tagDetails.length === 0 ? 'Add tag' : ''}
          </Button>
        )}
      </div>
      
      {/* Row 4: Children section - unified body with child blocks and add button */}
      <div className={`node-card__body ${!hasChildren ? 'node-card__body--empty' : ''}`}>
        {hasChildren && (
          <>
            <div 
              className="node-card__content-header"
              onClick={(e) => {
                e.stopPropagation();
                setContentExpanded(!contentExpanded);
              }}
            >
              <Button
                variant="ghost"
                size="xs"
                icon={contentExpanded ? mdiChevronDown : mdiChevronRight}
                className="node-card__content-toggle"
              >
                Content
              </Button>
            </div>
            {contentExpanded && (
              <div className="node-card__children">
                {children.map((child) => {
                  const hasPersistedCollapse = child.collapsed !== null && child.collapsed !== undefined;
                  const effectiveCollapsed = hasPersistedCollapse 
                    ? child.collapsed 
                    : tempCollapsedChildren.has(child.id);
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
                      onContentChange={handleContentChange}
                      onBulletClick={onNodeClick ? () => onNodeClick(child) : undefined}
                      onShiftClick={onNodeShiftClick ? () => onNodeShiftClick(child) : undefined}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
        {editable && (
          <div className="node-card__add-block">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleAddChild}
              icon={mdiPlus}
              className="node-card__add-block-button"
            >
              Add block
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * NodeCard - Internal component for individual cards
 * Not exported - only used within NodeCardView
 */
function NodeCard({
  node,
  index,
  layout,
  sortable,
  isDragging,
  isDropTarget,
  editable = true,
  allClasses: propsAllClasses,
  isSelected = false,
  onNodeClick,
  onNodeShiftClick,
  onDragStart,
  onSelectionChange,
  customContextMenu,
}: NodeCardProps) {
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  
  // Get all nodes for class/tag resolution
  const { data: allNodes } = useNodes();
  const { data: allClasses } = useClasses();
  const { data: allTags } = useTags();
  
  // Store actions for navigation
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Drag state for cover replacement
  const [isCoverDragging, setIsCoverDragging] = useState(false);
  
  // Resolve class details (excluding the implicit "page" class)
  const classDetails = useMemo(() => {
    if (!node?.classes) return [];
    const classIds = node.classes;
    return classIds
      .map((classId: number) => {
        const fromClasses = allClasses?.find(t => t.id === classId);
        if (fromClasses) return fromClasses;
        return allNodes?.find((n: Node) => n.id === classId);
      })
      .filter((t): t is Node => t !== undefined && t.uuid !== SYSTEM_CLASS_UUIDS.page);
  }, [node?.classes, allClasses, allNodes]);
  
  // Resolve tag details
  const tagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    return node.tags
      .map(tagId => {
        const fromTags = allTags?.find(t => t.id === tagId);
        if (fromTags) return fromTags;
        return allNodes?.find((n: Node) => n.id === tagId);
      })
      .filter((t): t is Node => {
        if (t === undefined) return false;
        if (t.is_class) return false;
        return true;
      });
  }, [node?.tags, allTags, allNodes]);
  
  // Get effective icon (from node or inherited from class)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, propsAllClasses), [node, propsAllClasses]);
  
  // Determine if we should show the bullet in the header
  const showBullet = !!effectiveIcon;
  
  // Use the layout as-is - the layout determines if cover should be shown
  const effectiveLayout = layout;
  
  const isHorizontalLayout = effectiveLayout === 'cover-left' || effectiveLayout === 'cover-right';
  const isGridLayout = true; // All layouts now use grid
  
  // Track temporary collapsed states (for system-initiated collapses)
  // Only applies to direct children - they start collapsed but this isn't persisted
  const [tempCollapsedChildren, setTempCollapsedChildren] = useState<Set<number>>(() => {
    return new Set(children.map(child => child.id));
  });
  
  // Reset temporary collapsed state when node changes
  useEffect(() => {
    setTempCollapsedChildren(new Set(children.map(child => child.id)));
  }, [node.id, children]);
  
  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  
  // Cover hover state
  const [isCoverHovered, setIsCoverHovered] = useState(false);
  
  // Cover image modal state
  const [isCoverModalOpen, setIsCoverModalOpen] = useState(false);
  
  // Asset upload state for cover
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  
  // Content section collapse state (collapsed by default)
  const [contentExpanded, setContentExpanded] = useState(false);
  
  // Bottom hover state for add button
  const [isBottomHovered, setIsBottomHovered] = useState(false);
  
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
  }, [node?.properties, node.id]);
  
  // Get the asset node for the cover image (for bullet)
  const { data: assetNode } = useNode(coverImageId, { include_children: false });
  
  // Bullet handlers for cover asset
  const handleCoverBulletClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (assetNode) {
      onNodeClick?.(assetNode);
    }
  }, [assetNode, onNodeClick]);
  
  const handleCoverBulletShiftClick = useCallback(() => {
    if (assetNode) {
      onNodeShiftClick?.(assetNode);
    }
  }, [assetNode, onNodeShiftClick]);
  
  // State for the cover URL (needs to be async to get token)
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  
  // Get the image URL from the asset node's uuid (async with token)
  useEffect(() => {
    // Reset if no cover
    if (!coverImageId || !assetNode?.uuid) {
      setCoverUrl(null);
      return;
    }
    
    let cancelled = false;
    
    getAssetUrlAsync(assetNode.uuid)
      .then(url => {
        if (!cancelled) {
          setCoverUrl(url);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error(`[NodeCard ${node.id}] Failed to load cover URL:`, err);
          setCoverUrl(null);
        }
      });
    
    return () => {
      cancelled = true;
    };
  }, [coverImageId, assetNode?.uuid, node.id]);
  
  
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
  
  // Handle opening node in main view
  const handleOpenInView = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openNode(node.id, node.is_page ? 'page' : 'block');
  }, [node.id, node.is_page, openNode]);
  
  // Handle opening node in sidebar
  const handleOpenInSidebar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    addSidebarCard(node.id, node.is_page ? 'page' : 'block');
  }, [node.id, node.is_page, addSidebarCard]);
  
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
        
        // Invalidate ALL view query results to refetch with updated properties
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
        
        // Also invalidate the parent page query so it refetches children with updated properties
        if (node.page_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.page_id) });
        }
        
        // Invalidate the parent node if this is a child (for hierarchical views)
        if (node.parent_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.parent_id) });
        }
      } catch (error) {
        console.error('Failed to set cover property:', error);
      }
    }
  }, [coverProperty, node.id, node.page_id, node.parent_id, setNodeProperty, queryClient]);
  
  const handleCoverDropped = useCallback(async (file: File | string) => {
    // Upload the file or fetch from URL
    try {
      let asset;
      if (typeof file === 'string') {
        // It's a URL - fetch it first
        const response = await fetch(file);
        const blob = await response.blob();
        const fileName = file.split('/').pop() || 'image.jpg';
        const fileObj = new File([blob], fileName, { type: blob.type });
        asset = await uploadAsset(fileObj);
      } else {
        // It's a File object
        asset = await uploadAsset(file);
      }
      await handleCoverUploaded(asset);
    } catch (error) {
      console.error('Failed to upload dropped cover:', error);
    }
  }, [handleCoverUploaded]);

  // Drag handlers for cover replacement
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
    
    if (!editable || !coverProperty) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        await handleCoverDropped(result.file);
      }
    } catch (error) {
      console.error('Failed to process dropped image:', error);
    }
  }, [editable, coverProperty, handleCoverDropped]);

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
  const ContextMenuComponent = customContextMenu ?? (node.is_page ? PageContextMenu : BlockContextMenu);

  // Cover element for grid layouts (reused for left/right/no-cover)
  const coverElement = effectiveLayout !== 'no-cover' && (
    <div 
      className={`node-card__cover ${isCoverDragging ? 'node-card__cover--dragging' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setIsCoverHovered(true)}
      onMouseLeave={() => setIsCoverHovered(false)}
      onDragOver={coverUrl ? handleDragOver : undefined}
      onDragLeave={coverUrl ? handleDragLeave : undefined}
      onDrop={coverUrl ? handleDrop : undefined}
    >
      {coverUrl ? (
        <>
          <img 
            key={coverUrl}
            src={coverUrl} 
            alt="" 
            className="node-card__cover-image"
            onClick={() => setIsCoverModalOpen(true)}
            style={{ cursor: 'pointer', pointerEvents: isCoverDragging ? 'none' : 'auto' }}
            title="Click to view full size"
            draggable="false"
          />
          {editable && isCoverHovered && (
            <FloatingButtonArray
              className="node-card__cover-actions"
              size="sm"
            >
              <Button
                icon={mdiPencil}
                iconOnly
                variant="ghost"
                size="sm"
                onClick={() => setIsAssetUploadOpen(true)}
                title="Change image"
              />
              <Button
                icon={mdiClose}
                iconOnly
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                title="Remove image"
              />
            </FloatingButtonArray>
          )}
        </>
      ) : (
        editable && <AddCoverButton onClick={() => setIsAssetUploadOpen(true)} onDrop={handleCoverDropped} size="sm" />
      )}
    </div>
  );

  return (
    <>
      <Card 
        className={cardClassName}
        style={cardStyle}
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
        
        {/* All layouts use CommonCardLayout with grid */}
        <CommonCardLayout
            node={node}
            effectiveIcon={effectiveIcon}
            showBullet={showBullet}
            editable={editable}
            classDetails={classDetails}
            tagDetails={tagDetails}
            children={children}
            hasChildren={hasChildren}
            contentExpanded={contentExpanded}
            setContentExpanded={setContentExpanded}
            sortable={sortable}
            tempCollapsedChildren={tempCollapsedChildren}
            isBottomHovered={isBottomHovered}
            setIsBottomHovered={setIsBottomHovered}
            handleContentChange={handleContentChange}
            handleHeaderMouseDown={handleHeaderMouseDown}
            handleOpenInSidebar={handleOpenInSidebar}
            handleOpenInView={handleOpenInView}
            handleAddChild={handleAddChild}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            coverPosition={
              effectiveLayout === 'no-cover' ? 'no' :
              effectiveLayout === 'cover-left' ? 'left' :
              effectiveLayout === 'cover-right' ? 'right' : 'top'
            }
            coverElement={coverElement}
          />
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
      
      {/* Cover Image Modal */}
      {coverUrl && (
        <ImageModal
          isOpen={isCoverModalOpen}
          onClose={() => setIsCoverModalOpen(false)}
          src={coverUrl}
          alt={assetNode?.name || 'Cover'}
          filename={assetNode?.name}
          assetNode={assetNode}
          onBulletClick={handleCoverBulletClick}
          onBulletShiftClick={handleCoverBulletShiftClick}
        />
      )}
    </>
  );
}

// ==================== NodeCardView ====================

/**
 * NodeCardView - Card grid view for NodeCollection
 */
export function NodeCardView({
  nodes,
  depth = 0,
  maxDepth = 2,
  layout = 'no-cover',
  columns,
  sortable,
  editable = true,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectionChange: controlledOnSelectionChange,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAdd,
  customContextMenu,
  className = '',
}: NodeCardViewProps) {
  // Get card size from store
  const cardSize = useNodesStore(state => state.cardSize);
  
  const gridStyle = columns 
    ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } 
    : undefined;
  
  // Fetch all classes for icon inheritance
  const { data: allClasses } = useClasses();
  
  // Internal selection state when selectable but not controlled
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());
  
  // Use controlled or internal selection (only when selectable)
  const selectedIds = selectable ? (controlledSelectedIds ?? internalSelectedIds) : undefined;
  const onSelectionChange = selectable ? (controlledOnSelectionChange ?? setInternalSelectedIds) : undefined;
  
  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Handle selection change for individual card
  const handleCardSelectionChange = useCallback((nodeId: number, selected: boolean) => {
    if (!onSelectionChange) return;
    const newSelectedIds = new Set(selectedIds || []);
    if (selected) {
      newSelectedIds.add(nodeId);
    } else {
      newSelectedIds.delete(nodeId);
    }
    onSelectionChange(newSelectedIds);
  }, [selectedIds, onSelectionChange]);
  
  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);
  
  // Handle mouse move during drag
  useEffect(() => {
    if (dragIndex === null || !sortable) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      
      const cards = containerRef.current.querySelectorAll('.node-card');
      let newDropTarget: number | null = null;
      
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        // Check if mouse is within the card bounds
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // Determine if dropping before or after based on position
          if (e.clientX < centerX || e.clientY < centerY) {
            newDropTarget = i;
          } else {
            newDropTarget = i;
          }
          break;
        }
      }
      
      setDropTargetIndex(newDropTarget);
    };
    
    const handleMouseUp = () => {
      if (dragIndex !== null && dropTargetIndex !== null && dragIndex !== dropTargetIndex) {
        onReorder?.(dragIndex, dropTargetIndex);
      }
      setDragIndex(null);
      setDropTargetIndex(null);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragIndex, dropTargetIndex, sortable, onReorder]);
  
  const gridClassName = [
    'node-card-view',
    sortable && 'node-card-view--sortable',
    selectable && 'node-card-view--selectable',
    layout === 'cover-top' && 'node-card-view--vertical-layout',
    `node-card-view--size-${cardSize}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={gridClassName} style={gridStyle} ref={containerRef}>
      {nodes.map((node, index) => (
        <NodeCard
          key={node.id}
          node={node}
          index={index}
          maxDepth={maxDepth}
          depth={depth}
          layout={layout}
          sortable={sortable}
          isDragging={dragIndex === index}
          isDropTarget={dropTargetIndex === index && dragIndex !== index}
          editable={editable}
          allClasses={allClasses}
          isSelected={selectable && selectedIds?.has(node.id)}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
          onDragStart={handleDragStart}
          onSelectionChange={selectable ? handleCardSelectionChange : undefined}
          customContextMenu={customContextMenu}
        />
      ))}
      {editable && onAdd && (
        <Card 
          className="node-card-add"
          padding={false}
          elevation="none"
          variant="default"
          onClick={onAdd}
        >
          <div className="node-card-add__content">
            <Button
              variant="ghost"
              size="lg"
              icon={mdiPlus}
              className="node-card-add__button"
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              Add card
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
