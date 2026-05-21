/**
 * NodeRef — Universal component for displaying a node reference.
 * 
 * Three variants:
 * - 'default': Interactive pill with remove/color-change (class/tag chips)
 * - 'link': Interactive pill with navigation on click (inline links outside editor)
 * - 'inline': Bare icon + text spans — no interactivity, no Pill wrapper.
 *            Used inside Lexical DecoratorNodes where the editor owns the DOM.
 * 
 * Node resolution:
 * - `node` prop: use directly (cheapest)
 * - `nodeId` (number): batch-fetched via useBatchedNode
 * - `nodeUuid` (string): resolved via ReferencedNodesContext → useNodeByUuid fallback
 */
import { useState, useCallback, useMemo, useRef, memo, createContext, useContext } from 'react';
import { Pill } from '@/components/core/Pill';
import { NodeIcon, CloseIcon } from '@/components/core/icons';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { ColorPickerRow } from './NodeContextMenu';
import { useBatchedNode } from '@/hooks';
import { useNodeDisplay } from '@/hooks/useNodeDisplay';
import { useReferencedNode } from '@/contexts/ReferencedNodesContext';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { useNavigationStore } from '@/stores';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/types/ast';
import type { Node } from '@/types';
import './NodeRef.css';

// Tracks nesting depth to prevent infinite recursion when a referenced node's
// name itself contains node links (which in turn might contain more node links).
const NodeRefDepth = createContext(0);

// Renders AST inline nodes as React without click-handler wrappers.
// Used by NodeRefInline to resolve inner node links in a referenced node's name.
function renderNameInlineNodes(nodes: ASTInlineNode[]): React.ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text || null;
      case 'node_link': {
        const { nodeUuid } = parseLinkId(node.link_id);
        return (
          <NodeRef
            key={i}
            variant="inline"
            nodeUuid={nodeUuid}
            refType={node.ref_type === 'class' ? 'class' : 'node'}
            customName={node.label ?? undefined}
          />
        );
      }
      case 'strong':
        return <strong key={i}>{renderNameInlineNodes(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderNameInlineNodes(node.children)}</em>;
      case 'strikethrough':
        return <s key={i}>{renderNameInlineNodes(node.children)}</s>;
      case 'highlight':
        return <mark key={i}>{renderNameInlineNodes(node.children)}</mark>;
      case 'underline':
        return <u key={i}>{renderNameInlineNodes(node.children)}</u>;
      case 'hard_break':
        return <br key={i} />;
      default:
        return null;
    }
  });
}

export interface NodeRefProps {
  /** The node to display (if provided, nodeId/nodeUuid are ignored) */
  node?: Node;
  /** Node ID to fetch by numeric ID (used if node is not provided) */
  nodeId?: number;
  /** Node UUID to resolve (via ReferencedNodesContext then API fallback). Used by Lexical decorators. */
  nodeUuid?: string;
  /** Display variant: 'default' for class pills, 'link' for inline links, 'inline' for bare icon+text */
  variant?: 'default' | 'link' | 'inline';
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

/** @deprecated Use NodeRefProps instead */
export type NodePillProps = NodeRefProps;

export const NodeRef = memo(function NodeRef(props: NodeRefProps) {
  // Dispatch to the lightweight inline renderer when variant === 'inline'
  if (props.variant === 'inline') {
    return <NodeRefInline {...props} />;
  }
  return <NodeRefInteractive {...props} />;
}, (prev, next) => {
  // Custom comparator: skip re-render when only function props change
  // (all callers use inline callbacks that change every render)
  return (
    prev.node?.id === next.node?.id &&
    prev.node?.name === next.node?.name &&
    prev.node?.color === next.node?.color &&
    prev.node?.icon === next.node?.icon &&
    prev.node?.is_page === next.node?.is_page &&
    prev.nodeId === next.nodeId &&
    prev.nodeUuid === next.nodeUuid &&
    prev.variant === next.variant &&
    prev.refType === next.refType &&
    prev.editMode === next.editMode &&
    prev.clickCount === next.clickCount &&
    prev.readOnly === next.readOnly &&
    prev.className === next.className &&
    prev.customName === next.customName
  );
});

// ─── Inline variant (bare spans, no state, no store) ─────────────────────

/** Lightweight renderer for Lexical decorator nodes — icon + text only. */
function NodeRefInline({
  node: providedNode,
  nodeId,
  nodeUuid,
  refType = 'node',
  customName,
}: NodeRefProps) {
  const depth = useContext(NodeRefDepth);

  // Resolve node: provided > uuid context > uuid fetch > batched ID fetch
  const refNode = useReferencedNode(nodeUuid ?? null);
  const { data: uuidFallback } = useNodeByUuid(
    !providedNode && !refNode && nodeUuid ? nodeUuid : null,
    { meta: { skipGlobalError: true } }
  );
  const { data: idFallback } = useBatchedNode(
    !providedNode && !refNode && !nodeUuid ? (nodeId ?? null) : null,
    { skipGlobalError: true }
  );
  const node = providedNode ?? refNode ?? uuidFallback ?? idFallback ?? null;

  const { effectiveIcon, displayText: nodeDisplayText, isPage, color } = useNodeDisplay(
    node,
    nodeUuid ? (nodeUuid.slice(0, 8) + '…') : '[Loading...]',
  );

  const displayText = customName || nodeDisplayText;

  // When at top depth and the node's name contains inner node links, render
  // them as live NodeRef components (same approach as the table view's NodeNameContent)
  // instead of plain text via nodeNameToText (which shows '...' for unresolved links).
  const hasInnerLinks = depth === 0 && !customName && !!node?.name && node.name.includes('"link_id"');

  if (hasInnerLinks && node?.name) {
    const ast = parseAST(node.name);
    const inlines = ast.flatMap(b => ('children' in b ? b.children : [])) as ASTInlineNode[];
    const rendered = renderNameInlineNodes(inlines);
    const hasContent = rendered.some(r => r !== null);
    if (hasContent) {
      return (
        <NodeRefDepth.Provider value={1}>
          <span
            className="inline-link-inner"
            data-ref-type={refType}
            style={color ? { textDecorationColor: color } : undefined}
          >
            {effectiveIcon && refType !== 'class' && (
              <span className="inline-link-icon">
                <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
              </span>
            )}
            <span className="inline-link-text">{rendered}</span>
          </span>
        </NodeRefDepth.Provider>
      );
    }
  }

  return (
    <span
      className="inline-link-inner"
      data-ref-type={refType}
      style={color ? { textDecorationColor: color } : undefined}
    >
      {effectiveIcon && refType !== 'class' && (
        <span className="inline-link-icon">
          <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
        </span>
      )}
      <span className="inline-link-text">{displayText}</span>
    </span>
  );
}

// ─── Interactive variant (Pill + context menu + navigation) ──────────────

function NodeRefInteractive({
  node: providedNode,
  nodeId,
  nodeUuid,
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
}: NodeRefProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  const pillRef = useRef<HTMLDivElement>(null);
  const contextMenuWrapperRef = useRef<HTMLDivElement>(null);
  
  // Use selectors to avoid subscribing to full store — actions are stable refs
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);
  
  // Only batch-fetch when no node is provided (need to fetch by ID)
  const { data: fetchedNode } = useBatchedNode(
    providedNode ? null : (nodeId ?? null),
    { skipGlobalError: true }
  );
  
  // UUID resolution (for non-inline interactive links that happen to have a UUID)
  const refNode = useReferencedNode(nodeUuid ?? null);
  const { data: uuidFallback } = useNodeByUuid(
    !providedNode && !fetchedNode && !refNode && nodeUuid ? nodeUuid : null,
    { meta: { skipGlobalError: true } }
  );
  
  // Use provided node directly, or fetched node for ID-only usage
  const node = providedNode ?? fetchedNode ?? refNode ?? uuidFallback;
  
  // Shared display data (icon, text, color) — deduplicated with InlineLink
  const { effectiveIcon, displayText: actualNodeName, isPage: _isPage, color: effectiveColor } = useNodeDisplay(
    node,
    nodeId ? '[Loading...]' : '[Missing]',
  );

  // Display text: prefer custom name, fall back to actual node name
  const displayText = useMemo(() => {
    if (customName) return customName;
    if (!node) return nodeId ? '[Loading...]' : '[Missing]';
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
        openNode(node.id);
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
          openNode(node.id);
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
          color={effectiveColor}
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

/** @deprecated Use NodeRef instead */
export const NodePill = NodeRef;


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
