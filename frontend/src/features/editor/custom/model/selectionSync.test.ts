/**
 * selectionSync tests
 */

import { describe, it, expect } from 'vitest';
import { setDOMSelection, getDOMSelectionOffset } from './selectionSync';

function render(root: HTMLElement, html: string) {
  root.innerHTML = html;
}

describe('setDOMSelection / getDOMSelectionOffset', () => {
  it('round-trips a collapsed offset in text units', () => {
    const root = document.createElement('div');
    render(root, '<span>hello</span><span>world</span>');
    document.body.appendChild(root);

    setDOMSelection(root, 7);
    expect(getDOMSelectionOffset(root)).toBe(7);

    document.body.removeChild(root);
  });

  it('round-trips a range across text units', () => {
    const root = document.createElement('div');
    render(root, '<span>hello</span><span>world</span>');
    document.body.appendChild(root);

    setDOMSelection(root, 1, 9);
    const selection = window.getSelection();
    expect(selection?.anchorOffset).toBe(1);
    expect(selection?.focusOffset).toBe(4);

    document.body.removeChild(root);
  });

  it('places the caret around atomic elements', () => {
    const root = document.createElement('div');
    render(root, '<span>ab</span><span contenteditable="false">pill</span><span>cd</span>');
    document.body.appendChild(root);

    setDOMSelection(root, 3); // after the pill
    expect(getDOMSelectionOffset(root)).toBe(3);

    setDOMSelection(root, 2); // before the pill
    expect(getDOMSelectionOffset(root)).toBe(2);

    document.body.removeChild(root);
  });

  it('returns null when the selection is outside the editor', () => {
    const root = document.createElement('div');
    const outside = document.createElement('div');
    outside.textContent = 'outside';
    document.body.appendChild(root);
    document.body.appendChild(outside);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    const range = document.createRange();
    range.setStart(outside.firstChild!, 2);
    range.setEnd(outside.firstChild!, 2);
    selection?.addRange(range);

    expect(getDOMSelectionOffset(root)).toBeNull();

    document.body.removeChild(root);
    document.body.removeChild(outside);
  });
});
