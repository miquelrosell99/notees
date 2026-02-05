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
 */
import { useCallback, useMemo, useState } from 'react';
import { mdiArrowRight, mdiDockRight } from '@mdi/js';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import type { ContextMenuItem } from '../../core/ContextMenu';
import { Block } from '../../blocks/Block';
import { BlockPreview } from '../../blocks/BlockPreview';
import { Bullet } from '../../blocks/Bullet';
import { Button } from '../../core/Button';
import { ChevronDownIcon, ChevronRightIcon } from '../../icons';
import { InlineNodeBreadcrumbs } from '../NodeBreadcrumbs';
import { PropertiesSection } from '../../PropertiesSection';
import { ListSortable } from '../../core/ListSortable';
import { useBlockCallbacks } from '../../blocks/BlockCallbacksContext';
import { useNodesStore } from '@/stores/nodesStore';
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
}

function NodeListItem({
  node,
  depth,
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
}: NodeListItemProps) {
  const rawChildren = useMemo(() => node.children ?? [], [node.children]);
  // When pagesOnly is true, recursively filter the entire subtree so Block gets a fully filtered tree
  const children = useMemo(() => 
    pagesOnly ? filterPagesRecursively(rawChildren) : rawChildren,
    [rawChildren, pagesOnly]
  );
  const shouldRenderChildren = depth < maxDepth && children.length > 0;
  
  // Get block callbacks from context (only available in editable mode with provider)
  const blockCallbacks = useBlockCallbacks();

  // Handlers
  const handleBulletClick = useCallback((blockId: number) => {
    // If clicking the same node, use it directly
    if (blockId === node.id) {
      onNodeClick?.(node);
    } else {
      // Find the child node in the tree, or create a minimal block node
      const childNode = findNodeById(blockId, children);
      if (childNode) {
        onNodeClick?.(childNode);
      } else {
        // Fallback: create a minimal node object (block, not page)
        onNodeClick?.({ id: blockId, is_page: false } as Node);
      }
    }
  }, [node, children, onNodeClick]);

  const handleShiftClick = useCallback((blockId: number) => {
    if (blockId === node.id) {
      onNodeShiftClick?.(node);
    } else {
      const childNode = findNodeById(blockId, children);
      if (childNode) {
        onNodeShiftClick?.(childNode);
      } else {
        onNodeShiftClick?.({ id: blockId, is_page: false } as Node);
      }
    }
  }, [node, children, onNodeShiftClick]);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Generate custom context menu items if provided
  const generatedContextMenuItems = useMemo(() => {
    if (!customContextMenuItems) return undefined;
    return customContextMenuItems(node, () => {
      // closeMenu callback - handled by Block component internally
    });
  }, [customContextMenuItems, node]);

  // Editable mode: render full Block component
  if (editable) {
    // Build block-specific callbacks from context
    const blockProps = blockCallbacks ? {
      onAddClass: blockCallbacks.onAddClass 
        ? (classNodeId: number, keepInline: boolean, className: string) => 
            blockCallbacks.onAddClass!(node.id, classNodeId, keepInline, className)
        : undefined,
      onAddTag: blockCallbacks.onAddTag
        ? (tagNodeId: number, keepInline: boolean, tagName: string) =>
            blockCallbacks.onAddTag!(node.id, tagNodeId, keepInline, tagName)
        : undefined,
      onCreateClass: blockCallbacks.onCreateClass
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateClass!(node.id, name, keepInline)
        : undefined,
      onCreateTag: blockCallbacks.onCreateTag
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateTag!(node.id, name, keepInline)
        : undefined,
      onCreatePageLink: blockCallbacks.onCreatePageLink,
      onOpenComments: blockCallbacks.onOpenComments
        ? () => blockCallbacks.onOpenComments!(node.id)
        : undefined,
      onAssetUpload: blockCallbacks.onAssetUpload
        ? (assetTypesOrFile?: ('image' | 'audio' | 'file')[] | File) =>
            blockCallbacks.onAssetUpload!(node.id, assetTypesOrFile)
        : undefined,
      onOpenBacklinks: blockCallbacks.onOpenBacklinks
        ? () => blockCallbacks.onOpenBacklinks!(node.id)
        : undefined,
      commentCount: blockCallbacks.getCommentCount?.(node) ?? node.comment_count ?? 0,
      backlinkCount: blockCallbacks.getBacklinkCount?.(node) ?? node.backlink_count ?? 0,
    } : {};

    return (
      <div className="node-list-item-wrapper">
        {/* Breadcrumbs for top-level items */}
        {showBreadcrumbs && depth === 0 && !node.is_page && (page || context || (node.page_id && node.page_name)) && (
          <InlineNodeBreadcrumbs
            node={node}
            page={page}
            context={context}
            onNavigate={(nodeId, nodeType) => {
              if (nodeType === 'page') {
                // Create a minimal page node to pass to onNodeClick
                const pageNode = page && page.id === nodeId ? page : { 
                  id: nodeId
                } as Node;
                onNodeClick?.(pageNode);
              }
            }}
            compact={true}
          />
        )}
        <Block
          block={node}
          children={children}
          siblings={siblings}
          depth={showIndentation ? depth : 0}
          parentId={node.parent_id}
          parentBlock={parentBlock}
          onContentChange={handleContentChange}
          onBulletClick={handleBulletClick}
          onShiftClick={handleShiftClick}
          showBullet={showBullets}
          showClasses={showClasses}
          isolatedState={isolatedBlockState}
          suppressColor={suppressColor}
          customContextMenuItems={generatedContextMenuItems}
          {...blockProps}
        />
        {/* Show properties section for property-type linked references */}
        {node._linkedRefMetadata?.linkType === 'property' && node._linkedRefMetadata.sourceNodeId && (
          <PropertiesSection
            nodeId={node._linkedRefMetadata.sourceNodeId}
            variant="block"
            readOnly={true}
            showHiddenSection={false}
            showAddProperty={false}
            filterPropertyIds={node._linkedRefMetadata.propertyId ? [node._linkedRefMetadata.propertyId] : undefined}
            onNavigateToNode={(nodeId) => {
              const targetNode = { id: nodeId } as Node;
              onNodeClick?.(targetNode);
            }}
            onOpenInSidebar={onNodeShiftClick ? (nodeId) => {
              const targetNode = { id: nodeId } as Node;
              onNodeShiftClick?.(targetNode);
            } : undefined}
          />
        )}
      </div>
    );
  }

  // Read-only mode: render Block with children (but no editing capabilities)
  return (
    <div className="node-list-item-wrapper">
      {/* Breadcrumbs for top-level items */}
      {showBreadcrumbs && depth === 0 && !node.is_page && (page || context || (node.page_id && node.page_name)) && (
        <InlineNodeBreadcrumbs
          node={node}
          page={page}
          context={context}
          onNavigate={(nodeId, nodeType) => {
            if (nodeType === 'page') {
              const pageNode = page && page.id === nodeId ? page : { 
                id: nodeId
              } as Node;
              onNodeClick?.(pageNode);
            }
          }}
          compact={true}
        />
      )}
      <Block
        block={node}
        children={children}
        siblings={siblings}
        depth={showIndentation ? depth : 0}
        parentId={node.parent_id}
        parentBlock={parentBlock}
        onBulletClick={() => onNodeClick?.(node)}
        onShiftClick={() => onNodeShiftClick?.(node)}
        showBullet={showBullets}
        showChildren={shouldRenderChildren}
        showClasses={showClasses}
        canMove={false}
        canEdit={false}
        canSelect={false}
        customContextMenuItems={generatedContextMenuItems}
      />
      {/* Show properties section for property-type linked references */}
      {node._linkedRefMetadata?.linkType === 'property' && node._linkedRefMetadata.sourceNodeId && (
        <PropertiesSection
          nodeId={node._linkedRefMetadata.sourceNodeId}
          variant="block"
          readOnly={true}
          showHiddenSection={false}
          showAddProperty={false}
          filterPropertyIds={node._linkedRefMetadata.propertyId ? [node._linkedRefMetadata.propertyId] : undefined}
          onNavigateToNode={(nodeId) => {
            const targetNode = { id: nodeId } as Node;
            onNodeClick?.(targetNode);
          }}
          onOpenInSidebar={onNodeShiftClick ? (nodeId) => {
            const targetNode = { id: nodeId } as Node;
            onNodeShiftClick?.(targetNode);
          } : undefined}
        />
      )}
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
          <BlockPreview
            variant="simple"
            node={page}
            showBullet={false}
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
}: NodeListViewProps) {
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
          />
        );
      })}
    </div>
  );
}
