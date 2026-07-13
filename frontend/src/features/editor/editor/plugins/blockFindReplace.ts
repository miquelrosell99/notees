/**
 * Block-level find/replace helpers for the per-block custom editor architecture.
 *
 * Operates across all registered inline editor handles rather than a single
 * monolithic editor instance.
 */

import { useInlineEditorRegistry } from '@/stores/inlineEditorRegistry';
import type { Match } from '@/stores/findReplaceStore';

export interface BlockMatch extends Match {
  blockId: string;
}

/** Execute search across all registered inline editors. */
export function executeBlockSearch(query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];

  const { editors } = useInlineEditorRegistry.getState();
  const matches: BlockMatch[] = [];

  for (const [blockId, editor] of editors) {
    const text = editor.getText();
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();
    let idx = searchText.indexOf(searchQuery);
    while (idx !== -1) {
      matches.push({
        blockId,
        nodeKey: blockId,
        offset: idx,
        length: query.length,
        text: text.slice(idx, idx + query.length),
      });
      idx = searchText.indexOf(searchQuery, idx + 1);
    }
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
  editor.scrollIntoView();
  editor.selectRange(match.offset, match.offset + match.length);
}

/** Replace a single match in its respective editor. */
export function replaceBlockMatch(match: Match, replaceText: string) {
  const blockId = match.blockId;
  if (!blockId) return;
  const editor = useInlineEditorRegistry.getState().getEditor(blockId);
  if (!editor) return;

  editor.replaceRange(match.offset, match.offset + match.length, replaceText);
}

/** Replace all matches, grouped by editor and processed last-to-first. */
export function replaceAllBlockMatches(matches: Match[], replaceText: string) {
  // Sort globally last-to-first so offsets remain valid as we mutate each editor
  const sorted = [...matches].sort((a, b) => {
    if (a.blockId !== b.blockId) return 0; // different blocks — order doesn't matter for independent handles
    return b.offset - a.offset;
  });

  for (const match of sorted) {
    replaceBlockMatch(match, replaceText);
  }
}
