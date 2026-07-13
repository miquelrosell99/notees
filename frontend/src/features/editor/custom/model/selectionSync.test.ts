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

  it('round-trips collapsed offsets between adjacent atomic elements', () => {
    const root = document.createElement('div');
    render(root, '<span contenteditable="false">pill1</span><span contenteditable="false">pill2</span>');
    document.body.appendChild(root);

    setDOMSelection(root, 1); // between the two pills
    expect(getDOMSelectionOffset(root)).toBe(1);

    document.body.removeChild(root);
  });

  it('round-trips collapsed offsets when the root contains only an atomic element', () => {
    const root = document.createElement('div');
    render(root, '<span contenteditable="false">pill</span>');
    document.body.appendChild(root);

    setDOMSelection(root, 0); // before the pill
    expect(getDOMSelectionOffset(root)).toBe(0);

    setDOMSelection(root, 1); // after the pill
    expect(getDOMSelectionOffset(root)).toBe(1);

    document.body.removeChild(root);
  });

  it('ignores the trailing caret anchor in logical offsets', () => {
    const root = document.createElement('div');
    render(
      root,
      '<span contenteditable="false">pill</span><span data-caret-anchor="true">\u200B</span>',
    );
    document.body.appendChild(root);

    setDOMSelection(root, 0); // before the pill
    expect(getDOMSelectionOffset(root)).toBe(0);

    setDOMSelection(root, 1); // after the pill (inside the anchor logically)
    expect(getDOMSelectionOffset(root)).toBe(1);

    document.body.removeChild(root);
  });

  // Link pills render as <span class="node-link-context-menu-trigger"><span
  // contenteditable="false">…label…</span></span>: the atomic element is nested
  // inside a plain wrapper. Offset mapping must still treat the wrapper as one
  // atomic unit, or the caret lands on the pill's label text (visually in the
  // middle of the link).
  const WRAPPED_PILL =
    '<span class="node-link-context-menu-trigger">' +
    '<span contenteditable="false">label</span>' +
    '</span>';

  it('places the caret after a wrapped atomic pill, not inside its label', () => {
    const root = document.createElement('div');
    render(
      root,
      `<span>ab</span>${WRAPPED_PILL}<span data-caret-anchor="true">\u200B</span>`,
    );
    document.body.appendChild(root);

    setDOMSelection(root, 3); // after the pill
    expect(getDOMSelectionOffset(root)).toBe(3);
    const anchor = window.getSelection()?.anchorNode;
    // The caret must sit in the trailing caret anchor, never on the pill label.
    expect(anchor?.textContent).toBe('\u200B');
    expect((anchor?.parentElement as HTMLElement | null)?.dataset.caretAnchor).toBe('true');

    document.body.removeChild(root);
  });

  it('places the caret before a wrapped atomic pill at the end of the preceding text', () => {
    const root = document.createElement('div');
    render(
      root,
      `<span>ab</span>${WRAPPED_PILL}<span data-caret-anchor="true">\u200B</span>`,
    );
    document.body.appendChild(root);

    setDOMSelection(root, 2); // before the pill
    expect(getDOMSelectionOffset(root)).toBe(2);
    const selection = window.getSelection();
    expect(selection?.anchorNode?.textContent).toBe('ab');
    expect(selection?.anchorOffset).toBe(2);

    document.body.removeChild(root);
  });

  it('round-trips caret offsets around a wrapped pill mid-content', () => {
    const root = document.createElement('div');
    render(root, `<span>ab</span>${WRAPPED_PILL}<span>cd</span>`);
    document.body.appendChild(root);

    setDOMSelection(root, 3); // after the pill, before "cd"
    expect(getDOMSelectionOffset(root)).toBe(3);
    const selection = window.getSelection();
    expect(selection?.anchorNode?.textContent).toBe('cd');
    expect(selection?.anchorOffset).toBe(0);

    document.body.removeChild(root);
  });

  it('maps a DOM selection inside the pill label to the offset after the pill', () => {
    const root = document.createElement('div');
    render(root, `<span>ab</span>${WRAPPED_PILL}<span>cd</span>`);
    document.body.appendChild(root);

    const labelText = root.querySelector('[contenteditable="false"]')!.firstChild!;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(labelText, 2);
    range.collapse(true);
    selection.addRange(range);

    expect(getDOMSelectionOffset(root)).toBe(3);

    document.body.removeChild(root);
  });

  const CARET_ANCHOR = '<span data-caret-anchor="true">\u200B</span>';

  it('uses the leading caret anchor for the position before a first-position pill', () => {
    const root = document.createElement('div');
    render(root, `${CARET_ANCHOR}${WRAPPED_PILL}${CARET_ANCHOR}`);
    document.body.appendChild(root);

    setDOMSelection(root, 0); // before the pill
    expect(getDOMSelectionOffset(root)).toBe(0);
    let anchorParent = window.getSelection()?.anchorNode?.parentElement as HTMLElement | null;
    // The caret must live in a caret anchor — never at a root boundary next to
    // the pill (renders over the pill icon; native Home/End do nothing there).
    expect(anchorParent?.dataset.caretAnchor).toBe('true');

    setDOMSelection(root, 1); // after the pill
    expect(getDOMSelectionOffset(root)).toBe(1);
    anchorParent = window.getSelection()?.anchorNode?.parentElement as HTMLElement | null;
    expect(anchorParent?.dataset.caretAnchor).toBe('true');

    document.body.removeChild(root);
  });

  it('does not let caret anchors consume logical offset', () => {
    const root = document.createElement('div');
    render(root, `${CARET_ANCHOR}${WRAPPED_PILL}<span>abc</span>`);
    document.body.appendChild(root);

    setDOMSelection(root, 2); // one char into "abc" after the pill
    expect(getDOMSelectionOffset(root)).toBe(2);
    const selection = window.getSelection();
    expect(selection?.anchorNode?.textContent).toBe('abc');
    expect(selection?.anchorOffset).toBe(1);

    setDOMSelection(root, 1); // right after the pill, before "abc"
    expect(getDOMSelectionOffset(root)).toBe(1);
    expect(selection?.anchorNode?.textContent).toBe('abc');
    expect(selection?.anchorOffset).toBe(0);

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
