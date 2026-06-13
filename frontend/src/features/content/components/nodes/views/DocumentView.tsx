/**
 * DocumentView — Document view using Lexical editor.
 *
 * Accepts nodes[] from queries and renders as a continuous document.
 * Passes nodes directly to BlockEditor which handles runtime sync.
 */

import { useMemo, useCallback, type JSX, memo } from 'react';
import { BlockList } from '@/features/content/components/blocks/BlockList';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import { getNodeByUuid } from '@/api/nodes';
import { uploadAsset } from '@/api/assets';
import { generateUUID } from '@/utils/uuid';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import './DocumentView.css';
import { registerView } from './registry';
/**
 * DocumentView - Document view using Lexical editor
 *
 * Accepts nodes[] and renders as a flat document (no bullets/indentation).
 */
export const DocumentView = memo(function DocumentView({
  nodes,
  editable,
  maxDepth = Infinity,
  onNodeClick,
  onNodeShiftClick: _onNodeShiftClick,
  onContentChange,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onTemplateInstantiate,
  templateClassFilters,
  pageId: _pageId,
  nodeUuid: _nodeUuid,
  className = '',
  hideProperties: _hideProperties,
}: NodeDocumentViewProps): JSX.Element {

  // Collect all nodes recursively up to maxDepth
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    const collect = (n: Node, depth: number) => {
      if (n.is_page) return;
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

  // Handler for external file drops — creates asset blocks
  const handleDropFiles = useCallback(async (files: File[]) => {
    if (!_pageId) return;
    const runtime = getNodeGraphRuntime();
    runtime.registerParentServerId(_nodeUuid ?? '', _pageId);

    for (const file of files) {
      try {
        const asset = await uploadAsset(file, _pageId);
        const newBlockId = generateUUID();
        const nodeChildren = allNodes;
        const lastChild = nodeChildren.length > 0 ? nodeChildren[nodeChildren.length - 1] : null;

        runtime.applyIntent({
          type: 'create_block',
          parentId: _nodeUuid ?? '',
          afterBlockId: lastChild?.uuid ?? null,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        // Immediately convert the new empty block to an asset
        if (asset.node_id) {
          runtime.upsertNodes([{
            blockId: newBlockId,
            serverId: asset.node_id,
            parentId: _nodeUuid ?? '',
            orderIndex: 0,
            nodeType: 'block',
            contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
            collapsed: false,
            isDeleted: false,
            isPage: false,
            classIds: [],
            tagIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            version: 1,
          }]);
        }
        runtime.flushEvents();
      } catch (err) {
        console.error('[DocumentView] Failed to upload dropped file:', err);
      }
    }
  }, [_pageId, _nodeUuid, allNodes]);

  // Early return if no nodes
  if (allNodes.length === 0) {
    return (
      <div className={`node-document-view node-document-view--empty ${className}`}>
        <span className="node-document-view__empty-message">No content yet</span>
      </div>
    );
  }

  return (
    <div className={`node-document-view ${className}`}>
      <BlockList
        nodes={nodes}
        readOnly={!editable}
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onPasteImage={onPasteImage}
        onDropFiles={handleDropFiles}
        onTemplateInstantiate={onTemplateInstantiate}
        templateClassFilters={templateClassFilters}
        nodeUuid={_nodeUuid}
        nodeId={_pageId}
        onNavigateToNode={handleNavigateToNode}
        onPillClick={handleNavigateToNode}
        maxDepth={maxDepth}
        skipPages
        placeholder="Start writing…"
      />
    </div>
  );
});

registerView({
  id: 'document',
  label: 'Document',
  icon: 'mdi mdi-file-document-outline',
  component: DocumentView,
  capabilities: { sorting: true },
});
