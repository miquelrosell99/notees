/**
 * Automated assertions for the M4 CRDT text spike.
 *
 * These tests mount two editors sharing one Yjs document and verify that:
 * 1. Rich content seeded in editor A appears in editor B.
 * 2. Concurrent text edits in A and B merge without 409s.
 * 3. Custom inline nodes (link pill, date range, math) survive the merge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LexicalEditor } from 'lexical';
import { CrdtSpikePage } from './CrdtSpikePage';
import { readASTFromEditor } from './crdtSpikeHelpers';
import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';

function collectTextFromInlineNode(node: ASTInlineNode): string {
  if ('text' in node) {
    return node.text;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(collectTextFromInlineNode).join('');
  }
  return '';
}

function collectText(ast: ContentAST): string {
  const parts: string[] = [];
  for (const para of ast) {
    const children = 'children' in para ? para.children : [];
    if (!children) continue;
    for (const child of children) {
      parts.push(collectTextFromInlineNode(child));
    }
  }
  return parts.join('');
}

function findInlineNode(ast: ContentAST, type: string) {
  for (const para of ast) {
    const children = 'children' in para ? para.children : [];
    if (!children) continue;
    for (const child of children) {
      if (child.type === type) return child;
    }
  }
  return undefined;
}

describe('CrdtSpikePage', () => {
  let editorA: LexicalEditor | null = null;
  let editorB: LexicalEditor | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    editorA = null;
    editorB = null;
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  function mount() {
    return render(
      <QueryClientProvider client={queryClient}>
        <CrdtSpikePage
          onEditorAReady={(ed) => {
            editorA = ed;
          }}
          onEditorBReady={(ed) => {
            editorB = ed;
          }}
        />
      </QueryClientProvider>,
    );
  }

  it('mounts both editors and propagates rich seed content from A to B', async () => {
    const user = userEvent.setup();
    const { getByText } = mount();

    await waitFor(() => expect(editorA).not.toBeNull());
    await waitFor(() => expect(editorB).not.toBeNull());

    await act(async () => {
      await user.click(getByText('Seed rich content'));
    });

    await waitFor(() => {
      const b = readASTFromEditor(editorB!);
      return findInlineNode(b, 'node_link') !== undefined;
    });

    const astB = readASTFromEditor(editorB!);
    expect(findInlineNode(astB, 'node_link')).toMatchObject({
      link_id: 'node-uuid-1',
      ref_type: 'node',
    });
    expect(findInlineNode(astB, 'date_range')).toMatchObject({
      start: '2026-06-01',
      end: '2026-06-07',
    });
    expect(findInlineNode(astB, 'math')).toMatchObject({
      expression: 'E=mc^2',
    });
    expect(collectText(astB)).toContain('bold');
    expect(collectText(astB)).toContain('italic');
  });

  it('merges concurrent text edits from both editors', async () => {
    const user = userEvent.setup();
    const { getByText } = mount();

    await waitFor(() => expect(editorA).not.toBeNull());
    await waitFor(() => expect(editorB).not.toBeNull());

    await act(async () => {
      await user.click(getByText('Seed rich content'));
    });

    await waitFor(() => {
      const b = readASTFromEditor(editorB!);
      return collectText(b).includes('Hello');
    });

    await act(async () => {
      await user.click(getByText('A append'));
      await user.click(getByText('B prepend'));
    });

    await waitFor(() => {
      const a = readASTFromEditor(editorA!);
      const b = readASTFromEditor(editorB!);
      const textA = collectText(a);
      const textB = collectText(b);
      return (
        textA.includes('[A-end]') &&
        textA.includes('[B-start]') &&
        textB.includes('[A-end]') &&
        textB.includes('[B-start]')
      );
    });

    const astA = readASTFromEditor(editorA!);
    const astB = readASTFromEditor(editorB!);

    // Both editors converge to the same merged content.
    expect(collectText(astA)).toBe(collectText(astB));

    // Custom inline nodes survive the concurrent text edits.
    expect(findInlineNode(astA, 'node_link')).toMatchObject({
      link_id: 'node-uuid-1',
    });
    expect(findInlineNode(astB, 'node_link')).toMatchObject({
      link_id: 'node-uuid-1',
    });
    expect(findInlineNode(astA, 'math')).toMatchObject({
      expression: 'E=mc^2',
    });
  });
});
