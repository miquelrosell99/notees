/**
 * BlockRow — Single block row in the block-level editor.
 *
 * Composes BlockUI (chrome) + InlineEditor (content) + BlockAfterContent.
 * One BlockRow per block. React owns the tree; Lexical owns only inline text.
 */

import { useRef, useMemo, useEffect, useLayoutEffect, forwardRef, useImperativeHandle, useState, useCallback, memo } from 'react';
import { InlineEditor, type InlineEditorHandle } from '@/editor/InlineEditor';
import { BlockUI } from './BlockUI';
import { BlockAfterContent } from './BlockAfterContent';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { parseAST } from '@/lib/astBuilder';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { NodeContextMenu } from '@/components/nodes/NodeContextMenu';
import { copyRuntimeBlocksToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { useAuthStore } from '@/stores/authStore';
import { pasteBlocksAfterBlock } from '@/editor/utils/pasteBlocks';
import { useLivePresenceStore } from '@/stores/livePresenceStore';
import { useShallow } from 'zustand/react/shallow';
import { useTaskActions } from '@/hooks/useTaskActions';
import { useResolvedClassDetails } from '@/hooks/useResolvedClassDetails';
import { ClassPillsRow } from '@/components/nodes/ClassPillsRow';
import './BlockRow.css';
import type { Node } from '@/types/api';
import type { JSX } from 'react';

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
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken') => void;
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
  onTab?: (blockId: string, shift: boolean) => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: (blockId: string) => void;
  /** UUID of the containing page (for live sync lock indicators). */
  nodeUuid?: string;
  /** Whether to show class pills below the block content. */
  showClasses?: boolean;
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
      onTab,
      onEscape,
      nodeUuid,
      showClasses = false,
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

    // Stable callbacks: use refs so InlineEditor memo doesn't re-render when parent passes new refs
    const callbacksRef = useRef({
      onEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onTab,
      onEscape,
      onCollapseToggle,
    });
    useLayoutEffect(() => {
      callbacksRef.current = {
        onEnter,
        onBackspaceAtStart,
        onDeleteAtEnd,
        onTab,
        onEscape,
        onCollapseToggle,
      };
    }, [onEnter, onBackspaceAtStart, onDeleteAtEnd, onTab, onEscape, onCollapseToggle]);

    const handleEnter = useCallback(() => callbacksRef.current.onEnter?.(node.uuid), [node.uuid]);
    const handleBackspaceAtStart = useCallback(() => callbacksRef.current.onBackspaceAtStart?.(node.uuid), [node.uuid]);
    const handleDeleteAtEnd = useCallback(() => callbacksRef.current.onDeleteAtEnd?.(node.uuid), [node.uuid]);
    const handleTab = useCallback((shift: boolean) => callbacksRef.current.onTab?.(node.uuid, shift), [node.uuid]);
    const handleEscape = useCallback(() => callbacksRef.current.onEscape?.(node.uuid), [node.uuid]);
    const handleCollapseToggleLocal = useCallback(() => callbacksRef.current.onCollapseToggle?.(node.uuid), [node.uuid]);

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
      const runtime = getNodeGraphRuntime();
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

    const plainTextFallback = useMemo(() => nodeNameToText(node.name), [node.name]);
    const classDetails = useResolvedClassDetails(node.classes);
    const hasClasses = showClasses && classDetails.length > 0;

    const editorElement = shouldMountEditor ? (
      <InlineEditor
        ref={editorRef}
        blockId={node.uuid}
        initialContentAST={contentAST}
        readOnly={readOnly || isLocked}
        placeholder={placeholder}
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
        onTab={handleTab}
        onEscape={handleEscape}
        nodeUuid={nodeUuid}
      />
    ) : (
      <div
        className="block-row__content-fallback"
        onClick={() => setIsInViewport(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsInViewport(true);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Load editor"
      >
        {plainTextFallback || '\u00A0'}
      </div>
    );

    return (
      <>
      <div
        ref={rowRef}
        className={`block-row node-block ${isActive ? 'block-row--active' : ''}`}
        data-block-id={node.uuid}
        data-depth={depth}
        style={{ '--block-depth': depth } as React.CSSProperties}
      >
        <BlockUI
          node={node}
          onCollapseToggle={handleCollapseToggleLocal}
          onNavigate={onNavigate}
          onOpenInSidebar={onOpenInSidebar}
          onContextMenu={handleBulletContextMenu}
          lockedBy={lockedBy}
          presenceUsers={presenceUsers}
          typingUsers={typingUsers}
        />
        <div className="block-row__body">
          {hasClasses ? (
            <div className="block-row__content-line">
              <div className="block-row__content">
                {editorElement}
              </div>
              <ClassPillsRow classes={classDetails} nodeId={node.id} readOnly={readOnly} />
            </div>
          ) : (
            <div className="block-row__content">
              {editorElement}
            </div>
          )}
          <BlockAfterContent node={node} />
        </div>
      </div>
      {contextMenuPos && (
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
