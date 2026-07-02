/**
 * cursorOffsetFromPoint tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLogicalOffsetFromPoint } from './cursorOffsetFromPoint';

function createCaretPosition(offsetNode: Node, offset: number): CaretPosition {
  return {
    offsetNode,
    offset,
    getClientRect: () => null,
  };
}

function setCaretPosition(offsetNode: Node, offset: number): void {
  Object.defineProperty(document, 'caretPositionFromPoint', {
    value: vi.fn(() => createCaretPosition(offsetNode, offset)),
    configurable: true,
  });
}

function clearCaretPosition(): void {
  Object.defineProperty(document, 'caretPositionFromPoint', {
    value: undefined,
    configurable: true,
  });
}

describe('getLogicalOffsetFromPoint', () => {
  beforeEach(() => {
    clearCaretPosition();
  });

  afterEach(() => {
    clearCaretPosition();
  });

  it('returns null when caret is outside the root', () => {
    const root = document.createElement('div');
    root.textContent = 'hello';
    const other = document.createElement('div');
    other.textContent = 'world';
    document.body.append(other);
    setCaretPosition(other.firstChild!, 2);

    expect(getLogicalOffsetFromPoint(root, 0, 0)).toBeNull();

    other.remove();
  });

  it('maps a click in plain text to the character offset', () => {
    const root = document.createElement('div');
    root.textContent = 'Hello world';
    setCaretPosition(root.firstChild!, 6);

    expect(getLogicalOffsetFromPoint(root, 0, 0)).toBe(6);
  });

  it('returns 0 for an empty root', () => {
    const root = document.createElement('div');
    setCaretPosition(root, 0);

    expect(getLogicalOffsetFromPoint(root, 0, 0)).toBe(0);
  });

  it('counts an atomic link wrapper as a single offset', () => {
    const root = document.createElement('div');
    root.append(document.createTextNode('See '));
    const link = document.createElement('button');
    link.className = 'inline-link-wrapper';
    link.textContent = 'node…';
    link.getBoundingClientRect = vi.fn(() => ({ left: 100, width: 40 } as DOMRect));
    root.append(link);

    // Click the left half of the pill -> cursor before the atomic node.
    setCaretPosition(link, 0);
    expect(getLogicalOffsetFromPoint(root, 105, 0)).toBe(4);
  });

  it('places the cursor after an atomic node when clicking its right half', () => {
    const root = document.createElement('div');
    root.append(document.createTextNode('See '));
    const link = document.createElement('button');
    link.className = 'inline-link-wrapper';
    link.textContent = 'node…';
    // Simulate a click on the right half of the pill.
    link.getBoundingClientRect = vi.fn(() => ({ left: 100, width: 40 } as DOMRect));
    root.append(link);

    setCaretPosition(link.firstChild!, 2);
    expect(getLogicalOffsetFromPoint(root, 130, 0)).toBe(5);
  });

  it('places the cursor before an atomic node when clicking its left half', () => {
    const root = document.createElement('div');
    const link = document.createElement('button');
    link.className = 'inline-link-wrapper';
    link.textContent = 'node…';
    link.getBoundingClientRect = vi.fn(() => ({ left: 100, width: 40 } as DOMRect));
    root.append(link);
    root.append(document.createTextNode(' text'));

    setCaretPosition(link.firstChild!, 1);
    expect(getLogicalOffsetFromPoint(root, 105, 0)).toBe(0);
  });

  it('treats a hard break as a single offset', () => {
    const root = document.createElement('div');
    root.append(document.createTextNode('line one'));
    root.append(document.createElement('br'));
    root.append(document.createTextNode('line two'));

    setCaretPosition(root.childNodes[2], 4);
    expect(getLogicalOffsetFromPoint(root, 0, 0)).toBe(13);
  });
});
