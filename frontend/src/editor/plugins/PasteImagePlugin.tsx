/**
 * PasteImagePlugin — Intercepts paste events containing files and triggers upload.
 *
 * When a user pastes a file (image, document, etc.) from the clipboard, this plugin:
 * 1. Detects the file in the clipboard data
 * 2. Determines the current block being edited
 * 3. Calls the onPasteImage callback with the block's serverId and the File
 *
 * The actual upload logic lives in the parent component (NodeContent/CardItem),
 * which decides whether to convert the block or create a linked asset.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { PASTE_COMMAND, COMMAND_PRIORITY_HIGH, $getSelection, $isRangeSelection } from 'lexical';
import type { LexicalNode } from 'lexical';
import { $isBlockNode, type BlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';

/** Walk up the Lexical node tree to find the enclosing BlockNode. */
function $findBlockNode(node: LexicalNode): BlockNode | null {
  let current: LexicalNode | null = node;
  while (current && !$isBlockNode(current)) {
    current = current.getParent();
  }
  return current as BlockNode | null;
}

interface PasteImagePluginProps {
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
}

export function PasteImagePlugin({ onPasteImage }: PasteImagePluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPasteImage) return;

    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        // Check for files in the clipboard (images, documents, etc.)
        if (clipboardData.files.length === 0) return false;
        const pastedFile = clipboardData.files[0];

        // Find the currently focused block
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        const anchorNode = selection.anchor.getNode();
        const blockNode = $findBlockNode(anchorNode);
        if (!blockNode) return false;

        const blockId = blockNode.getBlockId();
        const runtime = getNodeGraphRuntime();
        const graphNode = runtime.getNode(blockId);
        if (!graphNode?.serverId) return false;

        // Determine if block has content (non-empty text)
        const hasContent = (graphNode.contentAST?.length ?? 0) > 0 &&
          !(graphNode.contentAST?.length === 1 &&
            graphNode.contentAST[0].type === 'paragraph' &&
            graphNode.contentAST[0].children?.length === 1 &&
            graphNode.contentAST[0].children[0].type === 'text' &&
            !graphNode.contentAST[0].children[0].text?.trim());

        // Prevent default paste behavior for files
        event.preventDefault();

        // Trigger the upload callback with content awareness
        onPasteImage(graphNode.serverId, pastedFile, hasContent);

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onPasteImage]);

  return null;
}
