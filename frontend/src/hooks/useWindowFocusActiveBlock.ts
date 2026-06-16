/**
 * useWindowFocusActiveBlock — Suspend active block edit mode when the window loses focus.
 *
 * Matches Logseq-style behaviour: when the user clicks into another application,
 * the current block editor is deactivated (caret + bullet thread hidden). When
 * the window regains focus, the active block is restored so editing continues.
 */

import { useEffect, useRef } from 'react';
import { useEditorFocusStore } from '@/stores/editorFocusStore';

export function useWindowFocusActiveBlock(): void {
  const focusBlock = useEditorFocusStore((s) => s.focusBlock);
  const blurBlock = useEditorFocusStore((s) => s.blurBlock);
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const suspendedRef = useRef<string | null>(null);

  useEffect(() => {
    const handleBlur = () => {
      if (activeBlockId) {
        suspendedRef.current = activeBlockId;
        blurBlock(activeBlockId);
      }
    };

    const handleFocus = () => {
      const suspended = suspendedRef.current;
      suspendedRef.current = null;
      if (suspended) {
        focusBlock(suspended);
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, [activeBlockId, blurBlock, focusBlock]);
}
