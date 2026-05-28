/**
 * FindReplacePlugin — Page-scoped find & replace.
 *
 * - Escape when widget open: close widget
 *
 * The actual Ctrl+F / Ctrl+H shortcut is handled by the Command Registry
 * at the NodeView level so it works even when the editor is not focused.
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
import { useEditorRegistry } from '../../stores/editorRegistry';
import { FindReplaceWidget } from './FindReplaceWidget';

export function FindReplacePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const isOpen = useFindReplaceStore((s) => s.isOpen);
  const primaryEditor = useEditorRegistry((s) => s.primaryEditor);

  // Register this editor as the primary editor for find/replace
  useEffect(() => {
    useEditorRegistry.getState().setPrimaryEditor(editor);
    return () => {
      const current = useEditorRegistry.getState().primaryEditor;
      if (current === editor) {
        useEditorRegistry.getState().setPrimaryEditor(null);
      }
    };
  }, [editor]);

  // Escape closes the widget when the editor is focused
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
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

  // Only render the widget in the primary editor so we don't get duplicates
  // when multiple BlockEditors are on the page (card mode, embeds, etc.)
  if (!isOpen || editor !== primaryEditor) return null;

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
