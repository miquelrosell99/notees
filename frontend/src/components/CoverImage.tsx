/**
 * CoverImage Component
 * 
 * Displays a cover image as a small card aligned to the right of the page header.
 * Uses the 'cover' system property to store the asset node reference.
 * 
 * The cover appears as a card with fixed height and adaptive width to maintain
 * the image's aspect ratio. It floats to the right of the header title.
 * 
 * Features:
 * - Collapsible: Can be collapsed to just an arrow icon to reclaim header space
 * - State persistence: Collapsed state is remembered per node
 * - Smooth animations between collapsed/expanded states
 * 
 * Supports:
 * - Displaying existing cover image
 * - Removing cover image
 * - Changing cover image (opens asset selector)
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNode, useProperties, useSetNodeProperty } from '@/hooks';
import { getAssetUrl } from '@/api/assets';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { AssetActions } from './AssetActions';
import { mdiImageOutline, mdiChevronRight, mdiChevronLeft } from '@mdi/js';
import Icon from '@mdi/react';
import './CoverImage.css';

// Local storage key for collapsed state
const COVER_COLLAPSED_KEY = 'notees:cover-collapsed';

/**
 * Get collapsed state for a specific node from localStorage
 * Returns true (collapsed) by default if no state is stored and no image
 */
function getCollapsedState(pageId: number, hasImage: boolean): boolean {
  try {
    const stored = localStorage.getItem(COVER_COLLAPSED_KEY);
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
    const stored = localStorage.getItem(COVER_COLLAPSED_KEY);
    const states = stored ? JSON.parse(stored) as Record<string, boolean> : {};
    states[pageId.toString()] = collapsed;
    localStorage.setItem(COVER_COLLAPSED_KEY, JSON.stringify(states));
  } catch {
    // Ignore storage errors
  }
}

interface CoverImageProps {
  /** Page node ID */
  pageId: number;
  /** Cover image asset node ID (from properties.cover) */
  coverImageId: number | null;
  /** Callback to open asset picker */
  onSelectImage?: () => void;
  /** Whether cover can be edited */
  editable?: boolean;
}

export function CoverImage({ 
  pageId, 
  coverImageId, 
  onSelectImage,
  editable = true,
}: CoverImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => getCollapsedState(pageId, !!coverImageId));
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const { data: assetNode, isLoading } = useNode(coverImageId, { include_children: false });
  
  // Persist collapsed state when it changes
  useEffect(() => {
    setCollapsedState(pageId, isCollapsed);
  }, [pageId, isCollapsed]);
  
  // Reset collapsed state when pageId or coverImageId changes
  useEffect(() => {
    setIsCollapsed(getCollapsedState(pageId, !!coverImageId));
  }, [pageId, coverImageId]);
  
  // Find the cover property by UUID
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);
  
  const handleRemove = useCallback(() => {
    if (!coverProperty) return;
    setPropertyMutation.mutate({
      nodeId: pageId,
      propertyId: coverProperty.id,
      value: null
    });
  }, [pageId, coverProperty, setPropertyMutation]);
  
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
  
  // Get the image URL from the asset node's uuid
  const imageUrl = coverImageId && assetNode?.uuid 
    ? getAssetUrl(assetNode.uuid)
    : null;
  
  // Loading state
  if (coverImageId && isLoading) {
    return (
      <div className="cover-image-card cover-image-card--loading">
        <Card padding={false} radius="md" elevation="low">
          <div className="cover-image-card__placeholder" />
        </Card>
      </div>
    );
  }
  
  // No cover image
  if (!coverImageId || !imageUrl) {
    // Show collapsed strip if editable
    if (!editable) return null;
    
    // Collapsed state - just the expand arrow
    if (isCollapsed) {
      return (
        <div 
          className="cover-image-card cover-image-card--collapsed cover-image-card--empty-collapsed"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <button
            className="cover-image-card__collapse-btn cover-image-card__collapse-btn--collapsed"
            onClick={handleToggleCollapse}
            onKeyDown={handleCollapseKeyDown}
            title="Expand to add cover"
            aria-label="Expand cover area"
            aria-expanded="false"
          >
            <Icon path={mdiChevronLeft} size={0.7} />
          </button>
        </div>
      );
    }
    
    // Expanded empty state - show add button with collapse option
    return (
      <div 
        className="cover-image-card cover-image-card--empty"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="cover-image-card__collapse-btn cover-image-card__collapse-btn--empty-expanded"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Collapse cover area"
          aria-label="Collapse cover area"
          aria-expanded="true"
        >
          <Icon path={mdiChevronRight} size={0.6} />
        </button>
        <button 
          className="cover-image-card__add-btn"
          onClick={onSelectImage}
          title="Add cover image"
        >
          <Icon path={mdiImageOutline} size={0.7} />
        </button>
      </div>
    );
  }
  
  // Collapsed state with image - show only the expand arrow
  if (isCollapsed) {
    return (
      <div 
        className="cover-image-card cover-image-card--collapsed"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="cover-image-card__collapse-btn cover-image-card__collapse-btn--collapsed"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Expand cover image"
          aria-label="Expand cover image"
          aria-expanded="false"
        >
          <Icon path={mdiChevronLeft} size={0.7} />
        </button>
        
        {/* Preview tooltip on hover */}
        {isHovered && (
          <div className="cover-image-card__preview-tooltip">
            <img 
              src={imageUrl} 
              alt="Cover preview" 
              className="cover-image-card__preview-img"
            />
          </div>
        )}
      </div>
    );
  }
  
  // Expanded state - show full card
  return (
    <div 
      className="cover-image-card cover-image-card--expanded"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Action buttons - vertical stack on left side of image */}
      {editable && (
        <AssetActions
          onEdit={onSelectImage}
          onRemove={handleRemove}
          visible={isHovered}
          position="left"
          className="cover-image-card__actions"
          compact={true}
        >
          <Button
            icon={mdiChevronRight}
            variant="ghost"
            size="sm"
            onClick={handleToggleCollapse}
            title="Collapse cover"
            aria-label="Collapse cover image"
            aria-expanded="true"
          />
        </AssetActions>
      )}
      
      <Card padding={false} radius="md" elevation="low">
        <img 
          src={imageUrl} 
          alt="Cover" 
          className="cover-image-card__img"
        />
      </Card>
    </div>
  );
}

export default CoverImage;
