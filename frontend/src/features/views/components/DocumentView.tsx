/**
 * DocumentView — Document view rendering blocks via BlockList.
 *
 * Accepts nodes[] from queries and renders as a continuous document.
 * Passes nodes directly to BlockEditor which handles runtime sync.
 */

import { useMemo, useCallback, type JSX, memo } from 'react';
import { BlockList } from '@/features/content';

import { parseLinkId } from '@/lib/astBuilder';
import type { Node } from '@/types';
import type { NodeDocumentViewProps } from '@/types/nodeCollection';
import './DocumentView.css';
import { registerView } from './registry';

/**
 * DocumentView - Document view rendering blocks via BlockList
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
    if (node.aliased_uuid) {
      const mainNode = allNodes.find(n => n.uuid === node.aliased_uuid);
      return mainNode ?? ({ uuid: node.aliased_uuid, is_page: true } as unknown as Node);
    }
    return node;
  }, [allNodes]);

  // Handler for navigation from editor
  const handleNavigateToNode = useCallback((linkId: string) => {
    const nodeUuid = parseLinkId(linkId).nodeUuid;

    const targetNode = allNodes.find(n => n.uuid === nodeUuid);
    if (targetNode) {
      onNodeClick?.(resolveAlias(targetNode));
    } else {
      // Target is not in the loaded view; pass a minimal node so navigation can
      // still proceed. Alias redirection is only possible when the node is in
      // the local allNodes set.
      onNodeClick?.({ uuid: nodeUuid, is_page: true } as unknown as Node);
    }
  }, [allNodes, onNodeClick, resolveAlias]);

  // Handler for content changes from editor.
  // Pass the runtime block id (UUID) through; useContentSave resolves it to the
  // runtime node and creates an update_content operation even if the block has
  // not been persisted yet.
  const handleContentChangeBridge = useCallback((blockId: string, content: string) => {
    onContentChange?.(blockId, content);
  }, [onContentChange]);

  // TODO: External file drops previously went through the legacy OperationRuntime
  // undo engine and runtime event bus. Re-implement this with the core workspace
  // store (useCreateNode / asset class assignment) once the asset operation flow
  // is wired to the SQLite-derived state.

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
        documentMode
        onContentChange={handleContentChangeBridge}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onPasteImage={onPasteImage}
        onTemplateInstantiate={onTemplateInstantiate}
        templateClassFilters={templateClassFilters}
        nodeUuid={_nodeUuid}
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
