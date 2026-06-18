/**
 * Single-editor find/replace helpers — extracted from the legacy FindReplacePlugin.
 *
 * These operate on a single Lexical editor instance. The new BlockFindReplacePlugin
 * uses blockFindReplace.ts instead; this file is kept for any remaining single-editor
 * contexts (e.g., card title InlineEditor if it ever needs find/replace).
 */

import type { LexicalEditor } from 'lexical';
import {
  $getSelection,
  $isRangeSelection,
  $createRangeSelection,
  $getNodeByKey,
  $isTextNode,
} from 'lexical';
import type { Match } from '@/stores/findReplaceStore';

/** Execute search and return all matches */
export function executeSearch(
  editor: LexicalEditor,
  query: string,
  caseSensitive: boolean,
): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
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
export function selectMatch(editor: LexicalEditor, match: Match) {
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
export function replaceCurrent(editor: LexicalEditor, match: Match, replaceText: string) {
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
export function replaceAll(editor: LexicalEditor, matches: Match[], replaceText: string) {
  editor.update(() => {
    const sorted = [...matches].sort((a, b) => {
      if (a.nodeKey !== b.nodeKey) return 0;
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
