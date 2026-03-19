/**
 * NodeLinkPlugin — Lexical plugin for rendering inline link decorator nodes.
 *
 * Handles:
 * - Rendering InlineLinkNode as React components
 * - Click-to-navigate behavior
 * - Context menu for link editing
 * - Keyboard navigation around inline links
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
  $isElementNode,
  $createNodeSelection,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_DOWN_COMMAND,
  CLICK_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { $isInlineLinkNode, $createInlineLinkNode } from '../nodes/InlineLinkNode';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';

/** Pending update to apply to an InlineLinkNode (from LinkEditModal). */
export interface PendingPillUpdate {
  oldLinkId: string;
  newLinkId: string;
  newRefType: InlineLinkRefType;
  newUrl?: string;
  /** Updated label (undefined = keep existing, null = clear, string = set). */
  newLabel?: string | null;
}

export interface NodeLinkPluginProps {
  /** Called when a pill is clicked for navigation */
  onPillClick?: (linkId: string, refType: InlineLinkRefType) => void;
  /** Called when a pill is clicked in edit mode (opens edit modal) */
  onPillEdit?: (linkId: string, refType: InlineLinkRefType) => void;
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
  // Single-click: select the pill (NodeSelection) for editing/deletion
  // Double-click: navigate to the linked node

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const pillWrapper = target.closest('.inline-link-wrapper');
      
      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        const refType = (pillWrapper.getAttribute('data-ref-type') as InlineLinkRefType) || 'node';
        if (!linkId) return true;

        if (refType === 'url') {
          // URL pill: open in new tab on any click
          const url = pillWrapper.getAttribute('data-url');
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          return true;
        }

        // If this pill is already selected (NodeSelection from a previous
        // click), a second click places the cursor before or after it based
        // on which half of the pill was clicked.  This gives users a mouse-
        // based way to position the cursor adjacent to the pill without
        // relying on arrow keys.
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const selectedNodes = selection.getNodes();
          const alreadySelected = selectedNodes.find(
            n => $isInlineLinkNode(n) && n.getLinkId() === linkId
          );
          if (alreadySelected) {
            event.preventDefault();
            const pillRect = pillWrapper.getBoundingClientRect();
            const midX = pillRect.left + pillRect.width / 2;
            if (event.clientX >= midX) {
              alreadySelected.selectNext();
            } else {
              alreadySelected.selectPrevious();
            }
            return true;
          }
        }

        // First click: select the pill via NodeSelection
        event.preventDefault();
        editor.update(() => {
          // Find the InlineLinkNode matching this linkId
          const root = $getRoot();
          const findNode = (parent: ReturnType<typeof $getRoot>): void => {
            for (const child of parent.getChildren()) {
              if ($isInlineLinkNode(child) && child.getLinkId() === linkId) {
                const nodeSelection = $createNodeSelection();
                nodeSelection.add(child.getKey());
                $setSelection(nodeSelection);
                return;
              }
              if ('getChildren' in child && typeof child.getChildren === 'function') {
                findNode(child as any);
              }
            }
          };
          findNode(root);
        });
        return true;
      }

      return false;
    };

    // Double-click: navigate to the linked node
    const handleDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const pillWrapper = target.closest('.inline-link-wrapper');

      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        const refType = (pillWrapper.getAttribute('data-ref-type') as InlineLinkRefType) || 'node';
        if (linkId && refType !== 'url') {
          event.preventDefault();
          onPillClick?.(linkId, refType);
        }
        return true;
      }
      return false;
    };

    const rootElement = editor.getRootElement();
    if (rootElement) {
      rootElement.addEventListener('dblclick', handleDoubleClick);
    }

    const unsubClick = editor.registerCommand(CLICK_COMMAND, handleClick, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubClick();
      rootElement?.removeEventListener('dblclick', handleDoubleClick);
    };
  }, [editor, onPillClick]);

  // ─── Apply pending pill update (from LinkEditModal) ──────────

  useEffect(() => {
    if (!pendingPillUpdate) return;

    editor.update(() => {
      const root = $getRoot();
      // Recursive descent to find and replace the InlineLinkNode with matching linkId
      const findAndReplacePill = (parent: ReturnType<typeof $getRoot>) => {
        for (const child of parent.getChildren()) {
          if ($isInlineLinkNode(child) && child.getLinkId() === pendingPillUpdate.oldLinkId) {
            // Replace with a new InlineLinkNode with the updated linkId/label
            const label = pendingPillUpdate.newLabel !== undefined
              ? (pendingPillUpdate.newLabel || undefined)
              : child.getLabel() || undefined;
            const newPill = $createInlineLinkNode(
              pendingPillUpdate.newLinkId,
              pendingPillUpdate.newRefType,
              pendingPillUpdate.newUrl,
              label,
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
        rootEl.querySelectorAll('.inline-link-wrapper').forEach(el => {
          el.classList.remove('selected', 'inline-link-wrapper--selected');
        });

        // Check if current selection is a NodeSelection on a pill
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          for (const node of nodes) {
            if ($isInlineLinkNode(node)) {
              // Find the DOM element and add selected class
              const key = node.getKey();
              const dom = editor.getElementByKey(key);
              if (dom) {
                dom.classList.add('selected', 'inline-link-wrapper--selected');
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
  // crashing on isolated decorator nodes like InlineLinkNode.

  useEffect(() => {
    const handleArrowLeft = (event: KeyboardEvent) => {
      const selection = $getSelection();
      
      // Case 1: A pill is currently selected - move cursor to before it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isInlineLinkNode(node)) {
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
            if ($isInlineLinkNode(prevSibling)) {
              // If this ZWS node sits between two pills, don't skip over it
              // so the user can position the cursor here and type a space
              const nextSibling = anchorNode.getNextSibling();
              if (text === '\u200B' && $isInlineLinkNode(nextSibling)) {
                return false;
              }
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
          if ($isInlineLinkNode(node)) {
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
            if ($isInlineLinkNode(nextSibling)) {
              // If this ZWS node sits between two pills, don't skip over it
              // so the user can position the cursor here and type a space
              const prevSibling = anchorNode.getPreviousSibling();
              if (text === '\u200B' && $isInlineLinkNode(prevSibling)) {
                return false;
              }
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
    const handleBackspace = (event: KeyboardEvent) => {
      const selection = $getSelection();

      // Case 1: Pill already selected (NodeSelection) → delete it
      if ($isNodeSelection(selection)) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isInlineLinkNode(node)) {
            onPillRemove?.(node.getLinkId());
            node.remove();
          }
        }
        return nodes.some(n => $isInlineLinkNode(n));
      }

      // Case 2: RangeSelection right after a pill → select the pill
      // Prevents the caret from jumping to the start of the line when
      // Lexical removes an empty text node adjacent to a DecoratorNode.
      if ($isRangeSelection(selection) && selection.isCollapsed()) {
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();

        // Text anchor: cursor at offset 0 (or in ZWS-only node) with pill before
        if ($isTextNode(anchorNode)) {
          const text = anchorNode.getTextContent();
          const isAtStart = anchor.offset === 0 || (text === '\u200B' && anchor.offset <= 1);

          if (isAtStart) {
            const prevSibling = anchorNode.getPreviousSibling();
            if ($isInlineLinkNode(prevSibling)) {
              event.preventDefault();
              const nodeSelection = $createNodeSelection();
              nodeSelection.add(prevSibling.getKey());
              $setSelection(nodeSelection);
              return true;
            }
          }
        }

        // Element anchor: text node was already removed, cursor sits on
        // parentElement right after the pill
        if (anchor.type === 'element' && $isElementNode(anchorNode)) {
          const children = anchorNode.getChildren();
          const childBefore = anchor.offset > 0 ? children[anchor.offset - 1] : null;
          if (childBefore && $isInlineLinkNode(childBefore)) {
            event.preventDefault();
            const nodeSelection = $createNodeSelection();
            nodeSelection.add(childBefore.getKey());
            $setSelection(nodeSelection);
            return true;
          }
        }
      }

      return false;
    };

    const handleDeleteForward = () => {
      const selection = $getSelection();
      if (!$isNodeSelection(selection)) return false;

      const nodes = selection.getNodes();
      for (const node of nodes) {
        if ($isInlineLinkNode(node)) {
          onPillRemove?.(node.getLinkId());
          node.remove();
        }
      }
      return nodes.some(n => $isInlineLinkNode(n));
    };

    const unsubBack = editor.registerCommand(KEY_BACKSPACE_COMMAND, handleBackspace, COMMAND_PRIORITY_HIGH);
    const unsubDel = editor.registerCommand(KEY_DELETE_COMMAND, handleDeleteForward, COMMAND_PRIORITY_HIGH);

    return () => {
      unsubBack();
      unsubDel();
    };
  }, [editor, onPillRemove]);

  // ─── Enter on selected pill → navigate ─────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== 'Enter') return false;

        const selection = $getSelection();
        if (!$isNodeSelection(selection)) return false;

        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isInlineLinkNode(node)) {
            event.preventDefault();
            const linkId = node.getLinkId();
            const refType = node.getRefType();
            if (refType === 'url') {
              const url = node.getUrl();
              if (url) window.open(url, '_blank', 'noopener,noreferrer');
            } else {
              onPillClick?.(linkId, refType);
            }
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onPillClick]);

  return null;
}
