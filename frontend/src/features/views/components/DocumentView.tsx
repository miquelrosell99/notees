/**
 * DocumentView — Document view rendering blocks via BlockList.
 *
 * Accepts nodes[] from queries and renders as a continuous document.
 * Passes nodes directly to BlockEditor which handles runtime sync.
 */

import { useCallback, type JSX, memo } from 'react';
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
 * BlockList handles its own flattening and virtualization, so this view avoids
 * any recursive pre-processing that would freeze the main thread for large
 * documents.
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
  // Handler for navigation from editor. Only resolve against the top-level
  // nodes passed to the view; children are handled by BlockList. With
  // projectionDepth: 0 the input is already flat, so this is both cheap and
  // sufficient.
  const handleNavigateToNode = useCallback((linkId: string) => {
    const nodeUuid = parseLinkId(linkId).nodeUuid;
    const targetNode = nodes.find(n => n.uuid === nodeUuid);
    onNodeClick?.(targetNode ?? ({ uuid: nodeUuid, is_page: true } as unknown as Node));
  }, [nodes, onNodeClick]);

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
  if (nodes.length === 0) {
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
