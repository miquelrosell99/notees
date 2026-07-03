import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { CustomInlineEditor } from './CustomInlineEditor';
import type { InlineEditorHandle } from '@/features/editor/editor/types';
import { useEditorFocusStore } from '@/stores/editorFocusStore';

describe('CustomInlineEditor typing', () => {
  beforeEach(() => {
    useEditorFocusStore.setState({ activeBlockId: null, pendingFocusBlockId: null });
  });
  it('inserts a character when a beforeinput insertText event is dispatched', () => {
    const onChange = vi.fn();
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
    render(
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
});
