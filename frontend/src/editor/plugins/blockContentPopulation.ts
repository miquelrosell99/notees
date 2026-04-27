/**
 * Block content population helpers — pure Lexical AST manipulation.
 *
 * Extracted from BlockPlugin.tsx to keep the React component focused on
 * lifecycle and event handling.
 */
import {
  $createTextNode,
  $createLineBreakNode,
  $isTextNode,
  $isLineBreakNode,
} from 'lexical';
import {
  $createInlineLinkNode,
  $isInlineLinkNode,
} from '../nodes/InlineLinkNode';
import type { BlockNode } from '../nodes/BlockNode';
import type { ContentAST } from '../../runtime/types';
import type { ASTInlineNode, ASTNodeLink } from '@/types/ast';

/** Returns true when the first block in contentAST has type 'heading'. */
export function isHeadingAST(contentAST: ContentAST): boolean {
  return Array.isArray(contentAST) && contentAST.length > 0 && contentAST[0].type === 'heading';
}

/** Returns true when the AST is null / empty / effectively blank. */
export function isEmptyAST(contentAST: ContentAST): boolean {
  if (!contentAST || contentAST.length === 0) return true;
  const first = contentAST[0];
  if (!first.children || first.children.length === 0) return false;
  if (
    contentAST.length === 1 &&
    first.children.length === 1 &&
    first.children[0].type === 'text' &&
    first.children[0].text === ''
  ) return true;
  return false;
}

/**
 * Populate a BlockNode's children from a ContentAST.
 * Full mount: text + pills + formatting in one pass.
 */
export function populateBlockContent(block: BlockNode, contentAST: ContentAST): void {
  if (isEmptyAST(contentAST)) {
    block.append($createTextNode('\u200B'));
    return;
  }

  for (const para of contentAST) {
    if (!para.children) continue; // whiteboard/query blocks have no inline children
    for (const inline of para.children) {
      appendInlineNode(block, inline, 0);
    }
  }

  // Ensure trailing cursor node after pill / line break
  const children = block.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && ($isInlineLinkNode(lastChild) || $isLineBreakNode(lastChild))) {
    block.append($createTextNode('\u200B'));
  }
}

/**
 * Progressive ("light") population — Phase 1.
 *
 * Creates only TextNode and LineBreakNode children, skipping inline links
 * and expensive decorator nodes.  Links are represented as plain
 * text placeholders ("·") so the block has the correct character
 * count and is focusable.
 *
 * Call `upgradeBlockContent()` in a subsequent idle callback to
 * replace placeholders with real InlineLinkNodes.
 *
 * Returns `true` if the AST contains pills that still need upgrading,
 * `false` if the content is fully mounted (no pills).
 */
export function populateBlockContentLight(block: BlockNode, contentAST: ContentAST): boolean {
  if (isEmptyAST(contentAST)) {
    block.append($createTextNode('\u200B'));
    return false;
  }

  let hasPills = false;
  for (const para of contentAST) {
    if (!para.children) continue; // whiteboard/query blocks have no inline children
    for (const inline of para.children) {
      if (appendInlineNodeLight(block, inline, 0)) hasPills = true;
    }
  }

  // Trailing cursor node
  const children = block.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && $isLineBreakNode(lastChild)) {
    block.append($createTextNode('\u200B'));
  }

  return hasPills;
}

/**
 * Phase 1 inline node appender — text-only.
 * Pills become plain ZWS placeholder text nodes.
 */
export function appendInlineNodeLight(parent: BlockNode, inline: ASTInlineNode, format: number): boolean {
  let hasPills = false;
  switch (inline.type) {
    case 'text': {
      // Auto-migrate legacy plain-text nodes that contain `backtick` patterns.
      if (/`[^`\n]+`/.test(inline.text)) {
        for (const part of inline.text.split(/(`[^`\n]+`)/)) {
          if (!part) continue;
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const codeNode = $createTextNode(part.slice(1, -1));
            codeNode.setFormat(format | 16); // IS_CODE
            parent.append(codeNode);
          } else {
            const textNode = $createTextNode(part);
            if (format !== 0) textNode.setFormat(format);
            parent.append(textNode);
          }
        }
      } else {
        const textNode = $createTextNode(inline.text);
        if (format !== 0) textNode.setFormat(format);
        parent.append(textNode);
      }
      break;
    }
    case 'code': {
      const codeNode = $createTextNode(inline.text);
      codeNode.setFormat(format | 16); // IS_CODE
      parent.append(codeNode);
      break;
    }
    case 'hard_break':
      parent.append($createLineBreakNode());
      break;
    case 'node_link':
    case 'external_link':
      // Placeholder — keeps character count stable
      parent.append($createTextNode('\u200B'));
      hasPills = true;
      break;
    case 'strong':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 1)) hasPills = true; }
      break;
    case 'em':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 2)) hasPills = true; }
      break;
    case 'strikethrough':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 4)) hasPills = true; }
      break;
    case 'underline':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format | 8)) hasPills = true; }
      break;
    case 'highlight':
      for (const c of inline.children) { if (appendInlineNodeLight(parent, c, format)) hasPills = true; }
      break;
  }
  return hasPills;
}

/**
 * Collect pill AST nodes (node_link / external_link) from an inline
 * tree in document order, recursing through formatting wrappers.
 */
export function collectPillsFromAST(nodes: readonly ASTInlineNode[], out: ASTInlineNode[]): void {
  for (const n of nodes) {
    if (n.type === 'node_link' || n.type === 'external_link') {
      out.push(n);
    } else if ('children' in n && Array.isArray((n as any).children)) {
      collectPillsFromAST((n as any).children, out);
    }
  }
}

/**
 * Phase 2 — upgrade a light-mounted block to full content.
 *
 * Uses **surgical replacement**: only the ZWS placeholder TextNodes
 * that represent pills are swapped for real InlineLinkNodes.  All other
 * children (text, formatting) remain untouched, which means:
 *   - The user's cursor position is preserved.
 *   - No DOM flicker (no clear + repopulate cycle).
 *   - No portal duplication (old TextNodes have no decorators).
 *
 * If the number of ZWS placeholders doesn't match the pill count in
 * the AST (e.g. the block was edited between Phase 1 and Phase 2),
 * we fall back to a full clear + repopulate.
 */
export function upgradeBlockContent(block: BlockNode, contentAST: ContentAST): void {
  if (isEmptyAST(contentAST)) return;

  // --- Collect pills from the AST in document order ---
  const pills: ASTInlineNode[] = [];
  for (const para of contentAST) {
    if (para.children) collectPillsFromAST(para.children, pills);
  }
  if (pills.length === 0) return; // Nothing to upgrade

  // --- Find ZWS placeholder TextNodes that correspond to pills ---
  // In light-populated blocks, each pill is a standalone TextNode('\u200B').
  // Other ZWS nodes (trailing cursor helpers) are acceptable extras —
  // we only need at least as many as there are pills.
  const zwsNodes: { node: import('lexical').TextNode; index: number }[] = [];
  const children = block.getChildren();
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if ($isTextNode(child) && child.getTextContent() === '\u200B') {
      zwsNodes.push({ node: child, index: i });
    }
  }

  if (zwsNodes.length < pills.length) {
    // Mismatch — the block was likely edited.  Fall back to full repopulate.
    const allChildren = block.getChildren();
    for (const c of allChildren) c.remove();
    populateBlockContent(block, contentAST);
    return;
  }

  // --- Surgical replacement: 1-to-1 match of pills to ZWS nodes ---
  for (let i = 0; i < pills.length; i++) {
    const astPill = pills[i];
    const { node: zwsNode } = zwsNodes[i];

    // Determine if a pre-pill ZWS cursor node is needed.
    // `appendInlineNode` adds one when the pill would be the first child
    // or immediately follows another InlineLinkNode.
    const prev = zwsNode.getPreviousSibling();
    const needsPreZWS = !prev || $isInlineLinkNode(prev);

    let inlineLink;
    if (astPill.type === 'node_link') {
      inlineLink = $createInlineLinkNode(
        astPill.link_id,
        astPill.ref_type,
        undefined,
        astPill.label ?? undefined,
      );
    } else if (astPill.type === 'external_link') {
      const label = astPill.children
        ?.map((c: ASTInlineNode) => ('text' in c ? (c as any).text : ''))
        .join('') ?? '';
      inlineLink = $createInlineLinkNode(label || astPill.url, 'url', astPill.url);
    } else {
      continue;
    }

    if (needsPreZWS) {
      zwsNode.insertBefore($createTextNode('\u200B'));
    }
    zwsNode.replace(inlineLink);
  }

  // --- Ensure trailing ZWS after last pill / line break ---
  const finalChildren = block.getChildren();
  const last = finalChildren[finalChildren.length - 1];
  if (last && ($isInlineLinkNode(last) || $isLineBreakNode(last))) {
    block.append($createTextNode('\u200B'));
  }
}

/**
 * Recursively append inline nodes to a block, tracking format flags for nested marks.
 * Also ensures text nodes exist around pills for proper cursor navigation.
 */
export function appendInlineNode(parent: BlockNode, inline: ASTInlineNode, format: number): void {
  switch (inline.type) {
    case 'text': {
      // Auto-migrate legacy plain-text nodes that contain `backtick` patterns.
      if (/`[^`\n]+`/.test(inline.text)) {
        for (const part of inline.text.split(/(`[^`\n]+`)/)) {
          if (!part) continue;
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            const codeNode = $createTextNode(part.slice(1, -1));
            codeNode.setFormat(format | 16); // IS_CODE
            parent.append(codeNode);
          } else {
            const textNode = $createTextNode(part);
            if (format !== 0) textNode.setFormat(format);
            parent.append(textNode);
          }
        }
      } else {
        const textNode = $createTextNode(inline.text);
        if (format !== 0) textNode.setFormat(format);
        parent.append(textNode);
      }
      break;
    }
    case 'code': {
      const codeNode = $createTextNode(inline.text);
      codeNode.setFormat(format | 16); // IS_CODE
      parent.append(codeNode);
      break;
    }
    case 'hard_break': {
      parent.append($createLineBreakNode());
      break;
    }
    case 'node_link': {
      // Ensure there's a text node before the pill if this is the first element
      // or if the previous sibling is also a pill
      // Use zero-width space to prevent Lexical from removing the text node
      const children = parent.getChildren();
      const lastChild = children[children.length - 1];
      if (children.length === 0 || $isInlineLinkNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
      const pill = $createInlineLinkNode(inline.link_id, inline.ref_type, undefined, inline.label ?? undefined);
      parent.append(pill);
      break;
    }
    case 'strong': {
      // Recurse into children with bold flag added
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 1); // IS_BOLD
      }
      break;
    }
    case 'em': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 2); // IS_ITALIC
      }
      break;
    }
    case 'strikethrough': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 4); // IS_STRIKETHROUGH
      }
      break;
    }
    case 'underline': {
      for (const child of inline.children) {
        appendInlineNode(parent, child, format | 8); // IS_UNDERLINE
      }
      break;
    }
    case 'highlight': {
      // No Lexical highlight format, just recurse
      for (const child of inline.children) {
        appendInlineNode(parent, child, format);
      }
      break;
    }
    case 'external_link': {
      // Render as a URL pill
      const label = inline.children
        .map(c => ('text' in c ? c.text : ''))
        .join('');
      const urlPill = $createInlineLinkNode(label || inline.url, 'url', inline.url);
      parent.append(urlPill);
      break;
    }
  }
}

/**
 * Extract content from a BlockNode back into ContentAST.
 */
export function extractBlockContent(block: BlockNode): ContentAST {
  const children = block.getChildren();
  const inlines: ASTInlineNode[] = [];

  for (const child of children) {
    if ($isInlineLinkNode(child)) {
      const rt = child.getRefType();
      if (rt === 'url') {
        // URL pill → external_link AST
        const url = child.getUrl();
        const displayText = child.getLinkId();
        inlines.push({
          type: 'external_link',
          url,
          children: displayText && displayText !== url
            ? [{ type: 'text', text: displayText }]
            : [],
        });
      } else {
        const pillLabel = child.getLabel();
        const nodeLink: ASTNodeLink = {
          type: 'node_link',
          link_id: child.getLinkId(),
          ref_type: rt,
          ...(pillLabel ? { label: pillLabel } : {}),
        };
        inlines.push(nodeLink);
      }
    } else if ($isLineBreakNode(child)) {
      inlines.push({ type: 'hard_break' });
    } else {
      const text = child.getTextContent();
      // Skip zero-width space placeholders from empty blocks
      if (text === '\u200B') continue;
      const format = (child as any).getFormat?.() ?? 0;

      // Build the AST node with nested marks
      let node: ASTInlineNode;

      if (format & 16) {
        // IS_CODE — leaf node, backticks stored without delimiters
        node = { type: 'code', text };
      } else {
        node = { type: 'text', text };
        // Apply formatting marks
        if (format & 8) node = { type: 'underline', children: [node] };
        if (format & 4) node = { type: 'strikethrough', children: [node] };
        if (format & 2) node = { type: 'em', children: [node] };
        if (format & 1) node = { type: 'strong', children: [node] };
      }

      inlines.push(node);
    }
  }

  const blockType = block.getIsHeading() ? 'heading' : 'paragraph';
  return [{ type: blockType, children: inlines.length > 0 ? inlines : [{ type: 'text', text: '' }] }] as ContentAST;
}
