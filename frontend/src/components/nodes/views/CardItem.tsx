/**
 * CardItem — Per-card component for Card Mode.
 *
 * Reproduces the exact same UI as the old NodeCardView (cover images,
 * class/tag pills, hover-reveal body, action buttons, context menus,
 * checkboxes) but uses Lexical editors for title and children content.
 *
 * Layout per card (CSS grid inside Card component):
 *   Row 1: Cover image (optional — top/left/right)
 *   Row 2: Header (title + sidebar/open buttons)
 *   Row 3: Classes row (NodePill chips)
 *   Row 4: Tags row (NodePill chips)
 *   Row 5: Body — hover-reveal children (BlockEditor instances)
 */

import { useCallback, useState, useMemo, memo, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from '@/editor/theme';
import { EDITOR_NODES, serializeContentAST } from '@/editor/BlockEditor';
import { BlockPlugin } from '@/editor/plugins/BlockPlugin';
import { NodeLinkPlugin } from '@/editor/plugins/NodeLinkPlugin';
import { DragDropPlugin } from '@/editor/plugins/DragDropPlugin';
import { CollapsePlugin } from '@/editor/plugins/CollapsePlugin';
import { FormattingPlugin } from '@/editor/plugins/FormattingPlugin';
import { TriggerPlugin } from '@/editor/plugins/TriggerPlugin';
import { FloatingToolbarPlugin } from '@/editor/plugins/FloatingToolbarPlugin';
import { ContextMenuPlugin } from '@/editor/plugins/ContextMenuPlugin';
import { BlurOnClickOutsidePlugin } from '@/editor/plugins/BlurOnClickOutsidePlugin';

import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';
import type { ContentAST } from '@/runtime/types';

import type { Node } from '@/types';
import { getNodeColorStylesAuto } from '@/utils/color';
import {
  useNodes,
  useTags,
  useProperties,
  useSetNodeProperty,
  useCreateNode,
  useRemoveClass,
  useAddClass,
  useUpdateNode,
  useResolvedClassDetails,
} from '@/hooks';
import { useContentSave } from '@/hooks/useContentSave';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useAppStore } from '@/stores';
import { Button } from '@/components/core/Button';
import { Card } from '@/components/core/Card';
import { Checkbox } from '@/components/core/Checkbox';
import { NodePill } from '@/components/nodes/NodePill';
import { ImageNode } from '@/components/nodes/ImageNode';
import { AddCoverButton } from '@/components/core/AddCoverButton';
import { AssetUploadModal } from '@/components/assets/AssetUploadModal';
import { PageContextMenu, BlockContextMenu } from '@/components/nodes/NodeContextMenu';
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isNonRemovableClass } from '@/constants';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { uploadAsset } from '@/api/assets';
import type { Asset } from '@/api/assets';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { mdiPlus, mdiDockRight, mdiArrowRight, mdiPencil, mdiClose } from '@mdi/js';

import './CardItem.css';

// ─── Card Title Editor (BlockEditor wrapper) ────────────────────

import { BlockEditor } from '@/editor/BlockEditor';

interface CardTitleEditorProps {
  blockId: string;
  readOnly: boolean;
  onContentChange?: (blockId: string, content: string) => void;
  onNavigateToNode?: (linkId: string) => void;
}

/**
 * Full BlockEditor for the card title.
 * Projects only the root block (includeRoot=true, maxDepth=0).
 */
const CardTitleEditor = memo(function CardTitleEditor({
  blockId,
  readOnly,
  onContentChange,
  onNavigateToNode,
}: CardTitleEditorProps): JSX.Element {
  return (
    <div className="node-card__title-block">
      <BlockEditor
        editorId={`card-title-${blockId}`}
        rootBlockId={blockId}
        mode="document"
        readOnly={readOnly}
        includeRoot={true}
        maxDepth={0}
        placeholder="Untitled"
        onContentChange={onContentChange}
        onNavigateToNode={onNavigateToNode}
        className="node-card__title-editor"
      />
    </div>
  );
});

// ─── Card Children Editor (Lexical subtree) ───────────────────────

interface CardChildrenEditorProps {
  rootBlockId: string;
  readOnly: boolean;
  onContentChange?: (blockId: string, content: string) => void;
  onNavigateToNode?: (linkId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onAddClass?: (blockId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
}

/**
 * ONE Lexical editor for the children of a card's root block.
 * Uses includeRoot=false (default) so only children are projected.
 */
const CardChildrenEditor = memo(function CardChildrenEditor({
  rootBlockId,
  readOnly,
  onContentChange,
  onNavigateToNode,
  onOpenInSidebar,
  onAddClass,
  onSlashCommand,
}: CardChildrenEditorProps): JSX.Element {
  const editorId = `card-children-${rootBlockId}`;

  const initialConfig = useMemo(() => ({
    namespace: `CardChildren-${rootBlockId}`,
    theme: notesEditorTheme,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    editorState: null,
    onError: (error: Error) => {
      console.error(`[CardChildrenEditor ${rootBlockId}]`, error);
    },
  }), [rootBlockId, readOnly]);

  const handleContentChange = useCallback((blockId: string, contentAST: ContentAST) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'update_content', blockId, contentAST });
    onContentChange?.(blockId, serializeContentAST(contentAST));
  }, [onContentChange]);

  const handleBlockMerge = useCallback((sourceBlockId: string, targetBlockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'merge_blocks', sourceBlockId, targetBlockId });
  }, []);

  const handleBlockDelete = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'delete_block', blockId });
  }, []);

  const handleIndent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'indent_block', blockId });
  }, []);

  const handleOutdent = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'outdent_block', blockId });
  }, []);

  const handlePillClick = useCallback((linkId: string) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  return (
    <div className="node-card__children">
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="node-card__children-editable"
              aria-label="Card content"
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <FormattingPlugin />
        <CollapsePlugin />
        <BlockPlugin
          editorId={editorId}
          rootBlockId={rootBlockId}
          onContentChange={handleContentChange}
          onBlockMerge={handleBlockMerge}
          onBlockDelete={handleBlockDelete}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          readOnly={readOnly}
        />
        <NodeLinkPlugin
          onPillClick={handlePillClick}
          onPillRemove={() => {}}
        />
        <DragDropPlugin editorId={editorId} readOnly={readOnly} />
        <TriggerPlugin
          onLinkSelect={handlePillClick}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
        />
        <FloatingToolbarPlugin />
        <ContextMenuPlugin
          onNavigateToNode={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
        />
        <BlurOnClickOutsidePlugin readOnly={readOnly} />
      </LexicalComposer>
    </div>
  );
});

// ─── NodeCard (full card component) ───────────────────────────────

export interface NodeCardProps {
  node: Node;
  index: number;
  layout: 'no-cover' | 'cover-top' | 'cover-left' | 'cover-right';
  sortable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  editable?: boolean;
  allClasses?: Node[];
  isSelected?: boolean;
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  onDragStart?: (index: number) => void;
  onSelectionChange?: (nodeId: number, selected: boolean) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
}

/**
 * NodeCard — Individual card with cover, metadata rows, and Lexical editors.
 * Reproduces the old NodeCardView card layout exactly.
 */
export const NodeCard = memo(function NodeCard({
  node,
  index,
  layout,
  sortable = false,
  isDragging = false,
  isDropTarget = false,
  editable = true,
  allClasses: _propsAllClasses,
  isSelected = false,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onDragStart,
  onSelectionChange,
  customContextMenu,
}: NodeCardProps): JSX.Element {
  const children = useMemo(() => node.children ?? [], [node.children]);
  const hasChildren = children.length > 0;

  // Hooks for metadata resolution
  const { data: allNodes } = useNodes();
  const { data: allTags } = useTags();

  // Mutations
  const removeClass = useRemoveClass();
  const addClass = useAddClass();
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();

  // Store actions
  const { openNode, addSidebarCard } = useAppStore();

  // Content save hook
  const { handleContentChange: saveContent } = useContentSave();

  // Drag/hover states
  const [isCoverDragging, setIsCoverDragging] = useState(false);
  const [isCoverHovered, setIsCoverHovered] = useState(false);

  // Resolve class details (excluding implicit "page" class)
  const classDetails = useResolvedClassDetails(node?.classes);

  // Resolve tag details
  const tagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    return node.tags
      .map(tagId => {
        const fromTags = allTags?.find(t => t.id === tagId);
        if (fromTags) return fromTags;
        return allNodes?.find((n: Node) => n.id === tagId);
      })
      .filter((t): t is Node => {
        if (t === undefined) return false;
        if (t.is_class) return false;
        return true;
      });
  }, [node.tags, allTags, allNodes]);

  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);

  // Property hooks for cover
  const { data: allProperties } = useProperties();
  const setNodeProperty = useSetNodeProperty();
  const queryClient = useQueryClient();

  // Cover property & image ID
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);

  const coverImageId = useMemo(() => {
    if (!coverProperty?.id) return null;
    const coverValue = node?.properties?.[coverProperty.id];
    return typeof coverValue === 'number' ? coverValue : null;
  }, [node.properties, coverProperty?.id]);

  // ─── Handlers ───────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPos(null);
  }, []);

  const handleCheckboxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    onSelectionChange?.(node.id, e.target.checked);
  }, [node.id, onSelectionChange]);

  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleAddChild = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.id < 0) return;

    const maxSequence = children.length > 0
      ? Math.max(...children.map(c => c.sequence))
      : -1;

    createNode.mutate({
      name: '',
      parent_id: node.id,
      sequence: maxSequence + 1,
    });
  }, [node.id, children, createNode]);

  const handleOpenInView = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openNode(node.id);
  }, [node.id, openNode]);

  const handleOpenInSidebar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    addSidebarCard(node.id, node.is_page ? 'page' : 'block');
  }, [node.id, node.is_page, addSidebarCard]);

  const handleContentChange = useCallback((nodeId: number, content: string) => {
    saveContent(nodeId, content);
    onContentChange?.(nodeId, content);
  }, [saveContent, onContentChange]);

  // Cover handlers
  const handleRemoveCover = useCallback(() => {
    if (!coverProperty) return;
    setNodeProperty.mutate({ nodeId: node.id, propertyId: coverProperty.id, value: null });
  }, [node.id, coverProperty, setNodeProperty]);

  const handleCoverUploaded = useCallback(async (asset: Asset) => {
    setIsAssetUploadOpen(false);
    if (coverProperty) {
      try {
        await setNodeProperty.mutateAsync({
          nodeId: node.id,
          propertyId: coverProperty.id,
          value: asset.node_id,
        });
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.id) });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
        if (node.page_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.page_id) });
        }
        if (node.parent_id) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.parent_id) });
        }
      } catch (error) {
        console.error('Failed to set cover property:', error);
      }
    }
  }, [coverProperty, node.id, node.page_id, node.parent_id, setNodeProperty, queryClient]);

  const handleCoverDropped = useCallback(async (file: File | string) => {
    try {
      let asset;
      if (typeof file === 'string') {
        const response = await fetch(file);
        const blob = await response.blob();
        const fileName = file.split('/').pop() || 'image.jpg';
        const fileObj = new File([blob], fileName, { type: blob.type });
        asset = await uploadAsset(fileObj);
      } else {
        asset = await uploadAsset(file);
      }
      await handleCoverUploaded(asset);
    } catch (error) {
      console.error('Failed to upload dropped cover:', error);
    }
  }, [handleCoverUploaded]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCoverDragging(false);
    if (!editable || !coverProperty) return;
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        await handleCoverDropped(result.file);
      }
    } catch (error) {
      console.error('Failed to process dropped image:', error);
    }
  }, [editable, coverProperty, handleCoverDropped]);

  // Only initiate drag when clicking within the card's border area (outer ~6px)
  const handleCardMouseDown = useCallback((e: React.MouseEvent) => {
    if (!sortable) return;
    const card = (e.currentTarget as HTMLElement);
    const rect = card.getBoundingClientRect();
    const borderThreshold = 6;
    const x = e.clientX;
    const y = e.clientY;
    const nearEdge =
      x - rect.left < borderThreshold ||
      rect.right - x < borderThreshold ||
      y - rect.top < borderThreshold ||
      rect.bottom - y < borderThreshold;
    if (!nearEdge) return;
    e.preventDefault();
    onDragStart?.(index);
  }, [index, sortable, onDragStart]);

  // Bridge: Lexical content change → numeric nodeId
  const handleLexicalContentChange = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      handleContentChange(serverId, content);
    } else if (graphNode) {
      // Block not yet persisted — queue for when serverId arrives
      queueContentSave(blockId, content);
    }
  }, [handleContentChange]);

  // Navigate via pills — redirect aliases to main node
  const handleNavigateToNode = useCallback(async (linkId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(linkId);
    if (graphNode?.serverId) {
      onNodeClick?.({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
      return;
    }
    // Node not in runtime — fetch by UUID
    try {
      const { getNodeByUuid } = await import('@/api/nodes');
      const { parseLinkId } = await import('@/lib/astBuilder');
      const { nodeUuid } = parseLinkId(linkId);
      const node = await getNodeByUuid(nodeUuid);
      // Redirect aliases to their main node
      if (node.aliased_id) {
        onNodeClick?.({ id: node.aliased_id, is_page: true } as Node);
      } else {
        onNodeClick?.(node);
      }
    } catch {
      // Node not found
    }
  }, [onNodeClick]);

  const handleOpenBlockInSidebar = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (!graphNode?.serverId) return;
    if (onNodeShiftClick) {
      onNodeShiftClick({ id: graphNode.serverId, is_page: false } as Node);
    } else {
      addSidebarCard(graphNode.serverId, 'block');
    }
  }, [onNodeShiftClick, addSidebarCard]);

  // Add class to block (uses API mutation)
  const handleAddClass = useCallback((blockId: number, classId: number) => {
    addClass.mutate({ nodeId: blockId, classId });
  }, [addClass]);

  // Handle slash commands from editor
  const handleSlashCommand = useCallback((commandId: string, blockServerId: number | undefined) => {
    if (!_propsAllClasses) return;
    switch (commandId) {
      case 'query': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.query);
        if (cls && blockServerId != null) addClass.mutate({ nodeId: blockServerId, classId: cls.id });
        break;
      }
      case 'table': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.table);
        if (cls && blockServerId != null) addClass.mutate({ nodeId: blockServerId, classId: cls.id });
        break;
      }
      case 'code': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.code);
        if (cls && blockServerId != null) addClass.mutate({ nodeId: blockServerId, classId: cls.id });
        break;
      }
      case 'image':
      case 'audio':
      case 'file':
        // Cards don't currently support inline asset upload from slash commands
        break;
      case 'comment': {
        if (blockServerId != null) {
          const { openCommentsForNode } = useAppStore.getState();
          openCommentsForNode(blockServerId);
        }
        break;
      }
    }
  }, [_propsAllClasses, addClass]);

  // ─── Style & className ─────────────────────────────────────

  const cardStyle = useMemo(() => {
    if (!node.color) return undefined;
    return getNodeColorStylesAuto(node.color);
  }, [node.color]);

  const cardClassName = [
    'node-card',
    `node-card--${layout}`,
    node.color && 'node-card--colored',
    isDragging && 'node-card--dragging',
    isDropTarget && 'node-card--drop-target',
    isSelected && 'node-card--selected',
  ].filter(Boolean).join(' ');

  const ContextMenuComponent = customContextMenu ?? (node.is_page ? PageContextMenu : BlockContextMenu);

  // ─── Cover element ─────────────────────────────────────────

  const coverElement = layout !== 'no-cover' && (
    coverImageId ? (
      <div
        className={`node-card__cover${isCoverDragging ? ' node-card__cover--drag-over' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => setIsCoverHovered(true)}
        onMouseLeave={() => setIsCoverHovered(false)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ImageNode
          assetNodeId={coverImageId}
          alt="Cover"
          className="node-card__cover-image"
          showCard={false}
          clickable={true}
          showActions={editable && isCoverHovered}
          actions={
            <>
              <Button
                icon={mdiPencil}
                iconOnly
                variant="ghost"
                size="sm"
                onClick={() => setIsAssetUploadOpen(true)}
                title="Change image"
              />
              <Button
                icon={mdiClose}
                iconOnly
                variant="ghost"
                size="sm"
                onClick={handleRemoveCover}
                title="Remove image"
              />
            </>
          }
          actionsDirection="horizontal"
          showModalBullet={true}
        />
      </div>
    ) : (
      editable ? (
        <div
          className={`node-card__cover${isCoverDragging ? ' node-card__cover--drag-over' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <AddCoverButton onClick={() => setIsAssetUploadOpen(true)} onDrop={handleCoverDropped} size="sm" />
        </div>
      ) : null
    )
  );

  // ─── Render ─────────────────────────────────────────────────

  return (
    <>
      <Card
        className={cardClassName}
        style={cardStyle}
        onContextMenu={handleContextMenu}
        onMouseDown={handleCardMouseDown}
        padding={false}
        elevation="none"
        variant="default"
      >
        {/* Selection checkbox — shown on hover */}
        {onSelectionChange && (
          <div className="node-card__checkbox" onClick={handleCheckboxClick}>
            <Checkbox
              size="sm"
              checked={isSelected}
              onChange={handleCheckboxChange}
              aria-label={`Select ${nodeNameToText(node.name) || 'Untitled'}`}
            />
          </div>
        )}

        {/* Cover image (optional — top, left, right) */}
        {layout !== 'no-cover' && coverElement}

        {/* Row: Title */}
        <div className="node-card__header">
          <div className="node-card__title-wrapper">
            <CardTitleEditor
              blockId={String(node.uuid || node.id)}
              readOnly={!editable}
              onContentChange={handleLexicalContentChange}
              onNavigateToNode={handleNavigateToNode}
            />
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenInSidebar}
                icon={mdiDockRight}
                className="node-card__action-button node-card__action-button--always-visible"
                aria-label="Open in sidebar"
              />
            )}
            {editable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenInView}
                icon={mdiArrowRight}
                className="node-card__action-button node-card__action-button--always-visible"
                aria-label="Open node"
              />
            )}
          </div>
        </div>

        {/* Row: Classes */}
        <div className="node-card__metadata-row node-card__classes-row">
          {classDetails.map((cls) => (
            <NodePill
              key={cls.id}
              node={cls}
              readOnly={!editable}
              onRemove={isNonRemovableClass(cls.uuid) ? undefined : () => removeClass.mutate({ nodeId: node.id, classId: cls.id })}
              onColorChange={(color) => updateNode.mutate({ id: cls.id, data: { color } })}
            />
          ))}
          {editable && (
            <Button
              variant="ghost"
              size="xs"
              icon={mdiPlus}
              className="node-card__add-metadata-btn"
              title="Add class"
            >
              {classDetails.length === 0 ? 'Add class' : ''}
            </Button>
          )}
        </div>

        {/* Row: Tags */}
        <div className="node-card__metadata-row node-card__tags-row">
          {tagDetails.map((tag) => (
            <NodePill
              key={tag.id}
              node={tag}
              readOnly={!editable}
              onRemove={() => removeClass.mutate({ nodeId: node.id, classId: tag.id })}
              onColorChange={(color) => updateNode.mutate({ id: tag.id, data: { color } })}
            />
          ))}
          {editable && (
            <Button
              variant="ghost"
              size="xs"
              icon={mdiPlus}
              className="node-card__add-metadata-btn"
              title="Add tag"
            >
              {tagDetails.length === 0 ? 'Add tag' : ''}
            </Button>
          )}
        </div>

        {/* Row: Body — hover-reveal children */}
        <div className="node-card__body node-card__body--hover-reveal">
          {hasChildren && (
            <div className="node-card__collapsed-indicator">•••</div>
          )}
          <div className="node-card__body-content">
            {hasChildren && (
              <CardChildrenEditor
                rootBlockId={String(node.uuid || node.id)}
                readOnly={!editable}
                onContentChange={handleLexicalContentChange}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenBlockInSidebar}
                onAddClass={handleAddClass}
                onSlashCommand={handleSlashCommand}
              />
            )}
            {editable && (
              <div className="node-card__add-block">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddChild}
                  icon={mdiPlus}
                  className="node-card__add-block-button"
                >
                  Add block
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Context menu */}
      {contextMenuPos && (
        <ContextMenuComponent
          node={node}
          position={contextMenuPos}
          onClose={handleCloseContextMenu}
        />
      )}

      {/* Asset Upload Modal */}
      <AssetUploadModal
        isOpen={isAssetUploadOpen}
        onClose={() => setIsAssetUploadOpen(false)}
        onUpload={handleCoverUploaded}
        acceptedTypes={['image']}
      />
    </>
  );
});
