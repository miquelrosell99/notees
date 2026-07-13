/**
 * BlockRow — Single block row in the block-level editor.
 *
 * Composes BlockUI (chrome) + InlineEditor (content) + BlockAfterContent.
 * One BlockRow per block. React owns the tree; Lexical owns only inline text.
 */

import { useRef, useMemo, useLayoutEffect, useEffect, forwardRef, useImperativeHandle, useState, useCallback, memo, startTransition } from 'react';
import { useParams } from 'react-router-dom';
import { CustomInlineEditor } from '@/features/editor/custom/components/CustomInlineEditor';
import type { InlineEditorHandle } from '@/features/editor/editor/types';
import { InlineContentStatic } from '@/features/editor/editor/InlineContentStatic';
import { flushAllContentSaves } from '@/features/editor';
import { BlockUI } from './BlockUI';
import { BlockAfterContent } from './BlockAfterContent';
import { BulletLine } from './BulletLine';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useModalStore } from '@/stores/modalStore';
import { useUIStateStore } from '@/features/sync';
import { liveSyncManager, useLivePresenceStore } from '@/features/collab';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { NodeContextMenu } from '@/features/content/components/nodes/NodeContextMenu';
import { ConvertToPageModal } from '@/features/content/components/nodes/ConvertToPageModal';
import { copyRuntimeBlocksToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { useAuthStore } from '@/features/auth';
import { pasteBlocksAfterBlock } from '@/features/editor';
import { useShallow } from 'zustand/react/shallow';
// Kept as a deep import to avoid a circular dependency: useTaskActions imports
// the content barrel, and the content barrel exports BlockRow. Using the tasks
// barrel here would close the cycle content -> tasks -> content.
import { useTaskActions } from '@/features/tasks';
import { useProperties } from '@/features/properties';
import { useResolvedClassDetails, useClasses } from '@/features/content';
import { ClassPillsRow } from '@/features/content/components/nodes/ClassPillsRow';
import { PropertyIconButton, PropertiesSection } from '@/features/properties';
import { getNodeColorStylesAuto } from '@/utils/color';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { Button } from '@/components/ui/Button';
import './BlockRow.css';
import type { Node, Property } from '@/types/api';
import type { JSX } from 'react';
import { getOperationRuntime } from '@/runtime';
import { getNode, getChildren } from '@/runtime/graphHelpers';

// ─── Types ────────────────────────────────────────────────────────

export interface BlockRowHandle {
  focus: () => void;
  blur: () => void;
  getCursorPosition: () => 'start' | 'end' | 'middle' | 'empty';
  getCursorOffset: () => number;
}

interface BlockRowProps {
  node: Node;
  depth?: number;
  readOnly?: boolean;
  placeholder?: string;
  onContentChange?: (blockId: string, content: string) => void;
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user') => void;
  onPillRemove?: (linkId: string) => void;
  onCollapseToggle?: (blockId: string) => void;
  onNavigate?: (blockId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onAddClass?: (blockServerId: string, classId: string) => void;
  onSlashCommand?: (commandId: string, blockServerId: string | undefined) => void;
  onPasteImage?: (blockServerId: string, file: File, hasContent: boolean) => void;
  onTemplateInstantiate?: (templateNodeId: string, blockServerId: string | undefined) => void;
  templateClassFilters?: string[];
  onEnter?: (blockId: string) => void;
  onBackspaceAtStart?: (blockId: string) => void;
  onDeleteAtEnd?: (blockId: string) => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: (blockId: string) => void;
  /** UUID of the containing page (for live sync lock indicators). */
  nodeUuid?: string;
  /** Whether to show class pills below the block content. */
  showClasses?: boolean;
  /** Effective collapsed state driven by the device-local UI state store. */
  effectiveCollapsed?: boolean;
  /** True for the trailing pseudo-block that creates a real block on click. */
  isGhost?: boolean;
  /** Called when the ghost pseudo-block is clicked. */
  onGhostRealize?: (ghostUuid: string) => void;
  /** True when this block is an ancestor of the currently edited block. */
  isOnActiveTrail?: boolean;
  /** If true, the list-level overlay renders guide lines; this row only shows its own thread line. */
  useOverlayForGuides?: boolean;
  /** Whether this row is rendered inside a card context. */
  inCard?: boolean;
  /** Compact list-view size context (e.g. 'sm' for small list view). */
  listSize?: 'sm' | 'md';
  /** Whether this row is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
  /** When true, hide the bullet for this specific row (children keep theirs). */
  hideBullet?: boolean;
  /** Document mode: hide bullets and flatten chrome. */
  documentMode?: boolean;
}

// ─── Component ────────────────────────────────────────────────────

export const BlockRow = memo(
  forwardRef<BlockRowHandle, BlockRowProps>(function BlockRow(
    {
            node,
            depth = 0,
            readOnly = false,
            placeholder,
            onContentChange,
            onPillClick,
            onPillRemove,
            onCollapseToggle,
            onNavigate,
            onOpenInSidebar,
            onAddClass,
            onSlashCommand,
            onPasteImage,
            onTemplateInstantiate,
            templateClassFilters,
            onEnter,
            onBackspaceAtStart,
            onDeleteAtEnd,
            onEscape,
            nodeUuid,
            showClasses = false,
            effectiveCollapsed,
            isGhost = false,
            onGhostRealize,
            isOnActiveTrail = false,
            useOverlayForGuides = false,
            inCard = false,
            listSize,
            inPropertyEditor,
            hideBullet,
            documentMode },
    ref,
  ): JSX.Element {
    const editorRef = useRef<InlineEditorHandle>(null);
    // Cursor offset captured from the static DOM click. Stored in a ref so it
    // can be passed to InlineEditor on the render that mounts it without
    // triggering extra re-renders.
    const pendingCursorOffsetRef = useRef<number | undefined>(undefined);
    // Per-row selectors: only re-render this row when *this* block becomes or
    // stops being active. Subscribing every row to the raw activeBlockId forces
    // the entire visible list to re-render on every window blur/focus.
    const isActive = useEditorFocusStore((s) => s.activeBlockId === node.uuid);
    const isPendingFocus = useEditorFocusStore((s) => s.pendingFocusBlockId === node.uuid);
    const { workspaceId } = useParams<{ workspaceId?: string }>();
    const setCollapsed = useUIStateStore((s) => s.setCollapsed);

    // Check if another user holds the server-enforced lock for this block
    const lockOwner = useLivePresenceStore(
      (s) => (nodeUuid ? s.locks[nodeUuid]?.[node.uuid] : undefined),
    );
    const currentUserId = useAuthStore((s) => s.user?.nodeUuid ?? 0);
    const lockedBy = lockOwner && Number(lockOwner.nodeUuid) !== Number(currentUserId) ? [lockOwner] : undefined;
    const isLocked = lockedBy != null && lockedBy.length > 0;

    // Show remote presence and typing indicators
    // Use useShallow so identical arrays don't trigger re-renders.
    const presenceUsers = useLivePresenceStore(
      useShallow((s) => (nodeUuid ? s.getUsersOnBlock(nodeUuid, node.uuid).filter((u) => u.nodeUuid !== currentUserId) : [])),
    );
    const typingUsers = useLivePresenceStore(
      useShallow((s) => (nodeUuid ? s.getTypingUsersOnBlock(nodeUuid, node.uuid).filter((u) => u.nodeUuid !== currentUserId) : [])),
    );
    const isQueued = useLivePresenceStore(
      (s) => (nodeUuid ? s.isQueued(nodeUuid, node.uuid) : false),
    );
    const conflict = useLivePresenceStore(
      (s) => (nodeUuid ? s.getConflict(nodeUuid, node.uuid) : undefined),
    );

    const rowRef = useRef<HTMLDivElement>(null);

    // Mount the Lexical editor only for the block being edited. All other
    // visible blocks render a cheap static DOM view. This is the main lever for
    // reducing heap pressure on large pages.
    const shouldMountEditor = (isActive || isPendingFocus) && !isGhost && !readOnly && !isLocked;

    // Focus editor when pending focus matches this block
    useLayoutEffect(() => {
      if (isPendingFocus && editorRef.current) {
        editorRef.current.focus();
        useEditorFocusStore.getState().setPendingFocus(null);
      }
    }, [isPendingFocus]);

    // Clear the captured cursor offset when the editor unmounts so a later
    // keyboard-driven focus doesn't reuse an old click position.
    useEffect(() => {
      if (!shouldMountEditor) return;
      return () => {
        pendingCursorOffsetRef.current = undefined;
      };
    }, [shouldMountEditor]);

    const handleFocusStatic = useCallback(
      (cursorOffset?: number) => {
        if (readOnly || isLocked) return;
        pendingCursorOffsetRef.current = cursorOffset;
        useEditorFocusStore.getState().focusBlock(node.uuid);
        useEditorFocusStore.getState().setPendingFocus(node.uuid);
      },
      [node.uuid, readOnly, isLocked],
    );

    // Expose imperative handle for list-level keyboard navigation
    useImperativeHandle(
      ref,
      () => ({
        focus: () => editorRef.current?.focus(),
        blur: () => editorRef.current?.blur(),
        getCursorPosition: () => editorRef.current?.getCursorPosition() ?? 'empty',
        getCursorOffset: () => editorRef.current?.getCursorOffset() ?? 0,
      }),
      [],
    );

    const contentAST = useMemo(() => parseAST(node.name), [node.name]);
    const { cycleTaskStatus } = useTaskActions(node);

    const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
    const [showConvertToPageModal, setShowConvertToPageModal] = useState(false);
    const [backlinkExpanded, setBacklinkExpanded] = useState(false);
    const [isRowHovered, setIsRowHovered] = useState(false);
    const toggleBacklinks = useCallback(() => {
      startTransition(() => setBacklinkExpanded((v) => !v));
    }, []);

    // Stable callbacks: use refs so InlineEditor memo doesn't re-render when parent passes new refs
    const callbacksRef = useRef({
      onEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onEscape,
      onCollapseToggle,
    });
    useLayoutEffect(() => {
      callbacksRef.current = {
        onEnter,
        onBackspaceAtStart,
        onDeleteAtEnd,
        onEscape,
        onCollapseToggle,
      };
    }, [onEnter, onBackspaceAtStart, onDeleteAtEnd, onEscape, onCollapseToggle]);

    const handleEnter = useCallback(() => callbacksRef.current.onEnter?.(node.uuid), [node.uuid]);
    const handleBackspaceAtStart = useCallback(() => callbacksRef.current.onBackspaceAtStart?.(node.uuid), [node.uuid]);
    const handleDeleteAtEnd = useCallback(() => callbacksRef.current.onDeleteAtEnd?.(node.uuid), [node.uuid]);
    const handleEscape = useCallback(() => callbacksRef.current.onEscape?.(node.uuid), [node.uuid]);
    const handleCollapseToggleLocal = useCallback(() => callbacksRef.current.onCollapseToggle?.(node.uuid), [node.uuid]);

    const handleThreadLineClick = useCallback((e?: React.MouseEvent | React.KeyboardEvent) => {
      e?.stopPropagation();
      if (!workspaceId) return;
      const runtime = getOperationRuntime();
      const graphNode = getNode(runtime, node.uuid);
      if (!graphNode?.parentId) return;

      const siblings = getChildren(runtime, graphNode.parentId);
      if (siblings.length === 0) return;

      const anyExpanded = siblings.some(
        (s) => !useUIStateStore.getState().getNodeUIState(workspaceId, s.blockId)?.collapsed,
      );
      const targetCollapsed = anyExpanded;

      for (const sibling of siblings) {
        setCollapsed(workspaceId, sibling.blockId, targetCollapsed);
      }
    }, [node.uuid, workspaceId, setCollapsed]);

    const handleBulletContextMenu = useCallback(
      (_nodeId: string | number, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenuPos({ x: event.clientX, y: event.clientY });
      },
      [],
    );

    const handleCloseContextMenu = useCallback(() => {
      setContextMenuPos(null);
    }, []);

    const handleConvertToPage = useCallback(() => {
      setShowConvertToPageModal(true);
    }, []);

    const handleCopyBlocks = useCallback(() => {
      const runtime = getOperationRuntime();
      copyRuntimeBlocksToClipboard([node.uuid], runtime)
        .then((data) => useClipboardStore.getState().setCopied(data))
        .catch(console.error);
    }, [node.uuid]);

    const handlePasteBlocks = useCallback(async () => {
      const { copiedBlocks } = useClipboardStore.getState();
      if (copiedBlocks) {
        await pasteBlocksAfterBlock(copiedBlocks, node.uuid);
      }
    }, [node.uuid]);

    const handleRequestLock = useCallback(() => {
      if (!nodeUuid) return;
      liveSyncManager.sendRequestLock(node.uuid);
      useLivePresenceStore.getState().setQueued(nodeUuid, node.uuid, true);
    }, [node.uuid, nodeUuid]);

    const handleResolveConflict = useCallback(() => {
      if (!nodeUuid) return;
      const conflict = useLivePresenceStore.getState().getConflict(nodeUuid, node.uuid);
      if (conflict?.reason === '409_conflict') {
        useModalStore.getState().setConflictResolutionModalOpen(true, node.uuid);
        return;
      }
      useLivePresenceStore.getState().setConflict(nodeUuid, node.uuid, null);
      liveSyncManager.sendFocus(node.uuid);
    }, [node.uuid, nodeUuid]);

    const classDetails = useResolvedClassDetails(node.classes_uuid, { skipNodesFallback: true });

    // Determine the icon to show on the bullet
    // Priority: block's own icon > first class's icon
    const bulletIcon = useMemo(() => {
      if (node.icon) {
        return node.icon;
      }
      if (classDetails.length > 0) {
        const firstClassWithIcon = classDetails.find((c) => c.icon);
        if (firstClassWithIcon?.icon) {
          return firstClassWithIcon.icon;
        }
      }
      return undefined;
    }, [node.icon, classDetails]);

    // Hide class pills that are already referenced inline in the block content
    const inlineClassUuids = useMemo(() => {
      const uuids = new Set<string>();

      function walkInlines(inlines: Array<{ type: string; ref_type?: string; link_id?: string; children?: unknown[] }>) {
        for (const n of inlines) {
          if (n.type === 'node_link' && n.ref_type === 'class' && n.link_id) {
            const { nodeUuid } = parseLinkId(n.link_id);
            if (nodeUuid) uuids.add(nodeUuid);
          } else if (Array.isArray(n.children)) {
            walkInlines(n.children as Array<{ type: string; ref_type?: string; link_id?: string; children?: unknown[] }>);
          }
        }
      }

      for (const block of contentAST) {
        if ('children' in block && Array.isArray(block.children)) {
          walkInlines(block.children as Array<{ type: string; ref_type?: string; link_id?: string; children?: unknown[] }>);
        }
      }
      return uuids;
    }, [contentAST]);

    const visibleClassDetails = useMemo(
      () => classDetails.filter((cls) => !inlineClassUuids.has(cls.uuid)),
      [classDetails, inlineClassUuids],
    );

    const hasClasses = showClasses && (visibleClassDetails.length > 0 || !!onAddClass);
    const hasBacklinks = (node.backlink_count ?? 0) > 0;

    // Determine whether the parent is a card for class-pill filtering.
    // Computed from the runtime so it works for newly-created blocks that are
    // not yet persisted on the server. Read inline (no memo) so it stays
    // current when the parent's classes change without a node uuid change.
    const runtimeForParentCheck = getOperationRuntime();
    const graphNodeForParentCheck = getNode(runtimeForParentCheck, node.uuid);
    const parentGraphNode = graphNodeForParentCheck?.parentId
      ? getNode(runtimeForParentCheck, graphNodeForParentCheck.parentId)
      : undefined;
    const parentIsCard = parentGraphNode?.classIds?.includes(SYSTEM_CLASS_UUIDS.card) ?? false;

    // Query class detection for collapse arrow
    const { data: allClasses } = useClasses();
    const queryClass = useMemo(() => {
      if (!allClasses) return null;
      return allClasses.find((c) => c.uuid === SYSTEM_CLASS_UUIDS.query) ?? null;
    }, [allClasses]);
    const hasQueryClass = !!(queryClass && node.classes_uuid?.includes(queryClass.uuid));

    // Property icons inline based on icon_visibility
    const { data: allProperties } = useProperties();
    const propertyIcons = useMemo(() => {
      if (!node.properties_uuid || !allProperties) return { beforeContent: [] as Array<{ property: Property; value: unknown }>, afterBullet: [] as Array<{ property: Property; value: unknown }> };

      const beforeContent: Array<{ property: Property; value: unknown }> = [];
      const afterBullet: Array<{ property: Property; value: unknown }> = [];

      for (const prop of allProperties) {
        if (prop.icon_visibility === 'hidden') continue;

        const propIdKey = prop.uuid;
        const value = node.properties_uuid[propIdKey];
        if (value === undefined || value === null) continue;

        if (prop.icon_visibility === 'before_content') {
          beforeContent.push({ property: prop, value });
        } else if (prop.icon_visibility === 'after_bullet') {
          afterBullet.push({ property: prop, value });
        }
      }

      return { beforeContent, afterBullet };
    }, [node.properties_uuid, allProperties]);

    // Background tinting should only reflect the node's own direct color,
    // not colors inherited from assigned classes.
    const directNodeColor = node.color;

    const colorStyle = useMemo(() => {
      if (!directNodeColor) return undefined;
      return getNodeColorStylesAuto(directNodeColor);
    }, [directNodeColor]);

    const handleEditorBlur = useCallback(() => {
      // Flush pending debounced saves before unmounting the editor so the
      // static view does not briefly show stale content after blur.
      flushAllContentSaves();
    }, []);

    const editorElement = isGhost ? (
      <button
        type="button"
        className="block-row__content-fallback block-row__content-fallback--ghost"
        onClick={() => onGhostRealize?.(node.uuid)}
        aria-label="Add block"
        title="Click to add a block"
      >
        {'\u00A0'}
      </button>
    ) : shouldMountEditor ? (
      <CustomInlineEditor
        ref={editorRef}
        blockId={node.uuid}
        blockUuid={node.uuid}
        initialContentAST={contentAST}
        initialCursorOffset={pendingCursorOffsetRef.current}
        readOnly={readOnly || isLocked}
        placeholder={placeholder}
        isPage={node.is_page}
        hasNodeColor={!!directNodeColor}
        inCard={inCard}
        listSize={listSize}
        inPropertyEditor={inPropertyEditor}
        onContentChange={onContentChange}
        onPillClick={onPillClick}
        onPillRemove={onPillRemove}
        onAddClass={onAddClass}
        onSlashCommand={onSlashCommand}
        onPasteImage={onPasteImage}
        onTemplateInstantiate={onTemplateInstantiate}
        templateClassFilters={templateClassFilters}
        onEnter={handleEnter}
        onCtrlEnter={cycleTaskStatus}
        onBackspaceAtStart={handleBackspaceAtStart}
        onDeleteAtEnd={handleDeleteAtEnd}
        onEscape={handleEscape}
        onBlur={handleEditorBlur}
        nodeUuid={nodeUuid}
      />
    ) : (
      <InlineContentStatic
        name={node.name}
        placeholder={placeholder}
        blockId={node.uuid}
        onFocus={handleFocusStatic}
        isPage={node.is_page}
        hasNodeColor={!!directNodeColor}
        inCard={inCard}
        listSize={listSize}
        inPropertyEditor={inPropertyEditor}
        className="block-row__content-static"
      />
    );

    return (
      <>
      <div
        ref={rowRef}
        className={`block-row node-block ${isActive ? 'block-row--active' : ''} ${node.is_page ? 'node-block--page' : ''} ${isGhost ? 'block-row--ghost' : ''}`}
        data-block-id={node.uuid}
        data-depth={depth}
        data-ghost={isGhost || undefined}
        data-in-card={inCard || undefined}
        data-list-size={listSize || undefined}
        data-property-editor={inPropertyEditor || undefined}
        data-document-mode={documentMode || undefined}
        style={{ '--block-depth': depth, ...colorStyle } as React.CSSProperties}
        onMouseEnter={() => setIsRowHovered(true)}
        onMouseLeave={() => setIsRowHovered(false)}
      >
        {depth > 0 && !isGhost && (
          <BulletLine
            depth={Math.min(depth, 8)}
            isActivePath={isActive || isOnActiveTrail}
            onClick={handleThreadLineClick}
            interactive={!readOnly}
            useOverlayForGuides={useOverlayForGuides}
          />
        )}
        <div className="block-row__left">
          <BlockUI
            node={node}
            icon={bulletIcon}
            interactive={!isGhost}
            hasChildren={!isGhost && (hasQueryClass || (node.has_children ?? false))}
            collapsed={effectiveCollapsed ?? false}
            onCollapseToggle={isGhost ? undefined : handleCollapseToggleLocal}
            onNavigate={isGhost ? undefined : onNavigate}
            onOpenInSidebar={isGhost ? undefined : onOpenInSidebar}
            onContextMenu={isGhost ? undefined : handleBulletContextMenu}
            isActivePath={isActive || isOnActiveTrail}
            depth={depth}
            lockedBy={lockedBy}
            presenceUsers={presenceUsers}
            typingUsers={typingUsers}
            isQueued={isQueued}
            conflict={conflict}
            onRequestLock={nodeUuid ? handleRequestLock : undefined}
            onResolveConflict={nodeUuid ? handleResolveConflict : undefined}
            rowHover={isRowHovered}
            isGhost={isGhost}
            listSize={listSize}
            inPropertyEditor={inPropertyEditor}
            hideBullet={hideBullet}
            documentMode={documentMode}
          />
          {propertyIcons.afterBullet.length > 0 && (
            <div className="block-property-icons">
              {propertyIcons.afterBullet.map(({ property: prop, value: val }) => (
                <PropertyIconButton
                  key={prop.uuid}
                  property={prop}
                  node={node}
                  value={val}
                  editable={!readOnly}
                />
              ))}
            </div>
          )}
        </div>
        <div className="block-row__body">
          {isGhost ? (
            <div className="block-row__content">
              {editorElement}
            </div>
          ) : hasClasses || hasBacklinks ? (
            <div className="block-row__content-line">
              <div className="block-row__content">
                {/* Property value icons - before content position */}
                {propertyIcons.beforeContent.length > 0 && !isActive && (
                  <span className="block-property-icons--before-content">
                    {propertyIcons.beforeContent.map(({ property: prop, value: val }) => (
                      <PropertyIconButton
                        key={prop.uuid}
                        property={prop}
                        node={node}
                        value={val}
                        editable={!readOnly}
                      />
                    ))}
                  </span>
                )}
                {editorElement}
              </div>
              {hasBacklinks && (
                <Button
                  variant="ghost"
                  size="xs"
                  active={backlinkExpanded}
                  className="block-row__backlink-button"
                  onClick={toggleBacklinks}
                  onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
                  onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
                >
                  {node.backlink_count}
                </Button>
              )}
              {hasClasses && (
                <ClassPillsRow classes={visibleClassDetails} nodeUuid={node.uuid} readOnly={readOnly} onAddClass={onAddClass} parentIsCard={parentIsCard} />
              )}
            </div>
          ) : (
            <div className="block-row__content">
              {/* Property value icons - before content position */}
              {propertyIcons.beforeContent.length > 0 && !isActive && (
                <span className="block-property-icons--before-content">
                  {propertyIcons.beforeContent.map(({ property: prop, value: val }) => (
                    <PropertyIconButton
                      key={prop.uuid}
                      property={prop}
                      node={node}
                      value={val}
                      editable={!readOnly}
                    />
                  ))}
                </span>
              )}
              {editorElement}
            </div>
          )}
          {/* Inline properties: set properties without inline icon visibility
              (those already render as bullet/content icons above). Returns null
              when the node has no qualifying properties. */}
          {!isGhost && (
            <PropertiesSection
              nodeUuid={node.uuid}
              inline
              readOnly={readOnly}
              isMainNode={false}
              showHiddenSection={false}
              showAddProperty={false}
              onlyWithValues
              onNavigateToNode={onNavigate}
              onOpenInSidebar={onOpenInSidebar}
              className="block-row__properties"
            />
          )}
        </div>
        {!isGhost && (
          <div className="block-row__after-content">
            <BlockAfterContent node={node} backlinkExpanded={backlinkExpanded} />
          </div>
        )}
      </div>
      {!isGhost && contextMenuPos && (
        <NodeContextMenu
          node={node}
          position={contextMenuPos}
          onClose={handleCloseContextMenu}
          onCopyBlocks={handleCopyBlocks}
          onPasteBlocks={handlePasteBlocks}
          onConvertToPage={handleConvertToPage}
        />
      )}
      <ConvertToPageModal
        node={node}
        isOpen={showConvertToPageModal}
        onClose={() => setShowConvertToPageModal(false)}
      />
      </>
    );
  },
));
