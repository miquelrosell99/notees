/**
 * NodeBlockListView — List/outline view using Lexical NoteesEditor.
 *
 * Uses a SINGLE NoteesEditor instance for performance.
 * Passes nodes directly - NoteesEditor handles runtime sync internally.
 */
import { useCallback, useMemo, useId } from 'react';
import type { Node } from '@/types';
import type { NodeListViewProps } from '@/types/nodeCollection';
import { Bullet } from '../../blocks/Bullet';
import { NoteesEditor } from '@/editor/NoteesEditor';
import { ListSortable } from '../../core/ListSortable';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { sortBySequence } from '@/utils/nodeSort';
import './NodeBlockListView.css';

/**
 * NodeBlockListView - List/outline view using Lexical editor
 *
 * Simply passes nodes to NoteesEditor - no manual runtime sync needed.
 * The readOnly prop on NoteesEditor controls edit vs preview mode.
 */
export function NodeBlockListView({
  nodes,
  editable,
  pagesOnly = false,
  sortable = false,
  onReorder,
  renderItemAction,
  onNodeClick,
  onContentChange,
  pageId,
  pageUuid,
  className = '',
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

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback((blockId: string) => {
    // Get runtime to resolve blockId to serverId
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    
    if (!graphNode) return;
    
    const serverId = graphNode.serverId;
    if (!serverId) return;
    
    // Find node in allNodes or create stub
    const targetNode = allNodes.find(n => n.id === serverId);
    if (targetNode) {
      onNodeClick?.(targetNode);
    } else {
      onNodeClick?.({ id: serverId, is_page: graphNode.isPage } as Node);
    }
  }, [allNodes, onNodeClick]);

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

  // NoteesEditor handles runtime sync internally
  return (
    <div className={`node-list-view ${editable ? 'node-list-view--editable' : 'node-list-view--readonly'} ${className}`}>
      <NoteesEditor
        editorId={`list-view-${viewId}`}
        nodes={allNodes}
        mode="list"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onContentChange={handleContentChangeBridge}
        pageId={pageId}
        pageUuid={pageUuid}
        className="node-list-view__editor"
      />
    </div>
  );
}
