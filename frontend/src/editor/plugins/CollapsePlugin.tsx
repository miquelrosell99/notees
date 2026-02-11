/**
 * CollapsePlugin — Handles collapse/expand of node blocks.
 *
 * Arrow key toggles a node's collapsed flag through the runtime.
 * The projection layer hides descendants when parent is collapsed.
 * Lexical only renders visible nodes.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { $isNodeBlockNode } from '../nodes/NodeBlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

export function CollapsePlugin(): null {
  const [editor] = useLexicalComposerContext();

  // ─── Left arrow at start: collapse ─────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let blockIdToCollapse: string | null = null;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (!selection.isCollapsed()) return;

          const anchor = selection.anchor;
          if (anchor.offset !== 0) return;

          const anchorNode = anchor.getNode();
          let blockNode: ReturnType<typeof anchorNode.getParent> | typeof anchorNode = anchorNode;
          while (blockNode && !$isNodeBlockNode(blockNode)) {
            blockNode = blockNode.getParent();
          }

          if (!blockNode || !$isNodeBlockNode(blockNode)) return;
          if (!blockNode.getHasChildren()) return;
          if (blockNode.getCollapsed()) return;

          blockIdToCollapse = blockNode.getBlockId();
        });

        if (!blockIdToCollapse) return false;

        event?.preventDefault();
        const runtime = getNodeGraphRuntime();
        runtime.applyIntent({ type: 'set_collapsed', blockId: blockIdToCollapse, collapsed: true });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  // ─── Right arrow at end: expand ────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let blockIdToExpand: string | null = null;

        editor.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (!selection.isCollapsed()) return;

          const anchorNode = selection.anchor.getNode();
          let blockNode: ReturnType<typeof anchorNode.getParent> | typeof anchorNode = anchorNode;
          while (blockNode && !$isNodeBlockNode(blockNode)) {
            blockNode = blockNode.getParent();
          }

          if (!blockNode || !$isNodeBlockNode(blockNode)) return;
          if (!blockNode.getHasChildren()) return;
          if (!blockNode.getCollapsed()) return;

          // Check if at end of content
          const textContent = blockNode.getTextContent();
          if (selection.anchor.offset < textContent.length) return;

          blockIdToExpand = blockNode.getBlockId();
        });

        if (!blockIdToExpand) return false;

        event?.preventDefault();
        const runtime = getNodeGraphRuntime();
        runtime.applyIntent({ type: 'set_collapsed', blockId: blockIdToExpand, collapsed: false });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
