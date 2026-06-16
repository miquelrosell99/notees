/**
 * TriggerPlugin — Detects trigger patterns (+, @, #, /) and opens unified popups.
 *
 * Architecture:
 * - Intercepts trigger keys via Lexical KEY_DOWN_COMMAND (only fires on actual keypress)
 * - Inserts the trigger character into the text node
 * - Opens a portaled popup with its own search field
 * - Enter = default action, Shift+Enter = alternative action
 * - Escape = close popup, keep placeholder as literal text
 * - Backspace/Delete = close popup and remove the placeholder character
 * - On select: placeholder removed, result applied, focus returns to editor
 */

import { useEffect, useState, useRef, useCallback, type JSX } from 'react';
import { flushSync } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $getNodeByKey,
  $createTextNode,
  KEY_DOWN_COMMAND,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  type LexicalEditor,
} from 'lexical';
import { $createInlineLinkNode } from '@/features/content/editor/nodes/InlineLinkNode';
import { TriggerPopup, type TriggerPopupType } from './TriggerPopup';
import { useInputContext } from '@/stores/inputContext';
import type { Node } from '@/types/api';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';

function applyRuntimeIntent(intent: MutationIntent): void {
  getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

// ─── Types ────────────────────────────────────────────────────────

interface PopupState {
  type: TriggerPopupType;
  position: { top: number; left: number; caretTop: number };
  context?: 'template' | 'embed';
  classFilters?: number[];
}

interface Placeholder {
  nodeKey: string;
  offset: number;
  char: string;
}

export interface TriggerPluginProps {
  /** Called when a class should be added silently (Plain Enter on +) */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when a slash command is selected */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when a template is selected in template mode */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs used to pre-filter the link popup when in templateMode */
  templateClassFilters?: number[];
  /** Block ID for the inline editor hosting this trigger. */
  blockId: string;
}

export function TriggerPlugin({
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
  blockId: blockIdProp,
}: TriggerPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const placeholderRef = useRef<Placeholder | null>(null);
  const blockServerIdRef = useRef<number | undefined>(undefined);
  const popupOpenRef = useRef(false);
  const hadFocusBeforeRef = useRef(false);
  const selectionMadeRef = useRef(false);

  useEffect(() => {
    popupOpenRef.current = popup !== null;
  }, [popup]);

  // ─── Detect triggers on key down ─────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        // Don't intercept while popup is already open
        if (popupOpenRef.current) return false;

        // Only unmodified trigger keys
        if (event.ctrlKey || event.metaKey || event.altKey) return false;

        const key = event.key;
        if (!['+', '@', '#', '/'].includes(key)) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        if (!$isTextNode(anchorNode)) return false;

        const text = anchorNode.getTextContent();
        const offset = selection.anchor.offset;
        const prevChar = offset > 0 ? text[offset - 1] : null;

        let valid = false;
        if (key === '+' && (offset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (key === '@' && (offset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (key === '#' && (offset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (key === '/' && (offset === 0 || /\s/.test(prevChar || ''))) {
          valid = true;
        }

        if (!valid) return false;

        // Consume the key — we will insert the character ourselves
        event.preventDefault();

        // Capture caret coordinates BEFORE mutating the editor
        const coords = getCaretCoordinates(editor);

        // Remember whether the editor had focus so we only restore it on close
        // if the user was actually editing (not clicking a sidebar button).
        const rootEl = editor.getRootElement();
        hadFocusBeforeRef.current =
          rootEl != null &&
          (rootEl === document.activeElement || rootEl.contains(document.activeElement));

        editor.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;

          sel.insertText(key);

          const newAnchorNode = sel.anchor.getNode();
          if ($isTextNode(newAnchorNode)) {
            placeholderRef.current = {
              nodeKey: newAnchorNode.getKey(),
              offset: sel.anchor.offset - 1,
              char: key,
            };

            const runtime = getOperationRuntime();
            const graphNode = getNode(runtime, blockIdProp);
            blockServerIdRef.current = graphNode?.serverId;
          }
        });

        let triggerType: TriggerPopupType;
        switch (key) {
          case '+':
            triggerType = 'class';
            break;
          case '@':
            triggerType = 'link';
            break;
          case '#':
            triggerType = 'tag';
            break;
          case '/':
            triggerType = 'slash';
            break;
          default:
            return false;
        }
        popupOpenRef.current = true;
        setPopup({ type: triggerType, position: coords });

        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, blockIdProp]);

  // ─── Detect triggers on text insertion (Android soft keyboards) ──

  useEffect(() => {
    return editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      (payload: InputEvent | string) => {
        if (popupOpenRef.current) return false;

        let insertedText: string | null = null;
        if (typeof payload === 'string') {
          insertedText = payload;
        } else if (payload instanceof InputEvent && payload.data) {
          insertedText = payload.data;
        }

        if (!insertedText || insertedText.length !== 1 || !['+', '@', '#', '/'].includes(insertedText)) {
          return false;
        }

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        if (!$isTextNode(anchorNode)) return false;

        const text = anchorNode.getTextContent();
        const offset = selection.anchor.offset;
        const triggerOffset = offset - 1;
        const prevChar = triggerOffset > 0 ? text[triggerOffset - 1] : null;

        let valid = false;
        if (insertedText === '+' && (triggerOffset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (insertedText === '@' && (triggerOffset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (insertedText === '#' && (triggerOffset === 0 || /[^a-zA-Z0-9]/.test(prevChar || ''))) {
          valid = true;
        } else if (insertedText === '/' && (triggerOffset === 0 || /\s/.test(prevChar || ''))) {
          valid = true;
        }

        if (!valid) return false;

        const coords = getCaretCoordinates(editor);
        const rootEl = editor.getRootElement();
        hadFocusBeforeRef.current =
          rootEl != null &&
          (rootEl === document.activeElement || rootEl.contains(document.activeElement));

        placeholderRef.current = {
          nodeKey: anchorNode.getKey(),
          offset: triggerOffset,
          char: insertedText,
        };

        const runtime = getOperationRuntime();
        const graphNode = getNode(runtime, blockIdProp);
        blockServerIdRef.current = graphNode?.serverId;

        let triggerType: TriggerPopupType;
        switch (insertedText) {
          case '+':
            triggerType = 'class';
            break;
          case '@':
            triggerType = 'link';
            break;
          case '#':
            triggerType = 'tag';
            break;
          case '/':
            triggerType = 'slash';
            break;
          default:
            return false;
        }

        popupOpenRef.current = true;
        setPopup({ type: triggerType, position: coords });
        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, blockIdProp]);

  // ─── Track popup state in InputContext ───────────────────────

  useEffect(() => {
    if (popup) {
      useInputContext.getState().enterPopup();
      return () => useInputContext.getState().leavePopup();
    }
  }, [popup]);

  // ─── Placeholder removal ─────────────────────────────────────

  const removePlaceholder = useCallback(() => {
    const ph = placeholderRef.current;
    if (!ph) return;

    editor.update(() => {
      const node = $getNodeByKey(ph.nodeKey);
      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const before = text.slice(0, ph.offset);
        const after = text.slice(ph.offset + 1);
        node.setTextContent((before + after) || '\u200B');
        // node.select creates a fresh RangeSelection even when the editor
        // is blurred, so focus restoration later will land in the right place.
        node.select(ph.offset, ph.offset);
      }
    });
  }, [editor]);

  // ─── Close popup, return focus ───────────────────────────────

  const handleClose = useCallback(() => {
    const ph = placeholderRef.current;
    const madeSelection = selectionMadeRef.current;

    // Only restore cursor position if the popup was dismissed WITHOUT a
    // selection (Escape / outside-click). When a pill is inserted,
    // insertPill() already placed the cursor after the pill.
    if (ph && !madeSelection) {
      editor.update(() => {
        const node = $getNodeByKey(ph.nodeKey);
        if ($isTextNode(node)) {
          // Place cursor right after the placeholder character
          node.select(ph.offset + 1, ph.offset + 1);
        }
      });
    }

    popupOpenRef.current = false;
    flushSync(() => setPopup(null));
    placeholderRef.current = null;
    blockServerIdRef.current = undefined;
    selectionMadeRef.current = false;

    // Only steal focus back if the editor had it before the popup opened.
    // This prevents focus hijacking when the user intentionally clicked
    // elsewhere (sidebar, toolbar, etc.).
    if (hadFocusBeforeRef.current) {
      editor.focus();
    }
    hadFocusBeforeRef.current = false;
  }, [editor]);

  // ─── Delete placeholder and close popup ──────────────────────

  const handleDeletePlaceholder = useCallback(() => {
    popupOpenRef.current = false;
    removePlaceholder();
    flushSync(() => setPopup(null));
    placeholderRef.current = null;
    blockServerIdRef.current = undefined;
    selectionMadeRef.current = false;

    if (hadFocusBeforeRef.current) {
      editor.focus();
    }
    hadFocusBeforeRef.current = false;
  }, [editor, removePlaceholder]);

  // ─── Insert inline pill helper ───────────────────────────────

  const insertPill = useCallback(
    (nodeUuid: string, refType: 'node' | 'class' | 'user') => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchorNode = selection.anchor.getNode();
        const anchorOffset = selection.anchor.offset;
        const pill = $createInlineLinkNode(nodeUuid, refType);

        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          const before = text.slice(0, anchorOffset);
          const after = text.slice(anchorOffset);

          // Split the text node at the cursor: [before] [pill] [after]
          anchorNode.setTextContent(before || '\u200B');
          anchorNode.insertAfter(pill);

          if (after) {
            const afterTextNode = $createTextNode(after);
            pill.insertAfter(afterTextNode);
            afterTextNode.selectStart();
          } else {
            const afterNode = $createTextNode('\u200B');
            pill.insertAfter(afterNode);
            afterNode.selectStart();
          }
        } else {
          anchorNode.insertAfter(pill);
          const afterNode = $createTextNode('\u200B');
          pill.insertAfter(afterNode);
          afterNode.selectStart();
        }
      });
    },
    [editor]
  );

  // ─── Create embed sibling helper ─────────────────────────────

  const insertEmbedSibling = useCallback(
    (nodeUuid: string) => {
      const ph = placeholderRef.current;
      if (!ph) return;

      // We need the host block ID. Resolve from the placeholder node.
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(ph.nodeKey);
        if (!node) return;
        if (!blockIdProp) return;

        const runtime = getOperationRuntime();
        const hostNode = getNode(runtime, blockIdProp);
        if (!hostNode?.parentId) return;

        const newBlockId = crypto.randomUUID();
        useEditorFocusStore.getState().setPendingFocus(newBlockId);
        applyRuntimeIntent({
          type: 'create_block',
          parentId: hostNode.parentId,
          afterBlockId: blockIdProp,
          blockId: newBlockId,
          contentAST: [
            {
              type: 'paragraph',
              children: [{ type: 'node_link', link_id: nodeUuid, ref_type: 'embed' }],
            },
          ],
        });
        getRuntimeEventBus().flushEvents();
      });
    },
    [editor, blockIdProp]
  );

  // ─── Handle node selection (+, @, #) ─────────────────────────

  const handleSelectNode = useCallback(
    (node: Node, mode: 'default' | 'alternative', isUserMention = false) => {
      if (!popup) return;

      selectionMadeRef.current = true;
      removePlaceholder();

      if (popup.context === 'template') {
        onTemplateInstantiate?.(node.id, blockServerIdRef.current);
        handleClose();
        return;
      }

      if (popup.context === 'embed') {
        insertEmbedSibling(node.uuid);
        handleClose();
        return;
      }

      switch (popup.type) {
        case 'class': {
          // Default (Enter) adds the class silently; alternative (Shift+Enter)
          // inserts the pill as well.
          if (blockServerIdRef.current != null) {
            onAddClass?.(blockServerIdRef.current, node.id);
          }
          if (mode === 'alternative') {
            insertPill(node.uuid, 'class');
          }
          break;
        }
        case 'link': {
          insertPill(node.uuid, isUserMention ? 'user' : 'node');
          // TODO: mode === 'alternative' → open link editor modal
          break;
        }
        case 'tag': {
          insertPill(node.uuid, 'node');
          // TODO: mode === 'alternative' → open link editor modal
          break;
        }
      }

      handleClose();
    },
    [popup, removePlaceholder, insertPill, insertEmbedSibling, onAddClass, onTemplateInstantiate, handleClose]
  );

  // ─── Handle slash command selection ──────────────────────────

  const handleSelectCommand = useCallback(
    (commandId: string) => {
      removePlaceholder();

      if (commandId === 'template') {
        // Open template picker (link popup in template mode)
        const coords = getCaretCoordinates(editor);
        setPopup({
          type: 'link',
          position: coords,
          context: 'template',
          classFilters: templateClassFilters,
        });
        return;
      }

      if (commandId === 'embed') {
        // Open embed picker (link popup in embed mode)
        const coords = getCaretCoordinates(editor);
        setPopup({
          type: 'link',
          position: coords,
          context: 'embed',
        });
        return;
      }

      onSlashCommand?.(commandId, blockServerIdRef.current);
      handleClose();
    },
    [editor, removePlaceholder, onSlashCommand, templateClassFilters, handleClose]
  );

  // ─── Render ──────────────────────────────────────────────────

  if (!popup) return null;

  return (
    <TriggerPopup
      type={popup.type}
      position={popup.position}
      onSelectNode={popup.type !== 'slash' ? handleSelectNode : undefined}
      onSelectCommand={popup.type === 'slash' ? handleSelectCommand : undefined}
      onClose={handleClose}
      onDeletePlaceholder={handleDeletePlaceholder}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function getCaretCoordinates(editor: LexicalEditor): {
  top: number;
  left: number;
  caretTop: number;
} {
  const rootEl = editor.getRootElement();
  if (!rootEl) return { top: 0, left: 0, caretTop: 0 };

  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.rangeCount === 0) return { top: 0, left: 0, caretTop: 0 };

  const range = nativeSelection.getRangeAt(0);
  if (!rootEl.contains(range.startContainer)) return { top: 0, left: 0, caretTop: 0 };

  const cloned = range.cloneRange();
  cloned.collapse(true);

  const rect = cloned.getBoundingClientRect();
  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
    caretTop: rect.top + window.scrollY,
  };
}