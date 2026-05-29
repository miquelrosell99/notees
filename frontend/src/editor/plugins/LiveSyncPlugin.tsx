/**
 * LiveSyncPlugin — Lexical plugin that reports block focus/blur to the
 * live-sync manager so other clients see presence indicators.
 *
 * This plugin does NOT handle save broadcasting (that happens in the
 * mutation hook); it only tracks which block the local caret is inside.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection } from 'lexical';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { liveSyncManager } from '@/collab/LiveSyncManager';
import { useLivePresenceStore } from '@/stores/livePresenceStore';

interface LiveSyncPluginProps {
  pageUuid: string | null | undefined;
}

export function LiveSyncPlugin({ pageUuid }: LiveSyncPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const lastBlockRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pageUuid) return;

    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        let currentBlockUuid: string | null = null;

        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          const blockNode = findParentNodeBlock(anchorNode);
          if (blockNode) {
            currentBlockUuid = blockNode.getBlockId();
          }
        }

        if (currentBlockUuid !== lastBlockRef.current) {
          const previous = lastBlockRef.current;
          lastBlockRef.current = currentBlockUuid;

          if (previous) {
            liveSyncManager.sendBlur(previous);
          }
          if (currentBlockUuid) {
            liveSyncManager.sendFocus(currentBlockUuid);
            useLivePresenceStore.getState().setLocalFocus(pageUuid, currentBlockUuid);
          } else {
            useLivePresenceStore.getState().setLocalFocus(pageUuid, null);
          }
        }
      });
    });
  }, [editor, pageUuid]);

  // On unmount, blur whatever block was last focused
  useEffect(() => {
    return () => {
      const last = lastBlockRef.current;
      if (last) {
        liveSyncManager.sendBlur(last);
        lastBlockRef.current = null;
      }
      if (pageUuid) {
        useLivePresenceStore.getState().setLocalFocus(pageUuid, null);
      }
    };
  }, [pageUuid]);

  return null;
}
