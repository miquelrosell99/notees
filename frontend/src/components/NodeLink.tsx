/**
 * NodeLink Component
 * 
 * Displays an inline link to a node (page or block) with:
 * - Card-based styling with border, shadow, and rounded corners
 * - Badge showing click count
 * - Right-click context menu for replace/remove
 * - Click to navigate
 * 
 * Used in block content to show [[Page Name]] or ((block-uuid)) links.
 */
import { useState, useCallback, useRef } from 'react';
import { Card } from './core/Card';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import { useNode } from '@/hooks';
import { NodeIcon } from './icons';
import './NodeLink.css';

export interface NodeLinkProps {
  /** The type of link: page-link for [[]], block-link for (()) */
  type: 'page-link' | 'block-link';
  /** The node ID or UUID to link to */
  targetId: string | number;
  /** Click count for this link (how many times navigated) */
  clickCount?: number;
  /** Whether the link is read-only (no interactions) */
  readOnly?: boolean;
  /** Callback when link is clicked to navigate */
  onNavigate?: (targetId: string | number, type: 'page-link' | 'block-link') => void;
  /** Callback to replace the link with a different one */
  onReplace?: () => void;
  /** Callback to remove the link */
  onRemove?: () => void;
  /** Callback to increment click count */
  onClickCountIncrement?: () => void;
}

export function NodeLink({
  type,
  targetId,
  clickCount = 0,
  readOnly = false,
  onNavigate,
  onReplace,
  onRemove,
  onClickCountIncrement,
}: NodeLinkProps) {
  const linkRef = useRef<HTMLSpanElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  // Fetch the target node to display its name
  const { data: targetNode, isLoading } = useNode(
    typeof targetId === 'number' ? targetId : null
  );
  
  // Handle click to navigate
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!readOnly && onNavigate) {
      onClickCountIncrement?.();
      // Use actual node type when available, otherwise fallback to props type
      const actualType = targetNode 
        ? (targetNode.is_page ? 'page-link' : 'block-link')
        : type;
      onNavigate(targetId, actualType);
    }
  }, [readOnly, onNavigate, targetId, type, targetNode, onClickCountIncrement]);
  
  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [readOnly]);
  
  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);
  
  // Context menu items
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'navigate',
      label: 'Open link',
      onClick: () => {
        onNavigate?.(targetId, type);
        handleCloseContextMenu();
      },
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'replace',
      label: 'Replace link',
      onClick: () => {
        onReplace?.();
        handleCloseContextMenu();
      },
    },
    {
      id: 'remove',
      label: 'Remove link',
      danger: true,
      onClick: () => {
        onRemove?.();
        handleCloseContextMenu();
      },
    },
  ];
  
  // Determine display text
  const displayText = isLoading 
    ? 'Loading...' 
    : targetNode?.name || targetNode?.display_name || String(targetId);
  
  // Determine if target is a page
  const isPage = targetNode?.is_page ?? (type === 'page-link');
  
  return (
    <>
      <span
        ref={linkRef}
        className={`node-link node-link--${type}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`${type === 'page-link' ? 'Page' : 'Block'}: ${displayText}`}
      >
        <Card
          className="node-link__card"
          elevation="low"
          variant="outlined"
          padding={false}
          radius="sm"
          interactive={!readOnly}
        >
          <span className="node-link__icon">
            <NodeIcon icon={targetNode?.icon} isPage={isPage} size="xs" />
          </span>
          <span className="node-link__text">{displayText}</span>
          {clickCount > 0 && (
            <span className="node-link__badge">{clickCount}</span>
          )}
        </Card>
      </span>
      
      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={handleCloseContextMenu}
          title="Link Options"
        />
      )}
    </>
  );
}

export default NodeLink;
