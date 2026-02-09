/**
 * AST builder helpers for constructing AST documents programmatically.
 *
 * These are the ONLY sanctioned way to build AST nodes in application code.
 * They enforce correct typing and make AST construction concise.
 */
import type {
  ASTDocument,
  ASTParagraph,
  ASTText,
  ASTHardBreak,
  ASTNodeLink,
  ASTStrong,
  ASTEm,
  ASTCode,
  ASTStrikethrough,
  ASTHighlight,
  ASTExternalLink,
  ASTInlineNode,
} from '@/types/ast';

// Re-export types for convenience
export type { ASTDocument, ASTInlineNode };

// ─── Leaf builders ─────────────────────────────────────────────────

export function text(t: string): ASTText {
  return { type: 'text', text: t };
}

export function hardBreak(): ASTHardBreak {
  return { type: 'hard_break' };
}

export function nodeLink(linkId: string, refType: 'node' | 'class' = 'node'): ASTNodeLink {
  return { type: 'node_link', link_id: linkId, ref_type: refType };
}

export function code(t: string): ASTCode {
  return { type: 'code', text: t };
}

// ─── Mark builders ─────────────────────────────────────────────────

export function strong(...children: ASTInlineNode[]): ASTStrong {
  return { type: 'strong', children };
}

export function em(...children: ASTInlineNode[]): ASTEm {
  return { type: 'em', children };
}

export function strikethrough(...children: ASTInlineNode[]): ASTStrikethrough {
  return { type: 'strikethrough', children };
}

export function highlight(...children: ASTInlineNode[]): ASTHighlight {
  return { type: 'highlight', children };
}

export function externalLink(url: string, ...children: ASTInlineNode[]): ASTExternalLink {
  return { type: 'external_link', url, children };
}

// ─── Block builders ────────────────────────────────────────────────

export function paragraph(...children: ASTInlineNode[]): ASTParagraph {
  return { type: 'paragraph', children };
}

/**
 * Build a complete document from paragraphs.
 * If called with inline nodes directly, wraps them in a single paragraph.
 */
export function doc(...blocks: ASTParagraph[]): ASTDocument {
  return blocks;
}

/**
 * Convenience: build a single-paragraph document from inline nodes.
 */
export function inlineDoc(...children: ASTInlineNode[]): ASTDocument {
  return [paragraph(...children)];
}

// ─── Plain text shortcut ───────────────────────────────────────────

/**
 * Build a document from a plain string (no formatting).
 * This is the most common case — page titles, simple block text.
 */
export function fromPlainText(s: string): ASTDocument {
  if (!s) return [];
  return [paragraph(text(s))];
}

// ─── AST parsing / validation ──────────────────────────────────────

/**
 * Parse a JSON string or object into a validated ASTDocument.
 *
 * Returns an empty document if the input is invalid.
 * This is the ONLY way to deserialize a `name` column value.
 * 
 * Note: The name field must ALWAYS contain valid AST JSON.
 * Use the AST builder functions (paragraph, text, etc.) to create content.
 */
export function parseAST(input: unknown): ASTDocument {
  if (typeof input === 'string') {
    if (!input) return [];
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed)) {
        // Invalid: not an AST array
        return [];
      }
      return validateDocument(parsed);
    } catch {
      // Invalid JSON - should never happen with properly created AST
      return [];
    }
  }
  if (Array.isArray(input)) {
    return validateDocument(input);
  }
  return [];
}

/**
 * Validate that a parsed value is a well-formed ASTDocument.
 * Returns the input if valid, otherwise returns an empty document.
 */
function validateDocument(doc: unknown): ASTDocument {
  if (!Array.isArray(doc)) return [];
  // Shallow validation: each element must have a type field.
  for (const block of doc) {
    if (typeof block !== 'object' || block === null || !('type' in block)) {
      return [];
    }
  }
  return doc as ASTDocument;
}
