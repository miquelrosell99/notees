import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CustomInlineEditor } from './CustomInlineEditor';

describe('CustomInlineEditor typing', () => {
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
});
