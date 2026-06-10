/**
 * NodeBreadcrumbs Components
 *
 * Three-component architecture for breadcrumb navigation:
 * - NodeBreadcrumbsElement: Individual breadcrumb item (navigate + edit affordance)
 * - NodeBreadcrumbsList: Renders a list of breadcrumb elements (also used as popup)
 * - NodeBreadcrumbs: Main container with overflow detection and collapse
 *
 * Shows the FULL ancestor chain. When items don't fit, collapses to:
 * [first] [second] [...] [second-to-last] [last]
 * Clicking "..." opens a popup with the hidden items.
 *
 * Editing:
 * - Hovering a breadcrumb item reveals a chevron-down affordance.
 * - Clicking the affordance opens a NodeSelector popover so the user can
 *   reassign that ancestor's parent.
 * - Right-clicking a breadcrumb item opens a context menu with "Edit parent"
 *   and "Remove parent" actions.
 * - When the current node has no ancestors, an "+ Add parent" button is shown.
 *
 * Cache invalidation:
 * - Changing any ancestor's parent_id may affect ALL descendants, so we
 *   broadly invalidate all breadcrumb caches after any parent change.
 */
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useBreadcrumbs, useUpdateNode } from '@/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { Node } from '@/types';
import { ChevronRightIcon, NodeIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { NodeInline } from '@/features/content/components/blocks/NodeInline';
import { NodeSelector } from './NodeSelector';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import './NodeBreadcrumbs.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BreadcrumbItem {
  id: number;
  name: string;
  displayName?: string;
  icon?: string | null;
  isPage: boolean;
  /** If this is a property breadcrumb item */
  isProperty?: boolean;
  /** Property ID for property items */
  propertyId?: number;
  /** Whether this node's parent is locked */
  parentLocked?: boolean;
  /** Whether the child node's parent is locked (computed — controls edit affordance) */
  childParentLocked?: boolean;
}

// ─── NodeBreadcrumbsElement ───────────────────────────────────────────────────

interface NodeBreadcrumbsElementProps {
  item: BreadcrumbItem;
  onClick: (item: BreadcrumbItem) => void;
  /** Whether to show the separator chevron after this element */
  showSeparator?: boolean;
  /** Called when the edit-parent affordance (dropdown arrow) is clicked */
  onEditParent?: (item: BreadcrumbItem, anchorEl: HTMLElement) => void;
  /** Called when the element is right-clicked */
  onContextMenu?: (item: BreadcrumbItem, x: number, y: number) => void;
}

/**
 * Individual breadcrumb element — renders a single clickable breadcrumb.
 * On hover, reveals a chevron-down affordance for editing the parent of this node.
 */
function NodeBreadcrumbsElement({
  item,
  onClick,
  showSeparator = true,
  onEditParent,
  onContextMenu,
}: NodeBreadcrumbsElementProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const anchor = wrapperRef.current;
    if (anchor && onEditParent) onEditParent(item, anchor);
  }, [item, onEditParent]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(item, e.clientX, e.clientY);
  }, [item, onContextMenu]);

  return (
    <span ref={wrapperRef} className="node-breadcrumb-item" onContextMenu={handleContextMenu}>
      <NodeInline
        name={item.name}
        displayText={item.displayName}
        icon={item.icon}
        showBullet={!!item.icon}
        propertyName={item.isProperty ? item.name : undefined}
        onClick={() => onClick(item)}
        className={`node-breadcrumb-link ${item.isProperty ? 'node-breadcrumb-property' : ''}`}
      />
      {onEditParent && !item.isProperty && !item.childParentLocked && (
        <Button
          icon={"mdi mdi-chevron-down"}
          variant="ghost"
          size="xs"
          className="node-breadcrumb-edit-btn hover-reveal"
          onClick={handleEditClick}
          aria-label="Change parent"
          title="Change parent"
        />
      )}
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
  onEditParent?: (item: BreadcrumbItem, anchorEl: HTMLElement) => void;
  onContextMenu?: (item: BreadcrumbItem, x: number, y: number) => void;
}

/**
 * Renders a list of breadcrumb elements.
 * In 'popup' variant, renders as a floating dropdown card.
 * In 'inline' variant, renders items inline (used within main breadcrumbs).
 */
function NodeBreadcrumbsList({ items, onClick, variant = 'inline', onEditParent, onContextMenu }: NodeBreadcrumbsListProps) {
  if (variant === 'popup') {
    return (
      <div className="node-breadcrumbs-popup">
        {items.map((item) => (
          <button
            key={item.isProperty ? `prop-${item.id}` : item.id}
            className={`node-breadcrumbs-popup-item ${item.isProperty ? 'node-breadcrumb-property' : ''}`}
            onClick={() => onClick(item)}
          >
            {item.icon && <NodeIcon icon={item.icon} size="xs" className="node-breadcrumb-popup-icon" />}
            <span className="node-breadcrumb-popup-name">{item.isProperty ? item.name : (item.displayName || nodeNameToText(item.name) || 'Untitled')}</span>
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
          onEditParent={onEditParent}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

// ─── Ancestor chain hook ─────────────────────────────────────────────────────

/**
 * Fetches the ancestor chain for a node using the dedicated breadcrumbs API.
 * Returns breadcrumb items from root ancestor → immediate parent
 * (the current node itself is excluded by the API).
 *
 * For blocks: stops at the containing page.
 * Uses the closure table for O(1) lookup — a single API call regardless of depth.
 */
function useAncestorChain(nodeId: number | null, nodeType: 'page' | 'block'): { items: BreadcrumbItem[]; isPending: boolean } {
  const { data: breadcrumbs, isPending } = useBreadcrumbs(nodeId);

  const items = useMemo(() => {
    if (!breadcrumbs || breadcrumbs.length === 0) return [];

    const chain: BreadcrumbItem[] = [];
    for (const item of breadcrumbs) {
      chain.push({
        id: item.id,
        name: item.name || '',
        displayName: item.display_name || undefined,
        icon: item.icon,
        isPage: item.is_page,
        parentLocked: item.parent_locked,
      });
    }

    return chain;
  }, [breadcrumbs, nodeType]);

  return { items, isPending: isPending && !!nodeId };
}

// ─── NodeBreadcrumbs (main) ──────────────────────────────────────────────────

interface NodeBreadcrumbsProps {
  /** The node to show breadcrumbs for */
  nodeId: number;
  /** Type of node (affects how breadcrumbs are built) */
  nodeType: 'page' | 'block';
  /** Callback when clicking a breadcrumb item */
  onNavigate?: (nodeId: number) => void;
  /** Callback when clicking a property breadcrumb item */
  onNavigateToProperty?: (propertyId: number) => void;
  /** Property context for when viewing a block from a text property */
  propertyContext?: { propertyId: number; propertyName: string } | null;
  /** When true, only show ancestors below the page level (intermediate blocks) */
  stopAtPageLevel?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Whether the current node's parent is locked (disables parent editing) */
  parentLocked?: boolean;
  /** Whether parent-chain editing (add/change/remove parent) is enabled. Only the node view top bar should set this to true. */
  editable?: boolean;
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
  stopAtPageLevel = false,
  className = '',
  parentLocked = false,
  editable = false,
}: NodeBreadcrumbsProps) {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const containerRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const ellipsisRef = useRef<HTMLButtonElement>(null);
  const addParentRef = useRef<HTMLButtonElement>(null);

  // ─── Parent editing state ─────────────────────────────────────────────
  const [pickerState, setPickerState] = useState<{
    targetNodeId: number;
    currentParentId: number | null;
    anchorEl: HTMLElement;
  } | null>(null);
  const [contextMenuState, setContextMenuState] = useState<{
    item: BreadcrumbItem;
    x: number;
    y: number;
  } | null>(null);

  const updateNode = useUpdateNode();
  const queryClient = useQueryClient();

  // Walk the full ancestor chain (stops at page for blocks)
  const { items: ancestorBreadcrumbs, isPending: breadcrumbsPending } = useAncestorChain(nodeId, nodeType);

  // Build final breadcrumbs including property context
  const breadcrumbs = useMemo(() => {
    let items = [...ancestorBreadcrumbs];

    // When stopAtPageLevel, strip the page and all ancestors above it
    if (stopAtPageLevel) {
      let lastPageIndex = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].isPage) { lastPageIndex = i; break; }
      }
      if (lastPageIndex >= 0) {
        items = items.slice(lastPageIndex + 1);
      }
    }

    // If we have property context, insert it after the last page (or at the end)
    if (propertyContext && nodeType === 'block') {
      let insertAt = items.length;
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

    // Compute childParentLocked for each item: whether the child in the chain has a locked parent.
    // The child of items[i] is items[i+1], except for the last item whose child is nodeId.
    for (let i = 0; i < items.length; i++) {
      items[i].childParentLocked = i < items.length - 1
        ? items[i + 1].parentLocked
        : parentLocked;
    }

    return items;
  }, [ancestorBreadcrumbs, propertyContext, nodeType, stopAtPageLevel, parentLocked]);

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
        onNavigate?.(item.id);
      }
    },
    [onNavigate, onNavigateToProperty],
  );

  // ─── Parent editing handlers ──────────────────────────────────────────
  /** Broad breadcrumb cache invalidation — all ancestors of any node may be stale */
  const invalidateBreadcrumbs = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'breadcrumbs'], refetchType: 'active' });
  }, [queryClient]);

  /**
   * Opens the picker to change the parent of the CHILD of `item`.
   * The child is the next breadcrumb in the chain, or nodeId for the last breadcrumb.
   * The current parent of the child IS `item` itself.
   */
  const handleEditParent = useCallback((item: BreadcrumbItem, anchorEl: HTMLElement) => {
    if (item.isProperty || item.childParentLocked) return;
    const idx = breadcrumbs.findIndex((b) => b.id === item.id);
    const childNodeId = idx < breadcrumbs.length - 1 ? breadcrumbs[idx + 1].id : nodeId;
    setPickerState({ targetNodeId: childNodeId, currentParentId: item.id, anchorEl });
  }, [breadcrumbs, nodeId]);

  /** Called when the picker selects a new parent (or null to remove) */
  const handlePickerSelect = useCallback((val: number | number[] | null) => {
    if (!pickerState) return;
    const newParentId = typeof val === 'number' ? val : null;
    const { targetNodeId } = pickerState;
    setPickerState(null);
    updateNode.mutate(
      { id: targetNodeId, data: { parent_id: newParentId } },
      { onSuccess: invalidateBreadcrumbs },
    );
  }, [pickerState, updateNode, invalidateBreadcrumbs]);

  /** Right-click on a breadcrumb element */
  const handleBreadcrumbContextMenu = useCallback((item: BreadcrumbItem, x: number, y: number) => {
    if (item.isProperty || item.childParentLocked) return;
    setContextMenuState({ item, x, y });
  }, []);

  /** Context menu items for editing/removing a breadcrumb's parent */
  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenuState) return [];
    const { item } = contextMenuState;
    return [
      {
        id: 'edit-parent',
        label: 'Edit parent…',
        onClick: () => {
          const anchorEl =
            (document.elementFromPoint(contextMenuState.x, contextMenuState.y) as HTMLElement | null) ??
            document.body;
          setContextMenuState(null);
          handleEditParent(item, anchorEl);
        },
      },
      {
        id: 'remove-parent',
        label: 'Remove parent',
        danger: true,
        onClick: () => {
          setContextMenuState(null);
          const idx = breadcrumbs.findIndex((b) => b.id === item.id);
          const childNodeId = idx < breadcrumbs.length - 1 ? breadcrumbs[idx + 1].id : nodeId;
          updateNode.mutate(
            { id: childNodeId, data: { parent_id: null } },
            { onSuccess: invalidateBreadcrumbs },
          );
        },
      },
    ];
  }, [contextMenuState, handleEditParent, updateNode, invalidateBreadcrumbs]);

  // ─── Splitting for overflow ──────────────────────────────────────────
  const needsCollapse = isOverflowing && breadcrumbs.length > VISIBLE_START + VISIBLE_END;
  const startItems = needsCollapse ? breadcrumbs.slice(0, VISIBLE_START) : breadcrumbs;
  const hiddenItems = needsCollapse
    ? breadcrumbs.slice(VISIBLE_START, breadcrumbs.length - VISIBLE_END)
    : [];
  const endItems = needsCollapse
    ? breadcrumbs.slice(breadcrumbs.length - VISIBLE_END)
    : [];

  // ─── "+ Add parent" affordance (pages only, when no ancestors) ───────
  // Show a small spinner while breadcrumbs are loading to avoid flashing the "Add parent" button
  if (breadcrumbsPending) {
    return <span className="node-breadcrumb-spinner" />;
  }

  if (breadcrumbs.length === 0 && nodeType === 'page' && !parentLocked && editable) {
    return (
      <>
        <Button
          ref={addParentRef}
          icon={"mdi mdi-plus"}
          variant="ghost"
          size="xs"
          className="node-breadcrumb-add-parent"
          title="Add parent"
          onClick={() => {
            if (addParentRef.current) {
              setPickerState({ targetNodeId: nodeId, currentParentId: null, anchorEl: addParentRef.current });
            }
          }}
          aria-label="Add parent page"
        />
        {pickerState && pickerState.targetNodeId === nodeId && (
          <NodeSelector
            anchorEl={pickerState.anchorEl}
            onClose={() => setPickerState(null)}
            searchMode="pages"
            excludeNodeId={pickerState.targetNodeId}
            searchPlaceholder="Search pages..."
            onChange={handlePickerSelect}
            allowCreate
          />
        )}
      </>
    );
  }

  // Don't render if no breadcrumbs (non-page or block)
  if (breadcrumbs.length === 0) return null;

  return (
    <>
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
            onEditParent={editable && nodeType === 'page' ? handleEditParent : undefined}
            onContextMenu={editable && nodeType === 'page' ? handleBreadcrumbContextMenu : undefined}
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
              onEditParent={editable && nodeType === 'page' ? handleEditParent : undefined}
              onContextMenu={editable && nodeType === 'page' ? handleBreadcrumbContextMenu : undefined}
            />
          ))}
      </nav>

      {/* NodeSelector picker portal */}
      {pickerState && (
        <NodeSelector
          anchorEl={pickerState.anchorEl}
          onClose={() => setPickerState(null)}
          searchMode="pages"
          excludeNodeId={pickerState.targetNodeId}
          value={pickerState.currentParentId}
          searchPlaceholder="Search pages..."
          onChange={handlePickerSelect}
          allowCreate={false}
        />
      )}

      {/* Breadcrumb context menu */}
      {contextMenuState && (
        <ContextMenu
          items={contextMenuItems}
          position={{ x: contextMenuState.x, y: contextMenuState.y }}
          onClose={() => setContextMenuState(null)}
        />
      )}
    </>
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
  onNavigate?: (nodeId: number) => void;
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
          onClick={() => onNavigate?.(item.id)}
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

