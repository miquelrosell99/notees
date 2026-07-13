/**
 * Pure ContentAST helpers used by the runtime intent engine.
 *
 * Kept separate so the runtime core can focus on graph state and mutations.
 */
import type { ContentAST } from './types';
import type { ASTInlineNode } from '@/types/ast';

export function splitContentASTAtOffset(
  content: ContentAST,
  offset: number,
): { before: ContentAST; after: ContentAST } {
  if (content.length === 0) {
    return {
      before: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
      after: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    };
  }

  // Flatten to count characters
  let charCount = 0;
  let splitParaIndex = 0;
  let splitCharOffset = 0;
  let found = false;

  for (let i = 0; i < content.length; i++) {
    const para = content[i];
    if (!para.children) continue;
    const paraStart = charCount;
    for (const child of para.children) {
      const len = getInlineLength(child);
      if (charCount + len >= offset) {
        splitParaIndex = i;
        splitCharOffset = offset - paraStart;
        found = true;
        break;
      }
      charCount += len;
    }
    if (found) break;
    charCount++; // paragraph break
  }

  // Offset beyond content: split at end (everything stays in "before")
  if (!found) {
    return {
      before: content.map((p) => ({ ...p, children: p.children ? [...p.children] : [] })),
      after: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '' }] }],
    };
  }

  const before = content.slice(0, splitParaIndex);
  const after = content.slice(splitParaIndex + 1);

  const splitPara = content[splitParaIndex];
  if (splitPara && splitPara.children) {
    const { beforeInlines, afterInlines } = splitInlinesAtOffset(splitPara.children, splitCharOffset);
    before.push({ type: 'paragraph', children: beforeInlines });
    after.unshift({ type: 'paragraph', children: afterInlines });
  }

  return { before, after };
}

export function mergeContentASTs(a: ContentAST, b: ContentAST): ContentAST {
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const result = [...a];
  const lastPara = result[result.length - 1];
  const firstB = b[0];

  // Merge last paragraph of a with first paragraph of b
  // Then normalize adjacent plain-text nodes so the runtime's AST
  // matches what the inline editor produces after its own text-node merge pass.
  const merged = [...(lastPara.children || []), ...(firstB.children || [])];
  const normalized: ASTInlineNode[] = [];
  for (const node of merged) {
    const prev = normalized.length > 0 ? normalized[normalized.length - 1] : null;
    if (prev && prev.type === 'text' && node.type === 'text') {
      // Merge adjacent plain-text nodes
      normalized[normalized.length - 1] = { type: 'text', text: prev.text + node.text };
    } else {
      normalized.push(node);
    }
  }

  result[result.length - 1] = {
    type: 'paragraph',
    children: normalized,
  };

  // Add remaining paragraphs from b
  for (let i = 1; i < b.length; i++) {
    result.push(b[i]);
  }

  return result;
}

export function getInlineLength(node: ASTInlineNode): number {
  switch (node.type) {
    case 'text':
      return node.text.length;
    case 'hard_break':
      return 1;
    case 'node_link':
    case 'broken_link':
      return 1; // Pills count as 1 character
    case 'code':
      return node.text.length;
    case 'strong':
    case 'em':
    case 'strikethrough':
    case 'underline':
    case 'highlight':
      return node.children.reduce((sum: number, c: ASTInlineNode) => sum + getInlineLength(c), 0);
    case 'external_link':
      return node.children.reduce((sum: number, c: ASTInlineNode) => sum + getInlineLength(c), 0);
    default:
      return 0;
  }
}

/**
 * Calculate the total text length of a ContentAST (for cursor positioning).
 */
export function getContentASTLength(content: ContentAST): number {
  if (content.length === 0) return 0;

  let totalLength = 0;
  for (let i = 0; i < content.length; i++) {
    const para = content[i];
    if (!para.children) continue;
    for (const child of para.children) {
      totalLength += getInlineLength(child);
    }
    // Add paragraph break (except after last paragraph)
    if (i < content.length - 1) {
      totalLength++;
    }
  }
  return totalLength;
}

export function splitInlinesAtOffset(
  inlines: ASTInlineNode[],
  offset: number,
): { beforeInlines: ASTInlineNode[]; afterInlines: ASTInlineNode[] } {
  const before: ASTInlineNode[] = [];
  const after: ASTInlineNode[] = [];
  let remaining = offset;

  for (let i = 0; i < inlines.length; i++) {
    const node = inlines[i];
    const len = getInlineLength(node);

    if (remaining <= 0) {
      after.push(node);
    } else if (remaining >= len) {
      before.push(node);
      remaining -= len;
    } else {
      // Split this node
      if (node.type === 'text') {
        before.push({ type: 'text', text: node.text.slice(0, remaining) });
        after.push({ type: 'text', text: node.text.slice(remaining) });
      } else if ('children' in node && Array.isArray(node.children)) {
        // Recursively split wrapper nodes (strong, em, strikethrough, etc.)
        const { beforeInlines, afterInlines } = splitInlinesAtOffset(node.children, remaining);
        const hasBeforeContent =
          beforeInlines.length > 0 &&
          !(beforeInlines.length === 1 && beforeInlines[0].type === 'text' && beforeInlines[0].text === '');
        const hasAfterContent =
          afterInlines.length > 0 &&
          !(afterInlines.length === 1 && afterInlines[0].type === 'text' && afterInlines[0].text === '');
        if (hasBeforeContent) {
          before.push({ ...node, children: beforeInlines } as ASTInlineNode);
        }
        if (hasAfterContent) {
          after.push({ ...node, children: afterInlines } as ASTInlineNode);
        }
      } else {
        before.push(node);
      }
      remaining = 0;
    }
  }

  // Ensure non-empty
  if (before.length === 0) before.push({ type: 'text', text: '' });
  if (after.length === 0) after.push({ type: 'text', text: '' });

  return { beforeInlines: before, afterInlines: after };
}
