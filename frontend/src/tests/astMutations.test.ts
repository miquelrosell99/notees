/**
 * Tests for pure AST mutation functions.
 *
 * Covers: splitAtPosition, mergeDocuments, insertNodeLink, replaceTriggerWithLink,
 * removeTriggerText, deleteRange, insertText, toggleMark, toggleCode,
 * replaceNodeLink, flattenToInlines, documentLength, inlineNodeLength.
 */
import { describe, it, expect } from 'vitest';
import {
  splitAtPosition,
  mergeDocuments,
  insertNodeLink,
  replaceTriggerWithLink,
  removeTriggerText,
  deleteRange,
  insertText,
  toggleMark,
  toggleCode,
  replaceNodeLink,
  flattenToInlines,
  documentLength,
  inlineNodeLength,
} from '@/lib/astMutations';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';

// ─── Helpers ───────────────────────────────────────────────────────

function p(...children: ASTInlineNode[]): ASTDocument {
  return [{ type: 'paragraph', children }];
}

function text(t: string): ASTInlineNode {
  return { type: 'text', text: t };
}

function link(id: string, refType: 'node' | 'class' = 'node'): ASTInlineNode {
  return { type: 'node_link', link_id: id, ref_type: refType };
}

function strong(...children: ASTInlineNode[]): ASTInlineNode {
  return { type: 'strong', children };
}

function em(...children: ASTInlineNode[]): ASTInlineNode {
  return { type: 'em', children };
}

function codeNode(t: string): ASTInlineNode {
  return { type: 'code', text: t };
}

function hardBreak(): ASTInlineNode {
  return { type: 'hard_break' };
}

const empty: ASTDocument = [];

// ─── inlineNodeLength ──────────────────────────────────────────────

describe('inlineNodeLength', () => {
  it('returns character count for text', () => {
    expect(inlineNodeLength(text('hello'))).toBe(5);
  });

  it('returns character count for code', () => {
    expect(inlineNodeLength(codeNode('abc'))).toBe(3);
  });

  it('returns 1 for node_link', () => {
    expect(inlineNodeLength(link('1:abc'))).toBe(1);
  });

  it('returns 0 for hard_break', () => {
    expect(inlineNodeLength(hardBreak())).toBe(0);
  });

  it('returns sum of children for strong', () => {
    expect(inlineNodeLength(strong(text('ab'), text('cd')))).toBe(4);
  });

  it('returns sum of children for em', () => {
    expect(inlineNodeLength(em(text('xyz')))).toBe(3);
  });

  it('handles nested marks', () => {
    expect(inlineNodeLength(strong(em(text('ab'))))).toBe(2);
  });
});

// ─── documentLength ────────────────────────────────────────────────

describe('documentLength', () => {
  it('returns 0 for empty document', () => {
    expect(documentLength(empty)).toBe(0);
  });

  it('counts simple text', () => {
    expect(documentLength(p(text('hello')))).toBe(5);
  });

  it('counts pills as 1', () => {
    expect(documentLength(p(text('ab'), link('x'), text('cd')))).toBe(5);
  });

  it('handles multiple paragraphs (hard breaks add 0)', () => {
    // flattenToInlines inserts hard_break between paragraphs, but hard_break length = 0
    const doc: ASTDocument = [
      { type: 'paragraph', children: [text('ab')] },
      { type: 'paragraph', children: [text('cd')] },
    ];
    expect(documentLength(doc)).toBe(4); // 2 + 0 + 2
  });
});

// ─── flattenToInlines ──────────────────────────────────────────────

describe('flattenToInlines', () => {
  it('returns empty for empty doc', () => {
    expect(flattenToInlines(empty)).toEqual([]);
  });

  it('returns children of single paragraph', () => {
    const children = [text('hello')];
    expect(flattenToInlines(p(...children))).toEqual(children);
  });

  it('inserts hard_break between multi-paragraph', () => {
    const doc: ASTDocument = [
      { type: 'paragraph', children: [text('a')] },
      { type: 'paragraph', children: [text('b')] },
    ];
    const result = flattenToInlines(doc);
    expect(result).toEqual([text('a'), hardBreak(), text('b')]);
  });
});

// ─── splitAtPosition ───────────────────────────────────────────────

describe('splitAtPosition', () => {
  it('splits at 0 → empty before, all after', () => {
    const [before, after] = splitAtPosition(p(text('hello')), 0);
    expect(before).toEqual([]);
    expect(after).toEqual(p(text('hello')));
  });

  it('splits at end → all before, empty after', () => {
    const [before, after] = splitAtPosition(p(text('hello')), 5);
    expect(before).toEqual(p(text('hello')));
    expect(after).toEqual([]);
  });

  it('splits text in the middle', () => {
    const [before, after] = splitAtPosition(p(text('hello')), 3);
    expect(before).toEqual(p(text('hel')));
    expect(after).toEqual(p(text('lo')));
  });

  it('splits around a pill', () => {
    const [before, after] = splitAtPosition(p(text('ab'), link('x'), text('cd')), 3);
    // offset 3 = 'ab' (2) + link (1) → link goes to before
    expect(before).toEqual(p(text('ab'), link('x')));
    expect(after).toEqual(p(text('cd')));
  });

  it('splits before a pill', () => {
    const [before, after] = splitAtPosition(p(text('ab'), link('x'), text('cd')), 2);
    expect(before).toEqual(p(text('ab')));
    expect(after).toEqual(p(link('x'), text('cd')));
  });

  it('splits empty document', () => {
    const [before, after] = splitAtPosition(empty, 0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  });

  it('handles split within strong', () => {
    const [before, after] = splitAtPosition(p(strong(text('abcd'))), 2);
    expect(before).toEqual(p(strong(text('ab'))));
    expect(after).toEqual(p(strong(text('cd'))));
  });
});

// ─── mergeDocuments ────────────────────────────────────────────────

describe('mergeDocuments', () => {
  it('merges two documents into one paragraph', () => {
    const result = mergeDocuments(p(text('ab')), p(text('cd')));
    expect(result).toEqual(p(text('ab'), text('cd')));
  });

  it('merges with empty first', () => {
    const result = mergeDocuments(empty, p(text('cd')));
    expect(result).toEqual(p(text('cd')));
  });

  it('merges with empty second', () => {
    const result = mergeDocuments(p(text('ab')), empty);
    expect(result).toEqual(p(text('ab')));
  });

  it('merges two empty documents', () => {
    expect(mergeDocuments(empty, empty)).toEqual([]);
  });

  it('merges documents with pills', () => {
    const result = mergeDocuments(p(text('a'), link('x')), p(link('y'), text('b')));
    expect(result).toEqual(p(text('a'), link('x'), link('y'), text('b')));
  });
});

// ─── insertNodeLink ────────────────────────────────────────────────

describe('insertNodeLink', () => {
  it('inserts at position 0', () => {
    const { ast, cursorOffset } = insertNodeLink(p(text('hello')), 0, '1:abc', 'node');
    expect(cursorOffset).toBe(2); // link + space
    expect(ast).toEqual(p(link('1:abc'), text(' '), text('hello')));
  });

  it('inserts at end', () => {
    const { ast, cursorOffset } = insertNodeLink(p(text('hello')), 5, '1:abc', 'node');
    expect(cursorOffset).toBe(7);
    expect(ast).toEqual(p(text('hello'), link('1:abc'), text(' ')));
  });

  it('inserts in middle of text', () => {
    const { ast, cursorOffset } = insertNodeLink(p(text('abcd')), 2, '1:abc', 'node');
    expect(cursorOffset).toBe(4);
    expect(ast).toEqual(p(text('ab'), link('1:abc'), text(' '), text('cd')));
  });

  it('inserts into empty document', () => {
    const { ast, cursorOffset } = insertNodeLink(empty, 0, '1:abc', 'node');
    expect(cursorOffset).toBe(2);
    expect(ast).toEqual(p(link('1:abc'), text(' ')));
  });

  it('uses class ref_type', () => {
    const { ast } = insertNodeLink(p(text('x')), 1, '2:def', 'class');
    const inlines = flattenToInlines(ast);
    const nodeLink = inlines.find(n => n.type === 'node_link');
    expect(nodeLink).toEqual({ type: 'node_link', link_id: '2:def', ref_type: 'class' });
  });
});

// ─── replaceTriggerWithLink ────────────────────────────────────────

describe('replaceTriggerWithLink', () => {
  it('replaces [[ trigger with a link', () => {
    // Content: "hello [[world" → position 6 is start of [[, cursor at 13
    const doc = p(text('hello [[world'));
    const { ast, cursorOffset } = replaceTriggerWithLink(doc, 6, 13, '42:abc', 'node');
    // Should remove "[[world" (7 chars) and insert link + space (2 logical)
    expect(cursorOffset).toBe(8); // 6 + 2
    const inlines = flattenToInlines(ast);
    expect(inlines).toEqual([
      text('hello '),
      link('42:abc'),
      text(' '),
    ]);
  });

  it('replaces @ trigger with a class link', () => {
    const doc = p(text('before @type'));
    const { ast } = replaceTriggerWithLink(doc, 7, 12, 'cls:1', 'class');
    const inlines = flattenToInlines(ast);
    expect(inlines).toEqual([
      text('before '),
      { type: 'node_link', link_id: 'cls:1', ref_type: 'class' },
      text(' '),
    ]);
  });
});

// ─── removeTriggerText ─────────────────────────────────────────────

describe('removeTriggerText', () => {
  it('removes text range', () => {
    const doc = p(text('hello /query'));
    const result = removeTriggerText(doc, 6, 12);
    expect(result).toEqual(p(text('hello ')));
  });

  it('removes from start', () => {
    const doc = p(text('[[test'));
    const result = removeTriggerText(doc, 0, 6);
    expect(result).toEqual([]);
  });
});

// ─── deleteRange ───────────────────────────────────────────────────

describe('deleteRange', () => {
  it('deletes from middle of text', () => {
    const result = deleteRange(p(text('abcdef')), 2, 4);
    expect(result).toEqual(p(text('ab'), text('ef')));
  });

  it('deletes entire content', () => {
    const result = deleteRange(p(text('abc')), 0, 3);
    expect(result).toEqual([]);
  });

  it('does nothing when start >= end', () => {
    const doc = p(text('abc'));
    expect(deleteRange(doc, 2, 2)).toBe(doc);
    expect(deleteRange(doc, 3, 1)).toBe(doc);
  });

  it('deletes a pill', () => {
    const result = deleteRange(p(text('a'), link('x'), text('b')), 1, 2);
    expect(result).toEqual(p(text('a'), text('b')));
  });

  it('deletes across text and pill', () => {
    const result = deleteRange(p(text('ab'), link('x'), text('cd')), 1, 4);
    expect(result).toEqual(p(text('a'), text('d')));
  });
});

// ─── insertText ────────────────────────────────────────────────────

describe('insertText', () => {
  it('inserts at beginning', () => {
    const { ast, cursorOffset } = insertText(p(text('world')), 0, 'hello ');
    expect(cursorOffset).toBe(6);
    expect(ast).toEqual(p(text('hello '), text('world')));
  });

  it('inserts at end', () => {
    const { ast, cursorOffset } = insertText(p(text('hello')), 5, ' world');
    expect(cursorOffset).toBe(11);
    expect(ast).toEqual(p(text('hello'), text(' world')));
  });

  it('inserts in middle', () => {
    const { ast, cursorOffset } = insertText(p(text('ad')), 1, 'bc');
    expect(cursorOffset).toBe(3);
    expect(ast).toEqual(p(text('a'), text('bc'), text('d')));
  });

  it('inserts into empty doc', () => {
    const { ast, cursorOffset } = insertText(empty, 0, 'hello');
    expect(cursorOffset).toBe(5);
    expect(ast).toEqual(p(text('hello')));
  });
});

// ─── toggleMark ────────────────────────────────────────────────────

describe('toggleMark', () => {
  it('wraps plain text in strong', () => {
    const { ast } = toggleMark(p(text('hello')), 0, 5, 'strong');
    expect(ast).toEqual(p(strong(text('hello'))));
  });

  it('unwraps a strong node', () => {
    const { ast } = toggleMark(p(strong(text('hello'))), 0, 5, 'strong');
    expect(ast).toEqual(p(text('hello')));
  });

  it('wraps in em', () => {
    const { ast } = toggleMark(p(text('hello')), 0, 5, 'em');
    expect(ast).toEqual(p(em(text('hello'))));
  });

  it('returns same ast when start >= end', () => {
    const doc = p(text('hello'));
    const { ast } = toggleMark(doc, 3, 3, 'strong');
    expect(ast).toBe(doc);
  });

  it('wraps partial text', () => {
    const { ast } = toggleMark(p(text('hello world')), 0, 5, 'strong');
    expect(ast).toEqual(p(strong(text('hello')), text(' world')));
  });

  it('handles selection across pill boundary', () => {
    // "ab<pill>cd" → select positions 0-4 wraps all
    const doc = p(text('ab'), link('x'), text('cd'));
    const { ast } = toggleMark(doc, 0, 5, 'strong');
    expect(ast).toEqual(p(strong(text('ab'), link('x'), text('cd'))));
  });
});

// ─── toggleCode ────────────────────────────────────────────────────

describe('toggleCode', () => {
  it('wraps text in code', () => {
    const { ast } = toggleCode(p(text('hello')), 0, 5);
    expect(ast).toEqual(p(codeNode('hello')));
  });

  it('unwraps code to text', () => {
    const { ast } = toggleCode(p(codeNode('hello')), 0, 5);
    expect(ast).toEqual(p(text('hello')));
  });

  it('returns same ast when start >= end', () => {
    const doc = p(text('hello'));
    const { ast } = toggleCode(doc, 3, 3);
    expect(ast).toBe(doc);
  });

  it('collapses formatted text to plain code', () => {
    const { ast } = toggleCode(p(strong(text('bold'))), 0, 4);
    expect(ast).toEqual(p(codeNode('bold')));
  });
});

// ─── replaceNodeLink ───────────────────────────────────────────────

describe('replaceNodeLink', () => {
  it('replaces a link by its link_id', () => {
    const doc = p(text('before '), link('old-id'), text(' after'));
    const result = replaceNodeLink(doc, 'old-id', 'new-id', 'node');
    expect(result).toEqual(p(
      text('before '),
      { type: 'node_link', link_id: 'new-id', ref_type: 'node' },
      text(' after'),
    ));
  });

  it('replaces ref_type too', () => {
    const doc = p(link('abc'));
    const result = replaceNodeLink(doc, 'abc', 'def', 'class');
    expect(flattenToInlines(result)).toEqual([
      { type: 'node_link', link_id: 'def', ref_type: 'class' },
    ]);
  });

  it('returns same reference when link not found', () => {
    const doc = p(text('hello'), link('x'));
    const result = replaceNodeLink(doc, 'nonexistent', 'y');
    expect(result).toBe(doc);
  });

  it('replaces link inside a mark node', () => {
    const doc = p(strong(text('a'), link('old'), text('b')));
    const result = replaceNodeLink(doc, 'old', 'new', 'node');
    const inlines = flattenToInlines(result);
    expect(inlines).toEqual([
      strong(text('a'), { type: 'node_link', link_id: 'new', ref_type: 'node' } as ASTInlineNode, text('b')),
    ]);
  });

  it('handles empty document', () => {
    const result = replaceNodeLink(empty, 'x', 'y');
    expect(result).toBe(empty);
  });
});
