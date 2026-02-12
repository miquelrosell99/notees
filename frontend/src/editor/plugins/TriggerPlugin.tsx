/**
 * TriggerPlugin — Detects trigger patterns (/, [[, @, #) and shows popups.
 *
 * Monitors text input for trigger characters and displays the appropriate
 * popup menu for inserting links, types, tags, or slash commands.
 */

import { useEffect, useState, useCallback, useRef, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_NORMAL,
  KEY_ESCAPE_COMMAND,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import { $createNodePillNode } from '../nodes/NodePillNode';
import { TriggerPopup } from './TriggerPopup';

// ─── Types ────────────────────────────────────────────────────────

export type TriggerType = 'link' | 'type' | 'tag' | 'slash';

interface TriggerState {
  isOpen: boolean;
  type: TriggerType;
  query: string;
  triggerOffset: number;
  position: { top: number; left: number };
}

export interface TriggerPluginProps {
  /** Render the trigger popup UI */
  renderPopup?: (state: {
    type: TriggerType;
    query: string;
    position: { top: number; left: number };
    onSelect: (value: string, metadata?: any) => void;
    onClose: () => void;
  }) => JSX.Element | null;
  /** Called when a link node is selected */
  onLinkSelect?: (linkId: string) => void;
}

export function TriggerPlugin({
  renderPopup,
  onLinkSelect,
}: TriggerPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [trigger, setTrigger] = useState<TriggerState>({
    isOpen: false,
    type: 'slash',
    query: '',
    triggerOffset: 0,
    position: { top: 0, left: 0 },
  });
  const lastTextRef = useRef('');

  // ─── Detect triggers on text change ────────────────────────

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (trigger.isOpen) setTrigger(prev => ({ ...prev, isOpen: false }));
          return;
        }

        const anchorNode = selection.anchor.getNode();
        const text = anchorNode.getTextContent();
        const offset = selection.anchor.offset;

        // Look backwards from cursor for trigger patterns
        const textBefore = text.slice(0, offset);
        const match = detectTriggerPattern(textBefore);

        if (match) {
          const coords = getCaretCoordinates(editor);
          setTrigger({
            isOpen: true,
            type: match.type,
            query: match.query,
            triggerOffset: match.triggerStart,
            position: coords,
          });
        } else if (trigger.isOpen) {
          setTrigger(prev => ({ ...prev, isOpen: false }));
        }

        lastTextRef.current = text;
      });
    });
  }, [editor, trigger.isOpen]);

  // ─── Escape closes trigger ─────────────────────────────────

  useEffect(() => {
    if (!trigger.isOpen) return;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        setTrigger(prev => ({ ...prev, isOpen: false }));
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, trigger.isOpen]);

  // ─── Handle selection ──────────────────────────────────────

  const handleSelect = useCallback((value: string, _metadata?: any) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      // Remove trigger text and insert the selected item
      const anchorNode = selection.anchor.getNode();
      const text = anchorNode.getTextContent();

      // Remove trigger text
      const beforeTrigger = text.slice(0, trigger.triggerOffset);
      const afterCursor = text.slice(selection.anchor.offset);

      if (trigger.type === 'link' || trigger.type === 'type' || trigger.type === 'tag') {
        // Replace with a NodePill
        (anchorNode as any).setTextContent(beforeTrigger);

        const pill = $createNodePillNode(
          value,
          trigger.type === 'type' ? 'class' : 'node',
        );

        anchorNode.insertAfter(pill);

        // Add remaining text after pill
        if (afterCursor) {
          const { $createTextNode } = require('lexical');
          const afterNode = $createTextNode(afterCursor);
          pill.insertAfter(afterNode);
          afterNode.selectStart();
        } else {
          pill.selectEnd();
        }

        onLinkSelect?.(value);
      }
    });

    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, [editor, trigger, onLinkSelect]);

  const handleClose = useCallback(() => {
    setTrigger(prev => ({ ...prev, isOpen: false }));
  }, []);

  // ─── Render popup ──────────────────────────────────────────

  if (!trigger.isOpen) return null;

  // Use provided renderPopup or fall back to TriggerPopup
  if (renderPopup) {
    return renderPopup({
      type: trigger.type,
      query: trigger.query,
      position: trigger.position,
      onSelect: handleSelect,
      onClose: handleClose,
    });
  }

  return (
    <TriggerPopup
      type={trigger.type}
      query={trigger.query}
      position={trigger.position}
      onSelect={handleSelect}
      onClose={handleClose}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

interface TriggerMatch {
  type: TriggerType;
  query: string;
  triggerStart: number;
}

function detectTriggerPattern(text: string): TriggerMatch | null {
  // [[ link trigger
  const linkMatch = text.match(/\[\[([^\]]*?)$/);
  if (linkMatch) {
    return {
      type: 'link',
      query: linkMatch[1],
      triggerStart: text.length - linkMatch[0].length,
    };
  }

  // @ type trigger (not preceded by word char)
  const typeMatch = text.match(/(?:^|[^a-zA-Z0-9])@([^@\s]*)$/);
  if (typeMatch) {
    return {
      type: 'type',
      query: typeMatch[1],
      triggerStart: text.length - typeMatch[1].length - 1,
    };
  }

  // # tag trigger (not preceded by word char)
  const tagMatch = text.match(/(?:^|[^a-zA-Z0-9])#([^#\s]*)$/);
  if (tagMatch) {
    return {
      type: 'tag',
      query: tagMatch[1],
      triggerStart: text.length - tagMatch[1].length - 1,
    };
  }

  // / slash command (at start of text or after whitespace)
  const slashMatch = text.match(/(?:^|\s)\/([^\s]*)$/);
  if (slashMatch) {
    return {
      type: 'slash',
      query: slashMatch[1],
      triggerStart: text.length - slashMatch[1].length - 1,
    };
  }

  return null;
}

function getCaretCoordinates(editor: LexicalEditor): { top: number; left: number } {
  const rootEl = editor.getRootElement();
  if (!rootEl) return { top: 0, left: 0 };

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { top: 0, left: 0 };

  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);

  const rect = range.getBoundingClientRect();
  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
  };
}
