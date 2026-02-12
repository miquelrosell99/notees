/**
 * NodeBreadcrumbs Components
 * 
 * Three-component architecture for breadcrumb navigation:
 * - NodeBreadcrumbsElement: Individual breadcrumb item
 * - NodeBreadcrumbsList: Renders a list of breadcrumb elements (also used as popup)
 * - NodeBreadcrumbs: Main container with overflow detection and collapse
 * 
 * Shows the FULL ancestor chain. When items don't fit, collapses to:
 * [first] [second] [...] [second-to-last] [last]
 * Clicking "..." opens a popup with the hidden items.
 */
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Node } from '@/types';
import { ChevronRightIcon } from '../core/icons';
import { NodeInline } from '../blocks/NodeInline';
import './NodeBreadcrumbs.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BreadcrumbItem {
  id: number;
  name: string;
  icon?: string | null;
  isPage: boolean;
  /** If this is a property breadcrumb item */
  isProperty?: boolean;
  /** Property ID for property items */
  propertyId?: number;
}

// ─── NodeBreadcrumbsElement ───────────────────────────────────────────────────

interface NodeBreadcrumbsElementProps {
  item: BreadcrumbItem;
  onClick: (item: BreadcrumbItem) => void;
  /** Whether to show the separator chevron after this element */
  showSeparator?: boolean;
}

/**
 * Individual breadcrumb element — renders a single clickable breadcrumb.
 */
function NodeBreadcrumbsElement({ item, onClick, showSeparator = true }: NodeBreadcrumbsElementProps) {
  return (
    <span className="node-breadcrumb-item">
      <NodeInline
        name={item.name}
        icon={item.icon}
        showBullet={!!item.icon}
        propertyName={item.isProperty ? item.name : undefined}
        onClick={() => onClick(item)}
        className={`node-breadcrumb-link ${item.isProperty ? 'node-breadcrumb-property' : ''}`}
      />
      {showSeparator && (
        <ChevronRightIcon size="xs" className="node-breadcrumb-separator" />
      )}
    </span>
  );
}

// ─── NodeBreadcrumbsList ──────────────────────────────────────────────────────

interface NodeBreadcrumbsListProps {
  items: BreadcrumbItem[];
  onClick: (item: BreadcrumbItem) => void;
  /** Render as a dropdown popup */
  variant?: 'inline' | 'popup';
}

/**
 * Renders a list of breadcrumb elements.
 * In 'popup' variant, renders as a floating dropdown card.
 * In 'inline' variant, renders items inline (used within main breadcrumbs).
 */
function NodeBreadcrumbsList({ items, onClick, variant = 'inline' }: NodeBreadcrumbsListProps) {
  if (variant === 'popup') {
    return (
      <div className="node-breadcrumbs-popup">
        {items.map((item) => (
          <button
            key={item.isProperty ? `prop-${item.id}` : item.id}
            className={`node-breadcrumbs-popup-item ${item.isProperty ? 'node-breadcrumb-property' : ''}`}
            onClick={() => onClick(item)}
          >
            {item.icon && <span className="node-breadcrumb-popup-icon">{item.icon}</span>}
            <span className="node-breadcrumb-popup-name">{item.isProperty ? item.name : (nodeNameToText(item.name) || 'Untitled')}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <>
      {items.map((item, index) => (
        <NodeBreadcrumbsElement
          key={item.isProperty ? `prop-${item.id}` : item.id}
          item={item}
          onClick={onClick}
          showSeparator={index < items.length - 1}
        />
      ))}
    </>
  );
}

// ─── Ancestor chain hook ─────────────────────────────────────────────────────

/**
 * Walks the full parent chain for a node using chained useNode hooks.
 * Returns breadcrumb items from root ancestor → immediate parent
 * (the current node itself is excluded).
 *
 * For pages: walks the full parent_id chain (page → parent page → …).
 * For blocks: walks up to (and including) the containing page, then stops.
 *
 * Uses a fixed number of hook slots (20 max levels) — hooks beyond
 * the actual depth are disabled via null IDs.
 */
function useAncestorChain(nodeId: number | null, nodeType: 'page' | 'block'): BreadcrumbItem[] {
  const { data: n0 } = useNode(nodeId);
  const { data: n1 } = useNode(n0?.parent_id ?? null);
  const { data: n2 } = useNode(n1?.parent_id ?? null);
  const { data: n3 } = useNode(n2?.parent_id ?? null);
  const { data: n4 } = useNode(n3?.parent_id ?? null);
  const { data: n5 } = useNode(n4?.parent_id ?? null);
  const { data: n6 } = useNode(n5?.parent_id ?? null);
  const { data: n7 } = useNode(n6?.parent_id ?? null);
  const { data: n8 } = useNode(n7?.parent_id ?? null);
  const { data: n9 } = useNode(n8?.parent_id ?? null);
  const { data: n10 } = useNode(n9?.parent_id ?? null);
  const { data: n11 } = useNode(n10?.parent_id ?? null);
  const { data: n12 } = useNode(n11?.parent_id ?? null);
  const { data: n13 } = useNode(n12?.parent_id ?? null);
  const { data: n14 } = useNode(n13?.parent_id ?? null);
  const { data: n15 } = useNode(n14?.parent_id ?? null);
  const { data: n16 } = useNode(n15?.parent_id ?? null);
  const { data: n17 } = useNode(n16?.parent_id ?? null);
  const { data: n18 } = useNode(n17?.parent_id ?? null);
  const { data: n19 } = useNode(n18?.parent_id ?? null);

  return useMemo(() => {
    const ancestors = [n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14, n15, n16, n17, n18, n19];
    const chain: BreadcrumbItem[] = [];
    for (const node of ancestors) {
      if (!node) break;
      chain.push({
        id: node.id,
        name: node.name || '',
        icon: node.icon,
        isPage: node.is_page,
      });
      // For blocks, stop once we reach the containing page
      if (nodeType === 'block' && node.is_page) break;
    }
    // Reverse: we walked child→root, we want root→child
    chain.reverse();
    return chain;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14, n15, n16, n17, n18, n19, nodeType]);
}

// ─── NodeBreadcrumbs (main) ──────────────────────────────────────────────────

interface NodeBreadcrumbsProps {
  /** The node to show breadcrumbs for */
  nodeId: number;
  /** Type of node (affects how breadcrumbs are built) */
  nodeType: 'page' | 'block';
  /** Callback when clicking a breadcrumb item */
  onNavigate?: (nodeId: number, nodeType: 'page' | 'block') => void;
  /** Callback when clicking a property breadcrumb item */
  onNavigateToProperty?: (propertyId: number) => void;
  /** Property context for when viewing a block from a text property */
  propertyContext?: { propertyId: number; propertyName: string } | null;
  /** Additional CSS class */
  className?: string;
}

/** How many items to keep visible at each end when collapsing */
const VISIBLE_START = 2;
const VISIBLE_END = 2;

export function NodeBreadcrumbs({
  nodeId,
  nodeType,
  onNavigate,
  onNavigateToProperty,
  propertyContext,
  className = '',
}: NodeBreadcrumbsProps) {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const ellipsisRef = useRef<HTMLButtonElement>(null);

  // Walk the full ancestor chain (stops at page for blocks)
  const ancestorBreadcrumbs = useAncestorChain(nodeId, nodeType);

  // Build final breadcrumbs including property context
  const breadcrumbs = useMemo(() => {
    const items = [...ancestorBreadcrumbs];

    // If we have property context, insert it after the last page
    if (propertyContext && nodeType === 'block' && items.length > 0) {
      let insertAt = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].isPage) { insertAt = i + 1; break; }
      }
      items.splice(insertAt, 0, {
        id: propertyContext.propertyId,
        name: propertyContext.propertyName,
        icon: null,
        isPage: false,
        isProperty: true,
        propertyId: propertyContext.propertyId,
      });
    }

    return items;
  }, [ancestorBreadcrumbs, propertyContext, nodeType]);

  // ─── Overflow detection ──────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const checkOverflow = () => {
      setIsOverflowing(el.scrollWidth > el.clientWidth + 2);
    };

    checkOverflow();

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [breadcrumbs]);

  // ─── Close popup on click outside ───────────────────────────────────
  useClickOutside([popupRef, { current: ellipsisRef.current }], () => setPopupOpen(false), popupOpen);

  // ─── Handlers ────────────────────────────────────────────────────────
  const handleClick = useCallback(
    (item: BreadcrumbItem) => {
      setPopupOpen(false);
      if (item.isProperty && item.propertyId) {
        onNavigateToProperty?.(item.propertyId);
      } else {
        onNavigate?.(item.id, item.isPage ? 'page' : 'block');
      }
    },
    [onNavigate, onNavigateToProperty],
  );

  // Don't render if no breadcrumbs
  if (breadcrumbs.length === 0) return null;

  // ─── Splitting for overflow ──────────────────────────────────────────
  const needsCollapse = isOverflowing && breadcrumbs.length > VISIBLE_START + VISIBLE_END;
  const startItems = needsCollapse ? breadcrumbs.slice(0, VISIBLE_START) : breadcrumbs;
  const hiddenItems = needsCollapse
    ? breadcrumbs.slice(VISIBLE_START, breadcrumbs.length - VISIBLE_END)
    : [];
  const endItems = needsCollapse
    ? breadcrumbs.slice(breadcrumbs.length - VISIBLE_END)
    : [];

  return (
    <nav
      ref={containerRef}
      className={`node-breadcrumbs ${className}`}
      aria-label={nodeType === 'page' ? 'Page hierarchy' : 'Block path'}
    >
      {/* Start items (always visible) */}
      {startItems.map((item, index) => (
        <NodeBreadcrumbsElement
          key={item.isProperty ? `prop-${item.id}` : item.id}
          item={item}
          onClick={handleClick}
          showSeparator={needsCollapse || index < startItems.length - 1}
        />
      ))}

      {/* Ellipsis button for collapsed items */}
      {needsCollapse && (
        <span className="node-breadcrumb-item node-breadcrumb-ellipsis-container">
          <button
            ref={ellipsisRef}
            className="node-breadcrumb-link node-breadcrumb-ellipsis"
            onClick={() => setPopupOpen((v) => !v)}
            aria-label={`Show ${hiddenItems.length} more breadcrumbs`}
            aria-expanded={popupOpen}
          >
            …
          </button>
          <ChevronRightIcon size="xs" className="node-breadcrumb-separator" />

          {/* Popup with hidden items */}
          {popupOpen && (
            <div ref={popupRef} className="node-breadcrumb-popup-anchor">
              <NodeBreadcrumbsList
                items={hiddenItems}
                onClick={handleClick}
                variant="popup"
              />
            </div>
          )}
        </span>
      )}

      {/* End items (always visible when collapsed) */}
      {needsCollapse &&
        endItems.map((item, index) => (
          <NodeBreadcrumbsElement
            key={item.isProperty ? `prop-${item.id}` : item.id}
            item={item}
            onClick={handleClick}
            showSeparator={index < endItems.length - 1}
          />
        ))}
    </nav>
  );
}

// ─── InlineNodeBreadcrumbs (for list items) ───────────────────────────────────

export interface InlineNodeBreadcrumbsProps {
  /** The node to show breadcrumbs for */
  node: Node;
  /** Parent page (if known) */
  page?: Node | null;
  /** Context string (e.g., "via property_name") */
  context?: string;
  /** Callback when clicking a breadcrumb item */
  onNavigate?: (nodeId: number, nodeType: 'page' | 'block') => void;
  /** Additional CSS class */
  className?: string;
  /** Whether to show as compact inline */
  compact?: boolean;
}

export function InlineNodeBreadcrumbs({
  node,
  page,
  context,
  onNavigate,
  className = '',
  compact = true,
}: InlineNodeBreadcrumbsProps) {
  const breadcrumbs = useMemo((): BreadcrumbItem[] => {
    const items: BreadcrumbItem[] = [];

    if (!node.is_page) {
      if (page) {
        items.push({
          id: page.id,
          name: nodeNameToText(page.name) || 'Untitled',
          icon: page.icon,
          isPage: true,
        });
      } else if (node.page_id && node.page_name) {
        items.push({
          id: node.page_id,
          name: node.page_name,
          icon: null,
          isPage: true,
        });
      }
    }

    return items;
  }, [node, page]);

  if (breadcrumbs.length === 0 && !context) return null;

  return (
    <nav
      className={`node-breadcrumbs node-breadcrumbs--inline ${compact ? 'node-breadcrumbs--compact' : ''} ${className}`}
      aria-label="Node path"
    >
      {breadcrumbs.map((item, index) => (
        <NodeBreadcrumbsElement
          key={item.id}
          item={item}
          onClick={() => onNavigate?.(item.id, item.isPage ? 'page' : 'block')}
          showSeparator={index < breadcrumbs.length - 1 || !!context}
        />
      ))}
      {context && (
        <span className="node-breadcrumb-item node-breadcrumb-context">
          <span className="node-breadcrumb-context-text">{context}</span>
        </span>
      )}
    </nav>
  );
}

export default NodeBreadcrumbs;
