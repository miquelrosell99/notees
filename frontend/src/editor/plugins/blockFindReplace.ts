/**
 * Block-level find/replace helpers for the per-block editor architecture.
 *
 * Operates across all registered InlineEditor instances rather than
 * a single monolithic editor.
 */

import {
  $getNodeByKey,
  $isTextNode,
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import { useInlineEditorRegistry } from '../../stores/inlineEditorRegistry';
import type { Match } from '../../stores/findReplaceStore';

export interface BlockMatch extends Match {
  blockId: string;
}

/** Execute search across all registered inline editors. */
export function executeBlockSearch(query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];

  const { editors } = useInlineEditorRegistry.getState();
  const matches: BlockMatch[] = [];

  for (const [blockId, editor] of editors) {
    editor.read(() => {
      const nodeMap = editor.getEditorState()._nodeMap;
      for (const [key, node] of nodeMap) {
        if ($isTextNode(node)) {
          const text = node.getTextContent();
          const searchText = caseSensitive ? text : text.toLowerCase();
          const searchQuery = caseSensitive ? query : query.toLowerCase();
          let idx = searchText.indexOf(searchQuery);
          while (idx !== -1) {
            matches.push({
              blockId,
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
  }

  return matches;
}

/** Focus the editor containing the match and select it. */
export function selectBlockMatch(match: Match) {
  const blockId = match.blockId;
  if (!blockId) return;
  const editor = useInlineEditorRegistry.getState().getEditor(blockId);
  if (!editor) return;

  editor.focus();

  // Scroll the block into view
  const rootElement = editor.getRootElement();
  if (rootElement) {
    rootElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

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

/** Replace a single match in its respective editor. */
export function replaceBlockMatch(match: Match, replaceText: string) {
  const blockId = match.blockId;
  if (!blockId) return;
  const editor = useInlineEditorRegistry.getState().getEditor(blockId);
  if (!editor) return;

  editor.update(() => {
    const node = $getNodeByKey(match.nodeKey);
    if (!node || !$isTextNode(node)) return;
    const text = node.getTextContent();
    const before = text.slice(0, match.offset);
    const after = text.slice(match.offset + match.length);
    node.setTextContent(before + replaceText + after);
  });
}

/** Replace all matches, grouped by editor and processed last-to-first. */
export function replaceAllBlockMatches(matches: Match[], replaceText: string) {
  // Group matches by editor so we can process each editor independently
  const byEditor = new Map<LexicalEditor, Match[]>();

  for (const match of matches) {
    const blockId = match.blockId;
    if (!blockId) continue;
    const editor = useInlineEditorRegistry.getState().getEditor(blockId);
    if (!editor) continue;
    const list = byEditor.get(editor) ?? [];
    list.push(match);
    byEditor.set(editor, list);
  }

  for (const [editor, editorMatches] of byEditor) {
    editor.update(() => {
      // Sort last-to-first so offsets remain valid as we mutate
      const sorted = [...editorMatches].sort((a, b) => {
        if (a.nodeKey !== b.nodeKey) return 0; // different nodes — order doesn't matter within one update
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
}
