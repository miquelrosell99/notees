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
  COMMAND_PRIORITY_LOW,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  CLICK_COMMAND,
  SELECTION_CHANGE_COMMAND,
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
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const pillWrapper = target.closest('.node-pill-wrapper');
      
      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        const refType = (pillWrapper.getAttribute('data-ref-type') as 'node' | 'class') || 'node';
        if (linkId) {
          onPillClick?.(linkId, refType);
        }
        return true;
      }

      // Handle clicks after a pill (when pill is last element in block)
      // Check if click is in empty space after a pill
      const blockContent = target.closest('.node-block-content');
      if (blockContent) {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const anchor = selection.anchor.getNode();
            const parent = anchor.getParent();
            
            // If we're in a block with children
            if (parent && $isBlockNode(parent)) {
              const children = parent.getChildren();
              const lastChild = children[children.length - 1];
              
              // If last child is a pill and we clicked after it
              if ($isPillNode(lastChild)) {
                // Check if click is to the right of the pill
                const pillElement = editor.getElementByKey(lastChild.getKey());
                if (pillElement) {
                  const pillRect = pillElement.getBoundingClientRect();
                  const clickX = event.clientX;
                  
                  if (clickX > pillRect.right) {
                    // Click was after the pill - move cursor after it
                    event.preventDefault();
                    lastChild.selectNext();
                    return true;
                  }
                }
              }
            }
          }
        });
      }

      return false;
    };

    return editor.registerCommand(CLICK_COMMAND, handleClick, COMMAND_PRIORITY_HIGH);
  }, [editor, onPillClick]);

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
        editor.read(() => {
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
        });

        return false; // Don't prevent other handlers
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  // ─── Arrow key navigation (handle cursor movement around pills) ─

  useEffect(() => {
    const handleArrowLeft = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // If a pill is selected, move cursor to before it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isPillNode(node)) {
            event.preventDefault();
            // Move cursor to left of pill
            node.selectPrevious();
            return true;
          }
        }
      }

      // Handle cursor at pill boundary in RangeSelection
      if ($isRangeSelection(selection)) {
        const anchor = selection.anchor;
        const node = anchor.getNode();
        
        // Check if there's a pill node immediately to the left
        const prevSibling = node.getPreviousSibling();
        if ($isPillNode(prevSibling) && anchor.offset === 0) {
          // Cursor is at start of text node after a pill
          // Let default behavior work, but select the pill if arrow pressed again
          return false;
        }
      }

      return false;
    };

    const handleArrowRight = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // If a pill is selected, move cursor to after it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isPillNode(node)) {
            event.preventDefault();
            // Move cursor to right of pill
            node.selectNext();
            return true;
          }
        }
      }

      // Handle cursor at pill boundary in RangeSelection
      if ($isRangeSelection(selection)) {
        const anchor = selection.anchor;
        const node = anchor.getNode();
        const nodeText = node.getTextContent();
        
        // Check if there's a pill node immediately to the right
        const nextSibling = node.getNextSibling();
        if ($isPillNode(nextSibling) && anchor.offset === nodeText.length) {
          // Cursor is at end of text node before a pill
          // Let default behavior work
          return false;
        }
      }

      return false;
    };

    const unsubLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      handleArrowLeft,
      COMMAND_PRIORITY_LOW, // Low priority to let other handlers go first
    );

    const unsubRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      handleArrowRight,
      COMMAND_PRIORITY_LOW,
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
