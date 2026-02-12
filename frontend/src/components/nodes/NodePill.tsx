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
import { useState, useCallback, useMemo, useRef } from 'react';
import { Pill } from '../core/Pill';
import { NodeIcon, CloseIcon } from '../core/icons';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { ColorPickerRow } from './NodeContextMenu';
import { useNode, useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useAppStore } from '@/stores';
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
  /** Reference type: 'node' for regular links, 'class' for inline class references */
  refType?: 'node' | 'class';
  /** When true, clicking selects the pill (for contenteditable edit mode) instead of navigating */
  editMode?: boolean;
  /** Click count badge (for link tracking) */
  clickCount?: number;
  /** Callback when clicking the pill */
  onClick?: () => void;
  /** Callback when clicking the remove button */
  onRemove?: () => void;
  /** Callback when changing the color via right-click menu */
  onColorChange?: (color: string | null) => void;
  /** Callback when opening the link editor (edit target + custom label). Receives pill position. */
  onEditLink?: (pillRect: DOMRect) => void;
  /** Whether the pill is read-only (hides remove button and color change) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Custom display name (from link's name field). When set, pill shows this text and tooltip shows the actual node name. */
  customName?: string | null;
}

export function NodePill({
  node: providedNode,
  nodeId,
  variant = 'default',
  refType = 'node',
  editMode = false,
  clickCount = 0,
  onClick,
  onRemove,
  onColorChange,
  onEditLink,
  readOnly = false,
  className = '',
  customName,
}: NodePillProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  const pillRef = useRef<HTMLDivElement>(null);
  const contextMenuWrapperRef = useRef<HTMLDivElement>(null);
  
  const { openNode, addSidebarCard } = useAppStore();
  const { data: allClasses } = useClasses();
  
  // Always fetch node to subscribe to cache updates
  // Use providedNode's id if available, otherwise use nodeId prop
  const effectiveNodeId = providedNode?.id ?? nodeId ?? null;
  const { data: fetchedNode } = useNode(effectiveNodeId);
  
  // Prefer fetched node (has latest cache data) over provided node
  const node = fetchedNode ?? providedNode;
  
  // Debug log for color updates
  console.log('[NodePill] nodeId:', effectiveNodeId, 'color:', node?.color);
  
  // Get effective icon (considers inherited icons from classes)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);
  
  // Actual node name (for tooltip when customName is used)
  const actualNodeName = useMemo(() => {
    if (!node) return '';
    const textContent = nodeNameToText(node.name);
    if (!textContent || textContent.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!node.is_page && textContent.length > 50) {
      return `${textContent.slice(0, 50)}...`;
    }
    return textContent;
  }, [node]);

  // Display text: prefer custom name, fall back to actual node name
  const displayText = useMemo(() => {
    if (customName) return customName;
    if (!node) return nodeId ? `[Loading...]` : '[Missing]';
    return actualNodeName;
  }, [customName, node, nodeId, actualNodeName]);
  
  const isPage = node?.is_page ?? true;
  const isLink = variant === 'link';
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (readOnly) return;
    
    if (editMode && isLink) {
      // Edit mode: select the mount point (parent element) for contenteditable
      const mountPoint = pillRef.current?.parentElement;
      if (mountPoint) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNode(mountPoint);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return;
    }
    
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
  }, [readOnly, editMode, isLink, onClick, node, isPage, openNode, addSidebarCard]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    
    if (isLink) {
      // Show context menu for links — aligned to pill's left edge, just below it
      if (pillRef.current) {
        const rect = pillRef.current.getBoundingClientRect();
        setContextMenu({ x: rect.left, y: rect.bottom + 4 });
      } else {
        setContextMenu({ x: e.clientX, y: e.clientY });
      }
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
    
    if (onEditLink || onRemove) {
      items.push({ id: 'sep1', label: '', separator: true });

      if (onEditLink) {
        items.push({
          id: 'edit-link',
          label: 'Edit link',
          onClick: () => {
            handleCloseContextMenu();
            if (pillRef.current) {
              onEditLink(pillRef.current.getBoundingClientRect());
            }
          },
        });
      }
      
      if (onRemove) {
        items.push({
          id: 'remove',
          label: 'Remove',
          danger: true,
          onClick: () => {
            onRemove();
            handleCloseContextMenu();
          },
        });
      }
    }
    
    return items;
  }, [isLink, node, isPage, onRemove, onEditLink, openNode, addSidebarCard, handleCloseContextMenu]);

  // Handler for color change from context menu
  const handleColorChangeFromMenu = useCallback((color: string | null) => {
    console.log('[NodePill] handleColorChangeFromMenu called:', { color, hasOnColorChange: !!onColorChange });
    onColorChange?.(color);
    handleCloseContextMenu();
  }, [onColorChange, handleCloseContextMenu]);



  // Build title tooltip — when customName is used, show actual node name
  const title = useMemo(() => {
    if (!node) return '';
    const nameForTooltip = actualNodeName;
    let t = customName
      ? `${isPage ? 'Page' : 'Block'}: ${nameForTooltip}`
      : `${isPage ? 'Page' : 'Block'}: ${nameForTooltip}`;
    if (isLink) {
      t += '\nClick to open, Shift+click for sidebar';
    }
    if (onColorChange && !readOnly) {
      t += '\nRight-click to change color';
    }
    return t;
  }, [node, isPage, isLink, onColorChange, readOnly, customName, actualNodeName]);

  // Determine pill styling class
  const pillClass = isLink
    ? `node-pill node-pill--link ${isPage ? 'node-pill--page' : 'node-pill--block'} ${refType === 'class' ? 'node-pill--class' : ''} ${className}`
    : `node-pill ${className}`;

  return (
    <>
      <div 
        ref={pillRef}
        className={pillClass}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={title}
      >
        <Pill
          text={displayText}
          leftIcon={effectiveIcon ? <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" /> : undefined}
          rightIcon={
            (!readOnly && onRemove && !isLink) 
              ? <CloseIcon size="xs" /> 
              : undefined
          }
          onRightIconClick={(!readOnly && onRemove && !isLink) ? onRemove : undefined}
          color={node?.color || undefined}
        />
        {clickCount > 0 && <span className="node-pill__badge">{clickCount}</span>}
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
        <>
          {console.log('[NodePill] Context menu rendering, onColorChange:', !!onColorChange, 'readOnly:', readOnly)}
          {onColorChange && !readOnly && (
            <>
              {/* Backdrop to catch clicks outside */}
              <div 
                className="node-pill-context-menu-backdrop"
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 9998,
                }}
                onClick={handleCloseContextMenu}
              />
              <div 
                ref={contextMenuWrapperRef}
                className="node-pill-context-menu-wrapper"
                style={{
                  position: 'fixed',
                  left: contextMenu.x,
                  top: contextMenu.y,
                  zIndex: 9999,
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <ColorPickerRow
                  currentColor={node?.color ?? null}
                  onColorChange={handleColorChangeFromMenu}
                />
                <ContextMenu
                  items={contextMenuItems}
                  position={{ x: 0, y: 0 }}
                  onClose={handleCloseContextMenu}
                  containerRef={contextMenuWrapperRef}
                />
              </div>
            </>
          )}
          {(!onColorChange || readOnly) && (
            <ContextMenu
              items={contextMenuItems}
              position={contextMenu}
              onClose={handleCloseContextMenu}
            />
          )}
        </>
      )}
      

    </>
  );
}


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
