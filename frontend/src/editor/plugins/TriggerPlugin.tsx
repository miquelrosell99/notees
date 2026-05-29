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
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $getNodeByKey,
  $createTextNode,
  KEY_DOWN_COMMAND,
  COMMAND_PRIORITY_NORMAL,
} from 'lexical';
import { $createInlineLinkNode } from '../nodes/InlineLinkNode';
import { TriggerPopup, type TriggerPopupType } from './TriggerPopup';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { useInputContext } from '../../stores/inputContext';
import type { Node } from '../../types/api';

// ─── Types ────────────────────────────────────────────────────────

interface PopupState {
  type: TriggerPopupType;
  position: { top: number; left: number };
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
}

export function TriggerPlugin({
  onAddClass,
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
}: TriggerPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const placeholderRef = useRef<Placeholder | null>(null);
  const blockServerIdRef = useRef<number | undefined>(undefined);
  const popupOpenRef = useRef(false);

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

            const blockNode = findParentNodeBlock(newAnchorNode);
            if (blockNode) {
              const runtime = getNodeGraphRuntime();
              const graphNode = runtime.getNode(blockNode.getBlockId());
              blockServerIdRef.current = graphNode?.serverId;
            }
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
        setPopup({ type: triggerType, position: coords });

        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor]);

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

        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.anchor.set(node.getKey(), ph.offset, 'text');
          selection.focus.set(node.getKey(), ph.offset, 'text');
        }
      }
    });
  }, [editor]);

  // ─── Close popup, return focus ───────────────────────────────

  const handleClose = useCallback(() => {
    popupOpenRef.current = false;
    setPopup(null);
    placeholderRef.current = null;
    blockServerIdRef.current = undefined;
    editor.focus();
  }, [editor]);

  // ─── Delete placeholder and close popup ──────────────────────

  const handleDeletePlaceholder = useCallback(() => {
    popupOpenRef.current = false;
    removePlaceholder();
    setPopup(null);
    placeholderRef.current = null;
    blockServerIdRef.current = undefined;
    editor.focus();
  }, [editor, removePlaceholder]);

  // ─── Insert inline pill helper ───────────────────────────────

  const insertPill = useCallback(
    (nodeUuid: string, refType: 'node' | 'class') => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchorNode = selection.anchor.getNode();
        const pill = $createInlineLinkNode(nodeUuid, refType);
        anchorNode.insertAfter(pill);

        const afterNode = $createTextNode('\u200B');
        pill.insertAfter(afterNode);
        afterNode.selectStart();
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
        const blockNode = findParentNodeBlock(node);
        if (!blockNode) return;

        const runtime = getNodeGraphRuntime();
        const hostNode = runtime.getNode(blockNode.getBlockId());
        if (!hostNode?.parentId) return;

        const newBlockId = crypto.randomUUID();
        runtime.requestFocus(newBlockId);
        runtime.applyIntent({
          type: 'create_block',
          parentId: hostNode.parentId,
          afterBlockId: blockNode.getBlockId(),
          blockId: newBlockId,
          contentAST: [
            {
              type: 'paragraph',
              children: [{ type: 'node_link', link_id: nodeUuid, ref_type: 'embed' }],
            },
          ],
        });
        runtime.flushEvents();
      });
    },
    [editor]
  );

  // ─── Handle node selection (+, @, #) ─────────────────────────

  const handleSelectNode = useCallback(
    (node: Node, mode: 'default' | 'alternative') => {
      if (!popup) return;

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
          if (mode === 'default') {
            if (blockServerIdRef.current != null) {
              onAddClass?.(blockServerIdRef.current, node.id);
            }
          } else {
            insertPill(node.uuid, 'class');
          }
          break;
        }
        case 'link':
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

function getCaretCoordinates(editor: import('lexical').LexicalEditor): {
  top: number;
  left: number;
} {
  const rootEl = editor.getRootElement();
  if (!rootEl) return { top: 0, left: 0 };

  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.rangeCount === 0) return { top: 0, left: 0 };

  const range = nativeSelection.getRangeAt(0);
  if (!rootEl.contains(range.startContainer)) return { top: 0, left: 0 };

  const cloned = range.cloneRange();
  cloned.collapse(true);

  const rect = cloned.getBoundingClientRect();
  return {
    top: rect.bottom + window.scrollY,
    left: rect.left + window.scrollX,
  };
}
