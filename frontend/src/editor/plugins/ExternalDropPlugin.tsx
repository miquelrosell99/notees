/**
 * ExternalDropPlugin — Handle dropping external nodes into the editor.
 *
 * When Alt is held, dropping a node from the sidebar creates an inline
 * link pill reference at the drop position instead of moving the node.
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection } from 'lexical';
import { $createInlineLinkNode } from '../nodes/InlineLinkNode';
import { buildLinkId } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';

export interface ExternalDropPluginProps {
  editorId: string;
  readOnly?: boolean;
}

export function ExternalDropPlugin({ readOnly }: ExternalDropPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (readOnly) return;
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    const handleDragOver = (e: DragEvent) => {
      // Allow dropping if we have a notees node being dragged
      if (e.dataTransfer?.types.includes('application/x-notees-node')) {
        e.preventDefault();
      }
    };

    const handleDrop = (e: DragEvent) => {
      const data = e.dataTransfer?.getData('application/x-notees-node');
      if (!data || !e.altKey) return;

      let nodeInfo: { nodeUuid?: string; name?: string } | null = null;
      try {
        nodeInfo = JSON.parse(data);
      } catch {
        return;
      }
      if (!nodeInfo?.nodeUuid) return;

      e.preventDefault();
      e.stopPropagation();

      // Get drop position via caretRangeFromPoint / caretPositionFromPoint
      const x = e.clientX;
      const y = e.clientY;

      let range: Range | null = null;
      const doc = document as unknown as {
        caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?(x: number, y: number): Range | null;
      };
      if (doc.caretPositionFromPoint) {
        const caretPos = doc.caretPositionFromPoint(x, y);
        if (caretPos) {
          range = document.createRange();
          range.setStart(caretPos.offsetNode, caretPos.offset);
          range.setEnd(caretPos.offsetNode, caretPos.offset);
        }
      } else if (doc.caretRangeFromPoint) {
        range = doc.caretRangeFromPoint(x, y);
      }

      if (!range) return;

      // Focus editor and set native selection to drop point
      editor.focus(() => {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });

      // Insert inline link node via Lexical
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const linkId = buildLinkId(nodeInfo.nodeUuid!, generateUUID());
          const linkNode = $createInlineLinkNode(linkId, 'node');
          selection.insertNodes([linkNode]);
        }
      });
    };

    rootEl.addEventListener('dragover', handleDragOver);
    rootEl.addEventListener('drop', handleDrop);

    return () => {
      rootEl.removeEventListener('dragover', handleDragOver);
      rootEl.removeEventListener('drop', handleDrop);
    };
  }, [editor, readOnly]);

  return null;
}
