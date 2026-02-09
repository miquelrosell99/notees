/**
 * Pure AST mutation functions.
 *
 * Every function here takes an ASTDocument (or inline nodes) and returns
 * a NEW document. No mutation of the input.
 *
 * These are the ONLY permitted way to modify AST content in the editor.
 */

import type {
  ASTDocument,
  ASTInlineNode,
  ASTNodeLink,
} from '@/types/ast';

// ─── Position type ────────────────────────────────────────────────

/**
 * A cursor position within an AST document.
 * `offset` is in logical characters (each pill = 1 character).
 */
export interface ASTPosition {
  readonly offset: number;
}

// ─── Split ─────────────────────────────────────────────────────────

/**
 * Split an AST document at a cursor position.
 * Returns [before, after] — two documents.
 *
 * Used for Enter key (create new block): the block keeps `before`,
 * the new block gets `after`.
 */
export function splitAtPosition(
  ast: ASTDocument,
  offset: number,
): [ASTDocument, ASTDocument] {
  // Flatten to inline nodes for simpler splitting
  const inlines = flattenToInlines(ast);
  const [before, after] = splitInlines(inlines, offset);

  return [
    before.length > 0 ? [{ type: 'paragraph', children: before }] : [],
    after.length > 0 ? [{ type: 'paragraph', children: after }] : [],
  ];
}

/**
 * Split an inline node array at a logical offset.
 */
function splitInlines(
  nodes: ASTInlineNode[],
  offset: number,
): [ASTInlineNode[], ASTInlineNode[]] {
  if (offset <= 0) return [[], [...nodes]];

  let currentOffset = 0;
  const before: ASTInlineNode[] = [];
  const after: ASTInlineNode[] = [];
  let splitDone = false;

  for (const node of nodes) {
    if (splitDone) {
      after.push(node);
      continue;
    }

    const nodeLen = inlineNodeLength(node);

    if (currentOffset + nodeLen <= offset) {
      // Entire node goes to before
      before.push(node);
      currentOffset += nodeLen;
      if (currentOffset === offset) {
        splitDone = true;
      }
    } else {
      // Split happens within this node
      const splitOffset = offset - currentOffset;
      const [nodeBefore, nodeAfter] = splitSingleNode(node, splitOffset);
      if (nodeBefore) before.push(nodeBefore);
      if (nodeAfter) after.push(nodeAfter);
      splitDone = true;
    }
  }

  return [before, after];
}

/**
 * Split a single inline node at an internal offset.
 */
function splitSingleNode(
  node: ASTInlineNode,
  offset: number,
): [ASTInlineNode | null, ASTInlineNode | null] {
  switch (node.type) {
    case 'text': {
      const before = offset > 0 ? { type: 'text' as const, text: node.text.slice(0, offset) } : null;
      const after = offset < node.text.length ? { type: 'text' as const, text: node.text.slice(offset) } : null;
      return [before, after];
    }

    case 'code': {
      const before = offset > 0 ? { type: 'code' as const, text: node.text.slice(0, offset) } : null;
      const after = offset < node.text.length ? { type: 'code' as const, text: node.text.slice(offset) } : null;
      return [before, after];
    }

    case 'hard_break':
    case 'node_link':
      // Atomic — can't split, goes entirely to before or after
      return offset > 0 ? [node, null] : [null, node];

    case 'strong':
    case 'em':
    case 'strikethrough':
    case 'highlight': {
      const [childBefore, childAfter] = splitInlines(node.children, offset);
      const before = childBefore.length > 0
        ? { type: node.type, children: childBefore } as ASTInlineNode
        : null;
      const after = childAfter.length > 0
        ? { type: node.type, children: childAfter } as ASTInlineNode
        : null;
      return [before, after];
    }

    case 'external_link': {
      const [childBefore, childAfter] = splitInlines(node.children, offset);
      const before = childBefore.length > 0
        ? { type: 'external_link' as const, url: node.url, children: childBefore }
        : null;
      const after = childAfter.length > 0
        ? { type: 'external_link' as const, url: node.url, children: childAfter }
        : null;
      return [before, after];
    }

    default:
      return [node, null];
  }
}

// ─── Merge ─────────────────────────────────────────────────────────

/**
 * Merge two AST documents into one.
 * Used for Backspace at start (merge with block above) and
 * Delete at end (merge with block below).
 */
export function mergeDocuments(
  first: ASTDocument,
  second: ASTDocument,
): ASTDocument {
  const firstInlines = flattenToInlines(first);
  const secondInlines = flattenToInlines(second);
  const merged = [...firstInlines, ...secondInlines];
  if (merged.length === 0) return [];
  return [{ type: 'paragraph', children: merged }];
}

// ─── Insert node link ─────────────────────────────────────────────

/**
 * Insert a node link at a position. Adds a trailing space.
 * Returns the new AST and the cursor position after the insertion.
 */
export function insertNodeLink(
  ast: ASTDocument,
  offset: number,
  linkId: string,
  refType: 'node' | 'class',
): { ast: ASTDocument; cursorOffset: number } {
  const inlines = flattenToInlines(ast);
  const [before, after] = splitInlines(inlines, offset);

  const link: ASTNodeLink = { type: 'node_link', link_id: linkId, ref_type: refType };
  const space: ASTInlineNode = { type: 'text', text: ' ' };

  const merged = [...before, link, space, ...after];
  // New cursor is after the link + space (link=1 + space=1)
  const cursorOffset = offset + 2;

  return {
    ast: merged.length > 0 ? [{ type: 'paragraph', children: merged }] : [],
    cursorOffset,
  };
}

/**
 * Replace the trigger text (e.g., "@query" or "[[query") and insert a node link.
 * `triggerStart` is the position of the trigger character.
 * `cursorEnd` is the current cursor position (end of query text).
 *
 * Returns the new AST and cursor position after the link.
 */
export function replaceTriggerWithLink(
  ast: ASTDocument,
  triggerStart: number,
  cursorEnd: number,
  linkId: string,
  refType: 'node' | 'class',
): { ast: ASTDocument; cursorOffset: number } {
  // Remove the trigger text range
  const withoutTrigger = deleteRange(ast, triggerStart, cursorEnd);
  // Insert the link at the trigger start position
  return insertNodeLink(withoutTrigger, triggerStart, linkId, refType);
}

/**
 * Remove the trigger text without inserting anything.
 */
export function removeTriggerText(
  ast: ASTDocument,
  triggerStart: number,
  cursorEnd: number,
): ASTDocument {
  return deleteRange(ast, triggerStart, cursorEnd);
}

// ─── Delete range ─────────────────────────────────────────────────

/**
 * Delete a range of content from the AST.
 */
export function deleteRange(
  ast: ASTDocument,
  start: number,
  end: number,
): ASTDocument {
  if (start >= end) return ast;

  const inlines = flattenToInlines(ast);
  const [before] = splitInlines(inlines, start);
  const [, after] = splitInlines(inlines, end);

  const merged = [...before, ...after];
  if (merged.length === 0) return [];
  return [{ type: 'paragraph', children: merged }];
}

// ─── Insert text ──────────────────────────────────────────────────

/**
 * Insert plain text at a position.
 */
export function insertText(
  ast: ASTDocument,
  offset: number,
  text: string,
): { ast: ASTDocument; cursorOffset: number } {
  const inlines = flattenToInlines(ast);
  const [before, after] = splitInlines(inlines, offset);

  const textNode: ASTInlineNode = { type: 'text', text };
  const merged = [...before, textNode, ...after];

  return {
    ast: merged.length > 0 ? [{ type: 'paragraph', children: merged }] : [],
    cursorOffset: offset + text.length,
  };
}

// ─── Formatting (wrap/unwrap marks) ────────────────────────────────

export type MarkType = 'strong' | 'em' | 'strikethrough' | 'highlight';

/**
 * Toggle a mark (bold, italic, etc.) on a range of content.
 * If the entire range is already wrapped in the mark, unwrap it.
 * Otherwise, wrap the range in the mark.
 *
 * Returns the new AST and the new selection range.
 */
export function toggleMark(
  ast: ASTDocument,
  start: number,
  end: number,
  markType: MarkType,
): { ast: ASTDocument; start: number; end: number } {
  if (start >= end) return { ast, start, end };

  const inlines = flattenToInlines(ast);
  const [before, rest] = splitInlines(inlines, start);
  const [selected, after] = splitInlines(rest, end - start);

  if (selected.length === 0) return { ast, start, end };

  // Check if the selection is entirely within this mark type
  const isWrapped = selected.length === 1 && selected[0].type === markType && 'children' in selected[0];

  let newSelected: ASTInlineNode[];
  if (isWrapped) {
    // Unwrap: lift children out
    newSelected = (selected[0] as { children: ASTInlineNode[] }).children;
  } else {
    // Wrap: create a new mark node
    newSelected = [{ type: markType, children: selected } as ASTInlineNode];
  }

  const merged = [...before, ...newSelected, ...after];
  return {
    ast: merged.length > 0 ? [{ type: 'paragraph', children: merged }] : [],
    start,
    end,
  };
}

/**
 * Toggle inline code on a range. Code is special because it uses `text`
 * instead of `children`.
 */
export function toggleCode(
  ast: ASTDocument,
  start: number,
  end: number,
): { ast: ASTDocument; start: number; end: number } {
  if (start >= end) return { ast, start, end };

  const inlines = flattenToInlines(ast);
  const [before, rest] = splitInlines(inlines, start);
  const [selected, after] = splitInlines(rest, end - start);

  if (selected.length === 0) return { ast, start, end };

  // Check if selection is a single code node
  const isCode = selected.length === 1 && selected[0].type === 'code';

  let newSelected: ASTInlineNode[];
  if (isCode) {
    // Unwrap code → text
    newSelected = [{ type: 'text', text: (selected[0] as { text: string }).text }];
  } else {
    // Wrap in code — collapse children to plain text
    const plainText = selected.map(n => extractText(n)).join('');
    newSelected = [{ type: 'code', text: plainText }];
  }

  const merged = [...before, ...newSelected, ...after];
  return {
    ast: merged.length > 0 ? [{ type: 'paragraph', children: merged }] : [],
    start,
    end,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Get the logical character length of an inline node.
 * - text: character count
 * - code: character count
 * - node_link: 1 (atomic)
 * - hard_break: 0 (doesn't count for cursor offset within a line)
 * - marks: sum of children
 * - external_link: sum of children
 */
export function inlineNodeLength(node: ASTInlineNode): number {
  switch (node.type) {
    case 'text':
      return node.text.length;
    case 'code':
      return node.text.length;
    case 'node_link':
      return 1;
    case 'hard_break':
      return 0;
    case 'strong':
    case 'em':
    case 'strikethrough':
    case 'highlight':
      return node.children.reduce((sum, c) => sum + inlineNodeLength(c), 0);
    case 'external_link':
      return node.children.reduce((sum, c) => sum + inlineNodeLength(c), 0);
    default:
      return 0;
  }
}

/**
 * Flatten an AST document's paragraphs into a single inline node array.
 * Multi-paragraph documents get hard_break between paragraphs.
 */
export function flattenToInlines(ast: ASTDocument): ASTInlineNode[] {
  if (ast.length === 0) return [];
  if (ast.length === 1) return [...ast[0].children];

  const result: ASTInlineNode[] = [];
  for (let i = 0; i < ast.length; i++) {
    if (i > 0) result.push({ type: 'hard_break' });
    result.push(...ast[i].children);
  }
  return result;
}

/**
 * Get the total logical length of an AST document.
 */
export function documentLength(ast: ASTDocument): number {
  return flattenToInlines(ast).reduce((sum, n) => sum + inlineNodeLength(n), 0);
}

/**
 * Replace a node_link by its link_id with a new node_link.
 * Walks the entire AST tree. Returns a new AST (or the same reference if not found).
 */
export function replaceNodeLink(
  ast: ASTDocument,
  oldLinkId: string,
  newLinkId: string,
  newRefType: 'node' | 'class' = 'node',
): ASTDocument {
  function replaceInInline(node: ASTInlineNode): ASTInlineNode {
    if (node.type === 'node_link' && node.link_id === oldLinkId) {
      return { type: 'node_link', link_id: newLinkId, ref_type: newRefType };
    }
    if ('children' in node && Array.isArray(node.children)) {
      const mapped = (node.children as ASTInlineNode[]).map(replaceInInline);
      if (mapped.every((c: ASTInlineNode, i: number) => c === (node as { children: ASTInlineNode[] }).children[i])) return node;
      return { ...node, children: mapped } as ASTInlineNode;
    }
    return node;
  }

  const newDoc = ast.map(para => {
    const mapped = para.children.map(replaceInInline);
    if (mapped.every((c: ASTInlineNode, i: number) => c === para.children[i])) return para;
    return { ...para, children: mapped };
  });

  if (newDoc.every((p, i) => p === ast[i])) return ast;
  return newDoc;
}

/**
 * Extract plain text from an inline node (recursive).
 */
function extractText(node: ASTInlineNode): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'code':
      return node.text;
    case 'hard_break':
      return ' ';
    case 'node_link':
      return '';
    case 'strong':
    case 'em':
    case 'strikethrough':
    case 'highlight':
      return node.children.map(extractText).join('');
    case 'external_link':
      return node.children.map(extractText).join('');
    default:
      return '';
  }
}
