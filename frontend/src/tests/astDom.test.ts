/**
 * Tests for AST ↔ DOM mapping engine.
 *
 * Covers: astToHtml, domToAST, normalizeAST, getPlainText, getContentLength.
 *
 * Note: cursor position tests (getCursorPosition/setCursorPosition) are limited
 * because jsdom doesn't fully support Selection/Range APIs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  astToHtml,
  astToHtmlCached,
  domToAST,
  normalizeAST,
  getPlainText,
  getContentLength,
  isTextOnlyChange,
  detectTrigger,
  type ASTRenderContext,
  type ResolvedLink,
} from '@/lib/astDom';
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

function strikethrough(...children: ASTInlineNode[]): ASTInlineNode {
  return { type: 'strikethrough', children };
}

function highlight(...children: ASTInlineNode[]): ASTInlineNode {
  return { type: 'highlight', children };
}

function externalLink(url: string, ...children: ASTInlineNode[]): ASTInlineNode {
  return { type: 'external_link', url, children };
}

function hardBreak(): ASTInlineNode {
  return { type: 'hard_break' };
}

const empty: ASTDocument = [];

/** Test render context that resolves any link_id to its id as display text */
const testCtx: ASTRenderContext = {
  resolveLink: (linkId: string, refType: 'node' | 'class'): ResolvedLink => ({
    displayText: `[${linkId}]`,
    targetName: `[${linkId}]`,
    isTag: false,
    effectiveIcon: null,
    customLabel: null,
  }),
};

/** Context that marks links as tags */
const tagCtx: ASTRenderContext = {
  resolveLink: (linkId: string): ResolvedLink => ({
    displayText: `#${linkId}`,
    targetName: `#${linkId}`,
    isTag: true,
    effectiveIcon: null,
    customLabel: null,
  }),
};

/** Context that returns null for unresolvable links */
const nullCtx: ASTRenderContext = {
  resolveLink: () => null,
};

/** Create an element with innerHTML and return it */
function createElement(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

// ─── astToHtml ─────────────────────────────────────────────────────

describe('astToHtml', () => {
  it('returns empty string for empty document', () => {
    expect(astToHtml(empty, testCtx)).toBe('');
  });

  it('renders plain text', () => {
    const html = astToHtml(p(text('hello world')), testCtx);
    expect(html).toBe('hello world');
  });

  it('escapes HTML entities in text', () => {
    const html = astToHtml(p(text('<script>&')), testCtx);
    expect(html).toBe('&lt;script&gt;&amp;');
  });

  it('renders strong tag', () => {
    const html = astToHtml(p(strong(text('bold'))), testCtx);
    expect(html).toBe('<strong data-ast="strong">bold</strong>');
  });

  it('renders em tag', () => {
    const html = astToHtml(p(em(text('italic'))), testCtx);
    expect(html).toBe('<em data-ast="em">italic</em>');
  });

  it('renders code tag', () => {
    const html = astToHtml(p(codeNode('code text')), testCtx);
    expect(html).toBe('<code data-ast="code">code text</code>');
  });

  it('renders strikethrough', () => {
    const html = astToHtml(p(strikethrough(text('deleted'))), testCtx);
    expect(html).toBe('<s data-ast="strikethrough">deleted</s>');
  });

  it('renders highlight', () => {
    const html = astToHtml(p(highlight(text('marked'))), testCtx);
    expect(html).toBe('<mark data-ast="highlight">marked</mark>');
  });

  it('renders external link', () => {
    const html = astToHtml(p(externalLink('https://example.com', text('link text'))), testCtx);
    expect(html).toContain('data-ast="external_link"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('link text');
    expect(html).toContain('target="_blank"');
  });

  it('renders hard_break as <br>', () => {
    const html = astToHtml(p(text('a'), hardBreak(), text('b')), testCtx);
    expect(html).toBe('a<br>b');
  });

  it('renders node link as inline-link anchor', () => {
    const html = astToHtml(p(link('42:abc')), testCtx);
    expect(html).toContain('class="inline-link"');
    expect(html).toContain('contenteditable="false"');
    expect(html).toContain('data-link-id="42:abc"');
    expect(html).toContain('data-ref-type="node"');
    expect(html).toContain('[42:abc]');
  });

  it('renders class link as class-pill', () => {
    const html = astToHtml(p(link('cls:1', 'class')), testCtx);
    expect(html).toContain('class="class-pill"');
    expect(html).toContain('data-ref-type="class"');
  });

  it('renders tag link as tag-pill', () => {
    const html = astToHtml(p(link('tag:1')), tagCtx);
    expect(html).toContain('class="tag-pill"');
    expect(html).toContain('data-is-tag="true"');
  });

  it('shows fallback "…" for unresolvable links', () => {
    const html = astToHtml(p(link('unknown')), nullCtx);
    expect(html).toContain('…');
  });

  it('adds ZWS between adjacent pills', () => {
    const html = astToHtml(p(link('a'), link('b')), testCtx);
    expect(html).toContain('\u200B');
  });

  it('renders nested formatting', () => {
    const html = astToHtml(p(strong(em(text('bold italic')))), testCtx);
    expect(html).toBe('<strong data-ast="strong"><em data-ast="em">bold italic</em></strong>');
  });

  it('separates multi-paragraph with <br>', () => {
    const doc: ASTDocument = [
      { type: 'paragraph', children: [text('first')] },
      { type: 'paragraph', children: [text('second')] },
    ];
    const html = astToHtml(doc, testCtx);
    expect(html).toBe('first<br>second');
  });

  it('renders mixed inline content', () => {
    const html = astToHtml(p(text('Hello '), strong(text('world')), text('!')), testCtx);
    expect(html).toBe('Hello <strong data-ast="strong">world</strong>!');
  });
});

// ─── domToAST ──────────────────────────────────────────────────────

describe('domToAST', () => {
  it('extracts empty element', () => {
    const el = createElement('');
    expect(domToAST(el)).toEqual([]);
  });

  it('extracts plain text', () => {
    const el = createElement('hello world');
    expect(domToAST(el)).toEqual(p(text('hello world')));
  });

  it('strips ZWS from text', () => {
    const el = createElement('hello\u200Bworld');
    expect(domToAST(el)).toEqual(p(text('helloworld')));
  });

  it('extracts strong element', () => {
    const el = createElement('<strong data-ast="strong">bold</strong>');
    expect(domToAST(el)).toEqual(p(strong(text('bold'))));
  });

  it('extracts strong by tag name (without data-ast)', () => {
    const el = createElement('<strong>bold</strong>');
    expect(domToAST(el)).toEqual(p(strong(text('bold'))));
  });

  it('extracts B tag as strong', () => {
    const el = createElement('<b>bold</b>');
    expect(domToAST(el)).toEqual(p(strong(text('bold'))));
  });

  it('extracts em element', () => {
    const el = createElement('<em data-ast="em">italic</em>');
    expect(domToAST(el)).toEqual(p(em(text('italic'))));
  });

  it('extracts I tag as em', () => {
    const el = createElement('<i>italic</i>');
    expect(domToAST(el)).toEqual(p(em(text('italic'))));
  });

  it('extracts code element', () => {
    const el = createElement('<code data-ast="code">x = 1</code>');
    expect(domToAST(el)).toEqual(p(codeNode('x = 1')));
  });

  it('extracts S tag as strikethrough', () => {
    const el = createElement('<s>deleted</s>');
    expect(domToAST(el)).toEqual(p(strikethrough(text('deleted'))));
  });

  it('extracts DEL tag as strikethrough', () => {
    const el = createElement('<del>removed</del>');
    expect(domToAST(el)).toEqual(p(strikethrough(text('removed'))));
  });

  it('extracts MARK tag as highlight', () => {
    const el = createElement('<mark>highlighted</mark>');
    expect(domToAST(el)).toEqual(p(highlight(text('highlighted'))));
  });

  it('extracts node_link pill by data-ast', () => {
    const el = createElement('<a class="inline-link" contenteditable="false" data-ast="node_link" data-link-id="42:abc" data-ref-type="node">Node</a>');
    expect(domToAST(el)).toEqual(p(link('42:abc')));
  });

  it('extracts node_link pill by class (without data-ast)', () => {
    const el = createElement('<a class="inline-link" data-link-id="42:abc" data-ref-type="node">Node</a>');
    expect(domToAST(el)).toEqual(p(link('42:abc')));
  });

  it('extracts class-pill as class ref', () => {
    const el = createElement('<span class="class-pill" data-ast="node_link" data-link-id="cls:1" data-ref-type="class">Type</span>');
    expect(domToAST(el)).toEqual(p(link('cls:1', 'class')));
  });

  it('extracts tag-pill as node ref', () => {
    const el = createElement('<span class="tag-pill" data-ast="node_link" data-link-id="tag:1" data-ref-type="node">Tag</span>');
    expect(domToAST(el)).toEqual(p(link('tag:1')));
  });

  it('extracts BR as hard_break and creates paragraphs', () => {
    const el = createElement('first<br>second');
    expect(domToAST(el)).toEqual([
      { type: 'paragraph', children: [text('first')] },
      { type: 'paragraph', children: [text('second')] },
    ]);
  });

  it('extracts external link', () => {
    const el = createElement('<a data-ast="external_link" data-url="https://example.com" href="https://example.com">Example</a>');
    expect(domToAST(el)).toEqual(p(externalLink('https://example.com', text('Example'))));
  });

  it('extracts external link by href (without data-ast)', () => {
    const el = createElement('<a href="https://example.com">Example</a>');
    expect(domToAST(el)).toEqual(p(externalLink('https://example.com', text('Example'))));
  });

  it('recurses into unknown wrapper elements', () => {
    const el = createElement('<div><span>hello</span></div>');
    expect(domToAST(el)).toEqual(p(text('hello')));
  });

  it('handles nested formatting', () => {
    const el = createElement('<strong><em>bold italic</em></strong>');
    expect(domToAST(el)).toEqual(p(strong(em(text('bold italic')))));
  });

  it('handles mixed content', () => {
    const el = createElement('Hello <strong>bold</strong> and <em>italic</em>');
    expect(domToAST(el)).toEqual(p(
      text('Hello '),
      strong(text('bold')),
      text(' and '),
      em(text('italic')),
    ));
  });
});

// ─── Roundtrip: AST → HTML → DOM → AST ────────────────────────────

describe('AST → DOM → AST roundtrip', () => {
  it('roundtrips plain text', () => {
    const ast = p(text('hello world'));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips strong', () => {
    const ast = p(strong(text('bold')));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips em', () => {
    const ast = p(em(text('italic')));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips code', () => {
    const ast = p(codeNode('x = 1'));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips strikethrough', () => {
    const ast = p(strikethrough(text('deleted')));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips highlight', () => {
    const ast = p(highlight(text('marked')));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips external link', () => {
    const ast = p(externalLink('https://example.com', text('link')));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips node link pill', () => {
    const ast = p(link('42:abc'));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips class pill', () => {
    const ast = p(link('cls:1', 'class'));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips tag pill', () => {
    const ast = p(link('tag:1'));
    const html = astToHtml(ast, tagCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips mixed inline content', () => {
    const ast = p(
      text('Hello '),
      strong(text('bold')),
      text(' and '),
      em(text('italic')),
    );
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    expect(domToAST(el)).toEqual(ast);
  });

  it('roundtrips text + pill + text', () => {
    const ast = p(text('before '), link('42:abc'), text(' after'));
    const html = astToHtml(ast, testCtx);
    const el = createElement(html);
    const result = domToAST(el);
    // The ZWS between pill and next text might cause a split, normalize to compare
    const normalized = normalizeAST(result);
    // Check structure: should have text, link, text
    expect(normalized.length).toBe(1);
    const children = normalized[0].children;
    expect(children.length).toBe(3);
    expect(children[0]).toEqual(text('before '));
    expect(children[1]).toEqual(link('42:abc'));
    expect(children[2]).toEqual(text(' after'));
  });
});

// ─── normalizeAST ──────────────────────────────────────────────────

describe('normalizeAST', () => {
  it('merges adjacent text nodes', () => {
    const ast = p(text('hello'), text(' world'));
    expect(normalizeAST(ast)).toEqual(p(text('hello world')));
  });

  it('leaves non-adjacent text alone', () => {
    const ast = p(text('a'), link('x'), text('b'));
    expect(normalizeAST(ast)).toEqual(ast);
  });

  it('handles single text node', () => {
    const ast = p(text('hello'));
    expect(normalizeAST(ast)).toEqual(ast);
  });

  it('handles empty paragraph', () => {
    const ast: ASTDocument = [{ type: 'paragraph', children: [] }];
    expect(normalizeAST(ast)).toEqual(ast);
  });

  it('normalizes children of mark nodes', () => {
    const ast = p(strong(text('a'), text('b')));
    const result = normalizeAST(ast);
    expect(result).toEqual(p(strong(text('ab'))));
  });

  it('merges three consecutive text nodes', () => {
    const ast = p(text('a'), text('b'), text('c'));
    expect(normalizeAST(ast)).toEqual(p(text('abc')));
  });
});

// ─── DOM helpers ───────────────────────────────────────────────────

describe('getContentLength', () => {
  it('returns 0 for empty element', () => {
    expect(getContentLength(createElement(''))).toBe(0);
  });

  it('returns text length', () => {
    expect(getContentLength(createElement('hello'))).toBe(5);
  });

  it('counts pill as 1', () => {
    const el = createElement('ab<a class="inline-link" contenteditable="false" data-ast="node_link" data-link-id="x" data-ref-type="node">Node</a>cd');
    expect(getContentLength(el)).toBe(5); // 'ab' (2) + pill (1) + 'cd' (2)
  });

  it('excludes ZWS', () => {
    expect(getContentLength(createElement('a\u200Bb'))).toBe(2);
  });

  it('counts BR as 0', () => {
    expect(getContentLength(createElement('a<br>b'))).toBe(2);
  });
});

describe('getPlainText', () => {
  it('returns empty for empty element', () => {
    expect(getPlainText(createElement(''))).toBe('');
  });

  it('returns plain text', () => {
    expect(getPlainText(createElement('hello'))).toBe('hello');
  });

  it('strips ZWS', () => {
    expect(getPlainText(createElement('a\u200Bb'))).toBe('ab');
  });

  it('uses FFFC for pills', () => {
    const el = createElement('ab<a class="inline-link" data-link-id="x" data-ref-type="node">X</a>cd');
    expect(getPlainText(el)).toBe('ab\uFFFCcd');
  });

  it('recurses into formatting', () => {
    const el = createElement('<strong>bold</strong> text');
    expect(getPlainText(el)).toBe('bold text');
  });
});

// ─── detectTrigger ────────────────────────────────────────────────

describe('detectTrigger', () => {
  it('returns null for empty text', () => {
    expect(detectTrigger('', 0)).toBeNull();
  });

  it('returns null for cursor at 0', () => {
    expect(detectTrigger('hello', 0)).toBeNull();
  });

  it('detects @ trigger at start of text', () => {
    const result = detectTrigger('@task', 5);
    expect(result).toEqual({ type: 'type', query: 'task', triggerOffset: 0, cursorOffset: 5 });
  });

  it('detects @ trigger after whitespace', () => {
    const result = detectTrigger('hello @tag', 10);
    expect(result).toEqual({ type: 'type', query: 'tag', triggerOffset: 6, cursorOffset: 10 });
  });

  it('ignores @ not at word boundary', () => {
    expect(detectTrigger('email@test', 10)).toBeNull();
  });

  it('detects # trigger', () => {
    const result = detectTrigger('#topic', 6);
    expect(result).toEqual({ type: 'tag', query: 'topic', triggerOffset: 0, cursorOffset: 6 });
  });

  it('detects # trigger after space', () => {
    const result = detectTrigger('text #my', 8);
    expect(result).toEqual({ type: 'tag', query: 'my', triggerOffset: 5, cursorOffset: 8 });
  });

  it('detects [[ link trigger', () => {
    const result = detectTrigger('go to [[page', 12);
    expect(result).toEqual({ type: 'link', query: 'page', triggerOffset: 6, cursorOffset: 12 });
  });

  it('ignores closed [[ link', () => {
    expect(detectTrigger('go to [[page]]', 14)).toBeNull();
  });

  it('detects / slash command', () => {
    const result = detectTrigger('/todo', 5);
    expect(result).toEqual({ type: 'slash', query: 'todo', triggerOffset: 0, cursorOffset: 5 });
  });

  it('detects / slash after space', () => {
    const result = detectTrigger('text /cmd', 9);
    expect(result).toEqual({ type: 'slash', query: 'cmd', triggerOffset: 5, cursorOffset: 9 });
  });

  it('picks the rightmost trigger', () => {
    const result = detectTrigger('@type #tag', 10);
    expect(result).toEqual({ type: 'tag', query: 'tag', triggerOffset: 6, cursorOffset: 10 });
  });

  it('detects empty query for @ at cursor', () => {
    // When user just typed @ with nothing after
    const result = detectTrigger('hello @', 7);
    expect(result).toEqual({ type: 'type', query: '', triggerOffset: 6, cursorOffset: 7 });
  });

  it('detects empty query for [[', () => {
    const result = detectTrigger('hello [[', 8);
    expect(result).toEqual({ type: 'link', query: '', triggerOffset: 6, cursorOffset: 8 });
  });
});

// ─── isTextOnlyChange ─────────────────────────────────────────────

describe('isTextOnlyChange', () => {
  it('returns true for identical empty docs', () => {
    expect(isTextOnlyChange([], [])).toBe(true);
  });

  it('returns true when only text values differ', () => {
    const prev = p(text('hello'));
    const next = p(text('hello!'));
    expect(isTextOnlyChange(prev, next)).toBe(true);
  });

  it('returns false when paragraph count differs', () => {
    const prev = p(text('a'));
    const next: ASTDocument = [...p(text('a')), { type: 'paragraph', children: [text('b')] }];
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it('returns false when inline count differs', () => {
    const prev = p(text('ab'));
    const next: ASTDocument = [{ type: 'paragraph', children: [text('a'), text('b')] }];
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it('returns false when inline type differs', () => {
    const prev = p(text('hello'));
    const next: ASTDocument = [{ type: 'paragraph', children: [{ type: 'code', text: 'hello' }] }];
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });

  it('returns true for same structure with different text in marks', () => {
    const prev: ASTDocument = [{ type: 'paragraph', children: [
      { type: 'strong', children: [text('old')] },
    ] }];
    const next: ASTDocument = [{ type: 'paragraph', children: [
      { type: 'strong', children: [text('new')] },
    ] }];
    expect(isTextOnlyChange(prev, next)).toBe(true);
  });

  it('returns false when link_id differs', () => {
    const prev: ASTDocument = [{ type: 'paragraph', children: [
      { type: 'node_link', link_id: 'a', ref_type: 'node' },
    ] }];
    const next: ASTDocument = [{ type: 'paragraph', children: [
      { type: 'node_link', link_id: 'b', ref_type: 'node' },
    ] }];
    expect(isTextOnlyChange(prev, next)).toBe(false);
  });
});

// ─── astToHtmlCached ──────────────────────────────────────────────

describe('astToHtmlCached', () => {
  it('returns same string for same AST reference', () => {
    const doc = p(text('hello'));
    const html1 = astToHtmlCached(doc, testCtx);
    const html2 = astToHtmlCached(doc, testCtx);
    expect(html1).toBe(html2);
  });

  it('returns same content as astToHtml', () => {
    const doc = p(text('world'), link('42:abc'));
    const cached = astToHtmlCached(doc, testCtx);
    const direct = astToHtml(doc, testCtx);
    expect(cached).toBe(direct);
  });
});

// ─── Link status rendering ───────────────────────────────────────

describe('link status rendering', () => {
  it('adds link-pill--broken class for broken links', () => {
    const brokenCtx: ASTRenderContext = {
      resolveLink: () => ({
        displayText: 'Missing',
        targetName: 'Missing',
        isTag: false,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'broken',
      }),
    };
    const html = astToHtml(p(link('42:abc')), brokenCtx);
    expect(html).toContain('link-pill--broken');
    expect(html).toContain('data-link-status="broken"');
  });

  it('adds link-pill--cycle class for cycle links', () => {
    const cycleCtx: ASTRenderContext = {
      resolveLink: () => ({
        displayText: 'Cyclic',
        targetName: 'Cyclic',
        isTag: false,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'cycle',
      }),
    };
    const html = astToHtml(p(link('42:abc')), cycleCtx);
    expect(html).toContain('link-pill--cycle');
    expect(html).toContain('data-link-status="cycle"');
  });

  it('does not add status class for valid links', () => {
    const html = astToHtml(p(link('42:abc')), testCtx);
    expect(html).not.toContain('link-pill--broken');
    expect(html).not.toContain('link-pill--cycle');
  });

  it('includes title tooltip for broken links', () => {
    const brokenCtx: ASTRenderContext = {
      resolveLink: () => ({
        displayText: 'Missing',
        targetName: 'Missing',
        isTag: false,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'broken',
      }),
    };
    const html = astToHtml(p(link('42:abc')), brokenCtx);
    expect(html).toContain('title="Link target not found"');
  });

  it('includes title tooltip for cycle links', () => {
    const cycleCtx: ASTRenderContext = {
      resolveLink: () => ({
        displayText: 'Cyclic',
        targetName: 'Cyclic',
        isTag: false,
        effectiveIcon: null,
        customLabel: null,
        linkStatus: 'cycle',
      }),
    };
    const html = astToHtml(p(link('42:abc')), cycleCtx);
    expect(html).toContain('title="Circular reference detected"');
  });
});
