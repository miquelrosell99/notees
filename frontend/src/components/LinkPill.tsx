/**
 * LinkPill Component
 * 
 * Displays a page [[link]] or block ((link)) as an inline pill/box.
 * Features:
 * - Non-editable content (selects entire pill when cursor reaches it)
 * - Click to navigate to target
 * - Right-click context menu for link operations
 * - Optional click count badge
 * - Multi-line support (text wraps within pill)
 */
import { useState, useCallback, useRef } from 'react';
import { useTrackLinkClick, useLinkClick, useResetLinkClick, useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import { ContextMenu } from './core/ContextMenu';
import type { ContextMenuItem } from './core/ContextMenu';
import { NodeIcon } from './icons';
import './LinkPill.css';

export type LinkType = 'page' | 'block';

interface LinkPillProps {
  /** Type of link */
  type: LinkType;
  /** For page links: the page name; For block links: the block UUID */
  target: string;
  /** Target node ID (for click tracking) */
  targetNodeId?: number | null;
  /** Source node ID for click tracking */
  sourceNodeId?: number;
  /** Whether the pill is selected (e.g., cursor is on it) */
  isSelected?: boolean;
  /** Callback when pill is clicked (for navigation) */
  onClick?: () => void;
  /** Callback when pill should be deleted */
  onDelete?: () => void;
  /** Callback to change the link target */
  onChangeLink?: () => void;
  /** Whether to show click count badge */
  showClickCount?: boolean;
  /** Make it non-interactive (for display only) */
  readOnly?: boolean;
}

export function LinkPill({
  type,
  target,
  targetNodeId = null,
  sourceNodeId,
  isSelected = false,
  onClick,
  onDelete,
  onChangeLink,
  showClickCount = true,
  readOnly = false,
}: LinkPillProps) {
  const pillRef = useRef<HTMLSpanElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  
  const { addSidebarCard } = useNodesStore();
  const trackClick = useTrackLinkClick();
  const resetClick = useResetLinkClick();
  
  // Fetch the target node to get its icon
  const { data: targetNode } = useNode(targetNodeId ?? null);
  
  // Get click count for this link
  const { data: clickData } = useLinkClick(
    sourceNodeId ?? null,
    targetNodeId
  );
  
  const clickCount = clickData?.click_count ?? 0;
  
  // Display text - for pages it's the name, for blocks it could be truncated UUID or content
  const displayText = type === 'page' 
    ? target 
    : target.substring(0, 8) + '...'; // Truncate UUID for display
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (readOnly) return;
    
    // Track click
    if (sourceNodeId && targetNodeId) {
      trackClick.mutate({ 
        sourceNodeId, 
        targetNodeId 
      });
    }
    
    onClick?.();
  }, [readOnly, sourceNodeId, targetNodeId, trackClick, onClick]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (readOnly) return;
    
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, [readOnly]);
  
  const handleResetClicks = useCallback(() => {
    if (sourceNodeId && targetNodeId) {
      resetClick.mutate({ 
        sourceNodeId, 
        targetNodeId 
      });
    }
    setShowContextMenu(false);
  }, [sourceNodeId, targetNodeId, resetClick]);
  
  const handleCopyLink = useCallback(() => {
    const linkText = type === 'page' ? `[[${target}]]` : `((${target}))`;
    navigator.clipboard.writeText(linkText);
    setShowContextMenu(false);
  }, [type, target]);
  
  const handleOpenInSidebar = useCallback(() => {
    if (targetNodeId) {
      addSidebarCard(targetNodeId, type === 'page' ? 'page' : 'block');
    }
    setShowContextMenu(false);
  }, [targetNodeId, addSidebarCard, type]);
  
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'open',
      label: type === 'page' ? 'Open page' : 'Open block',
      onClick: () => {
        onClick?.();
        setShowContextMenu(false);
      },
    },
    {
      id: 'open-sidebar',
      label: 'Open in sidebar',
      shortcut: '⇧Click',
      onClick: handleOpenInSidebar,
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'copy-link',
      label: 'Copy link',
      onClick: handleCopyLink,
    },
    {
      id: 'change-link',
      label: 'Change link',
      onClick: () => {
        onChangeLink?.();
        setShowContextMenu(false);
      },
    },
    { id: 'sep2', label: '', separator: true },
    ...(clickCount > 0 ? [{
      id: 'reset-clicks',
      label: `Reset click count (${clickCount})`,
      onClick: handleResetClicks,
    }] : []),
    {
      id: 'delete',
      label: 'Remove link',
      danger: true,
      onClick: () => {
        onDelete?.();
        setShowContextMenu(false);
      },
    },
  ];
  
  return (
    <>
      <span
        ref={pillRef}
        className={`link-pill link-pill--${type}${isSelected ? ' link-pill--selected' : ''}${readOnly ? ' link-pill--readonly' : ''}`}
        contentEditable={false}
        data-link-type={type}
        data-link-target={target}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={type === 'page' ? `Page: ${target}` : `Block: ${target}`}
      >
        <span className="link-pill__icon">
          <NodeIcon icon={targetNode?.icon} isPage={type === 'page'} size="xs" />
        </span>
        <span className="link-pill__text">{displayText}</span>
        {showClickCount && clickCount > 0 && (
          <span className="link-pill__badge">{clickCount}</span>
        )}
      </span>
      
      {showContextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenuPos}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  );
}

export default LinkPill;
