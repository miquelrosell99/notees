/**
 * NodeLinkPlugin — Lexical plugin for inline link decorator nodes (pills).
 *
 * Handles:
 * - Structural invariant: ZWS text buffers around pills (browser limitation)
 * - Click-to-select and double-click-to-navigate behavior
 * - Pill update/replace from LinkEditModal
 * - Selection visual feedback (CSS class toggling)
 * - onPillRemove callback before Lexical deletes a pill
 * - Post-backspace pill selection (two-press UX: select → delete)
 * - Enter on selected pill → navigate
 *
 * Arrow key navigation and backspace/delete of decorator nodes are handled
 * natively by Lexical's RichTextPlugin via isKeyboardSelectable + NodeSelection.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  $getSelection,
  $getRoot,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $createNodeSelection,
  $createTextNode,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  DELETE_CHARACTER_COMMAND,
  CLICK_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { InlineLinkNode, $isInlineLinkNode, $createInlineLinkNode } from '../nodes/InlineLinkNode';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';
import { parseLinkId } from '../../lib/astBuilder';
import { copyToClipboard } from '../../utils/clipboardManager';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

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
  onPillEdit: _onPillEdit,
  onPillRemove,
  pendingPillUpdate,
  onPillUpdateApplied,
}: NodeLinkPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Structural invariant: every pill has adjacent text nodes ──
  // Without text neighbors the browser cannot place a caret next to a
  // contentEditable=false DecoratorNode.  This transform runs whenever
  // an InlineLinkNode is created or updated, ensuring ZWS buffers.

  useEffect(() => {
    return editor.registerNodeTransform(InlineLinkNode, (node) => {
      const prev = node.getPreviousSibling();
      if (!prev || $isInlineLinkNode(prev)) {
        node.insertBefore($createTextNode('\u200B'));
      }
      const next = node.getNextSibling();
      if (!next) {
        node.insertAfter($createTextNode('\u200B'));
      }
    });
  }, [editor]);

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
              if (!alreadySelected.getNextSibling()) {
                alreadySelected.insertAfter($createTextNode('\u200B'));
              }
              alreadySelected.selectNext();
            } else {
              const prev = alreadySelected.getPreviousSibling();
              if (!prev || $isInlineLinkNode(prev)) {
                alreadySelected.insertBefore($createTextNode('\u200B'));
              }
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

  // ─── Arrow key navigation ───────────────────────────────────
  // Lexical's RichTextPlugin (COMMAND_PRIORITY_EDITOR) natively handles:
  //   - NodeSelection + ArrowLeft/Right → selectPrevious()/selectNext()
  //   - RangeSelection + move → $moveCaretSelection with isKeyboardSelectable
  // The node transform ensures ZWS buffers always exist, so the native
  // handlers have text nodes to land on. No override needed.

  // ─── Backspace/Delete: fire onPillRemove callback ──────────
  // Lexical's RichTextPlugin natively handles deletion of decorator nodes
  // via NodeSelection + DELETE_CHARACTER_COMMAND. We only intercept to:
  // 1. Fire the onPillRemove callback before Lexical deletes the pill
  // 2. After a normal text backspace, convert to NodeSelection if cursor
  //    lands adjacent to a pill (two-press UX: select → delete)

  useEffect(() => {
    /**
     * If the current collapsed selection sits right next to an
     * InlineLinkNode, convert it to a NodeSelection on that pill.
     * Walks through empty / ZWS-only text nodes.
     */
    const $selectAdjacentPill = (backward: boolean): boolean => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

      const { anchor } = sel;
      const node = anchor.getNode();

      if (backward) {
        // Text anchor — check backwards from current position
        if ($isTextNode(node)) {
          const text = node.getTextContent();
          const atStart = anchor.offset === 0 || (text === '\u200B' && anchor.offset <= 1);
          if (atStart) {
            let prev = node.getPreviousSibling();
            while (prev) {
              if ($isInlineLinkNode(prev)) {
                const ns = $createNodeSelection();
                ns.add(prev.getKey());
                $setSelection(ns);
                return true;
              }
              if ($isTextNode(prev) && prev.getTextContent().replace(/\u200B/g, '') === '') {
                prev = prev.getPreviousSibling();
                continue;
              }
              break;
            }
          }
        }

        // Element anchor — cursor is directly on the parent element
        if (anchor.type === 'element' && $isElementNode(node)) {
          const child = anchor.offset > 0 ? node.getChildren()[anchor.offset - 1] : null;
          if (child && $isInlineLinkNode(child)) {
            const ns = $createNodeSelection();
            ns.add(child.getKey());
            $setSelection(ns);
            return true;
          }
        }
      } else {
        // Forward: check next sibling
        if ($isTextNode(node)) {
          const text = node.getTextContent();
          const atEnd = anchor.offset >= text.length || text === '\u200B';
          if (atEnd) {
            let next = node.getNextSibling();
            while (next) {
              if ($isInlineLinkNode(next)) {
                const ns = $createNodeSelection();
                ns.add(next.getKey());
                $setSelection(ns);
                return true;
              }
              if ($isTextNode(next) && next.getTextContent().replace(/\u200B/g, '') === '') {
                next = next.getNextSibling();
                continue;
              }
              break;
            }
          }
        }

        if (anchor.type === 'element' && $isElementNode(node)) {
          const child = node.getChildren()[anchor.offset] ?? null;
          if (child && $isInlineLinkNode(child)) {
            const ns = $createNodeSelection();
            ns.add(child.getKey());
            $setSelection(ns);
            return true;
          }
        }
      }

      return false;
    };

    // Fire onPillRemove before Lexical deletes the pill, then let Lexical
    // handle the actual node removal. Return false so RichTextPlugin proceeds.
    const handlePillDeletion = () => {
      const selection = $getSelection();
      if (!$isNodeSelection(selection)) return false;
      for (const node of selection.getNodes()) {
        if ($isInlineLinkNode(node)) {
          onPillRemove?.(node.getLinkId());
        }
      }
      return false; // Let Lexical handle the deletion
    };

    // Post-backspace fixup: if cursor landed next to a pill, select it.
    // Runs at NORMAL priority (after BlockPlugin at HIGH, before RichTextPlugin at EDITOR).
    const handleBackspaceFixup = (event: KeyboardEvent) => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) return false; // handled above
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

      // Check if cursor is already adjacent to a pill BEFORE deletion
      // If so, do the deletion ourselves and then check post-deletion
      const { anchor } = selection;
      const node = anchor.getNode();
      let nearPill = false;

      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const atStart = anchor.offset === 0 || (anchor.offset === 1 && text === '\u200B');
        if (atStart) {
          let prev = node.getPreviousSibling();
          while (prev) {
            if ($isInlineLinkNode(prev)) { nearPill = true; break; }
            if ($isTextNode(prev) && prev.getTextContent().replace(/\u200B/g, '') === '') {
              prev = prev.getPreviousSibling();
              continue;
            }
            break;
          }
        }
      }

      if (!nearPill) return false; // Not near a pill — let Lexical handle everything

      // Near a pill: perform deletion and post-fixup
      event.preventDefault();
      selection.deleteCharacter(true);
      $selectAdjacentPill(true);
      return true;
    };

    // Post-delete-forward fixup
    const handleDeleteFixup = (event: KeyboardEvent) => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) return false;
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

      const { anchor } = selection;
      const node = anchor.getNode();
      let nearPill = false;

      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const atEnd = anchor.offset >= text.length || text === '\u200B';
        if (atEnd) {
          let next = node.getNextSibling();
          while (next) {
            if ($isInlineLinkNode(next)) { nearPill = true; break; }
            if ($isTextNode(next) && next.getTextContent().replace(/\u200B/g, '') === '') {
              next = next.getNextSibling();
              continue;
            }
            break;
          }
        }
      }

      if (!nearPill) return false;

      event.preventDefault();
      selection.deleteCharacter(false);
      $selectAdjacentPill(false);
      return true;
    };

    // Android fallback: deleteCharacter fixup without KeyboardEvent
    const handleDeleteCharacterFixup = (isBackward: boolean) => {
      const selection = $getSelection();
      if ($isNodeSelection(selection)) return false;
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

      const { anchor } = selection;
      const node = anchor.getNode();
      let nearPill = false;

      if ($isTextNode(node)) {
        const text = node.getTextContent();
        if (isBackward) {
          const atStart = anchor.offset === 0 || (anchor.offset === 1 && text === '\u200B');
          if (atStart) {
            let prev = node.getPreviousSibling();
            while (prev) {
              if ($isInlineLinkNode(prev)) { nearPill = true; break; }
              if ($isTextNode(prev) && prev.getTextContent().replace(/\u200B/g, '') === '') {
                prev = prev.getPreviousSibling();
                continue;
              }
              break;
            }
          }
        } else {
          const atEnd = anchor.offset >= text.length || text === '\u200B';
          if (atEnd) {
            let next = node.getNextSibling();
            while (next) {
              if ($isInlineLinkNode(next)) { nearPill = true; break; }
              if ($isTextNode(next) && next.getTextContent().replace(/\u200B/g, '') === '') {
                next = next.getNextSibling();
                continue;
              }
              break;
            }
          }
        }
      }

      if (!nearPill) return false;

      selection.deleteCharacter(isBackward);
      $selectAdjacentPill(isBackward);
      return true;
    };

    // HIGH priority: fire callback before deletion (doesn't consume the event)
    const unsubBackHigh = editor.registerCommand(KEY_BACKSPACE_COMMAND, handlePillDeletion, COMMAND_PRIORITY_HIGH);
    const unsubDelHigh = editor.registerCommand(KEY_DELETE_COMMAND, handlePillDeletion, COMMAND_PRIORITY_HIGH);

    // NORMAL priority: post-deletion fixup near pills
    const unsubBackNormal = editor.registerCommand(KEY_BACKSPACE_COMMAND, handleBackspaceFixup, COMMAND_PRIORITY_NORMAL);
    const unsubDelNormal = editor.registerCommand(KEY_DELETE_COMMAND, handleDeleteFixup, COMMAND_PRIORITY_NORMAL);

    // Android fallbacks for soft keyboards that don't fire keydown events
    const unsubDeleteCharHigh = editor.registerCommand(DELETE_CHARACTER_COMMAND, handlePillDeletion, COMMAND_PRIORITY_HIGH);
    const unsubDeleteCharNormal = editor.registerCommand(DELETE_CHARACTER_COMMAND, handleDeleteCharacterFixup, COMMAND_PRIORITY_NORMAL);

    return () => {
      unsubBackHigh();
      unsubDelHigh();
      unsubBackNormal();
      unsubDelNormal();
      unsubDeleteCharHigh();
      unsubDeleteCharNormal();
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

  // ─── Copy shortcuts for selected pills ───────────────────────
  // Ctrl+C        → copy link reference ([[uuid]] or raw URL)
  // Shift+Ctrl+C  → copy display label
  // Alt+Ctrl+C    → copy markdown link [label](target)

  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (!isMod || event.key.toLowerCase() !== 'c') return;
      if (event.shiftKey && event.altKey) return;

      // Only when the editor is focused
      const rootEl = editor.getRootElement();
      if (!rootEl || !rootEl.contains(document.activeElement)) return;

      // Check if current selection is a NodeSelection on an InlineLinkNode
      const linkNode = editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isNodeSelection(selection)) return null;
        for (const node of selection.getNodes()) {
          if ($isInlineLinkNode(node)) {
            return node;
          }
        }
        return null;
      });

      if (!linkNode) return;

      event.preventDefault();
      event.stopPropagation();

      const refType = linkNode.getRefType();
      const linkId = linkNode.getLinkId();
      const url = linkNode.getUrl();
      const customLabel = linkNode.getLabel();
      const { nodeUuid } = parseLinkId(linkId);

      // Compute display label (mirrors InlineLink.tsx logic)
      let displayLabel = '';
      if (refType === 'url') {
        displayLabel =
          linkId && linkId !== url
            ? linkId
            : (url
                ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || url
                : 'URL');
      } else if (refType === 'broken') {
        displayLabel = customLabel || nodeUuid || '⛓️‍💥';
      } else {
        // node / class / embed
        const runtime = getNodeGraphRuntime();
        const targetNode = runtime.getNode(nodeUuid);
        displayLabel = customLabel || targetNode?.name || nodeUuid;
      }

      if (!event.shiftKey && !event.altKey) {
        // Ctrl+C — copy link reference
        const text = refType === 'url' ? url : `[[${nodeUuid}]]`;
        await copyToClipboard(text);
      } else if (event.shiftKey && !event.altKey) {
        // Shift+Ctrl+C — copy label
        await copyToClipboard(displayLabel);
      } else if (event.altKey && !event.shiftKey) {
        // Alt+Ctrl+C — copy markdown link
        const target = refType === 'url' ? url : nodeUuid;
        await copyToClipboard(`[${displayLabel}](${target})`);
      }
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [editor]);

  return null;
}
