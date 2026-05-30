/**
 * Inline content population helpers — adapted from blockContentPopulation.ts
 * for per-block InlineEditor instances.
 *
 * Operates on ParagraphNode (or any ElementNode) instead of BlockNode.
 * Does not deal with block chrome, depth, or hierarchy — only inline content.
 */

import {
  $createTextNode,
  $createLineBreakNode,
  $isLineBreakNode,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {
  $createInlineLinkNode,
  $isInlineLinkNode,
} from './nodes/InlineLinkNode';
import {
  $createMathNode,
  $isMathNode,
} from './nodes/MathNode';
import type { ContentAST } from '../runtime/types';
import type { ASTInlineNode, ASTNodeLink } from '@/types/ast';

// ─── Utilities ────────────────────────────────────────────────────

/** Returns true when the AST is null / empty / effectively blank. */
export function isEmptyAST(contentAST: ContentAST): boolean {
  if (!contentAST || contentAST.length === 0) return true;
  const first = contentAST[0];
  if (!first.children || first.children.length === 0) return true;
  if (
    contentAST.length === 1 &&
    first.children.length === 1 &&
    first.children[0].type === 'text' &&
    first.children[0].text === ''
  )
    return true;
  return false;
}

// ─── Population ───────────────────────────────────────────────────

/**
 * Populate an ElementNode (e.g. ParagraphNode) from a ContentAST.
 * Full mount: text + pills + formatting in one pass.
 */
export function populateInlineContent(parent: ElementNode, contentAST: ContentAST): void {
  if (isEmptyAST(contentAST)) {
    parent.append($createTextNode('\u200B'));
    return;
  }

  for (const para of contentAST) {
    if (!para.children) continue;
    for (const inline of para.children) {
      appendInlineNode(parent, inline, 0);
    }
  }

  // Ensure trailing cursor node after pill / line break
  const children = parent.getChildren();
  const lastChild = children[children.length - 1];
  if (lastChild && ($isInlineLinkNode(lastChild) || $isMathNode(lastChild) || $isLineBreakNode(lastChild))) {
    parent.append($createTextNode('\u200B'));
  }
}

// ─── Extraction ───────────────────────────────────────────────────

/**
 * Extract inline content from an ElementNode back into ContentAST.
 */
export function extractInlineContent(parent: ElementNode): ContentAST {
  const children = parent.getChildren();
  const inlines: ASTInlineNode[] = [];

  for (const child of children) {
    if ($isInlineLinkNode(child)) {
      const rt = child.getRefType();
      if (rt === 'url') {
        const url = child.getUrl();
        const displayText = child.getLinkId();
        inlines.push({
          type: 'external_link',
          url,
          children:
            displayText && displayText !== url
              ? [{ type: 'text', text: displayText }]
              : [],
        });
      } else if (rt === 'broken') {
        const pillLabel = child.getLabel();
        inlines.push({
          type: 'broken_link',
          link_id: child.getLinkId(),
          ...(pillLabel ? { label: pillLabel } : {}),
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
    } else if ($isMathNode(child)) {
      inlines.push({
        type: 'math',
        expression: child.getExpression(),
        displayMode: child.getDisplayMode(),
      });
    } else if ($isLineBreakNode(child)) {
      inlines.push({ type: 'hard_break' });
    } else {
      const text = child.getTextContent();
      // Skip zero-width space placeholders from empty blocks
      if (text === '\u200B') continue;
      const format = (child as TextNode).getFormat?.() ?? 0;

      let node: ASTInlineNode;

      if (format & 16) {
        node = { type: 'code', text };
      } else {
        node = { type: 'text', text };
        if (format & 8) node = { type: 'underline', children: [node] };
        if (format & 4) node = { type: 'strikethrough', children: [node] };
        if (format & 2) node = { type: 'em', children: [node] };
        if (format & 1) node = { type: 'strong', children: [node] };
      }

      inlines.push(node);
    }
  }

  return [
    { type: 'paragraph', children: inlines.length > 0 ? inlines : [{ type: 'text', text: '' }] },
  ] as ContentAST;
}

// ─── Inline node appender (reused from blockContentPopulation.ts) ─

function appendInlineNode(parent: ElementNode, inline: ASTInlineNode, format: number): void {
  switch (inline.type) {
    case 'text': {
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
      const children = parent.getChildren();
      const lastChild = children[children.length - 1];
      if (children.length === 0 || $isInlineLinkNode(lastChild) || $isMathNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
      const pill = $createInlineLinkNode(
        inline.link_id,
        inline.ref_type,
        undefined,
        inline.label ?? undefined,
      );
      parent.append(pill);
      break;
    }
    case 'broken_link': {
      const children = parent.getChildren();
      const lastChild = children[children.length - 1];
      if (children.length === 0 || $isInlineLinkNode(lastChild) || $isMathNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
      const pill = $createInlineLinkNode(
        inline.link_id,
        'broken',
        undefined,
        inline.label ?? undefined,
      );
      parent.append(pill);
      break;
    }
    case 'math': {
      const children = parent.getChildren();
      const lastChild = children[children.length - 1];
      if (children.length === 0 || $isInlineLinkNode(lastChild) || $isMathNode(lastChild)) {
        parent.append($createTextNode('\u200B'));
      }
      const mathNode = $createMathNode(inline.expression, inline.displayMode ?? false);
      parent.append(mathNode);
      break;
    }
    case 'strong': {
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
      for (const child of inline.children) {
        appendInlineNode(parent, child, format);
      }
      break;
    }
    case 'external_link': {
      const label = inline.children
        .map((c) => ('text' in c ? c.text : ''))
        .join('');
      const urlPill = $createInlineLinkNode(label || inline.url, 'url', inline.url);
      parent.append(urlPill);
      break;
    }
  }
}
