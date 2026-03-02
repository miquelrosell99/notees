/**
 * CreateLinkPlugin — handles Ctrl+L keyboard shortcuts to open link-creation modals.
 *
 * Shortcuts:
 *  - Ctrl+L          → page link modal, selected text pre-fills the search field
 *  - Ctrl+Shift+L    → page link modal, selected text becomes the custom label
 *  - Ctrl+Alt+L      → URL link modal, selected text detected as URL or label
 *
 * When a `pendingNewLink` prop arrives (modal saved), the plugin restores the
 * selection and replaces the selected text with a new InlineLinkNode.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
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
  anchorType: 'text' | 'element';
  focusKey: string;
  focusOffset: number;
  focusType: 'text' | 'element';
}

export interface CreateLinkPluginProps {
  readOnly?: boolean;
  /** Ctrl+L — page link, selected text as search query. */
  onOpenPageSearch: (selectedText: string) => void;
  /** Ctrl+Shift+L — page link, selected text as custom label. */
  onOpenPageLabel: (selectedText: string) => void;
  /** Ctrl+Alt+L — URL link. */
  onOpenUrlLink: (selectedText: string) => void;
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
  onOpenPageSearch,
  onOpenPageLabel,
  onOpenUrlLink,
  pendingNewLink,
  onNewLinkApplied,
}: CreateLinkPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // Store selection so it can be restored after the modal closes.
  const savedSelectionRef = useRef<SavedSelection | null>(null);

  // Keep callbacks in refs so they don't cause the effect to re-register.
  const onPageSearchRef = useRef(onOpenPageSearch);
  onPageSearchRef.current = onOpenPageSearch;
  const onPageLabelRef = useRef(onOpenPageLabel);
  onPageLabelRef.current = onOpenPageLabel;
  const onUrlLinkRef = useRef(onOpenUrlLink);
  onUrlLinkRef.current = onOpenUrlLink;

  // ─── Ctrl+L keyboard handler ──────────────────────────────────
  // Use a window-level capture listener to intercept Ctrl+L before the
  // browser steals it (Chrome uses Ctrl+L for the address bar).

  useEffect(() => {
    if (readOnly) return;

    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'l') return;

      // Only intercept when the editor is focused
      const rootEl = editor.getRootElement();
      if (!rootEl || !rootEl.contains(document.activeElement)) return;

      event.preventDefault();
      event.stopPropagation();

      editor.update(() => {
        const selection = $getSelection();
        const isRange = $isRangeSelection(selection);
        const selectedText = (isRange && !selection.isCollapsed())
          ? selection.getTextContent().trim()
          : '';

        // Always save selection so we can restore caret after modal closes.
        if (isRange) {
          savedSelectionRef.current = {
            anchorKey: selection.anchor.key,
            anchorOffset: selection.anchor.offset,
            anchorType: selection.anchor.type,
            focusKey: selection.focus.key,
            focusOffset: selection.focus.offset,
            focusType: selection.focus.type,
          };
        } else {
          savedSelectionRef.current = null;
        }

        if (event.shiftKey) {
          // Ctrl+Shift+L → page link, selected text becomes the label
          onPageLabelRef.current(selectedText);
        } else if (event.altKey) {
          // Ctrl+Alt+L → URL link
          onUrlLinkRef.current(selectedText);
        } else {
          // Ctrl+L → page link, selected text as search query
          onPageSearchRef.current(selectedText);
        }
      });
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [editor, readOnly]);

  // ─── Apply pending new link ───────────────────────────────────

  useEffect(() => {
    if (!pendingNewLink) return;

    const saved = savedSelectionRef.current;
    const link = pendingNewLink;

    editor.update(() => {
      if (saved) {
        // Restore the saved selection so insertNodes replaces the original text.
        const sel = $createRangeSelection();
        sel.anchor.set(saved.anchorKey, saved.anchorOffset, saved.anchorType);
        sel.focus.set(saved.focusKey, saved.focusOffset, saved.focusType);
        $setSelection(sel);
      }

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      // For URL pills the linkId is the label (if set) or the URL.
      // For node pills the linkId is the node UUID.
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

      // Replace selected text (or insert at caret) with the new inline link pill.
      selection.insertNodes([newNode]);
    });

    onNewLinkApplied();
    savedSelectionRef.current = null;
  }, [editor, pendingNewLink, onNewLinkApplied]);

  return null;
}
