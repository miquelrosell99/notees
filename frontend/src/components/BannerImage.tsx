/**
 * BannerImage Component
 * 
 * Displays a full-width banner image at the top of a page header.
 * Uses the 'banner' system property to store the asset node reference.
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
import { useNode, useProperties, useSetNodeProperty } from '@/hooks';
import { getAssetUrl } from '@/api/assets';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { AssetActions } from './AssetActions';
import { mdiImageOutline, mdiChevronDown, mdiChevronUp } from '@mdi/js';
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
  /** Whether banner can be edited */
  editable?: boolean;
  /** Height variant */
  height?: 'small' | 'medium' | 'large';
}

export function BannerImage({ 
  pageId, 
  bannerImageId, 
  onSelectImage,
  editable = true,
  height = 'medium'
}: BannerImageProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(() => getCollapsedState(pageId, !!bannerImageId));
  const { data: allProperties } = useProperties();
  const setPropertyMutation = useSetNodeProperty();
  const { data: assetNode, isLoading } = useNode(bannerImageId, { include_children: false });
  
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
  
  // Get the image URL from the asset node's uuid
  const imageUrl = bannerImageId && assetNode?.uuid 
    ? getAssetUrl(assetNode.uuid)
    : null;
  
  // Loading state
  if (bannerImageId && isLoading) {
    return (
      <div className={`banner-image banner-image--${height} banner-image--loading`}>
        <div className="banner-image__placeholder" />
      </div>
    );
  }
  
  // No banner image
  if (!bannerImageId || !imageUrl) {
    // Show collapsed strip if editable
    if (!editable) return null;
    
    // Collapsed state - just the expand arrow
    if (isCollapsed) {
      return (
        <div 
          className="banner-image banner-image--collapsed banner-image--empty-collapsed"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <button
            className="banner-image__collapse-btn banner-image__collapse-btn--collapsed"
            onClick={handleToggleCollapse}
            onKeyDown={handleCollapseKeyDown}
            title="Expand to add banner"
            aria-label="Expand banner area"
            aria-expanded="false"
          >
            <Icon path={mdiChevronDown} size={0.7} />
          </button>
        </div>
      );
    }
    
    // Expanded empty state - show add button
    return (
      <div 
        className="banner-image banner-image--empty"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="banner-image__collapse-btn banner-image__collapse-btn--expanded-empty"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Collapse banner area"
          aria-label="Collapse banner area"
          aria-expanded="true"
        >
          <Icon path={mdiChevronUp} size={0.7} />
        </button>
        <button 
          className="banner-image__add-btn"
          onClick={onSelectImage}
          title="Add banner image"
        >
          <Icon path={mdiImageOutline} size={0.8} />
          <span>Add banner</span>
        </button>
      </div>
    );
  }
  
  // Has banner image - collapsed state
  if (isCollapsed) {
    return (
      <div 
        className="banner-image banner-image--collapsed"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className="banner-image__collapse-btn banner-image__collapse-btn--collapsed"
          onClick={handleToggleCollapse}
          onKeyDown={handleCollapseKeyDown}
          title="Expand banner image"
          aria-label="Expand banner image"
          aria-expanded="false"
        >
          <Icon path={mdiChevronDown} size={0.7} />
        </button>
        
        {/* Preview tooltip on hover */}
        {isHovered && (
          <div className="banner-image__preview-tooltip">
            <img 
              src={imageUrl} 
              alt="Banner preview" 
              className="banner-image__preview-img"
            />
          </div>
        )}
      </div>
    );
  }
  
  // Expanded state - show full banner
  return (
    <Card 
      className={`banner-image banner-image--${height} banner-image--expanded`}
      elevation="low"
      variant="default"
      padding={false}
      radius="md"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <img 
        src={imageUrl} 
        alt="Banner" 
        className="banner-image__img"
      />
      
      {editable && (
        <div 
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <AssetActions
            onEdit={onSelectImage}
            onRemove={handleRemove}
            visible={isHovered}
            position="bottom-right"
          >
            <Button
              icon={mdiChevronUp}
              variant="ghost"
              size="sm"
              onClick={handleToggleCollapse}
              title="Collapse banner"
              aria-label="Collapse banner image"
              aria-expanded="true"
            />
          </AssetActions>
        </div>
      )}
    </Card>
  );
}

export default BannerImage;
