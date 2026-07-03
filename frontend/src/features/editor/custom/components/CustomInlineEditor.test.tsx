import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CustomInlineEditor } from './CustomInlineEditor';
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
});
