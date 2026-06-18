/**
 * BlockRow — Single block row in the block-level editor.
 *
 * Composes BlockUI (chrome) + InlineEditor (content) + BlockAfterContent.
 * One BlockRow per block. React owns the tree; Lexical owns only inline text.
 */

import { useRef, useMemo, useEffect, useLayoutEffect, forwardRef, useImperativeHandle, useState, useCallback, memo, startTransition } from 'react';
import { InlineEditor, type InlineEditorHandle } from '@/features/editor';
import { BlockUI } from './BlockUI';
import { BlockAfterContent } from './BlockAfterContent';
import { BulletLine } from './BulletLine';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { liveSyncManager, useLivePresenceStore } from '@/features/collab';
import { parseAST, parseLinkId } from '@/lib/astBuilder';
import { nodeNameToText } from '@/features/queries';
import { NodeContextMenu } from '@/features/content/components/nodes/NodeContextMenu';
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
import { PropertyIconButton } from '@/features/properties';
import { getNodeColorStylesAuto } from '@/utils/color';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { Button } from '@/components/ui/Button';
import './BlockRow.css';
import type { Node, Property } from '@/types/api';
import type { JSX } from 'react';
import { getOperationRuntime } from '@/runtime';
import { getNode, getChildren } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';

function applyRuntimeIntent(intent: MutationIntent): void {
  getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

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
  onAddClass?: (blockServerId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  templateClassFilters?: number[];
  onEnter?: (blockId: string) => void;
  onBackspaceAtStart?: (blockId: string) => void;
  onDeleteAtEnd?: (blockId: string) => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: (blockId: string) => void;
  /** UUID of the containing page (for live sync lock indicators). */
  nodeUuid?: string;
  /** Whether to show class pills below the block content. */
  showClasses?: boolean;
  /** Effective collapsed state (may differ from node.collapsed when expandAll is active). */
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
      documentMode,
    },
    ref,
  ): JSX.Element {
    const editorRef = useRef<InlineEditorHandle>(null);
    const pendingFocusBlockId = useEditorFocusStore((s) => s.pendingFocusBlockId);
    const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
    const isActive = activeBlockId === node.uuid;

    // Check if another user holds the server-enforced lock for this block
    const lockOwner = useLivePresenceStore(
      (s) => (nodeUuid ? s.locks[nodeUuid]?.[node.uuid] : undefined),
    );
    const currentUserId = useAuthStore((s) => s.user?.id ?? 0);
    const lockedBy = lockOwner && Number(lockOwner.id) !== Number(currentUserId) ? [lockOwner] : undefined;
    const isLocked = lockedBy != null && lockedBy.length > 0;

    // Show remote presence and typing indicators
    // Use useShallow so identical arrays don't trigger re-renders.
    const presenceUsers = useLivePresenceStore(
      useShallow((s) => (nodeUuid ? s.getUsersOnBlock(nodeUuid, node.uuid).filter((u) => u.id !== currentUserId) : [])),
    );
    const typingUsers = useLivePresenceStore(
      useShallow((s) => (nodeUuid ? s.getTypingUsersOnBlock(nodeUuid, node.uuid).filter((u) => u.id !== currentUserId) : [])),
    );
    const isQueued = useLivePresenceStore(
      (s) => (nodeUuid ? s.isQueued(nodeUuid, node.uuid) : false),
    );
    const conflict = useLivePresenceStore(
      (s) => (nodeUuid ? s.getConflict(nodeUuid, node.uuid) : undefined),
    );

    // Lazy-mount editor based on viewport visibility to reduce DOM weight
    const [isInViewport, setIsInViewport] = useState(true);
    const rowRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = rowRef.current;
      if (!el) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          setIsInViewport(entry.isIntersecting);
        },
        { root: null, rootMargin: '500px 0px 500px 0px', threshold: 0 },
      );
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    const shouldMountEditor = isActive || pendingFocusBlockId === node.uuid || isInViewport;

    // Focus editor when pending focus matches this block
    useLayoutEffect(() => {
      if (pendingFocusBlockId === node.uuid && editorRef.current) {
        editorRef.current.focus();
        useEditorFocusStore.getState().setPendingFocus(null);
      }
    }, [pendingFocusBlockId, node.uuid]);

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
      const runtime = getOperationRuntime();
      const graphNode = getNode(runtime, node.uuid);
      if (!graphNode?.parentId) return;

      const siblings = getChildren(runtime, graphNode.parentId);
      if (siblings.length === 0) return;

      const anyExpanded = siblings.some((s) => !s.collapsed);
      const targetCollapsed = anyExpanded;

      applyRuntimeIntent({
        type: 'batch',
        intents: siblings.map((s) => ({
          type: 'set_collapsed',
          blockId: s.blockId,
          collapsed: targetCollapsed,
        })),
      });
      getRuntimeEventBus().flushEvents();
    }, [node.uuid]);

    const handleBulletContextMenu = useCallback(
      (_nodeId: number, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenuPos({ x: event.clientX, y: event.clientY });
      },
      [],
    );

    const handleCloseContextMenu = useCallback(() => {
      setContextMenuPos(null);
    }, []);

    const handleCopyBlocks = useCallback(() => {
      const runtime = getOperationRuntime();
      copyRuntimeBlocksToClipboard([node.uuid], runtime)
        .then((data) => useClipboardStore.getState().setCopied(data))
        .catch(console.error);
    }, [node.uuid]);

    const handlePasteBlocks = useCallback(() => {
      const { copiedBlocks } = useClipboardStore.getState();
      if (copiedBlocks) {
        pasteBlocksAfterBlock(copiedBlocks, node.uuid);
      }
    }, [node.uuid]);

    const handleRequestLock = useCallback(() => {
      if (!nodeUuid) return;
      liveSyncManager.sendRequestLock(node.uuid);
      useLivePresenceStore.getState().setQueued(nodeUuid, node.uuid, true);
    }, [node.uuid, nodeUuid]);

    const handleResolveConflict = useCallback(() => {
      if (!nodeUuid) return;
      useLivePresenceStore.getState().setConflict(nodeUuid, node.uuid, null);
      liveSyncManager.sendFocus(node.uuid);
    }, [node.uuid, nodeUuid]);

    const plainTextFallback = useMemo(() => nodeNameToText(node.name), [node.name]);
    const classDetails = useResolvedClassDetails(node.classes, { skipNodesFallback: true });

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

    // Query class detection for collapse arrow
    const { data: allClasses } = useClasses();
    const queryClass = useMemo(() => {
      if (!allClasses) return null;
      return allClasses.find((c) => c.uuid === SYSTEM_CLASS_UUIDS.query) ?? null;
    }, [allClasses]);
    const hasQueryClass = !!(queryClass && node.classes?.includes(queryClass.id));

    // Property icons inline based on icon_visibility
    const { data: allProperties } = useProperties();
    const propertyIcons = useMemo(() => {
      if (!node.properties || !allProperties) return { beforeContent: [] as Array<{ property: Property; value: unknown }>, afterBullet: [] as Array<{ property: Property; value: unknown }> };

      const beforeContent: Array<{ property: Property; value: unknown }> = [];
      const afterBullet: Array<{ property: Property; value: unknown }> = [];

      for (const prop of allProperties) {
        if (prop.icon_visibility === 'hidden') continue;

        const propIdKey = prop.id;
        const value = node.properties[propIdKey];
        if (value === undefined || value === null) continue;

        if (prop.icon_visibility === 'before_content') {
          beforeContent.push({ property: prop, value });
        } else if (prop.icon_visibility === 'after_bullet') {
          afterBullet.push({ property: prop, value });
        }
      }

      return { beforeContent, afterBullet };
    }, [node.properties, allProperties]);

    const colorStyle = useMemo(() => {
      if (!node.color) return undefined;
      return getNodeColorStylesAuto(node.color);
    }, [node.color]);

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
      <InlineEditor
        ref={editorRef}
        blockId={node.uuid}
        initialContentAST={contentAST}
        readOnly={readOnly || isLocked}
        placeholder={placeholder}
        isPage={node.is_page}
        hasNodeColor={!!node.color}
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
        nodeUuid={nodeUuid}
      />
    ) : (
      <button
        type="button"
        className="block-row__content-fallback"
        onClick={() => setIsInViewport(true)}
        aria-label="Load editor"
      >
        {plainTextFallback || '\u00A0'}
      </button>
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
            collapsed={effectiveCollapsed ?? node.collapsed ?? false}
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
            documentMode={documentMode}
          />
          {propertyIcons.afterBullet.length > 0 && (
            <div className="block-property-icons">
              {propertyIcons.afterBullet.map(({ property: prop, value: val }) => (
                <PropertyIconButton
                  key={prop.id}
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
                        key={prop.id}
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
                  onClick={toggleBacklinks}
                  onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
                  onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
                >
                  {node.backlink_count}
                </Button>
              )}
              {hasClasses && (
                <ClassPillsRow classes={visibleClassDetails} nodeId={node.id} readOnly={readOnly} onAddClass={onAddClass} />
              )}
            </div>
          ) : (
            <div className="block-row__content">
              {/* Property value icons - before content position */}
              {propertyIcons.beforeContent.length > 0 && !isActive && (
                <span className="block-property-icons--before-content">
                  {propertyIcons.beforeContent.map(({ property: prop, value: val }) => (
                    <PropertyIconButton
                      key={prop.id}
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
        />
      )}
      </>
    );
  },
));
