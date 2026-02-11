/**
 * CollapsePlugin — Handles collapse/expand of node blocks.
 *
 * Cmd/Ctrl+Left/Right toggles a node's collapsed flag through the runtime.
 * The projection layer hides descendants when parent is collapsed.
 * Lexical only renders visible nodes.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_MODIFIER_COMMAND,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { $isNodeBlockNode } from '../nodes/NodeBlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

export function CollapsePlugin(): null {
  const [editor] = useLexicalComposerContext();

  // ─── Cmd/Ctrl+Left: collapse, Cmd/Ctrl+Right: expand ──────

  useEffect(() => {
    return editor.registerCommand(
      KEY_MODIFIER_COMMAND,
      (event: KeyboardEvent) => {
        const { key, ctrlKey, metaKey } = event;
        if (!ctrlKey && !metaKey) return false;
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false;

        let blockIdToToggle: string | null = null;
        let shouldCollapse = false;

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

          if (key === 'ArrowLeft' && !blockNode.getCollapsed()) {
            // Collapse
            blockIdToToggle = blockNode.getBlockId();
            shouldCollapse = true;
          } else if (key === 'ArrowRight' && blockNode.getCollapsed()) {
            // Expand
            blockIdToToggle = blockNode.getBlockId();
            shouldCollapse = false;
          }
        });

        if (!blockIdToToggle) return false;

        event.preventDefault();
        const runtime = getNodeGraphRuntime();
        runtime.applyIntent({ type: 'set_collapsed', blockId: blockIdToToggle, collapsed: shouldCollapse });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
