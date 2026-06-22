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
  $isElementNode,
  $getNodeByKey,
  $getRoot,
  $createTextNode,
  $createParagraphNode,
  KEY_DOWN_COMMAND,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  type LexicalEditor,
  type RangeSelection,
} from 'lexical';
import { $createInlineLinkNode } from '@/features/editor/editor/nodes/InlineLinkNode';
import { $createInlineDateRangeNode } from '@/features/editor/editor/nodes/InlineDateRangeNode';
import { TriggerPopup, type TriggerPopupType } from './TriggerPopup';
import { DateRangePicker } from '@/features/properties/components/DateRangePicker';
import type { DateRangeValue } from '@/utils/dateRange';
import type { Node } from '@/types/api';
import { getOperationRuntime } from '@/runtime';
import { getNode, getAllNodes } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { flushAllContentSaves } from '@/hooks/contentSaveTracker';
import { getSlashCommand } from '@/plugins/core';

function applyRuntimeIntent(intent: MutationIntent): void {
  getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

/**
 * Determine the character immediately before a collapsed RangeSelection.
 * Works for both text anchors and element (paragraph-boundary) anchors.
 */
function getPreviousChar(selection: RangeSelection): string | null {
  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();
  const offset = anchor.offset;

  if ($isTextNode(anchorNode)) {
    const text = anchorNode.getTextContent();
    return offset > 0 ? text[offset - 1] : null;
  }

  if ($isElementNode(anchorNode) && offset > 0) {
    const childBefore = anchorNode.getChildren()[offset - 1];
    if ($isTextNode(childBefore)) {
      const text = childBefore.getTextContent();
      return text.length > 0 ? text[text.length - 1] : null;
    }
    // Non-text inline node (pill, linebreak) acts as a word boundary.
    return ' ';
  }

  return null;
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
  const [dateRangePickerOpen, setDateRangePickerOpen] = useState(false);
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

        // Only unmodified trigger keys. Allow Alt/AltGraph because many
        // keyboard layouts (Mac Option, European AltGr) use them to type
        // trigger characters such as @ and #.
        const isAltGraph = event.getModifierState('AltGraph');
        if (event.metaKey) return false;
        if (event.ctrlKey && !isAltGraph) return false;

        const key = event.key;
        if (!['+', '@', '#', '/'].includes(key)) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const prevChar = getPreviousChar(selection);

        let valid = false;
        if (key === '+' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (key === '@' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (key === '#' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (key === '/' && (prevChar === null || /\s/.test(prevChar))) {
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

  // ─── Detect triggers on text insertion (Android soft keyboards / IME) ──

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

        const prevChar = getPreviousChar(selection);

        let valid = false;
        if (insertedText === '+' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (insertedText === '@' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (insertedText === '#' && (prevChar === null || /[^a-zA-Z0-9]/.test(prevChar))) {
          valid = true;
        } else if (insertedText === '/' && (prevChar === null || /\s/.test(prevChar))) {
          valid = true;
        }

        if (!valid) return false;

        // Lexical preventDefault'd the native beforeinput event before
        // dispatching this command, so we must insert the trigger character
        // ourselves (unlike the KEY_DOWN path where we suppress the browser
        // insertion and then insert manually).
        selection.insertText(insertedText);

        const newAnchorNode = selection.anchor.getNode();

        const coords = getCaretCoordinates(editor);
        const rootEl = editor.getRootElement();
        hadFocusBeforeRef.current =
          rootEl != null &&
          (rootEl === document.activeElement || rootEl.contains(document.activeElement));

        if ($isTextNode(newAnchorNode)) {
          placeholderRef.current = {
            nodeKey: newAnchorNode.getKey(),
            offset: selection.anchor.offset - 1,
            char: insertedText,
          };
        }

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

  // ─── Track popup state in EditorFocusStore ───────────────────

  useEffect(() => {
    if (popup) {
      useEditorFocusStore.getState().openPopup();
      return () => {
        useEditorFocusStore.getState().closePopup();
      };
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
        const pill = $createInlineLinkNode(nodeUuid, refType);

        const insertAfterPill = (afterText?: string) => {
          const afterNode = $createTextNode(afterText || '\u200B');
          pill.insertAfter(afterNode);
          afterNode.selectStart();
        };

        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          const anchorOffset = selection.anchor.offset;

          if ($isTextNode(anchorNode)) {
            const text = anchorNode.getTextContent();
            const before = text.slice(0, anchorOffset);
            const after = text.slice(anchorOffset);

            // Split the text node at the cursor: [before] [pill] [after]
            anchorNode.setTextContent(before || '\u200B');
            anchorNode.insertAfter(pill);
            insertAfterPill(after);
            return;
          }

          if ($isElementNode(anchorNode)) {
            // Anchor is on an element (usually the paragraph). Insert the pill
            // at the element offset so it lands inside the paragraph, not after it.
            const child = anchorNode.getChildAtIndex(anchorOffset);
            if (child) {
              child.insertBefore(pill);
            } else {
              anchorNode.append(pill);
            }
            insertAfterPill();
            return;
          }
        }

        // Fallback when there is no range selection or the anchor is the root:
        // append the pill to the first paragraph (creating one if necessary).
        const root = $getRoot();
        const firstChild = root.getFirstChild();
        const paragraph = $isElementNode(firstChild) ? firstChild : $createParagraphNode();
        if (paragraph !== firstChild) {
          root.append(paragraph);
        }
        paragraph.append(pill);
        insertAfterPill();
      });
    },
    [editor]
  );

  // ─── Insert inline date range helper ─────────────────────────

  const insertDateRange = useCallback(
    (value: DateRangeValue) => {
      editor.update(() => {
        const selection = $getSelection();
        const pill = $createInlineDateRangeNode(
          value.start,
          value.end,
          value.granularity,
          value.start_uuid,
          value.end_uuid,
        );

        const insertAfterPill = (afterText?: string) => {
          const afterNode = $createTextNode(afterText || '\u200B');
          pill.insertAfter(afterNode);
          afterNode.selectStart();
        };

        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          const anchorOffset = selection.anchor.offset;

          if ($isTextNode(anchorNode)) {
            const text = anchorNode.getTextContent();
            const before = text.slice(0, anchorOffset);
            const after = text.slice(anchorOffset);

            anchorNode.setTextContent(before || '\u200B');
            anchorNode.insertAfter(pill);
            insertAfterPill(after);
            return;
          }

          if ($isElementNode(anchorNode)) {
            const child = anchorNode.getChildAtIndex(anchorOffset);
            if (child) {
              child.insertBefore(pill);
            } else {
              anchorNode.append(pill);
            }
            insertAfterPill();
            return;
          }
        }

        const root = $getRoot();
        const firstChild = root.getFirstChild();
        const paragraph = $isElementNode(firstChild) ? firstChild : $createParagraphNode();
        if (paragraph !== firstChild) {
          root.append(paragraph);
        }
        paragraph.append(pill);
        insertAfterPill();
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
          // Default (Enter) adds the class silently; alternative
          // (Ctrl/Cmd/Shift+Enter) inserts the inline pill as well.
          if (mode === 'alternative') {
            insertPill(node.uuid, 'class');
            // Flush the debounced content save so the inline pill is persisted
            // before the onAddClass mutation invalidates page content and
            // refetches stale state without it.
            flushAllContentSaves();
          }
          if (blockServerIdRef.current != null) {
            onAddClass?.(blockServerIdRef.current, node.id);
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

      if (commandId === 'date-range') {
        handleClose();
        setDateRangePickerOpen(true);
        return;
      }

      const pluginCommand = getSlashCommand(commandId);
      if (pluginCommand) {
        pluginCommand.execute({
          editor,
          blockServerId: blockServerIdRef.current ?? null,
        });
        handleClose();
        return;
      }

      onSlashCommand?.(commandId, blockServerIdRef.current);
      handleClose();
    },
    [editor, removePlaceholder, onSlashCommand, templateClassFilters, handleClose]
  );

  // Hide the /cloze command unless the active block's parent is a card node.
  const hiddenSlashCommandIds = (() => {
    const hidden = new Set<string>();

    const blockServerId = blockServerIdRef.current;
    if (blockServerId == null) {
      hidden.add('cloze');
      return hidden;
    }

    const runtime = getOperationRuntime();
    const blockNode = getAllNodes(runtime).find((n) => n.serverId === blockServerId);
    if (!blockNode?.parentId) {
      hidden.add('cloze');
      return hidden;
    }

    const parentNode = getAllNodes(runtime).find((n) => n.blockId === blockNode.parentId);
    const parentIsCard = parentNode?.classIds.includes(SYSTEM_CLASS_UUIDS.card) ?? false;
    if (!parentIsCard) {
      hidden.add('cloze');
    }
    return hidden;
  })();

  // ─── Render ──────────────────────────────────────────────────

  if (!popup) return null;

  return (
    <>
      <TriggerPopup
        type={popup.type}
        position={popup.position}
        onSelectNode={popup.type !== 'slash' ? handleSelectNode : undefined}
        onSelectCommand={popup.type === 'slash' ? handleSelectCommand : undefined}
        onClose={handleClose}
        onDeletePlaceholder={handleDeletePlaceholder}
        hiddenSlashCommandIds={hiddenSlashCommandIds}
        contextBlockServerId={blockServerIdRef.current}
      />
      {dateRangePickerOpen && (
        <DateRangePicker
          onChange={(value) => {
            if (value) insertDateRange(value);
            setDateRangePickerOpen(false);
          }}
          onClose={() => setDateRangePickerOpen(false)}
        />
      )}
    </>
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

  const rootRect = rootEl.getBoundingClientRect();
  const fallback = {
    top: rootRect.bottom + window.scrollY,
    left: rootRect.left + window.scrollX,
    caretTop: rootRect.top + window.scrollY,
  };

  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.rangeCount === 0) {
    return fallback;
  }

  const range = nativeSelection.getRangeAt(0);
  if (!rootEl.contains(range.startContainer)) {
    return fallback;
  }

  const cloned = range.cloneRange();
  cloned.collapse(true);

  const rect = cloned.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return fallback;
  }

  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
    caretTop: rect.top + window.scrollY,
  };
}
