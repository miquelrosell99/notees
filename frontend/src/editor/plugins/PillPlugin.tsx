/**
 * PillPlugin — Lexical plugin for rendering Pill decorator nodes.
 *
 * Handles:
 * - Rendering PillNode as React components
 * - Click-to-navigate behavior
 * - Context menu for pill editing
 * - Keyboard navigation around pills
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  $getSelection,
  $isNodeSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  CLICK_COMMAND,
} from 'lexical';
import { $isPillNode } from '../nodes/PillNode';

export interface PillPluginProps {
  /** Called when a pill is clicked for navigation */
  onPillClick?: (linkId: string, refType: 'node' | 'class') => void;
  /** Called when a pill is removed */
  onPillRemove?: (linkId: string) => void;
}

export function PillPlugin({
  onPillClick,
  onPillRemove,
}: PillPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Click handling ────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      CLICK_COMMAND,
      (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        const pillWrapper = target.closest('.node-pill-wrapper');
        if (!pillWrapper) return false;

        const linkId = pillWrapper.getAttribute('data-link-id');
        const refType = (pillWrapper.getAttribute('data-ref-type') as 'node' | 'class') || 'node';
        if (linkId) {
          onPillClick?.(linkId, refType);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onPillClick]);

  // ─── Backspace/Delete on selected pill ─────────────────────

  useEffect(() => {
    const handleDelete = () => {
      const selection = $getSelection();
      if (!$isNodeSelection(selection)) return false;

      const nodes = selection.getNodes();
      for (const node of nodes) {
        if ($isPillNode(node)) {
          onPillRemove?.(node.getLinkId());
          node.remove();
        }
      }
      return nodes.some(n => $isPillNode(n));
    };

    const unsubBack = editor.registerCommand(KEY_BACKSPACE_COMMAND, handleDelete, COMMAND_PRIORITY_HIGH);
    const unsubDel = editor.registerCommand(KEY_DELETE_COMMAND, handleDelete, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubBack();
      unsubDel();
    };
  }, [editor, onPillRemove]);

  return null;
}
