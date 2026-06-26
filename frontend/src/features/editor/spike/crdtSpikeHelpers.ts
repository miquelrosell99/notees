/**
 * Shared helpers for the CRDT spike page and its tests.
 *
 * Kept in a separate file so the page component file only exports React
 * components (satisfying Fast Refresh rules).
 */

import {
  $getRoot,
  $createParagraphNode,
  type LexicalEditor,
} from 'lexical';
import { populateInlineContent, extractInlineContent } from '../editor/inlineContentPopulation';
import type { ContentAST } from '@/runtime/types';

export const richSeedAST: ContentAST = [
  {
    type: 'paragraph',
    children: [
      { type: 'text', text: 'Hello ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'italic' }] },
      { type: 'text', text: '. ' },
      {
        type: 'node_link',
        link_id: 'node-uuid-1',
        ref_type: 'node',
        label: 'a link pill',
      },
      { type: 'text', text: ' ' },
      {
        type: 'date_range',
        start: '2026-06-01',
        end: '2026-06-07',
        granularity: 'day',
        start_uuid: 'day-start-uuid',
        end_uuid: 'day-end-uuid',
        label: 'a week',
      },
      { type: 'text', text: ' ' },
      { type: 'math', expression: 'E=mc^2', displayMode: false },
    ],
  },
];

export function applyASTToEditor(editor: LexicalEditor, ast: ContentAST): void {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      populateInlineContent(paragraph, ast);
      root.append(paragraph);
    },
    { tag: 'history-merge' },
  );
}

export function readASTFromEditor(editor: LexicalEditor): ContentAST {
  let ast: ContentAST = [];
  editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChild();
    if (paragraph) {
      ast = extractInlineContent(paragraph as ReturnType<typeof $createParagraphNode>);
    }
  });
  return ast;
}
