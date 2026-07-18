/**
 * inlineEditorModel tests
 */

import { describe, it, expect } from 'vitest';
import type { ASTDocument as ContentAST } from '@/types/ast';
import type { ASTInlineNode } from '@/types/ast';
import {
  createState,
  insertText,
  deleteBackward,
  deleteForward,
  deleteRange,
  toggleMark,
  insertAtomicNode,
  insertHardBreak,
  splitAtCursor,
  moveCursor,
  setCollapsedOffset,
  astToUnits,
  unitsToAst,
  getInlineChildren,
  unlinkLinkById,
} from './inlineEditorModel';

function makeAst(children: ASTInlineNode[]): ContentAST {
  return [{ type: 'paragraph', children }];
}

describe('astToUnits / unitsToAst round-trip', () => {
  it('round-trips plain text', () => {
    const ast = makeAst([{ type: 'text', text: 'hello world' }]);
    expect(unitsToAst(astToUnits(getInlineChildren(ast)))).toEqual(ast[0].children);
  });

  it('round-trips nested marks', () => {
    const ast = makeAst([
      { type: 'strong', children: [{ type: 'em', children: [{ type: 'text', text: 'bold italic' }] }] },
    ]);
    expect(unitsToAst(astToUnits(getInlineChildren(ast)))).toEqual(ast[0].children);
  });

  it('round-trips code spans', () => {
    const ast = makeAst([
      { type: 'text', text: 'use ' },
      { type: 'code', text: 'const x' },
    ]);
    expect(unitsToAst(astToUnits(getInlineChildren(ast)))).toEqual(ast[0].children);
  });

  it('round-trips atomic nodes', () => {
    const ast = makeAst([
      { type: 'text', text: 'See ' },
      { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
      { type: 'text', text: ' now' },
    ]);
    expect(unitsToAst(astToUnits(getInlineChildren(ast)))).toEqual(ast[0].children);
  });
});

describe('insertText', () => {
  it('inserts text at cursor', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello' }]), { type: 'collapsed', offset: 5 });
    const next = insertText(state, ' world');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 11 });
  });

  it('inserts text in the middle', () => {
    const state = createState(makeAst([{ type: 'text', text: 'heo' }]), { type: 'collapsed', offset: 2 });
    const next = insertText(state, 'll');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 4 });
  });

  it('replaces a range', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello world' }]), { type: 'range', anchor: 2, focus: 7 });
    const next = insertText(state, 'y');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'heyorld' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 3 });
  });
});

describe('deleteBackward / deleteForward', () => {
  it('deletes the previous character', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello' }]), { type: 'collapsed', offset: 4 });
    const next = deleteBackward(state);
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'helo' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 3 });
  });

  it('deletes the next character', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello' }]), { type: 'collapsed', offset: 1 });
    const next = deleteForward(state);
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'hllo' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 1 });
  });

  it('deletes a range on backspace', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello world' }]), { type: 'range', anchor: 2, focus: 7 });
    const next = deleteBackward(state);
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'heorld' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 2 });
  });
});

describe('toggleMark', () => {
  it('toggles bold on selected text', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello world' }]), { type: 'range', anchor: 0, focus: 5 });
    const next = toggleMark(state, 'strong');
    expect(getInlineChildren(next.ast)).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'hello' }] },
      { type: 'text', text: ' world' },
    ]);
  });

  it('removes an existing mark from selected text', () => {
    const state = createState(
      makeAst([{ type: 'strong', children: [{ type: 'text', text: 'hello world' }] }]),
      { type: 'range', anchor: 0, focus: 5 },
    );
    const next = toggleMark(state, 'strong');
    expect(getInlineChildren(next.ast)).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'strong', children: [{ type: 'text', text: ' world' }] },
    ]);
  });
});

describe('insertAtomicNode', () => {
  it('inserts a pill at cursor', () => {
    const state = createState(makeAst([{ type: 'text', text: 'See ' }]), { type: 'collapsed', offset: 4 });
    const next = insertAtomicNode(state, { type: 'node_link', link_id: 'node:abc', ref_type: 'node' });
    expect(getInlineChildren(next.ast)).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
    ]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 5 });
  });

  it('inserts a hard break', () => {
    const state = createState(makeAst([{ type: 'text', text: 'line' }]), { type: 'collapsed', offset: 4 });
    const next = insertHardBreak(state);
    expect(getInlineChildren(next.ast)).toEqual([
      { type: 'text', text: 'line' },
      { type: 'hard_break' },
    ]);
  });
});

describe('splitAtCursor', () => {
  it('splits text at cursor', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello world' }]), { type: 'collapsed', offset: 5 });
    const { before, after } = splitAtCursor(state);
    expect(getInlineChildren(before)).toEqual([{ type: 'text', text: 'hello' }]);
    expect(getInlineChildren(after)).toEqual([{ type: 'text', text: ' world' }]);
  });
});

describe('moveCursor', () => {
  it('moves the cursor', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello' }]), { type: 'collapsed', offset: 2 });
    const next = moveCursor(state, 2);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 4 });
  });
});

describe('deleteRange', () => {
  it('removes a mid-string range', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hello world' }]), { type: 'collapsed', offset: 0 });
    const next = deleteRange(state, 2, 7);
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'heorld' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 2 });
  });

  it('removes an atomic node in a range', () => {
    const state = createState(
      makeAst([
        { type: 'text', text: 'A' },
        { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
        { type: 'text', text: 'B' },
      ]),
      { type: 'collapsed', offset: 0 },
    );
    const next = deleteRange(state, 0, 3);
    expect(getInlineChildren(next.ast)).toEqual([]);
  });
});

describe('setCollapsedOffset', () => {
  it('clamps the cursor inside the content', () => {
    const state = createState(makeAst([{ type: 'text', text: 'hi' }]), { type: 'collapsed', offset: 0 });
    expect(setCollapsedOffset(state, 100).selection).toEqual({ type: 'collapsed', offset: 2 });
    expect(setCollapsedOffset(state, -5).selection).toEqual({ type: 'collapsed', offset: 0 });
  });
});

describe('insertAtomicNode', () => {
  it('splits a text unit when inserting in the middle', () => {
    const state = createState(makeAst([{ type: 'text', text: 'abc' }]), { type: 'collapsed', offset: 1 });
    const next = insertAtomicNode(state, { type: 'hard_break' });
    expect(getInlineChildren(next.ast)).toEqual([
      { type: 'text', text: 'a' },
      { type: 'hard_break' },
      { type: 'text', text: 'bc' },
    ]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 2 });
  });
});

describe('unlinkLinkById', () => {
  it('replaces a mid-text node link with plain text and merges neighbors', () => {
    const state = createState(
      makeAst([
        { type: 'text', text: 'See ' },
        { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
        { type: 'text', text: ' now' },
      ]),
      { type: 'collapsed', offset: 0 },
    );
    const next = unlinkLinkById(state, 'node:abc', 'My Page');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'See My Page now' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 11 });
  });

  it('unlinks a pill at the start of the stream', () => {
    const state = createState(
      makeAst([
        { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
        { type: 'text', text: ' rest' },
      ]),
      { type: 'collapsed', offset: 0 },
    );
    const next = unlinkLinkById(state, 'node:abc', 'Label');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'Label rest' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 5 });
  });

  it('unlinks an external URL pill', () => {
    const state = createState(
      makeAst([
        { type: 'text', text: 'go ' },
        { type: 'external_link', url: 'https://x.dev', children: [{ type: 'text', text: 'x' }] },
      ]),
      { type: 'collapsed', offset: 0 },
    );
    const next = unlinkLinkById(state, 'https://x.dev', 'x');
    expect(getInlineChildren(next.ast)).toEqual([{ type: 'text', text: 'go x' }]);
    expect(next.selection).toEqual({ type: 'collapsed', offset: 4 });
  });

  it('is a no-op for an unknown link id', () => {
    const state = createState(
      makeAst([
        { type: 'text', text: 'See ' },
        { type: 'node_link', link_id: 'node:abc', ref_type: 'node' },
      ]),
      { type: 'collapsed', offset: 0 },
    );
    expect(unlinkLinkById(state, 'node:missing', 'X')).toBe(state);
  });
});
