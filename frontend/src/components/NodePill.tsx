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
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Pill } from './core/Pill';
import { NodeIcon, CloseIcon } from './icons';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import { ColorPickerRow } from './nodes/NodeContextMenu';
import { SuggestionPopup } from './SuggestionPopup';
import { useNode, useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
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
  /** Callback when replacing the link with a new node */
  onReplace?: (newNode: Node) => void;
  /** Callback when requesting custom label edit (for inline links). Receives pill position. */
  onCustomLabel?: (pillRect: DOMRect) => void;
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
  clickCount = 0,
  onClick,
  onRemove,
  onColorChange,
  onReplace,
  onCustomLabel,
  readOnly = false,
  className = '',
  customName,
}: NodePillProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showReplacePopup, setShowReplacePopup] = useState(false);
  const [replacePopupPos, setReplacePopupPos] = useState({ top: 0, left: 0 });
  
  const pillRef = useRef<HTMLDivElement>(null);
  const contextMenuWrapperRef = useRef<HTMLDivElement>(null);
  
  const { openNode, addSidebarCard } = useNodesStore();
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
    
    if (onCustomLabel || onReplace || onRemove) {
      items.push({ id: 'sep1', label: '', separator: true });

      if (onCustomLabel) {
        items.push({
          id: 'custom-label',
          label: 'Edit link text',
          onClick: () => {
            handleCloseContextMenu();
            if (pillRef.current) {
              onCustomLabel(pillRef.current.getBoundingClientRect());
            }
          },
        });
      }
      
      if (onReplace) {
        items.push({
          id: 'replace',
          label: 'Replace',
          onClick: () => {
            handleCloseContextMenu();
            // Position popup just below the pill
            if (pillRef.current) {
              const rect = pillRef.current.getBoundingClientRect();
              setReplacePopupPos({
                top: rect.bottom + 4,
                left: rect.left,
              });
            }
            setShowReplacePopup(true);
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
  }, [isLink, node, isPage, onRemove, onReplace, onCustomLabel, openNode, addSidebarCard, handleCloseContextMenu]);

  // Handler for color change from context menu
  const handleColorChangeFromMenu = useCallback((color: string | null) => {
    console.log('[NodePill] handleColorChangeFromMenu called:', { color, hasOnColorChange: !!onColorChange });
    onColorChange?.(color);
    handleCloseContextMenu();
  }, [onColorChange, handleCloseContextMenu]);

  // Handler for replace popup selection
  const handleReplaceSelect = useCallback((newNode: Node) => {
    // Blur before unmounting to prevent focus returning to block content
    (document.activeElement as HTMLElement)?.blur();
    onReplace?.(newNode);
    setShowReplacePopup(false);
  }, [onReplace]);

  // Handler to close replace popup
  const handleCloseReplacePopup = useCallback(() => {
    (document.activeElement as HTMLElement)?.blur();
    setShowReplacePopup(false);
  }, []);

  // Close replace popup on ESC key
  useEffect(() => {
    if (!showReplacePopup) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowReplacePopup(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showReplacePopup]);

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
    ? `node-pill node-pill--link ${isPage ? 'node-pill--page' : 'node-pill--block'} ${className}`
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
      
      {/* Replace popup (for link variant) */}
      {showReplacePopup && (
        <SuggestionPopup
          isOpen={showReplacePopup}
          query=""
          type="link"
          position={replacePopupPos}
          onSelect={handleReplaceSelect}
          onClose={handleCloseReplacePopup}
          excludeNodeId={node?.id}
        />
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
