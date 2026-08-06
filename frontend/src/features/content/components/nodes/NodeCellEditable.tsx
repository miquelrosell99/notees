import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import type { Node } from '@/types';
import { CustomInlineEditor, InlineContentStatic, flushAllContentSaves, useContentSave } from '@/features/editor';
import type { InlineEditorHandle } from '@/features/editor';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useNavigationStore } from '@/stores';
import { useWorkspaceStoreClient } from '@/core/hooks';
import { parseAST, parseLinkId } from '@/lib/astBuilder';

interface NodeCellEditableProps {
  node: Node;
}

/**
 * A table name cell that shows the block's own inline content and switches to
 * the bare inline editor on click.
 *
 * Uses the same content primitives as BlockRow (InlineContentStatic +
 * CustomInlineEditor) directly — no bullet, no child blocks, no nested view
 * mode. Focus is driven by editorFocusStore, so portaled editor popups
 * (trigger pickers, link edit modal) keep the editor mounted through the
 * popupOpen keepalive invariant.
 */
export function NodeCellEditable({ node }: NodeCellEditableProps) {
  const editorRef = useRef<InlineEditorHandle>(null);
  // Cursor offset captured from the static DOM click, passed to the editor on
  // the render that mounts it (same pattern as BlockRow).
  const pendingCursorOffsetRef = useRef<number | undefined>(undefined);
  const { handleContentChange } = useContentSave();
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { client } = useWorkspaceStoreClient(workspaceId ?? '');

  const isActive = useEditorFocusStore((s) => s.activeBlockId === node.uuid);
  const isPendingFocus = useEditorFocusStore((s) => s.pendingFocusBlockId === node.uuid);
  const shouldMountEditor = isActive || isPendingFocus;

  // The cell receives the node directly; its name is the source of truth for
  // the table cell (core-store subscription happens at the parent level).
  const displayName = node.name;
  const contentAST = useMemo(() => parseAST(displayName), [displayName]);

  // Focus the editor on the render that mounts it.
  useLayoutEffect(() => {
    if (isPendingFocus && editorRef.current) {
      editorRef.current.focus();
      useEditorFocusStore.getState().setPendingFocus(null);
    }
  }, [isPendingFocus]);

  // Drop the captured click offset when the editor unmounts so a later
  // keyboard-driven focus doesn't reuse a stale position.
  useEffect(() => {
    if (!shouldMountEditor) return;
    return () => {
      pendingCursorOffsetRef.current = undefined;
    };
  }, [shouldMountEditor]);

  const handleFocusStatic = useCallback(
    (cursorOffset?: number) => {
      pendingCursorOffsetRef.current = cursorOffset;
      useEditorFocusStore.getState().focusBlock(node.uuid);
      useEditorFocusStore.getState().setPendingFocus(node.uuid);
    },
    [node.uuid],
  );

  // Flush pending debounced saves before unmounting so the static view never
  // shows stale content after blur.
  const handleEditorBlur = useCallback(async () => {
    await flushAllContentSaves();
  }, []);

  // Enter/Escape commit and close — a cell has no sibling or child blocks.
  const handleCommitClose = useCallback(() => {
    editorRef.current?.blur();
  }, []);

  const handlePillClick = useCallback(
    async (linkId: string) => {
      let targetUuid = parseLinkId(linkId).nodeUuid;
      if (client) {
        const canonical = await client.mutate<string | null>('resolveAndHealNodeLink', [
          node.uuid,
          linkId,
        ]);
        if (canonical) {
          targetUuid = canonical;
        }
      }
      if (targetUuid) {
        useNavigationStore.getState().openNode(targetUuid);
      }
    },
    [client, node.uuid]
  );

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Wrapper solely prevents row selection when interacting with the cell editor; no semantic action.
    <div className="table-node-cell__name" onClick={(e) => e.stopPropagation()}>
      {shouldMountEditor ? (
        <CustomInlineEditor
          ref={editorRef}
          blockId={node.uuid}
          blockUuid={node.uuid}
          initialContentAST={contentAST}
          initialCursorOffset={pendingCursorOffsetRef.current}
          isPage={node.is_page}
          onContentChange={handleContentChange}
          onPillClick={handlePillClick}
          onEnter={handleCommitClose}
          onEscape={handleCommitClose}
          onBlur={handleEditorBlur}
        />
      ) : (
        <InlineContentStatic
          name={displayName}
          blockId={node.uuid}
          onFocus={handleFocusStatic}
          isPage={node.is_page}
        />
      )}
    </div>
  );
}
