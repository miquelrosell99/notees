/**
 * Tests for the canonical AST stringifier.
 *
 * Covers all three StringifyMode values, node link rendering with labels,
 * cycle detection, nested formatting, and edge cases.
 */
import { describe, it, expect } from 'vitest';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { NodeLinkResolver } from '@/lib/stringifyAST';
import type { ASTDocument, ASTInlineNode } from '@/types/ast';

// ─── Helpers ───────────────────────────────────────────────────────

/** Shorthand for a single paragraph with the given inline nodes. */
function p(...children: ASTInlineNode[]): ASTDocument {
  return [{ type: 'paragraph', children }];
}

function text(t: string) {
  return { type: 'text' as const, text: t };
}

function strong(...children: ASTInlineNode[]) {
  return { type: 'strong' as const, children };
}

function em(...children: ASTInlineNode[]) {
  return { type: 'em' as const, children };
}

function hardBreak() {
  return { type: 'hard_break' as const };
}

function nodeLink(linkId: string, refType: 'node' | 'class' = 'node') {
  return { type: 'node_link' as const, link_id: linkId, ref_type: refType };
}

function strikethrough(...children: ASTInlineNode[]) {
  return { type: 'strikethrough' as const, children };
}

function highlight(...children: ASTInlineNode[]) {
  return { type: 'highlight' as const, children };
}

function externalLink(url: string, ...children: ASTInlineNode[]) {
  return { type: 'external_link' as const, url, children };
}

function math(expression: string, displayMode = false) {
  return { type: 'math' as const, expression, displayMode };
}

// Resolver that maps link_id → { targetAST, label, targetId }
function makeResolver(
  map: Record<string, { ast: ASTDocument; label?: string | null; targetId?: string }>,
): NodeLinkResolver {
  return (linkId) => {
    const entry = map[linkId];
    if (!entry) return null;
    return {
      targetAST: entry.ast,
      label: entry.label ?? null,
      targetId: entry.targetId ?? linkId,
    };
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('stringifyAST', () => {
  // ── Plain text ──

  describe('text nodes', () => {
    const ast = p(text('Hello world'));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('Hello world');
    });
    it('PLAIN_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.PLAIN_MARKDOWN })).toBe('Hello world');
    });
    it('TEXT_ONLY', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('Hello world');
    });
  });

  // ── Empty document ──

  describe('empty document', () => {
    it('returns empty string', () => {
      expect(stringifyAST([], { mode: StringifyMode.NODE_MARKDOWN })).toBe('');
      expect(stringifyAST([], { mode: StringifyMode.TEXT_ONLY })).toBe('');
    });
  });

  // ── Formatting marks ──

  describe('strong', () => {
    const ast = p(text('a '), strong(text('bold')), text(' b'));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('a **bold** b');
    });
    it('TEXT_ONLY strips marks', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('a bold b');
    });
  });

  describe('em', () => {
    const ast = p(text('a '), em(text('italic')), text(' b'));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('a *italic* b');
    });
    it('TEXT_ONLY strips marks', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('a italic b');
    });
  });

  describe('inline code (plain text with backticks)', () => {
    const ast = p(text('run `npm install`'));

    it('NODE_MARKDOWN preserves backticks', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('run `npm install`');
    });
    it('TEXT_ONLY preserves backticks', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('run `npm install`');
    });
  });

  describe('strikethrough', () => {
    const ast = p(strikethrough(text('removed')));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('~~removed~~');
    });
    it('TEXT_ONLY', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('removed');
    });
  });

  describe('highlight', () => {
    const ast = p(highlight(text('important')));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('==important==');
    });
    it('TEXT_ONLY', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('important');
    });
  });

  // ── Nested formatting ──

  describe('nested formatting', () => {
    const ast = p(strong(em(text('bold italic'))));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('***bold italic***');
    });
    it('TEXT_ONLY', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('bold italic');
    });
  });

  // ── Hard break ──

  describe('hard_break', () => {
    const ast = p(text('line one'), hardBreak(), text('line two'));

    it('NODE_MARKDOWN uses two-space newline', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('line one  \nline two');
    });
    it('TEXT_ONLY uses space', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('line one line two');
    });
  });

  // ── External link ──

  describe('external_link', () => {
    const ast = p(text('see '), externalLink('https://example.com', text('here')));

    it('NODE_MARKDOWN', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe(
        'see [here](https://example.com)',
      );
    });
    it('TEXT_ONLY strips link', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe('see here');
    });
  });

  // ── Multiple paragraphs ──

  describe('multiple paragraphs', () => {
    const ast: ASTDocument = [
      { type: 'paragraph', children: [text('First paragraph.')] },
      { type: 'paragraph', children: [text('Second paragraph.')] },
    ];

    it('NODE_MARKDOWN separates with double newline', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe(
        'First paragraph.\n\nSecond paragraph.',
      );
    });
    it('TEXT_ONLY separates with space', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY })).toBe(
        'First paragraph. Second paragraph.',
      );
    });
  });

  // ── maxLength ──

  describe('maxLength', () => {
    const ast = p(text('Hello world, this is a long sentence'));

    it('truncates to maxLength', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, maxLength: 5 })).toBe('Hello');
    });

    it('does not truncate when under limit', () => {
      expect(stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, maxLength: 1000 })).toBe(
        'Hello world, this is a long sentence',
      );
    });
  });

  // ── Node links ──

  describe('node_link', () => {
    const resolver = makeResolver({
      'link-aaa': {
        ast: p(text('ISO 14971')),
        targetId: 'node-1',
      },
      'link-bbb': {
        ast: p(text('ISO 14971')),
        label: 'risk standard',
        targetId: 'node-1',
      },
    });

    describe('without label', () => {
      const ast = p(text('See '), nodeLink('link-aaa'));

      it('NODE_MARKDOWN wraps in [[…]]', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See [[ISO 14971]]');
      });

      it('PLAIN_MARKDOWN uses resolved text', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.PLAIN_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See ISO 14971');
      });

      it('TEXT_ONLY uses resolved text', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, resolveNodeLink: resolver }),
        ).toBe('See ISO 14971');
      });
    });

    describe('with label', () => {
      const ast = p(text('See the '), nodeLink('link-bbb'));

      it('NODE_MARKDOWN wraps with label syntax', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See the [risk standard]([[ISO 14971]])');
      });

      it('PLAIN_MARKDOWN uses label', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.PLAIN_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See the risk standard');
      });

      it('TEXT_ONLY uses label', () => {
        expect(
          stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, resolveNodeLink: resolver }),
        ).toBe('See the risk standard');
      });
    });

    describe('class ref_type', () => {
      const resolver2 = makeResolver({
        'link-ccc': {
          ast: p(text('Task')),
          targetId: 'class-task',
        },
        'link-ddd': {
          ast: p(text('Bug')),
          label: 'issue',
          targetId: 'class-bug',
        },
      });

      it('NODE_MARKDOWN renders as {{…}} without label', () => {
        const ast2 = p(text('This is a '), nodeLink('link-ccc', 'class'));
        expect(
          stringifyAST(ast2, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver2 }),
        ).toBe('This is a {{Task}}');
      });

      it('NODE_MARKDOWN renders label directly for class with label', () => {
        const ast2 = p(text('Filed as '), nodeLink('link-ddd', 'class'));
        expect(
          stringifyAST(ast2, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver2 }),
        ).toBe('Filed as issue');
      });
    });

    describe('unresolvable link', () => {
      const ast2 = p(text('See '), nodeLink('link-gone'));

      it('NODE_MARKDOWN emits [[…]] placeholder', () => {
        expect(
          stringifyAST(ast2, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See [[…]]');
      });

      it('PLAIN_MARKDOWN emits … placeholder', () => {
        expect(
          stringifyAST(ast2, { mode: StringifyMode.PLAIN_MARKDOWN, resolveNodeLink: resolver }),
        ).toBe('See …');
      });
    });

    describe('no resolver provided', () => {
      const ast2 = p(text('See '), nodeLink('link-aaa'));

      it('NODE_MARKDOWN emits [[…]]', () => {
        expect(stringifyAST(ast2, { mode: StringifyMode.NODE_MARKDOWN })).toBe('See [[…]]');
      });

      it('TEXT_ONLY emits …', () => {
        expect(stringifyAST(ast2, { mode: StringifyMode.TEXT_ONLY })).toBe('See …');
      });
    });
  });

  // ── Cycle detection ──

  describe('cycle detection', () => {
    // Node A links to Node B, Node B links to Node A.
    const resolver: NodeLinkResolver = (linkId) => {
      if (linkId === 'link-to-b') {
        return {
          targetAST: p(text('Node B says '), nodeLink('link-to-a')),
          label: null,
          targetId: 'node-b',
        };
      }
      if (linkId === 'link-to-a') {
        return {
          targetAST: p(text('Node A says '), nodeLink('link-to-b')),
          label: null,
          targetId: 'node-a',
        };
      }
      return null;
    };

    it('NODE_MARKDOWN breaks cycle with placeholder', () => {
      const ast = p(text('Start: '), nodeLink('link-to-b'));
      const result = stringifyAST(ast, {
        mode: StringifyMode.NODE_MARKDOWN,
        resolveNodeLink: resolver,
      });
      // Node B resolves, then tries Node A, which tries Node B again → cycle.
      expect(result).toBe('Start: [[Node B says [[Node A says [[…]]]]]]');
    });

    it('TEXT_ONLY breaks cycle with placeholder', () => {
      const ast = p(text('Start: '), nodeLink('link-to-b'));
      const result = stringifyAST(ast, {
        mode: StringifyMode.TEXT_ONLY,
        resolveNodeLink: resolver,
      });
      expect(result).toBe('Start: Node B says Node A says …');
    });
  });

  // ── Self-referencing node ──

  describe('self-referencing node', () => {
    const resolver: NodeLinkResolver = (linkId) => {
      if (linkId === 'link-self') {
        return {
          targetAST: p(text('Me '), nodeLink('link-self')),
          label: null,
          targetId: 'node-self',
        };
      }
      return null;
    };

    it('breaks self-cycle', () => {
      const ast = p(nodeLink('link-self'));
      const result = stringifyAST(ast, {
        mode: StringifyMode.NODE_MARKDOWN,
        resolveNodeLink: resolver,
      });
      expect(result).toBe('[[Me [[…]]]]');
    });
  });

  // ── Complex mixed content ──

  describe('complex mixed content', () => {
    const resolver = makeResolver({
      'link-x': { ast: p(text('Design Doc')), targetId: 'n-x' },
    });

    const ast = p(
      text('Review the '),
      strong(text('updated ')),
      nodeLink('link-x'),
      text(' before '),
      em(text('Friday')),
    );

    it('NODE_MARKDOWN', () => {
      expect(
        stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN, resolveNodeLink: resolver }),
      ).toBe('Review the **updated **[[Design Doc]] before *Friday*');
    });

    it('PLAIN_MARKDOWN', () => {
      expect(
        stringifyAST(ast, { mode: StringifyMode.PLAIN_MARKDOWN, resolveNodeLink: resolver }),
      ).toBe('Review the **updated **Design Doc before *Friday*');
    });

    it('TEXT_ONLY', () => {
      expect(
        stringifyAST(ast, { mode: StringifyMode.TEXT_ONLY, resolveNodeLink: resolver }),
      ).toBe('Review the updated Design Doc before Friday');
    });
  });

  // ── Math nodes ──

  describe('math nodes', () => {
    it('NODE_MARKDOWN inline', () => {
      expect(stringifyAST(p(math('E = mc^2')), { mode: StringifyMode.NODE_MARKDOWN })).toBe('$E = mc^2$');
    });
    it('NODE_MARKDOWN display', () => {
      expect(stringifyAST(p(math('\\sum_{i=1}^n', true)), { mode: StringifyMode.NODE_MARKDOWN })).toBe('$$\\sum_{i=1}^n$$');
    });
    it('PLAIN_MARKDOWN inline', () => {
      expect(stringifyAST(p(math('\\pi')), { mode: StringifyMode.PLAIN_MARKDOWN })).toBe('$\\pi$');
    });
    it('TEXT_ONLY strips delimiters', () => {
      expect(stringifyAST(p(math('\\frac{a}{b}', true)), { mode: StringifyMode.TEXT_ONLY })).toBe('\\frac{a}{b}');
    });
  });

  // ── Unknown AST node types ──

  describe('unknown AST node type', () => {
    it('is silently ignored', () => {
      const ast: ASTDocument = [
        {
          type: 'paragraph',
          children: [
            text('before '),
            { type: 'unknown_widget' as any } as any,
            text(' after'),
          ],
        },
      ];
      expect(stringifyAST(ast, { mode: StringifyMode.NODE_MARKDOWN })).toBe('before  after');
    });
  });
});
