/**
 * Tests for SyncedContentPlugin.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { forwardRef, createRef, useImperativeHandle, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ParagraphNode, TextNode, $getRoot, type ElementNode } from 'lexical';
import { notesEditorTheme } from '../theme';
import { InlineLinkNode } from '../nodes/InlineLinkNode';
import { MathNode } from '../nodes/MathNode';
import { SyncedContentPlugin } from './SyncedContentPlugin';
import { extractInlineContent } from '../inlineContentPopulation';
import { serializeContentAST } from '../editorConfig';
import type { ContentAST } from '@/runtime/types';

const initialConfig = {
  namespace: 'SyncedContentPluginTest',
  theme: notesEditorTheme,
  nodes: [ParagraphNode, TextNode, InlineLinkNode, MathNode],
  onError: vi.fn(),
  editable: true,
};

interface TestEditorHandle {
  getContent: () => string;
  focus: () => void;
  blur: () => void;
}

interface TestEditorProps {
  contentAST: ContentAST;
}

const TestEditor = forwardRef<TestEditorHandle, TestEditorProps>(function TestEditor(
  { contentAST },
  ref,
): JSX.Element {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <TestEditorInner contentAST={contentAST} ref={ref} />
    </LexicalComposer>
  );
});

const TestEditorInner = forwardRef<TestEditorHandle, TestEditorProps>(function TestEditorInner(
  { contentAST },
  ref,
): JSX.Element {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(ref, () => ({
    getContent: () =>
      editor.getEditorState().read(() => {
        const root = $getRoot();
        const paragraph = root.getFirstChild();
        if (!paragraph) return '';
        return serializeContentAST(extractInlineContent(paragraph as ElementNode));
      }),
    focus: () => {
      editor.getRootElement()?.focus();
    },
    blur: () => {
      editor.getRootElement()?.blur();
    },
  }));

  return (
    <>
      <RichTextPlugin
        contentEditable={<ContentEditable aria-label="Test content" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <SyncedContentPlugin contentAST={contentAST} />
    </>
  );
});

const astA: ContentAST = [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }];
const astB: ContentAST = [{ type: 'paragraph', children: [{ type: 'text', text: 'world' }] }];

describe('SyncedContentPlugin', () => {
  it('hydrates the editor from the initial prop', async () => {
    const ref = createRef<TestEditorHandle>();
    render(<TestEditor ref={ref} contentAST={astA} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getContent()).toBe(JSON.stringify(astA));
  });

  it('updates the editor when the prop changes while blurred', async () => {
    const ref = createRef<TestEditorHandle>();
    const { rerender } = render(<TestEditor ref={ref} contentAST={astA} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    expect(ref.current!.getContent()).toBe(JSON.stringify(astA));

    rerender(<TestEditor ref={ref} contentAST={astB} />);

    await waitFor(() => {
      expect(ref.current!.getContent()).toBe(JSON.stringify(astB));
    });
  });

  it('does not overwrite the editor while it is focused', async () => {
    const ref = createRef<TestEditorHandle>();
    const { rerender } = render(<TestEditor ref={ref} contentAST={astA} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.focus();
    });

    rerender(<TestEditor ref={ref} contentAST={astB} />);

    // Give any async work a chance to run, then assert the old content remains.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ref.current!.getContent()).toBe(JSON.stringify(astA));

    act(() => {
      ref.current!.blur();
    });

    await waitFor(() => {
      expect(ref.current!.getContent()).toBe(JSON.stringify(astB));
    });
  });
});
