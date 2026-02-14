/**
 * ListView — List/outline view using Lexical BlockEditor.
 *
 * Uses a SINGLE BlockEditor instance for performance.
 * Passes nodes directly - BlockEditor handles runtime sync internally.
 * 
 * Supports groupBy='page' to organize nodes under page headers.
 */
import { useCallback, useMemo, useId } from 'react';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Bullet } from '../../blocks/Bullet';
import { NodeInline } from '../../blocks/NodeInline';
import { BlockEditor } from '@/editor/BlockEditor';
import { ListSortable } from '../../core/ListSortable';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { sortBySequence } from '@/utils/nodeSort';
import { getNodeByUuid } from '@/api/nodes';
import './ListView.css';

/**
 * ListView - List/outline view using Lexical editor
 *
 * Simply passes nodes to BlockEditor - no manual runtime sync needed.
 * The readOnly prop on BlockEditor controls edit vs preview mode.
 */
export function ListView({
  nodes,
  editable,
  pagesOnly = false,
  sortable = false,
  onReorder,
  renderItemAction,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onAddClass,
  pageId,
  pageUuid,
  className = '',
  groupBy = 'none',
  enableGrouping = false,
}: NodeListViewProps) {
  const viewId = useId();

  // Collect all nodes recursively, filtering by pagesOnly if needed,
  // then sort by sequence (order field) so the editor receives them in
  // the correct display order.
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node) => {
      if (pagesOnly && !n.is_page) return;
      result.push(n);
      if (n.children) {
        for (const child of n.children) {
          collect(child);
        }
      }
    };
    for (const n of nodes) {
      collect(n);
    }
    return sortBySequence(result);
  }, [nodes, pagesOnly]);

  // Resolve alias: if node is an alias, return the main node instead
  const resolveAlias = useCallback((node: Node): Node => {
    if (node.aliased_id) {
      const mainNode = allNodes.find(n => n.id === node.aliased_id);
      return mainNode ?? { id: node.aliased_id, is_page: true } as Node;
    }
    return node;
  }, [allNodes]);

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback(async (blockId: string) => {
    // Get runtime to resolve blockId to serverId
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    
    if (graphNode?.serverId) {
      const targetNode = allNodes.find(n => n.id === graphNode.serverId);
      if (targetNode) {
        onNodeClick?.(resolveAlias(targetNode));
      } else {
        onNodeClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      }
      return;
    }

    // Node not in runtime — fetch by UUID from API
    try {
      const { parseLinkId } = await import('@/lib/astBuilder');
      const { nodeUuid } = parseLinkId(blockId);
      const node = await getNodeByUuid(nodeUuid);
      onNodeClick?.(resolveAlias(node));
    } catch {
      // Node not found
    }
  }, [allNodes, onNodeClick, resolveAlias]);

  // Handler for shift-click (open in sidebar) from editor
  const handleOpenInSidebar = useCallback((blockId: string) => {
    // Get runtime to resolve blockId to serverId
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    
    if (!graphNode) return;
    
    const serverId = graphNode.serverId;
    if (!serverId) return;
    
    // Find node in allNodes or create stub
    const targetNode = allNodes.find(n => n.id === serverId);
    if (targetNode) {
      onNodeShiftClick?.(targetNode);
    } else {
      onNodeShiftClick?.({ id: serverId, is_page: graphNode.isPage } as Node);
    }
  }, [allNodes, onNodeShiftClick]);

  // Handler for content changes from editor
  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      onContentChange?.(serverId, content);
    } else if (graphNode) {
      // Block not yet persisted — queue for when serverId arrives
      queueContentSave(blockId, content);
    }
  }, [onContentChange]);

  // Group nodes by page when groupBy='page' and enableGrouping=true
  const groupedNodes = useMemo(() => {
    if (!enableGrouping || groupBy !== 'page') {
      return null; // No grouping
    }

    // Group top-level nodes by their page
    const groups = new Map<string, { page: Node | null; nodes: Node[] }>();
    
    for (const node of nodes) {
      // Use page info from metadata (for linked refs) or from the node itself
      const pageKey = (node as any).page_id 
        ? `page-${(node as any).page_id}` 
        : node.is_page 
          ? `self-${node.id}` 
          : 'no-page';
      
      if (!groups.has(pageKey)) {
        // Extract page node if available
        let pageNode: Node | null = null;
        if ((node as any).page_id) {
          pageNode = {
            id: (node as any).page_id,
            name: (node as any).page_name || 'Untitled',
            uuid: (node as any).page_uuid || '',
            is_page: true,
          } as Node;
        } else if (node.is_page) {
          pageNode = node;
        }
        
        groups.set(pageKey, { page: pageNode, nodes: [] });
      }
      
      groups.get(pageKey)!.nodes.push(node);
    }
    
    return Array.from(groups.values());
  }, [nodes, groupBy, enableGrouping]);

  // Grouped view (by page)
  if (groupedNodes) {
    return (
      <div className={`node-list-view node-list-view--grouped ${className}`}>
        {groupedNodes.map((group, groupIndex) => {
          // Collect all nodes in this group (including children)
          const groupAllNodes: Node[] = [];
          const collectGroupNodes = (n: Node) => {
            if (pagesOnly && !n.is_page) return;
            groupAllNodes.push(n);
            if (n.children) {
              for (const child of n.children) {
                collectGroupNodes(child);
              }
            }
          };
          
          for (const n of group.nodes) {
            collectGroupNodes(n);
          }
          
          const sortedGroupNodes = sortBySequence(groupAllNodes);
          
          if (sortedGroupNodes.length === 0) return null;
          
          const groupKey = group.page?.id 
            ? `page-${group.page.id}` 
            : `group-${groupIndex}`;
          
          return (
            <div key={groupKey} className="node-list-view__group">
              {group.page && (
                <div className="node-list-view__group-header">
                  <NodeInline
                    name={group.page.name}
                    icon={group.page.icon}
                    isPage={group.page.is_page}
                    nodeId={group.page.id}
                    showBullet={true}
                    onClick={() => onNodeClick?.(group.page!)}
                    onShiftClick={() => onNodeShiftClick?.(group.page!)}
                  />
                </div>
              )}
              <div className="node-list-view__group-content">
                <BlockEditor
                  editorId={`list-view-${viewId}-${groupKey}`}
                  nodes={sortedGroupNodes}
                  mode="list"
                  readOnly={!editable}
                  onNavigateToNode={handleNavigateToNode}
                  onOpenInSidebar={handleOpenInSidebar}
                  onContentChange={handleContentChangeBridge}
                  onAddClass={onAddClass}
                  pageId={pageId}
                  pageUuid={pageUuid}
                  className="node-list-view__editor"
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // If sortable, use ListSortable wrapper (special mode for reordering)
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

  // Early return if no nodes
  if (allNodes.length === 0) {
    return (
      <div className={`node-list-view node-list-view--empty ${className}`}>
        <span className="node-list-view__empty-message">No items</span>
      </div>
    );
  }

  // BlockEditor handles runtime sync internally
  return (
    <div className={`node-list-view ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`}>
      <BlockEditor
        editorId={`list-view-${viewId}`}
        nodes={allNodes}
        mode="list"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onOpenInSidebar={handleOpenInSidebar}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        pageId={pageId}
        pageUuid={pageUuid}
        className="node-list-view__editor"
      />
    </div>
  );
}
