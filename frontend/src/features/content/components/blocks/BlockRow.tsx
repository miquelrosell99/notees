/**
 * BlockRow — Single block row in the block-level editor.
 *
 * Composes BlockUI (chrome) + InlineEditor (content) + BlockAfterContent.
 * One BlockRow per block. React owns the tree; the inline editor owns only inline text.
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
import { parseAST, parseLinkId, buildLinkId, unwrapCrdtContentAst } from '@/lib/astBuilder';
import { NodeContextMenu } from '@/features/content/components/nodes/NodeContextMenu';
import { ConvertToPageModal } from '@/features/content/components/nodes/ConvertToPageModal';
import { createBlockCopyData, copyToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { useAuthStore } from '@/features/auth';
import { useCoreBlockMutations } from '@/features/content/hooks/useCoreBlockMutations';
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
import type { ASTDocument as ContentAST } from '@/types/ast';
import type { JSX } from 'react';
import { useNode, useChildren, useWorkspaceStoreClient } from '@/core/hooks';

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
  /** When true, the list root is a focused block; the root row renders its
   *  full PropertiesSection after itself instead of the compact inline panel. */
  rootIsBlock?: boolean;
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
            documentMode,
            rootIsBlock = false },
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
    const { client } = useWorkspaceStoreClient(workspaceId ?? '');
    const mutations = useCoreBlockMutations(workspaceId);
    const { node: coreNode } = useNode(workspaceId ?? '', node.uuid);
    const parentId = coreNode?.parentId ?? node.parent_uuid ?? null;
    const { node: parentNode } = useNode(workspaceId ?? '', parentId ?? undefined);
    const { children: parentSiblingIds } = useChildren(workspaceId ?? '', parentNode?.parentId ?? undefined);
    const setCollapsed = useUIStateStore((s) => s.setCollapsed);

    const currentUserId = useAuthStore((s) => s.user?.nodeUuid ?? 0);

    // Scalar presence state is combined into one subscription to reduce the
    // per-row subscription count in large virtualized lists.
    const { lockOwner, isQueued, conflict } = useLivePresenceStore(
      useShallow(
        useCallback(
          (s) =>
            nodeUuid
              ? {
                  lockOwner: s.locks[nodeUuid]?.[node.uuid],
                  isQueued: s.isQueued(nodeUuid, node.uuid),
                  conflict: s.getConflict(nodeUuid, node.uuid),
                }
              : { lockOwner: undefined, isQueued: false, conflict: undefined },
          [nodeUuid, node.uuid],
        ),
      ),
    );
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

    const rowRef = useRef<HTMLDivElement>(null);

    // Mount the inline editor only for the block being edited. All other
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
        // Wait for pending/in-flight debounced saves before mounting the
        // editor; otherwise a quick blur→refocus can initialize the editor
        // with content captured before the blur flush landed.
        void flushAllContentSaves().then(() => {
          useEditorFocusStore.getState().focusBlock(node.uuid);
          useEditorFocusStore.getState().setPendingFocus(node.uuid);
        });
      },
      [node.uuid, readOnly, isLocked],
    );

    // Heal inline node_link targets against the canonical node_link row before
    // navigation. This keeps the AST cache in sync with the link registry when a
    // link instance's target has drifted (e.g. after a migration or manual fix).
    const handlePillClick = useCallback(
      async (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user') => {
        if (!client || (refType !== 'node' && refType !== 'class')) {
          onPillClick?.(linkId, refType);
          return;
        }

        const canonical = await client.mutate<string | null>('resolveAndHealNodeLink', [node.uuid, linkId]);
        const { linkUuid } = parseLinkId(linkId);
        const healedLinkId = canonical && linkUuid ? buildLinkId(canonical, linkUuid) : linkId;
        onPillClick?.(healedLinkId, refType);
      },
      [client, node.uuid, onPillClick],
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

    // Prefer the live store copy (`useNode` refetches on every notification for
    // this block) over the tree-projection prop: text saves emit scope 'node',
    // which does not invalidate GetNodeTreeQuery, so the projection lags behind
    // after a save. Reading live content keeps the static view correct after
    // blur and prevents editor remounts from initializing with stale text.
    const liveContent = coreNode?.content ?? node.content ?? node.name;
    const contentAST = useMemo(
      () => unwrapCrdtContentAst(parseAST(liveContent)) as ContentAST,
      [liveContent],
    );
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
      if (!workspaceId || parentSiblingIds.length === 0) return;

      const anyExpanded = parentSiblingIds.some(
        (siblingId) => !useUIStateStore.getState().getNodeUIState(workspaceId, siblingId)?.collapsed,
      );
      const targetCollapsed = anyExpanded;

      for (const siblingId of parentSiblingIds) {
        setCollapsed(workspaceId, siblingId, targetCollapsed);
      }
    }, [workspaceId, parentSiblingIds, setCollapsed]);

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
      const data = createBlockCopyData([node]);
      copyToClipboard(JSON.stringify(data))
        .then(() => useClipboardStore.getState().setCopied(data))
        .catch(console.error);
    }, [node]);

    const handlePasteBlocks = useCallback(async () => {
      const { copiedBlocks } = useClipboardStore.getState();
      if (copiedBlocks) {
        await mutations.pasteBlocksAfter({ afterBlockId: node.uuid, blockData: copiedBlocks });
      }
    }, [node.uuid, mutations]);

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
    // Read from the local-first core store so it works for newly-created blocks.
    const parentIsCard = parentNode?.classIds.includes(SYSTEM_CLASS_UUIDS.card) ?? false;

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

    const handleEditorBlur = useCallback(async () => {
      // Flush pending debounced saves before unmounting the editor so the
      // static view does not briefly show stale content after blur.
      await flushAllContentSaves();
    }, []);

    // Pill Delete/Unlink from the static (read-only) view: save and flush
    // immediately so the runtime projection is up-to-date before the editor
    // could mount with stale content on the next click.
    const handleStaticContentEdit = useCallback(
      async (content: string) => {
        onContentChange?.(node.uuid, content);
        await flushAllContentSaves();
      },
      [node.uuid, onContentChange],
    );

    const editorElement = isGhost ? (
      <button
        type="button"
        className="block-row__content-fallback block-row__content-fallback--ghost"
        onClick={() => onGhostRealize?.(node.uuid)}
        aria-label="Add block"
      >
        <span className="block-row__ghost-text">+ Add block</span>
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
        onPillClick={handlePillClick}
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
        name={liveContent}
        placeholder={placeholder}
        blockId={node.uuid}
        onFocus={handleFocusStatic}
        onContentEdit={!readOnly && !isLocked && onContentChange ? handleStaticContentEdit : undefined}
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
          {/* Inline properties: class-declared properties (even empty) and
              valued ad-hoc ones. Icon-visible properties stay as bullet/content
              icons; hidden and empty-hide-when-empty properties are omitted in
              rows. The root focused block renders its full PropertiesSection
              below the row instead.

              Property-value blocks rendered inside a property editor show their
              own content only; their own properties section is suppressed so the
              panel doesn't recurse or offer "Add property" on a property value. */}
          {!isGhost && !inPropertyEditor && !(rootIsBlock && depth === 0) && (
            <PropertiesSection
              nodeUuid={node.uuid}
              inline
              readOnly={readOnly}
              isMainNode={false}
              showHiddenSection={false}
              showAddProperty={false}
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
      {/* Full properties panel for the root focused block. Placed after the
          row so the focused block is the first thing visible, with its metadata
          immediately following and its children rendered underneath.

          Suppressed for blocks rendered inside a property editor (see inline
          properties comment above). */}
      {rootIsBlock && depth === 0 && !isGhost && !inPropertyEditor && (
        <PropertiesSection
          nodeUuid={node.uuid}
          showHiddenSection={true}
          showAddProperty={true}
          isMainNode={true}
          onNavigateToNode={onNavigate}
          onOpenInSidebar={onOpenInSidebar}
          className="block-row__root-properties"
        />
      )}
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
