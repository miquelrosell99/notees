/**
 * DocumentView — Document view using Lexical editor.
 *
 * Accepts nodes[] from queries and renders as a continuous document.
 * Passes nodes directly to BlockEditor which handles runtime sync.
 */

import { useMemo, useCallback, useId, type JSX } from 'react';
import { BlockEditor } from '../../../editor/BlockEditor';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { getNodeByUuid } from '@/api/nodes';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import './DocumentView.css';

/**
 * DocumentView - Document view using Lexical editor
 *
 * Accepts nodes[] and renders as a flat document (no bullets/indentation).
 */
export function DocumentView({
  nodes,
  editable,
  maxDepth = Infinity,
  onNodeClick,
  onContentChange,
  onAddClass,
  pageId,
  pageUuid,
  className = '',
}: NodeDocumentViewProps): JSX.Element {
  const viewId = useId();

  // Collect all nodes recursively up to maxDepth
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node, depth: number) => {
      result.push(n);
      if (depth < maxDepth && n.children) {
        for (const child of n.children) {
          collect(child, depth + 1);
        }
      }
    };
    for (const n of nodes) {
      collect(n, 0);
    }
    return result;
  }, [nodes, maxDepth]);

  // Resolve alias: if node is an alias, return the main node instead
  const resolveAlias = useCallback((node: Node): Node => {
    if (node.aliased_id) {
      const mainNode = allNodes.find(n => n.id === node.aliased_id);
      return mainNode ?? { id: node.aliased_id, is_page: true } as Node;
    }
    return node;
  }, [allNodes]);

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback(async (linkId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(linkId);
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
      const { nodeUuid } = parseLinkId(linkId);
      const node = await getNodeByUuid(nodeUuid);
      onNodeClick?.(resolveAlias(node));
    } catch {
      // Node not found
    }
  }, [allNodes, onNodeClick, resolveAlias]);

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

  // Early return if no nodes
  if (allNodes.length === 0) {
    return (
      <div className={`node-document-view node-document-view--empty ${className}`}>
        <span className="node-document-view__empty-message">No content</span>
      </div>
    );
  }

  return (
    <div className={`node-document-view ${className}`}>
      <BlockEditor
        editorId={`document-view-${viewId}`}
        nodes={allNodes}
        mode="document"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        pageId={pageId}
        pageUuid={pageUuid}
        placeholder="Start writing…"
      />
    </div>
  );
}
