/**
 * Tests for SyncedContentPlugin.
 */

// jsdom does not implement getBoundingClientRect; Lexical's internal selection
// update relies on it existing. Provide a stub so the tests run without throwing
// unrelated layout errors.
function stubGetBoundingClientRect() {
  const stub = () =>
    ({ bottom: 0, left: 0, top: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  if (!('getBoundingClientRect' in Range.prototype)) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: stub });
  }
  if (!('getBoundingClientRect' in Text.prototype)) {
    Object.defineProperty(Text.prototype, 'getBoundingClientRect', { value: stub });
  }
}
stubGetBoundingClientRect();

import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { forwardRef, createRef, useImperativeHandle, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ParagraphNode, TextNode, $getRoot, $createTextNode, type ElementNode } from 'lexical';
import { notesEditorTheme } from '../theme';
import { InlineLinkNode } from '../nodes/InlineLinkNode';
import { MathNode } from '../nodes/MathNode';
import { SyncedContentPlugin } from './SyncedContentPlugin';
import { extractInlineContent } from '../inlineContentPopulation';
import { serializeContentAST } from '../editorConfig';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
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
  insertText: (text: string) => void;
}

interface TestEditorProps {
  contentAST: ContentAST;
  readOnly?: boolean;
  blockId?: string;
}

const TestEditor = forwardRef<TestEditorHandle, TestEditorProps>(function TestEditor(
  { contentAST, readOnly, blockId },
  ref,
): JSX.Element {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <TestEditorInner contentAST={contentAST} readOnly={readOnly} blockId={blockId} ref={ref} />
    </LexicalComposer>
  );
});

const TestEditorInner = forwardRef<TestEditorHandle, TestEditorProps>(function TestEditorInner(
  { contentAST, readOnly, blockId },
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
    insertText: (text: string) => {
      editor.update(() => {
        const root = $getRoot();
        const paragraph = root.getFirstChild();
        if (!paragraph) return;
        const textNode = $createTextNode(text);
        (paragraph as ElementNode).append(textNode);
      });
    },
  }));

  return (
    <>
      <RichTextPlugin
        contentEditable={<ContentEditable aria-label="Test content" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <SyncedContentPlugin contentAST={contentAST} readOnly={readOnly} blockId={blockId} />
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

  it('does not overwrite local edits on blur when the prop has not changed', async () => {
    const ref = createRef<TestEditorHandle>();
    const { rerender } = render(<TestEditor ref={ref} contentAST={astA} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.focus();
    });

    // Simulate typing a trigger character while focused.
    act(() => {
      ref.current!.insertText('@');
    });

    // Blurring should not clobber the locally-typed character because the
    // external prop has not changed.
    act(() => {
      ref.current!.blur();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ref.current!.getContent()).toBe(JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'hello@' }] }]));

    // Once the prop does change, the blur-sync should apply it.
    rerender(<TestEditor ref={ref} contentAST={astB} />);
    await waitFor(() => {
      expect(ref.current!.getContent()).toBe(JSON.stringify(astB));
    });
  });

  it('does not overwrite local edits when readOnly is toggled without blur', async () => {
    const ref = createRef<TestEditorHandle>();
    const { rerender } = render(<TestEditor ref={ref} contentAST={astA} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.focus();
    });

    act(() => {
      ref.current!.insertText('@');
    });

    // Toggle readOnly without firing a blur event. The editor becomes inactive,
    // but local edits should be preserved because the prop has not changed
    // externally.
    rerender(<TestEditor ref={ref} contentAST={astA} readOnly />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ref.current!.getContent()).toBe(
      JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'hello@' }] }]),
    );
  });

  it('does not overwrite the editor while a trigger popup is open for it', async () => {
    const blockId = 'test-block';
    const ref = createRef<TestEditorHandle>();
    const { rerender } = render(<TestEditor ref={ref} contentAST={astA} blockId={blockId} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current!.focus();
    });

    // Simulate opening a trigger popup for this editor. The editor loses focus
    // to the popup input, but activeBlockId stays set and popupOpen becomes true.
    act(() => {
      useEditorFocusStore.getState().focusBlock(blockId);
      useEditorFocusStore.getState().openPopup();
    });

    // The editor is blurred while the popup is open, as in real usage.
    act(() => {
      ref.current!.blur();
    });

    rerender(<TestEditor ref={ref} contentAST={astB} blockId={blockId} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ref.current!.getContent()).toBe(JSON.stringify(astA));

    // Once the popup closes, the prop change should apply (editor is blurred).
    act(() => {
      useEditorFocusStore.getState().closePopup();
    });

    await waitFor(() => {
      expect(ref.current!.getContent()).toBe(JSON.stringify(astB));
    });
  });
});
