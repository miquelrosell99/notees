/**
 * NodeCard Component
 * 
 * Individual card component for displaying a node in card view.
 * Uses the Card core component and handles:
 * - Cover images
 * - Header with BlockPreview title
 * - Children via nested NodeCollection
 * - Context menu
 * - Selection checkbox
 * - Drag initiation from header
 */
import { useCallback, useMemo, useState } from 'react';
import type { Node } from '@/types';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { getNodeColorStylesAuto } from '@/utils/color';
import { BlockPreview } from '../../blocks/BlockPreview';
import { NodeCollection } from '../NodeCollection';
import { Card } from '../../core/Card';
import { Checkbox } from '../../core/Checkbox';
import { AddCoverButton } from '../../core/AddCoverButton';
import { AssetUploadModal } from '../../assets/AssetUploadModal';
import { PageContextMenu, BlockContextMenu } from '../NodeContextMenu';
import type { Asset } from '@/api/assets';

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

/**
 * Extract cover image from node content
 */
function extractCoverImage(node: Node): string | null {
  if (!node.name) return null;
  
  // Match markdown image: ![alt](uuid or url)
  const imageMatch = node.name.match(/!\[.*?\]\(([^)]+)\)/);
  if (imageMatch) {
    return imageMatch[1];
  }
  
  return null;
}

/**
 * Resolve cover URL
 */
function resolveCoverUrl(coverImage: string | null): string | null {
  if (!coverImage) return null;
  
  // If it's a UUID (no protocol), convert to asset URL
  if (!coverImage.includes('://') && !coverImage.startsWith('/')) {
    return `/api/assets/${coverImage}`;
  }
  
  return coverImage;
}

export function NodeCard({
  node,
  index,
  maxDepth,
  depth,
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
  const shouldRenderChildren = depth < maxDepth && children.length > 0;
  
  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  
  // Asset upload state for cover
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);
  
  // Get effective icon (from node or inherited from class)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);
  
  // Determine if we should show the bullet in the header
  // Show bullet only if there's an effective icon (from node or type)
  const showBullet = !!effectiveIcon;
  
  // Extract cover from content
  const coverImage = useMemo(() => extractCoverImage(node), [node]);
  const coverUrl = useMemo(() => resolveCoverUrl(coverImage), [coverImage]);
  
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

  const handleCoverUploaded = useCallback((_asset: Asset) => {
    setIsAssetUploadOpen(false);
    // The asset is uploaded and associated with the node
    // The image will appear in node.name as markdown ![](uuid)
  }, []);

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
          <div className="node-card__cover">
            {coverUrl ? (
              <img src={coverUrl} alt="" className="node-card__cover-image" />
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
          <BlockPreview
            variant="simple"
            node={node}
            showBullet={showBullet}
            showIcon={true}
            icon={effectiveIcon}
            onClick={() => onNodeClick?.(node)}
            onShiftClick={() => onNodeShiftClick?.(node)}
            className="node-card__title-block"
            suppressColor={true}
          />
        </div>
        
        {/* Card body with children */}
        {shouldRenderChildren && (
          <div className="node-card__body">
            <NodeCollection
              nodes={children}
              viewMode="list"
              availableViewModes={['list']}
              editable={editable}
              sortable={false}
              maxDepth={maxDepth - depth - 1}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContentChange={onContentChange}
              showEmpty={false}
              className="node-card__children"
            />
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
        parentId={node.id}
        acceptedTypes={['image']}
      />
    </>
  );
}
