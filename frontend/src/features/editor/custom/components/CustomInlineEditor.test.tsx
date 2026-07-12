import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CustomInlineEditor } from './CustomInlineEditor';
import type { InlineEditorHandle } from '@/features/editor/editor/types';
import type { ContentAST } from '@/runtime/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { getDOMSelectionOffset } from '../model/selectionSync';

function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('CustomInlineEditor typing', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
  });
  it('inserts a character when a beforeinput insertText event is dispatched', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: '' }] }]}
        onContentChange={onChange}
      />,
    );

    const editor = screen.getByRole('textbox');
    editor.focus();

    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'a',
    });
    act(() => {
      editor.dispatchEvent(event);
    });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }]);
  });

  it('updates the global editor focus store when it receives focus', () => {
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: '' }] }]}
      />,
    );

    const editor = screen.getByRole('textbox');
    act(() => {
      editor.focus();
    });

    expect(useEditorFocusStore.getState().activeBlockId).toBe('block-1');
  });

  it('deletes the character after the cursor when Delete is pressed', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        initialCursorOffset={1}
        onContentChange={onChange}
      />,
    );

    const editor = screen.getByRole('textbox');
    act(() => {
      editor.focus();
    });

    fireEvent.keyDown(editor, { key: 'Delete' });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'ac' }] }]);
  });

  it('replaces the selected range when the user types', () => {
    const onChange = vi.fn();
    const ref = createRef<InlineEditorHandle>();
    renderWithProviders(
      <CustomInlineEditor
        ref={ref}
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        onContentChange={onChange}
      />,
    );

    act(() => {
      ref.current?.selectRange(1, 3);
    });

    const editor = screen.getByRole('textbox');
    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: 'x',
    });
    act(() => {
      editor.dispatchEvent(event);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'ax' }] }]);
  });

  it('deletes the selected range when Backspace is pressed', () => {
    const onChange = vi.fn();
    const ref = createRef<InlineEditorHandle>();
    renderWithProviders(
      <CustomInlineEditor
        ref={ref}
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        onContentChange={onChange}
      />,
    );

    act(() => {
      ref.current?.selectRange(1, 3);
    });

    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Backspace' });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }]);
  });

  it('deletes the selected range when Delete is pressed', () => {
    const onChange = vi.fn();
    const ref = createRef<InlineEditorHandle>();
    renderWithProviders(
      <CustomInlineEditor
        ref={ref}
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        onContentChange={onChange}
      />,
    );

    act(() => {
      ref.current?.selectRange(1, 3);
    });

    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Delete' });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'a' }] }]);
  });

  it('ignores Backspace keydown events from inside an editor companion', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        onContentChange={onChange}
      />,
    );

    const editor = screen.getByRole('textbox');
    const companionInput = document.createElement('input');
    companionInput.setAttribute('data-editor-companion', 'true');
    editor.appendChild(companionInput);
    act(() => {
      companionInput.focus();
    });

    fireEvent.keyDown(companionInput, { key: 'Backspace' });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]);

    editor.removeChild(companionInput);
  });

  it('ignores beforeinput delete events from inside an editor companion', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
        onContentChange={onChange}
      />,
    );

    const editor = screen.getByRole('textbox');
    const companionInput = document.createElement('input');
    companionInput.setAttribute('data-editor-companion', 'true');
    editor.appendChild(companionInput);
    act(() => {
      companionInput.focus();
    });

    const event = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    });
    act(() => {
      companionInput.dispatchEvent(event);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    expect(JSON.parse(lastCall[1])).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]);

    editor.removeChild(companionInput);
  });

  it('does not delete a selected link pill when Backspace is pressed in a companion input', () => {
    const onChange = vi.fn();
    const initialAST = [
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'before ' },
          { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
        ],
      },
    ];
    renderWithProviders(
      <CustomInlineEditor
        blockId="block-1"
        initialContentAST={initialAST as unknown as ContentAST}
        onContentChange={onChange}
      />,
    );

    const pill = document.querySelector('[data-link-id="node:abc"]') as HTMLElement | null;
    expect(pill).not.toBeNull();

    act(() => {
      pill?.click();
    });

    const editor = screen.getByRole('textbox');
    const companionInput = document.createElement('input');
    companionInput.setAttribute('data-editor-companion', 'true');
    editor.appendChild(companionInput);
    act(() => {
      companionInput.focus();
    });

    fireEvent.keyDown(companionInput, { key: 'Backspace' });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const lastAST = JSON.parse(lastCall[1]);
    expect(lastAST[0].children.some((child: { type: string }) => child.type === 'node_link')).toBe(true);

    editor.removeChild(companionInput);
  });

  it('restores the pending caret when a mutation lands while blurred and focus returns', () => {
    // Mirrors the trigger-popup flow ("+" / "@" / "#"): the popup's search
    // input owns focus while the pill insertion mutation is applied, then the
    // popup closes and the editor is refocused programmatically. The caret
    // must land at the model selection (after the insertion), not wherever
    // the browser would drop it on refocus.
    const ref = createRef<InlineEditorHandle>();
    renderWithProviders(
      <CustomInlineEditor
        ref={ref}
        blockId="block-1"
        initialContentAST={[{ type: 'paragraph', children: [{ type: 'text', text: 'abc' }] }]}
      />,
    );

    const editor = screen.getByRole('textbox');
    act(() => {
      editor.focus();
    });

    // Popup opens and steals focus.
    act(() => {
      editor.blur();
    });

    // The selection mutation lands while the editor is blurred.
    act(() => {
      ref.current?.replaceRange(3, 3, 'X');
    });

    // Popup closes and refocuses the editor. Dispatch the focus event directly:
    // jsdom's focus() forcibly resets the selection to 0 AFTER focus listeners
    // run, which would clobber the restored caret (real browsers don't do that).
    act(() => {
      fireEvent.focus(editor);
    });

    expect(getDOMSelectionOffset(editor)).toBe(4);
  });
});
