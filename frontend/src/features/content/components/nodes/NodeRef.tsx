/**
 * NodeRef — Universal component for displaying a node reference.
 * 
 * Three variants:
 * - 'default': Interactive pill with remove/color-change (class/tag chips)
 * - 'link': Interactive pill with navigation on click (inline links outside editor)
 * - 'inline': Bare icon + text spans — no interactivity, no Pill wrapper.
 *            Used by the inline content renderer, where the editor owns the DOM.
 * 
 * Node resolution:
 * - `node` prop: use directly (cheapest)
 * - `nodeId` (number): batch-fetched via useBatchedNode
 * - `nodeUuid` (string): resolved via ReferencedNodesContext → useNodeByUuid fallback
 */
import { useState, useCallback, useMemo, useRef, memo, createContext, useContext } from 'react';
import { Pill } from '@/components/ui/Pill';
import { NodeIcon, CloseIcon } from '@/components/ui/icons';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ColorPickerRow } from './ColorPickerRow';
import { NodeLinkContextMenu } from './NodeLinkContextMenu';
import { useBatchedNode } from '@/hooks';
import { useNodeDisplay } from '@/features/content/hooks/useNodeDisplay';
import { useReferencedNode } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getNodeUuidByServerId } from '@/features/content/hooks/useNodeMutations.utils';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/types/ast';
import type { Node } from '@/types';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import '@/styles/math.css';
import './NodeRef.css';

// Tracks nesting depth to prevent infinite recursion when a referenced node's
// name itself contains node links (which in turn might contain more node links).
const NodeRefDepth = createContext(0);

function renderMath(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression, {
      displayMode,
      throwOnError: false,
      strict: false,
    });
  } catch {
    return displayMode
      ? `<div class="katex-error">$$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$$</div>`
      : `<span class="katex-error">$${expression.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}$</span>`;
  }
}

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
      case 'broken_link': {
        const text = node.label || node.link_id.split(':')[0] || '⛓️‍💥';
        return (
          <span key={i} className="broken-link" title={`Broken link: ${node.link_id}`}>
            {text}
          </span>
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
      case 'math': {
        const html = renderMath(node.expression, node.displayMode ?? false);
        return (
          <span
            key={i}
            className={node.displayMode ? 'math-wrapper math-wrapper--display' : 'math-wrapper'}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }
      default:
        return null;
    }
  });
}

export interface NodeRefProps {
  /** The node to display (if provided, nodeId/nodeUuid are ignored) */
  node?: Node;
  /** Node UUID to resolve (via ReferencedNodesContext then API fallback). Used by inline content renderers. */
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
  /** When true, the remove icon is hidden until the pill is hovered/focused and the pill expands to reveal it. */
  rightIconHoverReveal?: boolean;
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
  // (all callers use inline callbacks that change every render).
  // Compare node objects by identity rather than by field, because the node
  // passed to a class pill is often re-resolved from the classes query cache;
  // when that cache changes the object identity changes even if the field
  // values are identical. A deep comparison would block the update and keep
  // inherited colors/icon stale.
  return (
    prev.node === next.node &&
    prev.nodeUuid === next.nodeUuid &&
    prev.variant === next.variant &&
    prev.refType === next.refType &&
    prev.editMode === next.editMode &&
    prev.clickCount === next.clickCount &&
    prev.readOnly === next.readOnly &&
    prev.rightIconHoverReveal === next.rightIconHoverReveal &&
    prev.className === next.className &&
    prev.customName === next.customName
  );
});

// ─── Inline variant (bare spans, no state, no store) ─────────────────────

/** Lightweight renderer for inline content (editor + static views) — icon + text only. */
function NodeRefInline({
      node: providedNode,
      nodeUuid,
      refType = 'node',
      customName }: NodeRefProps) {
  const depth = useContext(NodeRefDepth);
  const queryClient = useQueryClient();

  // Resolve to a UUID for fetching/navigation
  const resolvedNodeUuid = nodeUuid ?? (nodeUuid ? getNodeUuidByServerId(queryClient, nodeUuid) : null);

  // Resolve node: provided > uuid context > batched UUID fetch
  const refNode = useReferencedNode(resolvedNodeUuid ?? null);
  const { data: fetchedNode } = useBatchedNode(
    !providedNode && !refNode && resolvedNodeUuid ? resolvedNodeUuid : null,
    { skipGlobalError: true }
  );
  const node = providedNode ?? refNode ?? fetchedNode ?? null;

  const { effectiveIcon, displayText: nodeDisplayText, isPage, color } = useNodeDisplay(
    node,
    resolvedNodeUuid ? (resolvedNodeUuid.slice(0, 8) + '…') : '[Loading...]',
  );

  const displayText = customName || nodeDisplayText;

  // When at top depth and the node's stored content contains inner node links,
  // render them as live NodeRef components (same approach as the table view's
  // NodeNameContent) instead of plain text via nodeNameToText (which shows '...'
  // for unresolved links). We inspect the raw content AST, not node.name, because
  // node.name is a derived plain-text string where links already appear as '…'.
  const nameSource = node?.content ?? node?.name ?? '';
  const hasInnerLinks = depth === 0 && !customName && !!nameSource && nameSource.includes('"link_id"');

  if (hasInnerLinks && nameSource) {
    const ast = parseAST(nameSource);
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
      rightIconHoverReveal = false,
      className = '',
      customName }: NodeRefProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  
  const pillRef = useRef<HTMLDivElement>(null);
  const contextMenuWrapperRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  
  // Use selectors to avoid subscribing to full store — actions are stable refs
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  // Resolve to a UUID for fetching/navigation
  const resolvedNodeUuid = nodeUuid ?? (nodeUuid ? getNodeUuidByServerId(queryClient, nodeUuid) : null);
  
  // Batch-fetch when no node is provided
  const refNode = useReferencedNode(resolvedNodeUuid ?? null);
  const { data: fetchedNode } = useBatchedNode(
    !providedNode && !refNode && resolvedNodeUuid ? resolvedNodeUuid : null,
    { skipGlobalError: true }
  );
  
  // Use provided node directly, or fetched node for UUID usage
  const node = providedNode ?? refNode ?? fetchedNode;
  
  // Shared display data (icon, text, color) — deduplicated with InlineLink
  const { effectiveIcon, displayText: actualNodeName, isPage: _isPage, color: effectiveColor } = useNodeDisplay(
    node,
    resolvedNodeUuid ? '[Loading...]' : '[Missing]',
  );

  // Display text: prefer custom name, fall back to actual node name
  const displayText = useMemo(() => {
    if (customName) return customName;
    if (!node) return resolvedNodeUuid ? '[Loading...]' : '[Missing]';
    return actualNodeName;
  }, [customName, node, resolvedNodeUuid, actualNodeName]);
  
  const isPage = node?.is_page ?? true;
  const isLink = variant === 'link';
  
  const activate = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
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
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        window.open(`/${workspaceId ?? ''}/${node.uuid}`, '_blank', 'noopener,noreferrer');
      } else if (e.shiftKey) {
        addSidebarCard(node.uuid, isPage ? 'page' : 'block');
      } else {
        openNode(node.uuid);
      }
    } else if (onClick) {
      onClick();
    }
  }, [readOnly, editMode, isLink, onClick, node, isPage, openNode, workspaceId, addSidebarCard]);

  // Middle-click opens the node in a new browser tab. Handled on mousedown
  // (not auxclick) so preventDefault also suppresses the browser's
  // autoscroll mode.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1 || !node) return;
    e.preventDefault();
    window.open(`/${workspaceId ?? ''}/${node.uuid}`, '_blank', 'noopener,noreferrer');
  }, [node, workspaceId]);

  const handleClick = useCallback((e: React.MouseEvent) => activate(e), [activate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(e);
    }
  }, [activate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!node) return;
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
    } else {
      // Unified link menu for class/tag pills
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, [node, isLink]);

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
          openNode(node.uuid);
          handleCloseContextMenu();
        },
      },
      {
        id: 'open-sidebar',
        label: 'Open in sidebar',
        shortcut: '⇧Click',
        onClick: () => {
          addSidebarCard(node.uuid, isPage ? 'page' : 'block');
          handleCloseContextMenu();
        },
      },
      {
        id: 'open-new-tab',
        label: 'Open in new browser tab',
        shortcut: 'Ctrl/Cmd+Click',
        onClick: () => {
          window.open(`/${workspaceId ?? ''}/${node.uuid}`, '_blank', 'noopener,noreferrer');
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
  }, [isLink, node, isPage, onRemove, onEditLink, openNode, addSidebarCard, handleCloseContextMenu, workspaceId]);

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
    } else {
      t += '\nRight-click for actions';
    }
    return t;
  }, [node, isPage, isLink, customName, actualNodeName]);

  // Determine pill styling class
  const pillClass = isLink
    ? `node-pill ${className}`
    : `node-pill ${className}`;

  const pillVariant = isLink
    ? refType === 'class'
      ? 'link-class'
      : isPage
        ? 'link-page'
        : 'link-block'
    : 'default';

  return (
    <>
      <div
        role={isLink ? 'link' : 'button'}
        tabIndex={0}
        ref={pillRef as React.RefObject<HTMLDivElement>}
        className={pillClass}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={title}
        aria-label={title}
      >
        <Pill
          text={displayText}
          variant={pillVariant}
          leftIcon={effectiveIcon ? <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" /> : undefined}
          rightIcon={
            (!isLink && !readOnly && onRemove)
              ? <CloseIcon size="xs" />
              : undefined
          }
          onRightIconClick={(!isLink && !readOnly && onRemove) ? onRemove : undefined}
          color={effectiveColor}
          rightIconHoverReveal={rightIconHoverReveal}
        />
        {clickCount > 0 && <span className="node-pill__badge">{clickCount}</span>}
      </div>

      {/* Unified context menu (class/tag pills) */}
      {contextMenu && !isLink && node && (
        <NodeLinkContextMenu
          linkId={node.uuid}
          refType={refType}
          nodeUuid={node.uuid}
          position={contextMenu}
          onClose={handleCloseContextMenu}
          currentColor={node.color ?? null}
          onColorChange={!readOnly && onColorChange ? handleColorChangeFromMenu : undefined}
          onRemove={!readOnly ? onRemove : undefined}
        />
      )}

      {/* Context menu (for link variant) */}
      {contextMenu && isLink && (
        <>
          {onColorChange && !readOnly && (
            <>
              {/* Backdrop to catch clicks outside */}
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
              <div
                className="node-pill-context-menu-backdrop"
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 'var(--z-9998)',
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
                  zIndex: 'var(--z-9999)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
                onClickCapture={(e) => e.stopPropagation()}
                onMouseDownCapture={(e) => e.stopPropagation()}
              >
                <ColorPickerRow
                  currentColor={node?.color ?? null}
                  onColorChange={handleColorChangeFromMenu}
                  className="node-pill-context-menu__color-row"
                />
                <ContextMenu
                  items={contextMenuItems}
                  position={{ x: 0, y: 0 }}
                  onClose={handleCloseContextMenu}
                  containerRef={contextMenuWrapperRef}
                  className="node-pill-context-menu"
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

