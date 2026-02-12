/**
 * NodeBlockDocumentView — Document view using Lexical editor.
 *
 * Accepts nodes[] from queries and renders as a continuous document.
 * Passes nodes directly to NoteesEditor which handles runtime sync.
 */

import { useMemo, useCallback, useId, type JSX } from 'react';
import { NoteesEditor } from '../../../editor/NoteesEditor';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import './NodeBlockDocumentView.css';

/**
 * NodeBlockDocumentView - Document view using Lexical editor
 *
 * Accepts nodes[] and renders as a flat document (no bullets/indentation).
 */
export function NodeBlockDocumentView({
  nodes,
  editable,
  maxDepth = Infinity,
  onNodeClick,
  onContentChange,
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

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback((linkId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(linkId);
    if (!graphNode) return;
    const serverId = graphNode.serverId;
    if (!serverId) return;
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
      <NoteesEditor
        editorId={`document-view-${viewId}`}
        nodes={allNodes}
        mode="document"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onContentChange={handleContentChangeBridge}
        pageId={pageId}
        pageUuid={pageUuid}
        placeholder="Start writing…"
      />
    </div>
  );
}
