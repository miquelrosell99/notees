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
        
        // If cursor is at position 0 in a text node (or just has ZWS)
        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          // Consider ZWS-only text node as "at start"
          const isAtStart = anchor.offset === 0 || (text === '\u200B' && anchor.offset <= 1);
          
          if (isAtStart) {
            const prevSibling = anchorNode.getPreviousSibling();
            if ($isPillNode(prevSibling)) {
              // Select the pill instead of moving past it
              event.preventDefault();
              const nodeSelection = $createNodeSelection();
              nodeSelection.add(prevSibling.getKey());
              $setSelection(nodeSelection);
              return true;
            }
          }
        }
      }

      return false;
    };

    const handleArrowRight = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // Debug logging
      console.log('[PillPlugin] ArrowRight - selection type:', selection?.constructor.name);
      
      // Case 1: A pill is currently selected - move cursor to after it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isPillNode(node)) {
            console.log('[PillPlugin] Pill selected, moving to next');
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
        
        console.log('[PillPlugin] RangeSelection - anchorNode type:', anchorNode.getType(), 
          'offset:', anchor.offset, 
          'isTextNode:', $isTextNode(anchorNode));
        
        // If cursor is at end of a text node
        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          const textLength = text.length;
          console.log('[PillPlugin] Text content:', JSON.stringify(text), 'length:', textLength);
          
          // Consider being at or past the text length as "at end"
          // Also consider ZWS-only nodes as being "at end"
          const isAtEnd = anchor.offset >= textLength || text === '\u200B';
          console.log('[PillPlugin] isAtEnd:', isAtEnd);
          
          if (isAtEnd) {
            const nextSibling = anchorNode.getNextSibling();
            console.log('[PillPlugin] nextSibling type:', nextSibling?.getType(), 'isPill:', $isPillNode(nextSibling));
            
            if ($isPillNode(nextSibling)) {
              // Select the pill instead of moving past it
              console.log('[PillPlugin] Selecting pill!');
              event.preventDefault();
              const nodeSelection = $createNodeSelection();
              nodeSelection.add(nextSibling.getKey());
              $setSelection(nodeSelection);
              return true;
            }
          }
        }
        
        // Also check if the anchor is on an element node (parent block)
        // and we need to check children
        if (!$isTextNode(anchorNode)) {
          console.log('[PillPlugin] Anchor is on element node');
          const parent = anchorNode;
          const children = parent.getChildren?.() || [];
          console.log('[PillPlugin] Children count:', children.length, 'offset:', anchor.offset);
          const childAtOffset = children[anchor.offset];
          if ($isPillNode(childAtOffset)) {
            console.log('[PillPlugin] Child at offset is pill, selecting');
            event.preventDefault();
            const nodeSelection = $createNodeSelection();
            nodeSelection.add(childAtOffset.getKey());
            $setSelection(nodeSelection);
            return true;
          }
        }
      }

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
