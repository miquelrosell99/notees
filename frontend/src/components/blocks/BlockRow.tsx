/**
 * BlockRow — Single block row in the block-level editor.
 *
 * Composes BlockUI (chrome) + InlineEditor (content) + BlockAfterContent.
 * One BlockRow per block. React owns the tree; Lexical owns only inline text.
 */

import { useRef, useMemo, useEffect, forwardRef, useImperativeHandle, useState, useCallback } from 'react';
import { InlineEditor, type InlineEditorHandle } from '@/editor/InlineEditor';
import { BlockUI } from './BlockUI';
import { BlockAfterContent } from './BlockAfterContent';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { parseAST } from '@/lib/astBuilder';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { NodeContextMenu } from '@/components/nodes/NodeContextMenu';
import { copyRuntimeBlocksToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';
import { useAuthStore } from '@/stores/authStore';
import { pasteBlocksAfterBlock } from '@/editor/utils/pasteBlocks';
import { useLivePresenceStore, type PresenceUser } from '@/stores/livePresenceStore';
import './BlockRow.css';
import type { Node } from '@/types/api';
import type { JSX } from 'react';

const EMPTY_USERS: PresenceUser[] = [];

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
  onCollapseToggle?: () => void;
  onNavigate?: (blockId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onAddClass?: (blockServerId: number, classId: number) => void;
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  templateClassFilters?: number[];
  onEnter?: () => void;
  onBackspaceAtStart?: () => void;
  onDeleteAtEnd?: () => void;
  onTab?: (shift: boolean) => void;
  /** UUID of the containing page (for live sync lock indicators). */
  pageUuid?: string;
}

// ─── Component ────────────────────────────────────────────────────

export const BlockRow = forwardRef<BlockRowHandle, BlockRowProps>(
  function BlockRow(
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
      onTemplateInstantiate,
      templateClassFilters,
      onEnter,
      onBackspaceAtStart,
      onDeleteAtEnd,
      onTab,
      pageUuid,
    },
    ref,
  ): JSX.Element {
    const editorRef = useRef<InlineEditorHandle>(null);
    const pendingFocusBlockId = useEditorFocusStore((s) => s.pendingFocusBlockId);
    const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
    const isActive = activeBlockId === node.uuid;

    // Check if another user is editing this block
    const usersOnBlock = useLivePresenceStore(
      (s) => (pageUuid ? s.presence[pageUuid]?.[node.uuid] : undefined) ?? EMPTY_USERS,
    );
    const currentUserId = useAuthStore((s) => s.user?.id ?? 0);
    const lockedBy = useMemo(
      () => usersOnBlock.filter((u) => u.id !== currentUserId),
      [usersOnBlock, currentUserId],
    );
    const isLocked = lockedBy.length > 0;

    // Focus editor when pending focus matches this block
    useEffect(() => {
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

    const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);

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

    return (
      <>
      <div
        className={`block-row node-block ${isActive ? 'block-row--active' : ''}`}
        data-block-id={node.uuid}
        data-depth={depth}
        style={{ '--block-depth': depth } as React.CSSProperties}
      >
        <BlockUI
          node={node}
          onCollapseToggle={onCollapseToggle}
          onNavigate={onNavigate}
          onOpenInSidebar={onOpenInSidebar}
          onContextMenu={handleBulletContextMenu}
          lockedBy={lockedBy}
        />
        <div className="block-row__content">
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
            onTemplateInstantiate={onTemplateInstantiate}
            templateClassFilters={templateClassFilters}
            onEnter={onEnter}
            onBackspaceAtStart={onBackspaceAtStart}
            onDeleteAtEnd={onDeleteAtEnd}
            onTab={onTab}
            pageUuid={pageUuid}
          />
        </div>
        <BlockAfterContent node={node} />
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
);
