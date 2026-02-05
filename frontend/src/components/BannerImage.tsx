/**
 * BannerImage Component
 * 
 * Displays a full-width banner image at the top of a page header.
 * Uses the 'Banner' system property to store the asset node reference.
 * 
 * The banner replaces the old cover behavior - appearing as a full-width
 * header background above the page title.
 * 
 * Features:
 * - Collapsible: Can be collapsed to just an arrow strip to reclaim header space
 * - State persistence: Collapsed state is remembered per node
 * - Smooth vertical animations between collapsed/expanded states
 * - Collapsed by default when empty
 * 
 * Supports:
 * - Displaying existing banner image
 * - Removing banner image
 * - Changing banner image (opens asset selector)
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useProperties, useSetNodeProperty } from '@/hooks';
import { uploadAsset, type Asset } from '@/api/assets';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { Button } from './core/Button';
import { ImageNode } from './ImageNode';
import { mdiImageOutline, mdiChevronDown, mdiPencil, mdiClose } from '@mdi/js';
import Icon from '@mdi/react';
import './BannerImage.css';

// Local storage key for collapsed state
const BANNER_COLLAPSED_KEY = 'notees:banner-collapsed';

/**
 * Get collapsed state for a specific node from localStorage
 * Returns true (collapsed) by default if no state is stored
 */
function getCollapsedState(pageId: number, hasImage: boolean): boolean {
  try {
    const stored = localStorage.getItem(BANNER_COLLAPSED_KEY);
    if (stored) {
      const states = JSON.parse(stored) as Record<string, boolean>;
      const storedState = states[pageId.toString()];
      if (storedState !== undefined) {
        return storedState;
      }
    }
  } catch {
    // Ignore parse errors
  }
  // Default: collapsed when empty, expanded when has image
  return !hasImage;
}

/**
 * Save collapsed state for a specific node to localStorage
 */
function setCollapsedState(pageId: number, collapsed: boolean): void {
  try {
    const stored = localStorage.getItem(BANNER_COLLAPSED_KEY);
    const states = stored ? JSON.parse(stored) as Record<string, boolean> : {};
    states[pageId.toString()] = collapsed;
    localStorage.setItem(BANNER_COLLAPSED_KEY, JSON.stringify(states));
  } catch {
    // Ignore storage errors
  }
}

interface BannerImageProps {
  /** Page node ID */
  pageId: number;
  /** Banner image asset node ID (from properties.banner) */
  bannerImageId: number | null;
  /** Callback to open asset picker */
  onSelectImage?: () => void;
  /** Callback when image uploaded (for handling after drag-drop) */
  onImageUploaded?: (asset: Asset) => void;
  /** Whether banner can be edited */
  editable?: boolean;
  /** Height variant */
  height?: 'small' | 'medium' | 'large';
}

export function BannerImage({ 
  pageId, 
  bannerImageId, 
  onSelectImage,
  onImageUploaded,
  editable = true,
  height = 'medium'
}: BannerImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => getCollapsedState(pageId, !!bannerImageId));
  const [isDragging, setIsDragging] = useState(false);
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  
  // Persist collapsed state when it changes
  useEffect(() => {
    setCollapsedState(pageId, isCollapsed);
  }, [pageId, isCollapsed]);
  
  // Reset collapsed state when pageId changes (navigating to a different page)
  useEffect(() => {
    setIsCollapsed(getCollapsedState(pageId, !!bannerImageId));
  }, [pageId, bannerImageId]);
  
  // Find the banner property by UUID
  const bannerProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.banner);
  }, [allProperties]);
  
  const handleRemove = useCallback(() => {
    if (!bannerProperty) return;
    setPropertyMutation.mutate({
      nodeId: pageId,
      propertyId: bannerProperty.id,
      value: null
    });
  }, [pageId, bannerProperty, setPropertyMutation]);
  
  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);
  
  // Handle keyboard navigation for collapse toggle
  const handleCollapseKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggleCollapse();
    }
  }, [handleToggleCollapse]);
  
  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, [editable]);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);
  
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (!editable || !bannerProperty) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        const asset = await uploadAsset(result.file);
        setPropertyMutation.mutate({
          nodeId: pageId,
          propertyId: bannerProperty.id,
          value: asset.node_id
        });
        if (onImageUploaded) {
          onImageUploaded(asset);
        }
        // Expand if collapsed after successful drop
        if (isCollapsed) {
          setIsCollapsed(false);
        }
      }
    } catch (error) {
      console.error('Failed to upload dropped banner:', error);
    }
  }, [editable, bannerProperty, pageId, setPropertyMutation, onImageUploaded, isCollapsed]);
  
  // No banner image
  if (!bannerImageId) {
    // Show collapsed strip if editable
    if (!editable) return null;
    
    return (
      <div 
        className={`banner-image banner-image--empty ${isDragging ? 'banner-image--dragging' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onDragOver={!isCollapsed ? handleDragOver : undefined}
        onDragLeave={!isCollapsed ? handleDragLeave : undefined}
        onDrop={!isCollapsed ? handleDrop : undefined}
      >
        <button
          className="banner-image__collapse-btn"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title={isCollapsed ? "Expand to add banner" : "Collapse banner area"}
          aria-label={isCollapsed ? "Expand banner area" : "Collapse banner area"}
          aria-expanded={!isCollapsed}
        >
          <Icon path={mdiChevronDown} size={0.7} rotate={isCollapsed ? 0 : 180} />
        </button>
        <div className={`banner-image__content ${isCollapsed ? 'banner-image__content--collapsed' : 'banner-image__content--expanded'}`}>
          <Button 
            variant="ghost"
            size="sm"
            className="banner-image__add-btn"
            onClick={onSelectImage}
            title="Add banner image"
          >
            <Icon path={mdiImageOutline} size={0.8} />
            <span>Add banner</span>
          </Button>
        </div>
      </div>
    );
  }
  
  // Has banner image
  return (
    <>
      <div 
        className={`banner-image banner-image--with-image ${isDragging ? 'banner-image--dragging' : ''}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="banner-image__collapse-btn"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title={isCollapsed ? "Expand banner image" : "Collapse banner"}
          aria-label={isCollapsed ? "Expand banner image" : "Collapse banner image"}
          aria-expanded={!isCollapsed}
        >
          <Icon path={mdiChevronDown} size={0.7} rotate={isCollapsed ? 0 : 180} />
        </button>
        
        <div 
          className={`banner-image__content banner-image__content--with-image ${isCollapsed ? 'banner-image__content--collapsed' : `banner-image__content--expanded banner-image--${height}`}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <ImageNode
            assetNodeId={bannerImageId}
            alt="Banner"
            className="banner-image__image-node"
            showCard={true}
            elevation="low"
            radius="md"
            clickable={true}
            showActions={editable && isHovered && !isCollapsed}
            actions={
              <>
                <Button
                  icon={mdiPencil}
                  iconOnly
                  variant="ghost"
                  size="sm"
                  onClick={onSelectImage}
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
              </>
            }
            actionsDirection="horizontal"
            isDragging={isDragging}
            showModalBullet={true}
          />
        </div>
      </div>
    </>
  );
}

export default BannerImage;
