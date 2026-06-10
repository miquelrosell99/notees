/**
 * KanbanCard — Per-card component for Card Mode.
 *
 * Reproduces the exact same UI as the old NodeKanbanView (cover images,
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

import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { queueContentSave } from '@/hooks/useBlockPersist';

import type { Node } from '@/types';
import { getNodeColorStylesAuto } from '@/utils/color';
import { getEffectiveColor } from '@/utils/nodeIcon';
import {
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
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/core/Button';
import { Card } from '@/components/core/Card';
import { Checkbox } from '@/components/core/Checkbox';
import { NodeRef } from '@/components/nodes/NodeRef';
import { ImageNode } from '@/components/nodes/ImageNode';
import { AddCoverButton } from '@/components/core/AddCoverButton';
import { AssetUploadModal } from '@/components/assets/AssetUploadModal';
import { PageContextMenu, BlockContextMenu } from '@/components/nodes/NodeContextMenu';
import { CardBreadcrumbs } from '@/components/nodes/CardBreadcrumbs';
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isNonRemovableClass } from '@/constants';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { uploadAsset } from '@/api/assets';
import type { Asset } from '@/api/assets';
import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import { TableCreationModal, type TableGridSize } from '@/components/core/TableCreationModal';

import './CardItem.css';

// ─── Card Title Editor (InlineEditor wrapper) ────────────────────

import { InlineEditor } from '@/editor/InlineEditor';
import { parseAST } from '@/lib/astBuilder';
import { PropertiesSection } from '@/components/properties/PropertiesSection';
import { BlockList } from '@/components/blocks/BlockList';


interface CardTitleEditorProps {
  blockId: string;
  initialContent: string;
  readOnly: boolean;
  onContentChange?: (blockId: string, content: string) => void;
  onNavigateToNode?: (linkId: string) => void;
}

/**
 * InlineEditor for the card title.
 * Renders a single block's content without list chrome.
 */
const CardTitleEditor = memo(function CardTitleEditor({
  blockId,
  initialContent,
  readOnly,
  onContentChange,
  onNavigateToNode,
}: CardTitleEditorProps): JSX.Element {
  const initialContentAST = useMemo(() => parseAST(initialContent), [initialContent]);
  return (
    <div className="node-card__title-block">
      <InlineEditor
        blockId={blockId}
        initialContentAST={initialContentAST}
        readOnly={readOnly}
        placeholder="Untitled"
        onContentChange={onContentChange}
        onPillClick={(linkId) => onNavigateToNode?.(linkId)}
      />
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
  allNodes?: Node[];
  allTags?: Node[];
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
  showBreadcrumbs?: boolean;
}

/**
 * NodeCard — Individual card with cover, metadata rows, and Lexical editors.
 * Reproduces the old NodeKanbanView card layout exactly.
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
  allNodes,
  allTags,
  showBreadcrumbs = false,
}: NodeCardProps): JSX.Element {
  const children = useMemo(() => node.children ?? [], [node.children]);
  const hasChildren = children.length > 0;

  // Mutations
  const removeClass = useRemoveClass();
  const addClass = useAddClass();
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();

  // Store actions (use selectors to avoid full-store re-renders)
  const openNode = useNavigationStore(s => s.openNode);
  const addSidebarCard = useNavigationStore(s => s.addSidebarCard);

  // Content save hook
  const { handleContentChange: saveContent } = useContentSave();

  // Body collapse state
  const [isBodyCollapsed, setIsBodyCollapsed] = useState(true);

  // Drag/hover states
  const [isCoverDragging, setIsCoverDragging] = useState(false);
  const [isCoverHovered, setIsCoverHovered] = useState(false);

  // Resolve class details (excluding implicit "page" class)
  const classDetails = useResolvedClassDetails(node?.classes);

  // Resolve tag details — O(1) Map lookups instead of .find() per tag
  const tagDetails = useMemo(() => {
    if (!node?.tags || node.tags.length === 0) return [];
    const tagMap = new Map<number, Node>();
    for (const t of allTags ?? []) tagMap.set(t.id, t);
    const nodeMap = new Map<number, Node>();
    for (const n of allNodes ?? []) nodeMap.set(n.id, n);
    return node.tags
      .map(tagId => tagMap.get(tagId) ?? nodeMap.get(tagId))
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

  // Table creation modal state
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [tableTargetBlockId, setTableTargetBlockId] = useState<number | null>(null);

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

  // Manual asset class state
  const [_manualAssetBlockId, setManualAssetBlockId] = useState<number | null>(null);
  const [_manualAssetBlockContent, setManualAssetBlockContent] = useState<string>('');

  // Add class to block (uses API mutation)
  const handleAddClass = useCallback((blockId: number, classId: number) => {
    // Optimistically update the runtime for immediate visual feedback
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getAllNodes().find(n => n.serverId === blockId);
    if (graphNode) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        runtime.upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
        }]);
      }
    }

    // Check if this is adding the asset class manually
    const assetCls = _propsAllClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.asset);
    if (assetCls && classId === assetCls.id) {
      addClass.mutate({ nodeId: blockId, classId });
      const block = children.find(c => c.id === blockId);
      const blockContent = block?.name || '';
      setManualAssetBlockId(blockId);
      setManualAssetBlockContent(blockContent);
      // Cards don't have a full asset upload flow currently — just add the class
      // (future: open modal)
    } else {
      addClass.mutate({ nodeId: blockId, classId });
    }
  }, [addClass, _propsAllClasses, children]);

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
        if (blockServerId != null) {
          setTableTargetBlockId(blockServerId);
          setIsTableModalOpen(true);
        }
        break;
      }
      case 'code': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.code);
        if (cls && blockServerId != null) addClass.mutate({ nodeId: blockServerId, classId: cls.id });
        break;
      }
      case 'warning':
      case 'note':
      case 'tip':
      case 'info':
      case 'danger':
      case 'success': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS[commandId]);
        if (cls && blockServerId != null) addClass.mutate({ nodeId: blockServerId, classId: cls.id });
        break;
      }
      case 'image':
      case 'audio':
      case 'file':
        // Cards don't currently support inline asset upload from slash commands
        break;
    }
  }, [_propsAllClasses, addClass]);

  // Handle table creation from modal — new table
  const handleTableConfirm = useCallback(async (size: TableGridSize) => {
    if (tableTargetBlockId == null || !_propsAllClasses) return;
    const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.table);
    if (!cls) return;

    addClass.mutate({ nodeId: tableTargetBlockId, classId: cls.id });

    try {
      const headerRow = await createNode.mutateAsync({ name: '', parent_id: tableTargetBlockId, sequence: 0 });
      await Promise.all(
        Array.from({ length: size.columns }, (_, i) =>
          createNode.mutateAsync({ name: `Column ${i + 1}`, parent_id: headerRow.id, sequence: i })
        )
      );
      for (let r = 1; r < size.rows; r++) {
        const row = await createNode.mutateAsync({ name: '', parent_id: tableTargetBlockId, sequence: r });
        await Promise.all(
          Array.from({ length: size.columns }, (_, c) =>
            createNode.mutateAsync({ name: '', parent_id: row.id, sequence: c })
          )
        );
      }
    } catch (err) {
      console.error('[KanbanCard] Failed to create table structure:', err);
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, _propsAllClasses, addClass]);

  // Handle table creation — adapt existing children
  const handleTableAdaptExisting = useCallback(() => {
    if (tableTargetBlockId == null || !_propsAllClasses) return;
    const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.table);
    if (cls) addClass.mutate({ nodeId: tableTargetBlockId, classId: cls.id });
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, _propsAllClasses, addClass]);

  const handleTableCancel = useCallback(() => {
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, []);

  // ─── Style & className ─────────────────────────────────────

  const effectiveColor = useMemo(
    () => getEffectiveColor(node, _propsAllClasses),
    [node, _propsAllClasses],
  );

  const cardStyle = useMemo(() => {
    if (!effectiveColor) return undefined;
    return getNodeColorStylesAuto(effectiveColor);
  }, [effectiveColor]);

  const cardClassName = [
    'node-card',
    `node-card--${layout}`,
    effectiveColor && 'node-card--colored',
    isDragging && 'node-card--dragging',
    isDropTarget && 'node-card--drop-target',
    isSelected && 'node-card--selected',
  ].filter(Boolean).join(' ');

  const ContextMenuComponent = customContextMenu ?? (node.is_page ? PageContextMenu : BlockContextMenu);

  // ─── Cover element ─────────────────────────────────────────

  const coverElement = layout !== 'no-cover' && (
    coverImageId ? (
      <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
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
                icon={"mdi mdi-pencil"}
                iconOnly
                variant="ghost"
                size="sm"
                onClick={() => setIsAssetUploadOpen(true)}
                title="Change image"
              />
              <Button
                icon={"mdi mdi-close"}
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
        <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
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
          <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} className="node-card__checkbox hover-reveal" onClick={handleCheckboxClick}>
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
        <div className={`node-card__header${showBreadcrumbs ? ' node-card__header--with-breadcrumbs' : ''}`}>
          {showBreadcrumbs && (
            <div className="node-card__breadcrumbs-row">
              <CardBreadcrumbs node={node} />
            </div>
          )}
          <div className="node-card__header-row">
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              icon="mdi mdi-chevron-down"
              className={`node-card__collapse-btn${hasChildren ? ' node-card__collapse-btn--has-children' : ''}`}
              onClick={(e) => { e.stopPropagation(); setIsBodyCollapsed(v => !v); }}
              title={isBodyCollapsed ? 'Expand' : 'Collapse'}
              aria-label={isBodyCollapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!isBodyCollapsed}
            />
            <div className="node-card__title-wrapper">
              <CardTitleEditor
                blockId={String(node.uuid || node.id)}
                initialContent={node.name}
                readOnly={!editable}
                onContentChange={handleLexicalContentChange}
                onNavigateToNode={handleNavigateToNode}
              />
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenInSidebar}
                  icon={"mdi mdi-dock-right"}
                  className="node-card__action-button hover-reveal"
                  aria-label="Open in sidebar"
                />
              )}
              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenInView}
                  icon={"mdi mdi-arrow-right"}
                  className="node-card__action-button hover-reveal"
                  aria-label="Open node"
                />
              )}
            </div>
          </div>
        </div>

        {/* Row: Classes — hidden when empty in read-only mode */}
        {(editable || classDetails.length > 0) && (
        <div className="node-card__metadata-row node-card__classes-row">
          {classDetails.map((cls) => (
            <NodeRef
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
              icon={"mdi mdi-plus"}
              className={`node-card__add-metadata-btn${classDetails.length > 0 ? ' node-card__action-button' : ''}`}
              title="Add class"
            >
              {classDetails.length === 0 ? 'Add class' : ''}
            </Button>
          )}
        </div>
        )}

        {/* Row: Properties */}
        <div className="node-card__properties-row">
          <PropertiesSection
            nodeId={node.id}
            inline={true}
            readOnly={!editable}
            showHiddenSection={false}
            showAddProperty={editable}
            isMainNode={true}
            onNavigateToNode={(id) => openNode(id)}
            onOpenInSidebar={(id) => addSidebarCard(id, 'block')}
          />
        </div>

        {/* Row: Tags — hidden when empty in read-only mode */}
        {(editable || tagDetails.length > 0) && (
        <div className="node-card__metadata-row node-card__tags-row">
          {tagDetails.map((tag) => (
            <NodeRef
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
              icon={"mdi mdi-plus"}
              className={`node-card__add-metadata-btn${tagDetails.length > 0 ? ' node-card__action-button' : ''}`}
              title="Add tag"
            >
              {tagDetails.length === 0 ? 'Add tag' : ''}
            </Button>
          )}
        </div>
        )}

        {/* Row: Body — collapsible children */}
        <div className={`node-card__body${isBodyCollapsed ? ' node-card__body--collapsed' : ''}`}>
          <div className="node-card__body-content">
            {hasChildren && (
              <BlockList
                nodes={node.children ?? []}
                readOnly={!editable}
                onContentChange={handleLexicalContentChange}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenBlockInSidebar}
                onAddClass={handleAddClass}
                onSlashCommand={handleSlashCommand}
                nodeUuid={node.uuid}
                nodeId={node.id}
              />
            )}
            {editable && (
              <div className="node-card__add-block">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleAddChild}
                  icon={"mdi mdi-plus"}
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

      {/* Table Creation Modal */}
      <TableCreationModal
        isOpen={isTableModalOpen}
        onConfirm={handleTableConfirm}
        onAdaptExisting={handleTableAdaptExisting}
        onCancel={handleTableCancel}
      />
    </>
  );
});
