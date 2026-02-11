/**
 * NodeListView Component
 * 
 * List/outline view for NodeCollection.
 * Displays nodes as a recursive bullet list with indentation.
 * 
 * Features:
 * - Bullet points with expand/collapse
 * - Indentation based on depth
 * - Editable: renders Block component
 * - Read-only: renders BlockPreview component
 * - Recursive children handling
 * - Sortable mode with drag-and-drop reordering
 * - Breadcrumbs for top-level nodes (showing page hierarchy)
 * - GroupBy support: groups blocks by page (pages shown as collapsed headers)
 * - Local collapse state for page nodes and level-2 blocks (cosmetic, not persisted)
 */
import { useCallback, useMemo, useState } from 'react';
import { mdiArrowRight, mdiDockRight } from '@mdi/js';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import type { ContextMenuItem } from '../../core/ContextMenu';
import { Bullet } from '../../blocks/Bullet';
import { NodeInline } from '../../blocks/NodeInline';
import { NoteesEditor } from '@/editor/NoteesEditor';
import { Button } from '../../core/Button';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import { InlineNodeBreadcrumbs } from '../NodeBreadcrumbs';
import { ListSortable } from '../../core/ListSortable';
import { useNodesStore, useSettingsStore } from '@/stores';
import { sortNodes, compareNodes } from '@/utils/sorting';
import { findNodeById } from '@/utils/nodeTree';
import './NodeListView.css';

/**
 * Recursively filter a node tree to only include pages.
 * Returns a new tree where each node's children only contains pages.
 */
function filterPagesRecursively(nodes: Node[]): Node[] {
  return nodes
    .filter(n => n.is_page)
    .map(n => ({
      ...n,
      children: n.children ? filterPagesRecursively(n.children) : undefined,
    }));
}

/**
 * Group blocks by their page_id
 * Returns: { pages: sorted page nodes, groups: array of { page, blocks } }
 * 
 * Uses page_name/page_uuid from nodes when pageMap is not available
 * (query results include these fields from the server-side join)
 */
function groupBlocksByPage(
  nodes: Node[],
  pageMap?: Map<number, Node>
): {
  pages: Node[];
  groups: { page: Node | null; blocks: Node[] }[];
} {
  // Separate pages from blocks
  const pageNodes: Node[] = [];
  const blockNodes: Node[] = [];
  
  for (const node of nodes) {
    if (node.is_page) {
      pageNodes.push(node);
    } else {
      blockNodes.push(node);
    }
  }
  
  // Build a combined page map from pageMap and pageNodes
  const combinedPageMap = new Map<number, Node>();
  
  // Add from provided pageMap
  if (pageMap) {
    for (const [id, page] of pageMap.entries()) {
      combinedPageMap.set(id, page);
    }
  }
  
  // Add pages from the nodes array (overwrite if already exists)
  for (const page of pageNodes) {
    combinedPageMap.set(page.id, page);
  }
  
  // Group blocks by page_id
  const groupMap = new Map<number | null, Node[]>();
  for (const block of blockNodes) {
    const pageId = block.page_id ?? null;
    const existing = groupMap.get(pageId);
    if (existing) {
      existing.push(block);
    } else {
      groupMap.set(pageId, [block]);
    }
  }
  
  // Convert to array with page nodes and sort
  const groups: { page: Node | null; blocks: Node[] }[] = [];
  for (const [pageId, blocks] of groupMap.entries()) {
    // Try to get page from combined map first
    let page: Node | null = pageId !== null ? combinedPageMap.get(pageId) ?? null : null;
    
    // If still not found, construct a minimal page object from the first block's page_name
    if (!page && pageId !== null && blocks.length > 0) {
      const firstBlock = blocks[0];
      if (firstBlock.page_name) {
        page = {
          id: pageId,
          uuid: firstBlock.page_uuid ?? '',
          name: firstBlock.page_name,
          icon: null,
          color: null,
          parent_id: null,
          page_id: null,
          is_page: true,
          sequence: 0,
          collapsed: false,
          active: true,
          create_date: '',
          write_date: '',
        };
      }
    }
    
    groups.push({ page, blocks });
  }
  
  // Sort groups by page (using compareNodes for smart date handling)
  groups.sort((a, b) => {
    // Nulls (no page) come last
    if (!a.page && !b.page) return 0;
    if (!a.page) return 1;
    if (!b.page) return -1;
    return compareNodes(a.page, b.page);
  });
  
  return {
    pages: sortNodes(pageNodes),
    groups,
  };
}

interface NodeListItemProps {
  node: Node;
  depth: number;
  /** Initial depth when this list view was started (for calculating relative depth) */
  initialDepth?: number;
  editable: boolean;
  maxDepth: number;
  showBullets: boolean;
  showIndentation: boolean;
  showBreadcrumbs: boolean;
  showClasses: boolean;
  pagesOnly: boolean;
  siblings: Node[];
  parentBlock?: Node | null;
  page?: Node | null;
  context?: string;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  isolatedBlockState?: boolean;
  /** Suppress color styling on this block (used when color is applied at container level) */
  suppressColor?: boolean;
  /** Custom context menu items generator */
  customContextMenuItems?: (node: Node, closeMenu: () => void) => ContextMenuItem[];
  /** Set of locally expanded node IDs (for cosmetic collapse state of pages and level-2 blocks) */
  localExpandedNodes?: Set<number>;
  /** Callback to toggle local node collapse state */
  onToggleNodeCollapse?: (nodeId: number) => void;
  /** Whether auto-collapse is enabled (default: false) */
  autoCollapse?: boolean;
}

function NodeListItem({
  node,
  depth,
  initialDepth: initialDepthProp,
  editable,
  maxDepth,
  showBullets,
  showIndentation,
  showBreadcrumbs,
  showClasses,
  pagesOnly,
  siblings,
  parentBlock,
  page,
  context,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  isolatedBlockState = false,
  suppressColor = false,
  customContextMenuItems,
  localExpandedNodes,
  onToggleNodeCollapse,
  autoCollapse = false,
}: NodeListItemProps) {
  // Track initial depth for relative depth calculation
  const initialDepth = initialDepthProp ?? depth;
  const relativeDepth = depth - initialDepth;
  
  // Get collapse level setting (0 = disabled) - only used when autoCollapse is true
  const collapseLevel = useSettingsStore((state) => state.linkedRefsCollapseLevel);
  
  // Recursively apply collapsed override to the entire subtree
  // Only applies when autoCollapse is enabled
  // Pages and blocks at relativeDepth >= collapseLevel should be collapsed by default (use local state)
  const applyCollapsedOverride = useCallback((n: Node, nodeDepth: number): Node => {
    // If auto-collapse is disabled or collapse level is 0, don't apply any overrides
    if (!autoCollapse || collapseLevel === 0) return n;
    
    const nodeRelativeDepth = nodeDepth - initialDepth;
    const shouldUseLocalState = (n.is_page || nodeRelativeDepth >= collapseLevel) && localExpandedNodes && onToggleNodeCollapse;
    
    const overriddenNode = shouldUseLocalState
      ? { ...n, collapsed: !localExpandedNodes.has(n.id) }
      : n;
    
    // Recursively process children
    if (overriddenNode.children && overriddenNode.children.length > 0) {
      return {
        ...overriddenNode,
        children: overriddenNode.children.map(child => applyCollapsedOverride(child, nodeDepth + 1)),
      };
    }
    
    return overriddenNode;
  }, [initialDepth, collapseLevel, autoCollapse, localExpandedNodes, onToggleNodeCollapse]);
  
  // Apply collapsed override to current node and all descendants
  const effectiveNode = useMemo(() => {
    return applyCollapsedOverride(node, depth);
  }, [node, depth, applyCollapsedOverride]);
  
  // Get children from effective node (already has collapsed overrides applied)
  // When pagesOnly is true, recursively filter the entire subtree so Block gets a fully filtered tree
  const children = useMemo(() => {
    const nodeChildren = effectiveNode.children ?? [];
    return pagesOnly ? filterPagesRecursively(nodeChildren) : nodeChildren;
  }, [effectiveNode.children, pagesOnly]);
  
  const shouldRenderChildren = depth < maxDepth && children.length > 0;

  // Handlers
  const handleNavigateToNode = useCallback((linkId: string) => {
    const id = Number(linkId);
    if (isNaN(id)) return;
    if (id === node.id) {
      onNodeClick?.(node);
    } else {
      const childNode = findNodeById(id, children);
      if (childNode) {
        onNodeClick?.(childNode);
      } else {
        onNodeClick?.({ id, is_page: false } as Node);
      }
    }
  }, [node, children, onNodeClick]);

  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    const id = Number(blockId);
    if (!isNaN(id)) {
      onContentChange?.(id, content);
    }
  }, [onContentChange]);
  
  // Handle collapse toggle for pages and configurable level blocks - use local state instead of persisting
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    // If auto-collapse is disabled, don't intercept
    if (!autoCollapse || collapseLevel === 0) return;
    
    if ((node.is_page || relativeDepth >= collapseLevel) && onToggleNodeCollapse) {
      e.preventDefault();
      e.stopPropagation();
      onToggleNodeCollapse(node.id);
    }
  }, [node.is_page, node.id, relativeDepth, autoCollapse, collapseLevel, onToggleNodeCollapse]);

  // Breadcrumbs element (shared between editable and read-only)
  const breadcrumbsElement = showBreadcrumbs && depth === 0 && !node.is_page && (page || context || (node.page_id && node.page_name)) ? (
    <InlineNodeBreadcrumbs
      node={node}
      page={page}
      context={context}
      onNavigate={(nodeId, nodeType) => {
        if (nodeType === 'page') {
          const pageNode = page && page.id === nodeId ? page : { id: nodeId } as Node;
          onNodeClick?.(pageNode);
        }
      }}
      compact={true}
    />
  ) : null;

  // Editable mode: render NoteesEditor for the block subtree
  if (editable) {
    return (
      <div className="node-list-item-wrapper">
        {breadcrumbsElement}
        <NoteesEditor
          editorId={`list-${effectiveNode.id}`}
          rootBlockId={String(effectiveNode.uuid || effectiveNode.id)}
          viewMode="list"
          readOnly={false}
          onNavigateToNode={handleNavigateToNode}
          onContentChange={handleContentChangeBridge}
        />
      </div>
    );
  }

  // Read-only mode: lightweight rendering with NodeInline + recursive children
  return (
    <div className="node-list-item-wrapper">
      {breadcrumbsElement}
      <div className="node-list-item" style={showIndentation && depth > 0 ? { paddingLeft: `${depth * 1.5}rem` } : undefined}>
        <div className="node-list-item__row">
          {showBullets && (
            <Bullet
              nodeId={effectiveNode.id}
              icon={effectiveNode.icon}
              isPage={effectiveNode.is_page}
              interactive={true}
              hasChildren={children.length > 0}
              collapsed={effectiveNode.collapsed}
              onClick={() => onNodeClick?.(effectiveNode)}
              onShiftClick={() => onNodeShiftClick?.(effectiveNode)}
              onCollapseToggle={autoCollapse && collapseLevel > 0 && (node.is_page || relativeDepth >= collapseLevel) && onToggleNodeCollapse ? handleCollapseToggle : undefined}
              size="sm"
            />
          )}
          <NodeInline
            name={effectiveNode.name}
            icon={!showBullets ? effectiveNode.icon : undefined}
            isPage={effectiveNode.is_page}
            nodeId={effectiveNode.id}
            onClick={() => onNodeClick?.(effectiveNode)}
            onShiftClick={() => onNodeShiftClick?.(effectiveNode)}
            className="node-list-item__content"
          />
        </div>
        {shouldRenderChildren && !effectiveNode.collapsed && (
          <div className="node-list-item__children">
            {children.map(child => (
              <NodeListItem
                key={child.id}
                node={child}
                depth={depth + 1}
                initialDepth={initialDepthProp ?? depth}
                editable={false}
                maxDepth={maxDepth}
                showBullets={showBullets}
                showIndentation={showIndentation}
                showBreadcrumbs={false}
                showClasses={showClasses}
                pagesOnly={pagesOnly}
                siblings={children}
                parentBlock={effectiveNode}
                onNodeClick={onNodeClick}
                onNodeShiftClick={onNodeShiftClick}
                onContentChange={onContentChange}
                localExpandedNodes={localExpandedNodes}
                onToggleNodeCollapse={onToggleNodeCollapse}
                autoCollapse={autoCollapse}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * GroupHeader - Renders a page as a group header using BlockPreview
 * Treats the page as a "parent" with collapsible children
 */
interface GroupHeaderProps {
  page: Node | null;
  pageId: number | null;
  blocks: Node[];
  editable: boolean;
  maxDepth: number;
  showBullets: boolean;
  showIndentation: boolean;
  showBreadcrumbs: boolean;
  showClasses: boolean;
  pagesOnly: boolean;
  pageMap?: Map<number, Node>;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  isolatedBlockState?: boolean;
  customContextMenuItems?: (node: Node, closeMenu: () => void) => ContextMenuItem[];
  localExpandedNodes?: Set<number>;
  onToggleNodeCollapse?: (nodeId: number) => void;
  initialDepth?: number;
  autoCollapse?: boolean;
}

function GroupHeader({
  page,
  pageId,
  blocks,
  editable,
  maxDepth,
  showBullets,
  showIndentation,
  showBreadcrumbs,
  showClasses,
  pagesOnly,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  isolatedBlockState = false,
  customContextMenuItems,
  localExpandedNodes,
  onToggleNodeCollapse,
  initialDepth,
  autoCollapse = false,
}: GroupHeaderProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const openNode = useNodesStore(state => state.openNode);
  const addSidebarCard = useNodesStore(state => state.addSidebarCard);
  
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCollapsed(prev => !prev);
  }, []);

  return (
    <div className={`node-list-group ${isCollapsed ? 'node-list-group--collapsed' : ''}`}>
      {/* Group header - page as parent with collapse arrow */}
      <div className="node-list-group__header">
        {/* Collapse arrow */}
        {blocks.length > 0 && (
          <button
            className="node-list-group__collapse-arrow"
            onClick={handleCollapseToggle}
            title={isCollapsed ? 'Expand' : 'Collapse'}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? <ChevronRightIcon size="xs" /> : <ChevronDownIcon size="xs" />}
          </button>
        )}
        {page ? (
          <NodeInline
            name={page.name}
            icon={page.icon}
            isPage={page.is_page}
            nodeId={page.id}
            showIcon={true}
            onClick={() => onNodeClick?.(page)}
            onShiftClick={() => onNodeShiftClick?.(page)}
            className="node-list-group__page-header"
          />
        ) : (
          <span className="node-list-group__no-page-label">
            {pageId !== null ? `Page #${pageId} (unavailable)` : 'Unknown Page'}
          </span>
        )}
        {/* Navigation buttons - shown on hover */}
        {page && (
          <div className="node-list-group__actions">
            <Button
              icon={mdiDockRight}
              variant="ghost"
              size="xs"
              title="Open in sidebar"
              onClick={(e) => {
                e.stopPropagation();
                addSidebarCard(page.id, page.is_page ? 'page' : 'block');
              }}
            />
            <Button
              icon={mdiArrowRight}
              variant="ghost"
              size="xs"
              title="Open node"
              onClick={(e) => {
                e.stopPropagation();
                openNode(page.id, page.is_page ? 'page' : 'block');
              }}
            />
          </div>
        )}
      </div>
      
      {/* Group children - blocks indented as if children of the page */}
      {!isCollapsed && (
        <div className="node-list-group__children">
          {blocks.map((block) => (
            <NodeListItem
              key={block.id}
              node={block}
              depth={1} // Start at depth 1 since page header is depth 0
              initialDepth={1} // Track initial depth for relative level-2 calculation
              editable={editable}
              maxDepth={maxDepth}
              showBullets={showBullets}
              showIndentation={showIndentation}
              showBreadcrumbs={showBreadcrumbs}
              showClasses={showClasses}
              pagesOnly={pagesOnly}
              siblings={blocks}
              parentBlock={page}
              page={page}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContentChange={onContentChange}
              isolatedBlockState={isolatedBlockState}
              customContextMenuItems={customContextMenuItems}
              localExpandedNodes={localExpandedNodes}
              onToggleNodeCollapse={onToggleNodeCollapse}
              autoCollapse={autoCollapse}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * NodeListView - List/outline view for NodeCollection
 */
export function NodeListView({
  nodes,
  editable,
  depth = 0,
  maxDepth = Infinity,
  showBullets = true,
  showIndentation = true,
  showBreadcrumbs = true,
  showClasses = false,
  pagesOnly = false,
  sortable = false,
  onReorder,
  renderItemAction,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  pageMap,
  groupBy = 'page',
  enableGrouping = false,
  className = '',
  isolatedBlockState = false,
  suppressRootColor = false,
  customContextMenuItems,
  autoCollapse = false,
}: NodeListViewProps) {
  // Local state for cosmetically collapsed nodes (pages and configurable level blocks)
  // Only used when autoCollapse is true
  // These are always collapsed on load, but users can temporarily expand them
  const [localExpandedNodes, setLocalExpandedNodes] = useState<Set<number>>(new Set());
  
  // Store the initial depth for this NodeListView instance
  const initialDepth = useMemo(() => depth, []);
  
  // Toggle node collapse state locally (only active when autoCollapse is true)
  const handleToggleNodeCollapse = useCallback((nodeId: number) => {
    if (!autoCollapse) return;
    setLocalExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, [autoCollapse]);
  
  // If sortable, use ListSortable wrapper (no grouping in sortable mode)
  if (sortable && onReorder) {
    return (
      <ListSortable
        items={nodes.map(n => ({ id: n.id, node: n }))}
        onReorder={onReorder}
        onItemClick={(item) => onNodeClick?.(item.node)}
        className={`node-list-view node-list-view--sortable ${className}`}
        itemClassName="node-list-view__sortable-item"
        showDragHandle={true}
        renderIcon={(item) => (
          <Bullet
            nodeId={item.node.id}
            icon={item.node.icon}
            isPage={item.node.is_page}
            interactive={false}
            size="sm"
          />
        )}
        renderText={(item) => (
          <span className="node-list-view__item-name">
            {item.node.name || 'Untitled'}
          </span>
        )}
        renderAction={renderItemAction 
          ? (item, index) => renderItemAction(item.node, index)
          : undefined
        }
      />
    );
  }

  // Filter top-level nodes if pagesOnly is set
  const filteredNodes = pagesOnly ? nodes.filter(n => n.is_page) : nodes;

  // Group by page mode (only when grouping is enabled)
  if (enableGrouping && groupBy === 'page') {
    const { pages, groups } = groupBlocksByPage(filteredNodes, pageMap);
    
    return (
      <div className={`node-list-view node-list-view--grouped ${className}`}>
        {/* Render standalone pages first (sorted) */}
        {pages.length > 0 && (
          <div className="node-list-view__pages-section">
            {pages.map((node) => (
              <NodeListItem
                key={node.id}
                node={node}
                depth={depth}
                initialDepth={initialDepth} // Track initial depth for relative level-2 calculation
                editable={editable}
                maxDepth={maxDepth}
                showBullets={showBullets}
                showIndentation={showIndentation}
                showBreadcrumbs={showBreadcrumbs}
                showClasses={showClasses}
                pagesOnly={pagesOnly}
                siblings={pages}
                parentBlock={null}
                onNodeClick={onNodeClick}
                onNodeShiftClick={onNodeShiftClick}
                onContentChange={onContentChange}
                isolatedBlockState={isolatedBlockState}
                customContextMenuItems={customContextMenuItems}
                localExpandedNodes={localExpandedNodes}
                onToggleNodeCollapse={handleToggleNodeCollapse}
                autoCollapse={autoCollapse}
              />
            ))}
          </div>
        )}
        
        {/* Render grouped blocks */}
        {groups.map(({ page, blocks }) => (
          <GroupHeader
            key={page?.id ?? 'no-page'}
            page={page}
            pageId={blocks[0]?.page_id ?? null}
            blocks={blocks}
            editable={editable}
            maxDepth={maxDepth}
            showBullets={showBullets}
            showIndentation={showIndentation}
            showBreadcrumbs={showBreadcrumbs}
            showClasses={showClasses}
            pagesOnly={pagesOnly}
            pageMap={pageMap}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            isolatedBlockState={isolatedBlockState}
            customContextMenuItems={customContextMenuItems}
            localExpandedNodes={localExpandedNodes}
            onToggleNodeCollapse={handleToggleNodeCollapse}
            autoCollapse={autoCollapse}
          />
        ))}
      </div>
    );
  }

  // No grouping - regular non-sortable list
  return (
    <div className={`node-list-view ${className}`}>
      {filteredNodes.map((node, index) => {
        // Get page from pageMap if available
        const page = node.page_id && pageMap ? pageMap.get(node.page_id) : undefined;
        
        // Suppress color on first node when suppressRootColor is set
        const shouldSuppressColor = suppressRootColor && index === 0 && depth === 0;
        
        return (
          <NodeListItem
            key={node.id}
            node={node}
            depth={depth}
            initialDepth={initialDepth} // Track initial depth for relative level-2 calculation
            editable={editable}
            maxDepth={maxDepth}
            showBullets={showBullets}
            showIndentation={showIndentation}
            showBreadcrumbs={showBreadcrumbs}
            showClasses={showClasses}
            pagesOnly={pagesOnly}
            siblings={filteredNodes}
            parentBlock={null}
            page={page}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            isolatedBlockState={isolatedBlockState}
            suppressColor={shouldSuppressColor}
            customContextMenuItems={customContextMenuItems}
            localExpandedNodes={localExpandedNodes}
            onToggleNodeCollapse={handleToggleNodeCollapse}
            autoCollapse={autoCollapse}
          />
        );
      })}
    </div>
  );
}
