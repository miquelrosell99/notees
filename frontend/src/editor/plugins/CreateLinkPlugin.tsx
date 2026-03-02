/**
 * CreateLinkPlugin — handles Ctrl+L to open the link-creation modal from a text selection.
 *
 * When the user presses Ctrl+L with text selected:
 *  - The selected text is captured.
 *  - The selection coordinates are saved so they can be restored after the modal closes.
 *  - A callback fires to open BlockEditor's link-creation modal.
 *
 * When a `pendingNewLink` prop arrives (modal saved), the plugin restores the selection
 * and replaces the selected text with a new InlineLinkNode.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_NORMAL,
  KEY_DOWN_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createRangeSelection,
  $setSelection,
} from 'lexical';
import { $createInlineLinkNode } from '../nodes/InlineLinkNode';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';

// ─── Types ────────────────────────────────────────────────────────

export interface PendingNewLink {
  refType: InlineLinkRefType;
  /** URL for url-mode links. */
  url?: string;
  /** Node UUID for node-mode links. */
  nodeUuid?: string;
  label?: string | null;
}

interface SavedSelection {
  anchorKey: string;
  anchorOffset: number;
  focusKey: string;
  focusOffset: number;
}

export interface CreateLinkPluginProps {
  readOnly?: boolean;
  /** Called when Ctrl+L is pressed with text selected (URL mode). */
  onOpenCreateLink: (selectedText: string) => void;
  /** Called when Ctrl+Shift+L is pressed with text selected (node mode). */
  onOpenCreateNodeLink: (selectedText: string) => void;
  /** Pending link to insert (from modal save). Cleared by calling onNewLinkApplied. */
  pendingNewLink: PendingNewLink | null;
  /** Called after pendingNewLink is consumed. */
  onNewLinkApplied: () => void;
}

// ─── URL detection ────────────────────────────────────────────────

/** Returns true if the text looks like an http/https URL. */
export function isLikelyUrl(text: string): boolean {
  return /^https?:\/\/\S+/.test(text.trim());
}

// ─── Plugin ───────────────────────────────────────────────────────

export function CreateLinkPlugin({
  readOnly = false,
  onOpenCreateLink,
  onOpenCreateNodeLink,
  pendingNewLink,
  onNewLinkApplied,
}: CreateLinkPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // Store selection so it can be restored after the modal closes.
  const savedSelectionRef = useRef<SavedSelection | null>(null);

  // Keep callbacks in refs so they don't cause the effect to re-register.
  const onOpenRef = useRef(onOpenCreateLink);
  onOpenRef.current = onOpenCreateLink;
  const onOpenNodeRef = useRef(onOpenCreateNodeLink);
  onOpenNodeRef.current = onOpenCreateNodeLink;

  // ─── Ctrl+L keyboard handler ──────────────────────────────────

  useEffect(() => {
    if (readOnly) return;

    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.key !== 'l') return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;

        const selectedText = selection.getTextContent();
        if (!selectedText.trim()) return false;

        event.preventDefault();

        // Save selection coordinates for restoration after modal closes.
        savedSelectionRef.current = {
          anchorKey: selection.anchor.key,
          anchorOffset: selection.anchor.offset,
          focusKey: selection.focus.key,
          focusOffset: selection.focus.offset,
        };

        if (event.shiftKey) {
          // Ctrl+Shift+L → node link, selected text becomes the label
          onOpenNodeRef.current(selectedText);
        } else {
          // Ctrl+L → URL link, detected as URL or label
          onOpenRef.current(selectedText);
        }
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, readOnly]);

  // ─── Apply pending new link ───────────────────────────────────

  useEffect(() => {
    if (!pendingNewLink || !savedSelectionRef.current) return;

    const saved = savedSelectionRef.current;
    const link = pendingNewLink;

    editor.update(() => {
      // Restore the saved selection so insertNodes replaces the original text.
      const sel = $createRangeSelection();
      sel.anchor.set(saved.anchorKey, saved.anchorOffset, 'text');
      sel.focus.set(saved.focusKey, saved.focusOffset, 'text');
      $setSelection(sel);

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      // For URL pills the linkId convention is: label if present, else the URL.
      // For node pills the linkId is the node UUID (optionally compound with a link UUID).
      const linkId =
        link.refType === 'url'
          ? (link.label?.trim() || link.url || `link-${Date.now()}`)
          : (link.nodeUuid || `link-${Date.now()}`);

      const newNode = $createInlineLinkNode(
        linkId,
        link.refType,
        link.url,
        link.label ?? undefined,
      );

      // Replace selected text with the new inline link pill.
      selection.insertNodes([newNode]);
    });

    onNewLinkApplied();
    savedSelectionRef.current = null;
  }, [editor, pendingNewLink, onNewLinkApplied]);

  return null;
}
