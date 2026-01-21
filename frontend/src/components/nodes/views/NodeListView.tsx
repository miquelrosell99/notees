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
 */
import { useCallback, useMemo } from 'react';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Block } from '../../blocks/Block';
import { BlockPreview } from '../../blocks/BlockPreview';
import { Bullet } from '../../blocks/Bullet';
import { InlineNodeBreadcrumbs } from '../NodeBreadcrumbs';
import { ListSortable } from '../../core/ListSortable';
import { useBlockCallbacks } from '../../blocks/BlockCallbacksContext';
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

interface NodeListItemProps {
  node: Node;
  depth: number;
  editable: boolean;
  maxDepth: number;
  showBullets: boolean;
  showIndentation: boolean;
  showBreadcrumbs: boolean;
  pagesOnly: boolean;
  siblings: Node[];
  parentBlock?: Node | null;
  page?: Node | null;
  context?: string;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
}

function NodeListItem({
  node,
  depth,
  editable,
  maxDepth,
  showBullets,
  showIndentation,
  showBreadcrumbs,
  pagesOnly,
  siblings,
  parentBlock,
  page,
  context,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
}: NodeListItemProps) {
  const rawChildren = node.children ?? [];
  // When pagesOnly is true, recursively filter the entire subtree so Block gets a fully filtered tree
  const children = useMemo(() => 
    pagesOnly ? filterPagesRecursively(rawChildren) : rawChildren,
    [rawChildren, pagesOnly]
  );
  const shouldRenderChildren = depth < maxDepth && children.length > 0;
  
  // Get block callbacks from context (only available in editable mode with provider)
  const blockCallbacks = useBlockCallbacks();

  // Handlers
  const handleBulletClick = useCallback(() => {
    onNodeClick?.(node);
  }, [node, onNodeClick]);

  const handleShiftClick = useCallback(() => {
    onNodeShiftClick?.(node);
  }, [node, onNodeShiftClick]);

  const handleContentChange = useCallback((blockId: number, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // Editable mode: render full Block component
  if (editable) {
    // Build block-specific callbacks from context
    const blockProps = blockCallbacks ? {
      onAddType: blockCallbacks.onAddType 
        ? (typeNodeId: number, keepInline: boolean, typeName: string) => 
            blockCallbacks.onAddType!(node.id, typeNodeId, keepInline, typeName)
        : undefined,
      onAddTag: blockCallbacks.onAddTag
        ? (tagNodeId: number, keepInline: boolean, tagName: string) =>
            blockCallbacks.onAddTag!(node.id, tagNodeId, keepInline, tagName)
        : undefined,
      onCreateType: blockCallbacks.onCreateType
        ? (name: string, keepInline: boolean) =>
            blockCallbacks.onCreateType!(node.id, name, keepInline)
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
        {showBreadcrumbs && depth === 0 && (page || context) && (
          <InlineNodeBreadcrumbs
            node={node}
            page={page}
            context={context}
            onNavigate={(nodeId, nodeType) => {
              if (nodeType === 'page') {
                // Create a minimal page node to pass to onNodeClick
                const pageNode = page && page.id === nodeId ? page : { 
                  id: nodeId, 
                  is_page: true 
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
          {...blockProps}
        />
      </div>
    );
  }

  // Read-only mode: render BlockPreview with recursive children
  return (
    <div className="node-list-item" style={{ '--depth': showIndentation ? depth : 0 } as React.CSSProperties}>
      {/* Breadcrumbs for top-level items */}
      {showBreadcrumbs && depth === 0 && (page || context) && (
        <InlineNodeBreadcrumbs
          node={node}
          page={page}
          context={context}
          onNavigate={(nodeId, nodeType) => {
            if (nodeType === 'page') {
              const pageNode = page && page.id === nodeId ? page : { 
                id: nodeId, 
                is_page: true 
              } as Node;
              onNodeClick?.(pageNode);
            }
          }}
          compact={true}
        />
      )}
      <BlockPreview
        variant="simple"
        node={node}
        showBullet={showBullets}
        onClick={() => onNodeClick?.(node)}
        onShiftClick={() => onNodeShiftClick?.(node)}
        onBulletClick={() => onNodeClick?.(node)}
      />
      
      {shouldRenderChildren && (
        <div className="node-list-item__children">
          {children.map((child) => (
            <NodeListItem
              key={child.id}
              node={child}
              depth={depth + 1}
              editable={editable}
              maxDepth={maxDepth}
              showBullets={showBullets}
              showIndentation={showIndentation}
              showBreadcrumbs={false}
              pagesOnly={pagesOnly}
              siblings={children}
              parentBlock={node}
              onNodeClick={onNodeClick}
              onNodeShiftClick={onNodeShiftClick}
              onContentChange={onContentChange}
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
  pagesOnly = false,
  sortable = false,
  onReorder,
  renderItemAction,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  pageMap,
  className = '',
}: NodeListViewProps) {
  // If sortable, use ListSortable wrapper
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

  // Regular non-sortable list
  return (
    <div className={`node-list-view ${className}`}>
      {filteredNodes.map((node) => {
        // Get page from pageMap if available
        const page = node.page_id && pageMap ? pageMap.get(node.page_id) : undefined;
        
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
            pagesOnly={pagesOnly}
            siblings={filteredNodes}
            parentBlock={null}
            page={page}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
          />
        );
      })}
    </div>
  );
}
