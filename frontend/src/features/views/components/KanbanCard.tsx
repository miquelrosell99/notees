/**
 * KanbanCard — Per-card component for Card Mode.
 *
 * Reproduces the exact same UI as the old NodeKanbanView (cover images,
 * class/tag pills, hover-reveal body, action buttons, context menus,
 * checkboxes) but uses inline editors for title and children content.
 *
 * Layout per card (CSS grid inside Card component):
 *   Row 1: Cover image (optional — top/left/right)
 *   Row 2: Header (title + sidebar/open buttons)
 *   Row 3: Classes row (NodePill chips)
 *   Row 4: Tags row (NodePill chips)
 *   Row 5: Body — hover-reveal children (BlockEditor instances)
 */

import { useCallback, useState, useMemo, memo, type JSX } from 'react';

import type { Node } from '@/types';
import { getNodeColorStylesAuto } from '@/utils/color';
import { getEffectiveColor } from '@/utils/nodeIcon';
import { useProperties, useSetNodeProperty } from '@/features/properties';
import { useCreateNode, useRemoveClass, useAddClass, useUpdateNode, useResolvedClassDetails } from '@/features/content';
import { getNodeUuidByServerId } from '@/features/content/hooks/useNodeMutations.utils';
import { useContentSave } from '@/features/editor';
import { useCreateFlashcard } from '@/plugins/builtin/flashcards';
import { stringifyAST, StringifyMode } from '@/lib';
import { nodeNameToText } from '@/features/queries';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { NodeRef } from '@/features/content';
import { AssetImage } from '@/features/content';
import { AddCoverButton } from '@/components/ui/AddCoverButton';
import { AssetUploadModal } from '@/features/assets';
import { PageContextMenu, BlockContextMenu } from '@/features/content';
import { NodeBreadcrumbs } from '@/features/content';
import { SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS, isNonRemovableClass } from '@/constants';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import { uploadAsset, type Asset } from '@/features/assets';
import { extractImageFromDragEvent } from '@/features/content';
import { TableCreationModal, type TableGridSize } from '@/components/ui/TableCreationModal';

import './CardItem.css';

// ─── Card Title Editor (CustomInlineEditor wrapper) ────────────────────

import { CustomInlineEditor } from '@/features/editor/custom/components/CustomInlineEditor';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { PropertiesSection } from '@/features/properties';
import { BlockList } from '@/features/content';
import { getOperationRuntime } from '@/runtime';
import { getNode, getAllNodes } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { getRuntimeDisplayName } from '@/features/content/hooks/runtimeContentOverlay';



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
      <CustomInlineEditor
        blockId={blockId}
        initialContentAST={initialContentAST}
        readOnly={readOnly}
        placeholder="Untitled"
        cardTitle
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
  onContentChange?: (nodeUuid: string, content: string) => void;
  onDragStart?: (index: number) => void;
  onSelectionChange?: (nodeUuid: string, selected: boolean) => void;
  customContextMenu?: React.ComponentType<{
    node: Node;
    position: { x: number; y: number };
    onClose: () => void;
  }>;
  showBreadcrumbs?: boolean;
  /** Layout context driving container-level card styling. */
  context?: 'masonry' | 'kanban';
  /** When true, the card stretches to fill its parent's height. */
  fill?: boolean;
}

/**
 * NodeCard — Individual card with cover, metadata rows, and inline editors.
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
  context,
  fill = false,
}: NodeCardProps): JSX.Element {
  const children = useMemo(() => node.children ?? [], [node.children]);
  const hasChildren = children.length > 0;

  // Mutations
  const removeClass = useRemoveClass();
  const addClass = useAddClass();
  const createFlashcard = useCreateFlashcard();
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
  const classDetails = useResolvedClassDetails(node?.classes_uuid);

  // Resolve tag details — O(1) Map lookups instead of .find() per tag
  const tagDetails = useMemo(() => {
    if (!node?.tags_uuid || node.tags_uuid.length === 0) return [];
    const tagMap = new Map<string, Node>();
    for (const t of allTags ?? []) tagMap.set(t.uuid, t);
    const nodeMap = new Map<string, Node>();
    for (const n of allNodes ?? []) nodeMap.set(n.uuid, n);
    return node.tags_uuid
      .map(tagId => tagMap.get(tagId) ?? nodeMap.get(tagId))
      .filter((t): t is Node => {
        if (t === undefined) return false;
        if (t.is_class) return false;
        return true;
      });
  }, [node.tags_uuid, allTags, allNodes]);

  // Context menu state
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Asset upload state
  const [isAssetUploadOpen, setIsAssetUploadOpen] = useState(false);

  // Table creation modal state
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [tableTargetBlockId, setTableTargetBlockId] = useState<string | null>(null);

  // Property hooks for cover
  const { data: allProperties } = useProperties();
  const setNodeProperty = useSetNodeProperty();
  const queryClient = useQueryClient();

  // Cover property & image ID
  const coverProperty = useMemo(() => {
    return allProperties?.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.cover);
  }, [allProperties]);

  const coverImageId = useMemo(() => {
    if (!coverProperty?.uuid) return null;
    const coverValue = node?.properties_uuid?.[coverProperty.uuid];
    return typeof coverValue === 'string' ? coverValue : null;
  }, [node.properties_uuid, coverProperty?.uuid]);

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
    onSelectionChange?.(node.uuid, e.target.checked);
  }, [node.uuid, onSelectionChange]);

  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleAddChild = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();

    const maxSequence = children.length > 0
      ? Math.max(...children.map(c => c.sequence))
      : -1;

    createNode.mutate({
      name: '',
      parent_uuid: node.uuid,
      sequence: maxSequence + 1,
    });
  }, [node.uuid, node.uuid, children, createNode]);

  const handleOpenInView = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openNode(node.uuid);
  }, [node.uuid, openNode]);

  const handleOpenInSidebar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    addSidebarCard(node.uuid, node.is_page ? 'page' : 'block');
  }, [node.uuid, node.is_page, addSidebarCard]);

  const handleContentChange = useCallback((nodeUuid: string, content: string) => {
    saveContent(nodeUuid, content);
    onContentChange?.(nodeUuid, content);
  }, [saveContent, onContentChange]);

  // Cover handlers
  const handleRemoveCover = useCallback(() => {
    if (!coverProperty) return;
    setNodeProperty.mutate({ nodeUuid: node.uuid, propertyId: coverProperty.uuid, value: null });
  }, [node.uuid, coverProperty, setNodeProperty]);

  const handleCoverUploaded = useCallback(async (asset: Asset) => {
    setIsAssetUploadOpen(false);
    if (coverProperty) {
      try {
        await setNodeProperty.mutateAsync({
          nodeUuid: node.uuid,
          propertyId: coverProperty.uuid,
          value: asset.node_uuid,
        });
        queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.uuid) });
        queryClient.invalidateQueries({ queryKey: nodeViewKeys.queryResults() });
        if (node.page_uuid) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.page_uuid) });
        }
        if (node.parent_uuid) {
          queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(node.parent_uuid) });
        }
      } catch (error) {
        console.error('Failed to set cover property:', error);
      }
    }
  }, [coverProperty, node.uuid, node.page_uuid, node.parent_uuid, setNodeProperty, queryClient]);

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

  // Bridge: block content change → runtime block id.
  // useContentSave resolves the runtime node and persists even for blocks that
  // have not been acknowledged by the server yet.
  const handleBlockContentChange = useCallback((blockId: string, content: string) => {
    handleContentChange(blockId, content);
  }, [handleContentChange]);

  // Navigate via pills — redirect aliases to main node when known locally.
  const handleNavigateToNode = useCallback((linkId: string) => {
    // Resolve to a target UUID synchronously. Use the runtime when available,
    // otherwise parse the link id. Avoiding an async fetch here eliminates the
    // stale-closure race where a later click could be overwritten by an earlier
    // fetch that finishes second.
    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, linkId);
    const nodeUuid = graphNode?.blockId ?? parseLinkId(linkId).nodeUuid;

    const targetNode = allNodes?.find(n => n.uuid === nodeUuid);
    if (targetNode?.aliased_uuid) {
      onNodeClick?.({ uuid: targetNode.aliased_uuid, is_page: true } as unknown as Node);
      return;
    }

    const isPage = graphNode?.isPage ?? targetNode?.is_page ?? true;
    onNodeClick?.({ uuid: nodeUuid, is_page: isPage } as unknown as Node);
  }, [allNodes, onNodeClick]);

  const handleOpenBlockInSidebar = useCallback((blockId: string) => {
    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, blockId);
    if (!graphNode?.blockId) return;
    if (onNodeShiftClick) {
      onNodeShiftClick({ uuid: graphNode.blockId, is_page: false } as unknown as Node);
    } else {
      addSidebarCard(graphNode.blockId, 'block');
    }
  }, [onNodeShiftClick, addSidebarCard]);

  // Manual asset class state
  const [_manualAssetBlockId, setManualAssetBlockId] = useState<string | null>(null);
  const [_manualAssetBlockContent, setManualAssetBlockContent] = useState<string>('');

  // Add class to block (uses API mutation)
  const handleAddClass = useCallback((blockId: string, classId: string) => {
    // Optimistically update the runtime for immediate visual feedback
    const runtime = getOperationRuntime();
    const graphNode = getAllNodes(runtime).find(n => n.blockId === blockId);
    if (graphNode) {
      const classStrId = String(classId);
      if (!graphNode.classIds.includes(classStrId)) {
        upsertNodes([{
          ...graphNode,
          classIds: [...graphNode.classIds, classStrId],
        }]);
      }
    }

    // Check if this is adding the asset class manually
    const assetCls = _propsAllClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.asset);
    if (assetCls && classId === assetCls.uuid) {
      addClass.mutate({ nodeUuid: blockId, classId });
      const block = children.find(c => c.uuid === blockId);
      const blockContent = block?.name || '';
      setManualAssetBlockId(blockId);
      setManualAssetBlockContent(blockContent);
      // Cards don't have a full asset upload flow currently — just add the class
      // (future: open modal)
    } else {
      addClass.mutate({ nodeUuid: blockId, classId });
    }
  }, [addClass, _propsAllClasses, children]);

  // Handle slash commands from editor
  const handleSlashCommand = useCallback((commandId: string, blockServerId: string | undefined) => {
    if (!_propsAllClasses) return;
    switch (commandId) {
      case 'query': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.query);
        if (cls && blockServerId != null) addClass.mutate({ nodeUuid: blockServerId, classId: cls.uuid });
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
        if (cls && blockServerId != null) addClass.mutate({ nodeUuid: blockServerId, classId: cls.uuid });
        break;
      }
      case 'warning':
      case 'note':
      case 'tip':
      case 'info':
      case 'danger':
      case 'success': {
        const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS[commandId]);
        if (cls && blockServerId != null) addClass.mutate({ nodeUuid: blockServerId, classId: cls.uuid });
        break;
      }
      case 'image':
      case 'audio':
      case 'file':
        // Cards don't currently support inline asset upload from slash commands
        break;
      case 'flashcard': {
        const cls = _propsAllClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.card);
        if (!cls || blockServerId == null) break;
        addClass.mutate(
          { nodeUuid: blockServerId, classId: cls.uuid },
          {
            onSuccess: () => {
              const runtime = getOperationRuntime();
              const graphNode = getAllNodes(runtime).find(n => n.blockId === blockServerId);
              const frontText = graphNode
                ? stringifyAST(graphNode.contentAST, { mode: StringifyMode.TEXT_ONLY }).trim()
                : '';
              createFlashcard.mutate({ nodeUuid: blockServerId, frontText, backText: '' });
            },
          },
        );
        break;
      }
      case 'cloze': {
        const cls = _propsAllClasses?.find(c => c.uuid === SYSTEM_CLASS_UUIDS.cloze);
        if (!cls || blockServerId == null) break;
        addClass.mutate({ nodeUuid: blockServerId, classId: cls.uuid });
        break;
      }
    }
  }, [_propsAllClasses, addClass, createFlashcard]);

  // Handle table creation from modal — new table
  const handleTableConfirm = useCallback(async (size: TableGridSize) => {
    if (tableTargetBlockId == null || !_propsAllClasses) return;
    const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.table);
    if (!cls) return;

    addClass.mutate({ nodeUuid: tableTargetBlockId, classId: cls.uuid });

    try {
      const parentUuid = getNodeUuidByServerId(queryClient, tableTargetBlockId);
      if (!parentUuid) return;
      const headerRow = await createNode.mutateAsync({ name: '', parent_uuid: parentUuid, sequence: 0 });
      await Promise.all(
        Array.from({ length: size.columns }, (_, i) =>
          createNode.mutateAsync({ name: `Column ${i + 1}`, parent_uuid: headerRow.uuid, sequence: i })
        )
      );
      for (let r = 1; r < size.rows; r++) {
        const row = await createNode.mutateAsync({ name: '', parent_uuid: parentUuid, sequence: r });
        await Promise.all(
          Array.from({ length: size.columns }, (_, c) =>
            createNode.mutateAsync({ name: '', parent_uuid: row.uuid, sequence: c })
          )
        );
      }
    } catch (err) {
      console.error('[KanbanCard] Failed to create table structure:', err);
    }
    setIsTableModalOpen(false);
    setTableTargetBlockId(null);
  }, [tableTargetBlockId, _propsAllClasses, addClass, createNode, queryClient]);

  // Handle table creation — adapt existing children
  const handleTableAdaptExisting = useCallback(() => {
    if (tableTargetBlockId == null || !_propsAllClasses) return;
    const cls = _propsAllClasses.find(c => c.uuid === SYSTEM_CLASS_UUIDS.table);
    if (cls) addClass.mutate({ nodeUuid: tableTargetBlockId, classId: cls.uuid });
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
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- cover wrapper only stops event bubbling
      <div
        className={`node-card__cover${isCoverDragging ? ' node-card__cover--drag-over' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={() => setIsCoverHovered(true)}
        onMouseLeave={() => setIsCoverHovered(false)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <AssetImage
          assetNodeId={coverImageId}
          alt={`Cover image for ${nodeNameToText(node.name) || 'Untitled'}`}
          className="node-card__cover-image"
          assetVariant="card-cover"
          showCard={false}
          clickable={true}
          showActions={editable && isCoverHovered}
          actions={
            <>
              <Button aria-label="Change image"
                icon={"mdi mdi-pencil"}
                variant="ghost"
                size="sm"
                onClick={() => setIsAssetUploadOpen(true)}
                title="Change image"
              />
              <Button aria-label="Remove image"
                icon={"mdi mdi-close"}
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
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- cover wrapper only stops event bubbling
        <div
          className={`node-card__cover${isCoverDragging ? ' node-card__cover--drag-over' : ''}`}
          onClick={(e) => e.stopPropagation()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <AddCoverButton onClick={() => setIsAssetUploadOpen(true)} onDrop={handleCoverDropped} processDrop={extractImageFromDragEvent} size="sm" variant="card-cover" />
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
        data-card-context={context}
        data-fill={fill || undefined}
      >
        {/* Selection checkbox — shown on hover */}
        {onSelectionChange && (
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- wrapper only stops event bubbling
          <div className="node-card__checkbox hover-reveal" onClick={handleCheckboxClick}>
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
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- wrapper only stops event bubbling
            <div className="node-card__breadcrumbs-row" onClick={(e) => e.stopPropagation()}>
              <NodeBreadcrumbs
                nodeUuid={node.uuid}
                nodeType={node.is_page ? 'page' : 'block'}
                compact
                onNavigate={openNode}
              />
            </div>
          )}
          <div className="node-card__header-row">
            <Button
              variant="ghost"
              size="xs"
              icon="mdi mdi-chevron-down"
              className={`node-card__collapse-btn${hasChildren ? ' node-card__collapse-btn--has-children' : ''}`}
              onClick={(e) => { e.stopPropagation(); setIsBodyCollapsed(v => !v); }}
              title={isBodyCollapsed ? 'Expand' : 'Collapse'}
              aria-label={isBodyCollapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!isBodyCollapsed}
            />
            <div className="node-card__title-wrapper">
              <CardTitleEditor
                blockId={String(node.uuid || node.uuid)}
                initialContent={getRuntimeDisplayName(node)}
                readOnly={!editable}
                onContentChange={handleBlockContentChange}
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
              key={cls.uuid}
              node={cls}
              readOnly={!editable}
              onRemove={isNonRemovableClass(cls.uuid) ? undefined : () => removeClass.mutate({ nodeUuid: node.uuid, classId: cls.uuid })}
              onColorChange={(color) => updateNode.mutate({ nodeUuid: cls.uuid, data: { color } })}
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
            nodeUuid={node.uuid}
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
              key={tag.uuid}
              node={tag}
              readOnly={!editable}
              onRemove={() => removeClass.mutate({ nodeUuid: node.uuid, classId: tag.uuid })}
              onColorChange={(color) => updateNode.mutate({ nodeUuid: tag.uuid, data: { color } })}
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
                onContentChange={handleBlockContentChange}
                onNavigateToNode={handleNavigateToNode}
                onOpenInSidebar={handleOpenBlockInSidebar}
                onAddClass={handleAddClass}
                onSlashCommand={handleSlashCommand}
                nodeUuid={node.uuid}
                inCard
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
