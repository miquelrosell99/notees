/**
 * FindReplacePlugin — Page-scoped find & replace.
 *
 * - Ctrl+F / Cmd+F: open widget
 * - Ctrl+H / Cmd+H: toggle replace section (when open)
 * - Escape when widget open: close widget
 */

import { useEffect, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createRangeSelection,
  $getNodeByKey,
  $isTextNode,
} from 'lexical';
import { useFindReplaceStore } from '../../stores/findReplaceStore';
import { FindReplaceWidget } from './FindReplaceWidget';
import { useInputContext } from '../../stores/inputContext';

export function FindReplacePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const isOpen = useFindReplaceStore((s) => s.isOpen);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const isMod = event.ctrlKey || event.metaKey;
        if (isMod && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          useFindReplaceStore.getState().open();
          return true;
        }
        if (isOpen && isMod && event.key.toLowerCase() === 'h') {
          event.preventDefault();
          useFindReplaceStore.getState().toggleReplaceExpanded();
          return true;
        }
        if (isOpen && event.key === 'Escape') {
          event.preventDefault();
          useFindReplaceStore.getState().close();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, isOpen]);

  // Close widget when editor loses focus to a modal/dialog
  useEffect(() => {
    if (!isOpen) return;
    const check = () => {
      if (useInputContext.getState().modalOpen) {
        useFindReplaceStore.getState().close();
      }
    };
    const id = setInterval(check, 200);
    return () => clearInterval(id);
  }, [isOpen]);

  if (!isOpen) return null;

  return <FindReplaceWidget editor={editor} />;
}

/** Execute search and return all matches */
export function executeSearch(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  query: string,
  caseSensitive: boolean,
): import('../../stores/findReplaceStore').Match[] {
  if (!query) return [];
  const matches: import('../../stores/findReplaceStore').Match[] = [];
  editor.read(() => {
    const root = editor.getEditorState()._nodeMap;
    for (const [key, node] of root) {
      if ($isTextNode(node)) {
        const text = node.getTextContent();
        const searchText = caseSensitive ? text : text.toLowerCase();
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        let idx = searchText.indexOf(searchQuery);
        while (idx !== -1) {
          matches.push({
            nodeKey: key,
            offset: idx,
            length: query.length,
            text: text.slice(idx, idx + query.length),
          });
          idx = searchText.indexOf(searchQuery, idx + 1);
        }
      }
    }
  });
  return matches;
}

/** Select a specific match in the editor */
export function selectMatch(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  match: import('../../stores/findReplaceStore').Match,
) {
  editor.update(() => {
    const node = $getNodeByKey(match.nodeKey);
    if (!node || !$isTextNode(node)) return;
    const selection = $createRangeSelection();
    selection.anchor.set(match.nodeKey, match.offset, 'text');
    selection.focus.set(match.nodeKey, match.offset + match.length, 'text');
    const currentSel = $getSelection();
    if ($isRangeSelection(currentSel)) {
      currentSel.anchor.set(match.nodeKey, match.offset, 'text');
      currentSel.focus.set(match.nodeKey, match.offset + match.length, 'text');
    }
  });
}

/** Replace the current match */
export function replaceCurrent(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  match: import('../../stores/findReplaceStore').Match,
  replaceText: string,
) {
  editor.update(() => {
    const node = $getNodeByKey(match.nodeKey);
    if (!node || !$isTextNode(node)) return;
    const text = node.getTextContent();
    const before = text.slice(0, match.offset);
    const after = text.slice(match.offset + match.length);
    node.setTextContent(before + replaceText + after);
  });
}

/** Replace all matches */
export function replaceAll(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  matches: import('../../stores/findReplaceStore').Match[],
  replaceText: string,
) {
  editor.update(() => {
    // Process from last to first so offsets remain valid
    const sorted = [...matches].sort((a, b) => {
      if (a.nodeKey !== b.nodeKey) return 0; // same node assumed for simple case
      return b.offset - a.offset;
    });
    for (const match of sorted) {
      const node = $getNodeByKey(match.nodeKey);
      if (!node || !$isTextNode(node)) continue;
      const text = node.getTextContent();
      const before = text.slice(0, match.offset);
      const after = text.slice(match.offset + match.length);
      node.setTextContent(before + replaceText + after);
    }
  });
}
