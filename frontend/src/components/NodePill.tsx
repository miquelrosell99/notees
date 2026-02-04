/**
 * NodePill - Universal pill component for displaying any node
 * 
 * Used for:
 * - Inline links in block content ([[page]] or ((block)))
 * - Class/tag pills on blocks and pages
 * - Any node reference display
 * 
 * Features:
 * - Can accept a node object directly OR a nodeId to fetch
 * - Optional click count badge (for link tracking)
 * - Optional remove button
 * - Optional color picker via right-click
 * - Faded background color based on node's isPage status
 */
import { useState, useCallback, useMemo } from 'react';
import { Pill } from './core/Pill';
import { NodeIcon, CloseIcon } from './icons';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import { ColorPickerRow } from './nodes/NodeContextMenu';
import { useNode, useClasses } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import type { Node } from '@/types';
import './NodePill.css';

export interface NodePillProps {
  /** The node to display (if provided, nodeId is ignored) */
  node?: Node;
  /** Node ID to fetch (used if node is not provided) */
  nodeId?: number;
  /** Display variant: 'default' for class pills, 'link' for inline links with faded colors */
  variant?: 'default' | 'link';
  /** Click count badge (for link tracking) */
  clickCount?: number;
  /** Callback when clicking the pill */
  onClick?: () => void;
  /** Callback when clicking the remove button */
  onRemove?: () => void;
  /** Callback when changing the color via right-click menu */
  onColorChange?: (color: string | null) => void;
  /** Whether the pill is read-only (hides remove button and color change) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodePill({
  node: providedNode,
  nodeId,
  variant = 'default',
  clickCount = 0,
  onClick,
  onRemove,
  onColorChange,
  readOnly = false,
  className = '',
}: NodePillProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  const { openNode, addSidebarCard } = useNodesStore();
  const { data: allClasses } = useClasses();
  
  // Fetch node if not provided directly
  const { data: fetchedNode } = useNode(providedNode ? null : (nodeId ?? null));
  const node = providedNode ?? fetchedNode;
  
  // Get effective icon (considers inherited icons from classes)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);
  
  // Display text
  const displayText = useMemo(() => {
    if (!node) return nodeId ? `[Loading...]` : '[Missing]';
    if (!node.name || node.name.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    // Truncate long block content
    if (!node.is_page && node.name.length > 50) {
      return `${node.name.slice(0, 50)}...`;
    }
    return node.name;
  }, [node, nodeId]);
  
  const isPage = node?.is_page ?? true;
  const isLink = variant === 'link';
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (readOnly) return;
    
    if (isLink && node) {
      // Navigation mode (for inline links)
      if (e.shiftKey) {
        addSidebarCard(node.id, isPage ? 'page' : 'block');
      } else {
        openNode(node.id, isPage ? 'page' : 'block');
      }
    } else if (onClick) {
      onClick();
    }
  }, [readOnly, isLink, onClick, node, isPage, openNode, addSidebarCard]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    
    if (isLink) {
      // Show context menu for links
      setContextMenu({ x: e.clientX, y: e.clientY });
    } else if (onColorChange) {
      // Show color picker for class/tag pills
      setColorPickerPos({ x: e.clientX, y: e.clientY });
      setShowColorPicker(true);
    }
  }, [readOnly, isLink, onColorChange]);

  const handleColorChange = useCallback((color: string | null) => {
    onColorChange?.(color);
    setShowColorPicker(false);
  }, [onColorChange]);

  const handleColorPickerClose = useCallback(() => {
    setShowColorPicker(false);
  }, []);
  
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);
  
  // Context menu items for navigable links
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!isLink || !node) return [];
    
    const items: ContextMenuItem[] = [
      {
        id: 'open',
        label: isPage ? 'Open page' : 'Open block',
        onClick: () => {
          openNode(node.id, isPage ? 'page' : 'block');
          handleCloseContextMenu();
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          addSidebarCard(node.id, isPage ? 'page' : 'block');
          handleCloseContextMenu();
        },
      },
    ];
    
    if (onRemove) {
      items.push(
        { id: 'sep1', label: '', separator: true },
        {
          id: 'remove',
          label: 'Remove link',
          danger: true,
          onClick: () => {
            onRemove();
            handleCloseContextMenu();
          },
        }
      );
    }
    
    return items;
  }, [isLink, node, isPage, onRemove, openNode, addSidebarCard, handleCloseContextMenu]);

  // Build title tooltip
  const title = useMemo(() => {
    if (!node) return '';
    let t = `${isPage ? 'Page' : 'Block'}: ${node.name}`;
    if (isLink) {
      t += '\nClick to open, Shift+click for sidebar';
    }
    if (onColorChange && !readOnly) {
      t += '\nRight-click to change color';
    }
    return t;
  }, [node, isPage, isLink, onColorChange, readOnly]);

  // Determine pill styling class
  const pillClass = isLink
    ? `node-pill node-pill--link ${isPage ? 'node-pill--page' : 'node-pill--block'} ${className}`
    : `node-pill ${className}`;

  return (
    <>
      <div 
        className={pillClass}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={title}
      >
        <Pill
          text={displayText}
          leftIcon={effectiveIcon ? <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" /> : undefined}
          rightIcon={
            clickCount > 0 
              ? <span className="node-pill__badge">{clickCount}</span>
              : (!readOnly && onRemove && !isLink) 
                ? <CloseIcon size="xs" /> 
                : undefined
          }
          onRightIconClick={(!readOnly && onRemove && !isLink) ? onRemove : undefined}
          color={node?.color || undefined}
        />
      </div>
      
      {/* Color Picker Popup (for class/tag pills) */}
      {showColorPicker && (
        <PillColorPicker
          position={colorPickerPos}
          currentColor={node?.color ?? null}
          onColorChange={handleColorChange}
          onClose={handleColorPickerClose}
        />
      )}
      
      {/* Context menu (for link variant) */}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
}

// Keep backward compatibility


/**
 * Floating color picker popup for pills
 */
interface PillColorPickerProps {
  position: { x: number; y: number };
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
  onClose: () => void;
}

function PillColorPicker({ position, currentColor, onColorChange, onClose }: PillColorPickerProps) {
  const handleClickOutside = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div 
      className="pill-color-picker-overlay"
      onClick={handleClickOutside}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div 
        className="pill-color-picker"
        style={{ 
          position: 'fixed',
          left: position.x,
          top: position.y,
        }}
        onClick={handleContentClick}
      >
        <ColorPickerRow 
          currentColor={currentColor} 
          onColorChange={onColorChange} 
        />
      </div>
    </div>
  );
}
