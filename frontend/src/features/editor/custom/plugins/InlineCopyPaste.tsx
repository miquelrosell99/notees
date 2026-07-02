/**
 * InlineCopyPaste — Custom-editor port of InlineCopyPastePlugin.
 *
 * Handles the copy side for a single inline editor:
 *   - copy: [[blockUuid]] when no text is selected
 *
 * Paste handling lives in useInlineCopyPaste and is wired to the root's
 * onPaste prop by CustomInlineEditor.
 */

import { useEffect, type JSX } from 'react';
import { copyToClipboard } from '@/utils/clipboardManager';
import { useClipboardStore } from '@/stores/clipboardStore';

interface InlineCopyPasteProps {
  rootRef: React.RefObject<HTMLDivElement | null>;
  blockId: string;
}

export function InlineCopyPaste({ rootRef, blockId }: InlineCopyPasteProps): JSX.Element | null {
  // COPY_COMMAND equivalent: copy [[blockUuid]] when no text is selected.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      if (!selection || !selection.isCollapsed) return;
      if (!root.contains(selection.anchorNode)) return;

      const linkText = `[[${blockId}]]`;
      if (event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData('text/plain', linkText);
      } else {
        void copyToClipboard(linkText);
      }
      useClipboardStore.getState().setLinkMode();
      event.stopPropagation();
    };

    root.addEventListener('copy', handleCopy, true);
    return () => root.removeEventListener('copy', handleCopy, true);
  }, [rootRef, blockId]);

  return null;
}
