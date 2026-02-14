/**
 * NodeLinkPlugin — Lexical plugin for rendering node-link pill decorator nodes.
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
  COMMAND_PRIORITY_LOW,
  $getSelection,
  $getRoot,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $createNodeSelection,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  CLICK_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { $isPillNode, $createPillNode } from '../nodes/PillNode';

/** Pending update to apply to a PillNode (from LinkEditModal). */
export interface PendingPillUpdate {
  oldLinkId: string;
  newLinkId: string;
  newRefType: 'node' | 'class';
}

export interface NodeLinkPluginProps {
  /** Called when a pill is clicked for navigation */
  onPillClick?: (linkId: string, refType: 'node' | 'class') => void;
  /** Called when a pill is clicked in edit mode (opens edit modal) */
  onPillEdit?: (linkId: string, refType: 'node' | 'class') => void;
  /** Called when a pill is removed */
  onPillRemove?: (linkId: string) => void;
  /** Pending pill update from LinkEditModal (applied then cleared) */
  pendingPillUpdate?: PendingPillUpdate | null;
  /** Called after pendingPillUpdate is consumed */
  onPillUpdateApplied?: () => void;
}

export function NodeLinkPlugin({
  onPillClick,
  onPillEdit,
  onPillRemove,
  pendingPillUpdate,
  onPillUpdateApplied,
}: NodeLinkPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Click handling ────────────────────────────────────────

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const pillWrapper = target.closest('.node-pill-wrapper');
      
      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        const refType = (pillWrapper.getAttribute('data-ref-type') as 'node' | 'class') || 'node';
        if (linkId) {
          // In edit mode, open the edit modal instead of navigating
          if (editor.isEditable() && onPillEdit) {
            onPillEdit(linkId, refType);
          } else {
            onPillClick?.(linkId, refType);
          }
        }
        return true;
      }

      return false;
    };

    return editor.registerCommand(CLICK_COMMAND, handleClick, COMMAND_PRIORITY_HIGH);
  }, [editor, onPillClick, onPillEdit]);

  // ─── Apply pending pill update (from LinkEditModal) ──────────

  useEffect(() => {
    if (!pendingPillUpdate) return;

    editor.update(() => {
      const root = $getRoot();
      // Recursive descent to find and replace the PillNode with matching linkId
      const findAndReplacePill = (parent: ReturnType<typeof $getRoot>) => {
        for (const child of parent.getChildren()) {
          if ($isPillNode(child) && child.getLinkId() === pendingPillUpdate.oldLinkId) {
            // Replace with a new PillNode with the updated linkId
            const newPill = $createPillNode(
              pendingPillUpdate.newLinkId,
              pendingPillUpdate.newRefType,
            );
            child.replace(newPill);
            return true;
          }
          // Recurse into element nodes
          if ('getChildren' in child && typeof child.getChildren === 'function') {
            if (findAndReplacePill(child as any)) return true;
          }
        }
        return false;
      };
      findAndReplacePill(root);
    });

    onPillUpdateApplied?.();
  }, [editor, pendingPillUpdate, onPillUpdateApplied]);

  // ─── Selection change handling (apply selected class) ─────────

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const rootEl = editor.getRootElement();
        if (!rootEl) return false;

        // Remove selected class from all pills
        rootEl.querySelectorAll('.node-pill-wrapper').forEach(el => {
          el.classList.remove('selected', 'node-pill-wrapper--selected');
        });

        // Check if current selection is a NodeSelection on a pill
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          for (const node of nodes) {
            if ($isPillNode(node)) {
              // Find the DOM element and add selected class
              const key = node.getKey();
              const dom = editor.getElementByKey(key);
              if (dom) {
                dom.classList.add('selected', 'node-pill-wrapper--selected');
              }
            }
          }
        }

        return false; // Don't prevent other handlers
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  // ─── Arrow key navigation (handle cursor movement around pills) ─
  // We must handle ALL navigation to prevent Lexical's default handler from
  // crashing on isolated decorator nodes like PillNode.

  useEffect(() => {
    const handleArrowLeft = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // Case 1: A pill is currently selected - move cursor to before it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isPillNode(node)) {
            event.preventDefault();
            node.selectPrevious();
            return true;
          }
        }
      }

      // Case 2: Cursor is in text, check if there's a pill to the left
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        
        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          // Consider ZWS-only text node or position 0 as "at start"
          const isAtStart = anchor.offset === 0 || (text === '\u200B' && anchor.offset <= 1);
          
          if (isAtStart) {
            const prevSibling = anchorNode.getPreviousSibling();
            if ($isPillNode(prevSibling)) {
              // Select the pill instead of letting Lexical try to navigate
              event.preventDefault();
              const nodeSelection = $createNodeSelection();
              nodeSelection.add(prevSibling.getKey());
              $setSelection(nodeSelection);
              return true;
            }
          }
        }
      }

      // Let default Lexical behavior handle non-pill cases
      return false;
    };

    const handleArrowRight = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // Case 1: A pill is currently selected - move cursor to after it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isPillNode(node)) {
            event.preventDefault();
            node.selectNext();
            return true;
          }
        }
      }

      // Case 2: Cursor is in text, check if there's a pill to the right
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        
        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          const textLength = text.length;
          // Consider at end of text or ZWS-only node as "at end"
          const isAtEnd = anchor.offset >= textLength || text === '\u200B';
          
          if (isAtEnd) {
            const nextSibling = anchorNode.getNextSibling();
            if ($isPillNode(nextSibling)) {
              // Select the pill instead of letting Lexical try to navigate
              event.preventDefault();
              const nodeSelection = $createNodeSelection();
              nodeSelection.add(nextSibling.getKey());
              $setSelection(nodeSelection);
              return true;
            }
          }
        }
      }

      // Let default Lexical behavior handle non-pill cases
      return false;
    };

    // Use COMMAND_PRIORITY_HIGH so we intercept before default Lexical handling
    const unsubLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      handleArrowLeft,
      COMMAND_PRIORITY_HIGH,
    );

    const unsubRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      handleArrowRight,
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unsubLeft();
      unsubRight();
    };
  }, [editor]);

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
