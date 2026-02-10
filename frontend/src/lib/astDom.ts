/**
 * AST ↔ DOM mapping engine for contenteditable editing.
 *
 * This module is the single bridge between the AST (source of truth)
 * and the browser's contenteditable DOM. It contains two core functions:
 *
 *   astToHtml(ast, ctx)     – Render an ASTDocument to an HTML string
 *                             suitable for innerHTML of a contenteditable div.
 *   domToAST(element)       – Extract an ASTDocument from the live DOM.
 *
 * All pill elements (node links, class refs, tags) are rendered as
 * contenteditable="false" atomic spans with data attributes that carry
 * the AST identity. The AST is the sole authority — the DOM is
 * ephemeral and rebuilt from the AST whenever they diverge.
 */

import type {
  ASTDocument,
  ASTInlineNode,
  ASTParagraph,
  ASTNodeLink,
} from '@/types/ast';

// ─── Context for rendering ────────────────────────────────────────

/**
 * Link resolution status for visual cues.
 */
export type LinkStatus = 'valid' | 'broken' | 'cycle';

/**
 * Resolved info for a node link, used during AST→DOM rendering.
 */
export interface ResolvedLink {
  /** Display text for the pill */
  readonly displayText: string;
  /** The actual target node name (before custom label override) */
  readonly targetName: string;
  /** Whether the target is a tag (renders as tag pill instead of inline link) */
  readonly isTag: boolean;
  /** SVG icon path (mdi) if available */
  readonly effectiveIcon: string | null;
  /** Custom label set on the link (overrides node name) */
  readonly customLabel: string | null;
  /** Link resolution status: valid, broken (target deleted), or cycle (circular ref) */
  readonly linkStatus?: LinkStatus;
}

/**
 * Context provided to astToHtml for resolving node links.
 * The editor component builds this from React Query data.
 */
export interface ASTRenderContext {
  /** Resolve a link_id to display info. Returns null if unresolvable. */
  resolveLink: (linkId: string, refType: 'node' | 'class') => ResolvedLink | null;
}

// ─── HTML escaping ─────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Zero-width space helper ───────────────────────────────────────

/** Zero-width space used to create cursor anchoring points around pills. */
const ZWS = '\u200B';

// ─── AST → HTML ───────────────────────────────────────────────────

/**
 * Render an ASTDocument to an HTML string for a contenteditable div.
 *
 * The current content model uses a single paragraph (blocks are separate nodes),
 * so multi-paragraph documents just concatenate with <br> between paragraphs.
 */
export function astToHtml(ast: ASTDocument, ctx: ASTRenderContext): string {
  if (ast.length === 0) return '';

  // Single-paragraph case (most common)
  if (ast.length === 1) {
    return renderParagraphContent(ast[0], ctx);
  }

  // Multi-paragraph: separate with hard breaks (blocks don't embed paragraphs)
  return ast.map(p => renderParagraphContent(p, ctx)).join('<br>');
}

/**
 * Render the inline children of a paragraph.
 */
function renderParagraphContent(para: ASTParagraph, ctx: ASTRenderContext): string {
  if (para.children.length === 0) return '';

  const parts: string[] = [];
  const children = para.children;

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const html = renderInlineNode(node, ctx);
    parts.push(html);

    // Add ZWS after atomic pills if the next node is also a pill or nothing follows
    if (isAtomicNode(node)) {
      const next = children[i + 1];
      if (!next || isAtomicNode(next)) {
        parts.push(ZWS);
      }
    }
  }

  return parts.join('');
}

/**
 * Check if an inline node renders as an atomic (contenteditable=false) element.
 */
function isAtomicNode(node: ASTInlineNode): boolean {
  return node.type === 'node_link';
}

/**
 * Render a single inline node to HTML.
 */
function renderInlineNode(node: ASTInlineNode, ctx: ASTRenderContext): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.text);

    case 'hard_break':
      return '<br>';

    case 'node_link':
      return renderNodeLinkPill(node, ctx);

    case 'strong':
      return `<strong data-ast="strong">${renderChildren(node.children, ctx)}</strong>`;

    case 'em':
      return `<em data-ast="em">${renderChildren(node.children, ctx)}</em>`;

    case 'code':
      return `<code data-ast="code">${escapeHtml(node.text)}</code>`;

    case 'strikethrough':
      return `<s data-ast="strikethrough">${renderChildren(node.children, ctx)}</s>`;

    case 'highlight':
      return `<mark data-ast="highlight">${renderChildren(node.children, ctx)}</mark>`;

    case 'underline':
      return `<u data-ast="underline">${renderChildren(node.children, ctx)}</u>`;

    case 'external_link':
      return `<a data-ast="external_link" data-url="${escapeAttr(node.url)}" href="${escapeAttr(node.url)}" target="_blank" rel="noopener noreferrer">${renderChildren(node.children, ctx)}</a>`;

    default:
      return '';
  }
}

/**
 * Render children of a mark/link node.
 */
function renderChildren(children: ASTInlineNode[], ctx: ASTRenderContext): string {
  return children.map(c => renderInlineNode(c, ctx)).join('');
}

/**
 * Render a node_link as an atomic pill element.
 *
 * For 'node' ref_type: emits a placeholder span that will be hydrated
 *   with a React NodePill component via portal in the editor/display layer.
 * For 'class' ref_type: renders as class-pill HTML (no portal needed).
 */
function renderNodeLinkPill(node: ASTNodeLink, ctx: ASTRenderContext): string {
  if (node.ref_type === 'class') {
    // Type/class pill — keep as full HTML (resolved inline)
    const resolved = ctx.resolveLink(node.link_id, node.ref_type);
    const linkStatus = resolved?.linkStatus ?? (resolved ? 'valid' : 'broken');
    const displayText = resolved?.displayText ?? '…';
    const statusAttr = ` data-link-status="${linkStatus}"`;
    const statusClass = linkStatus !== 'valid' ? ` link-pill--${linkStatus}` : '';
    const tooltip = linkStatus === 'broken'
      ? ' title="Link target not found"'
      : linkStatus === 'cycle'
        ? ' title="Circular reference detected"'
        : '';
    const iconHtml = renderTagIcon();
    return `<span class="class-pill${statusClass}" contenteditable="false" data-ast="node_link" data-link-id="${escapeAttr(node.link_id)}" data-ref-type="class"${statusAttr}${tooltip}>${iconHtml}<span class="class-pill__text">${escapeHtml(displayText)}</span></span>`;
  }

  // All ref_type='node' links (regular pages, blocks, tags) → placeholder span.
  // The React layer mounts a NodePill component into this span via portal.
  return `<span class="node-link-mount" contenteditable="false" data-ast="node_link" data-link-id="${escapeAttr(node.link_id)}" data-ref-type="node"></span>`;
}

/**
 * Render the standard tag icon SVG used in type and tag pills.
 */
function renderTagIcon(): string {
  // mdiTag path
  const iconPath = 'M5.5,7A1.5,1.5 0 0,1 4,5.5A1.5,1.5 0 0,1 5.5,4A1.5,1.5 0 0,1 7,5.5A1.5,1.5 0 0,1 5.5,7M21.41,11.58L12.41,2.58C12.05,2.22 11.55,2 11,2H4C2.89,2 2,2.89 2,4V11C2,11.55 2.22,12.05 2.59,12.42L11.59,21.42C11.95,21.78 12.45,22 13,22C13.55,22 14.05,21.78 14.41,21.41L21.41,14.41C21.78,14.05 22,13.55 22,13C22,12.45 21.78,11.95 21.41,11.58Z';
  const iconSvg = `<svg viewBox="0 0 24 24" style="width: 14.4px; height: 14.4px;"><path fill="currentColor" d="${iconPath}"></path></svg>`;
  return `<span class="tag-pill__icon">${iconSvg}</span>`;
}

// ─── DOM → AST ────────────────────────────────────────────────────

/**
 * Extract an ASTDocument from a contenteditable element's live DOM.
 *
 * This is called after user edits (input events) to derive the new AST
 * from the DOM mutations the browser made.
 */
export function domToAST(element: HTMLElement): ASTDocument {
  const inlines = extractInlineNodes(element);
  if (inlines.length === 0) return [];

  // Split on hard_break to reconstruct paragraphs
  const paragraphs: ASTParagraph[] = [];
  let current: ASTInlineNode[] = [];

  for (const node of inlines) {
    if (node.type === 'hard_break') {
      paragraphs.push({ type: 'paragraph', children: current });
      current = [];
    } else {
      current.push(node);
    }
  }
  // Last paragraph
  if (current.length > 0 || paragraphs.length > 0) {
    paragraphs.push({ type: 'paragraph', children: current });
  }

  // Filter out completely empty paragraphs at the end (trailing <br>)
  while (paragraphs.length > 1 && paragraphs[paragraphs.length - 1].children.length === 0) {
    paragraphs.pop();
  }

  return paragraphs;
}

/**
 * Extract inline AST nodes from a DOM element, recursively.
 * Handles text nodes, pill elements, formatting elements, and BR tags.
 */
function extractInlineNodes(element: HTMLElement | ChildNode): ASTInlineNode[] {
  const result: ASTInlineNode[] = [];

  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Strip ZWS, collapse if only ZWS
      const text = (child.textContent || '').replace(/\u200B/g, '');
      if (text) {
        result.push({ type: 'text', text });
      }
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;

    // Check for atomic pill (node_link)
    if (el.dataset.ast === 'node_link') {
      const linkId = el.dataset.linkId || '';
      const refType = (el.dataset.refType as 'node' | 'class') || 'node';
      result.push({ type: 'node_link', link_id: linkId, ref_type: refType });
      continue;
    }

    // Check for inline-link class (atomic pill without data-ast, e.g. after paste)
    if (el.classList.contains('inline-link') || el.classList.contains('node-link-mount') || el.classList.contains('tag-pill') || el.classList.contains('class-pill')) {
      const linkId = el.dataset.linkId || '';
      const refType = (el.dataset.refType as 'node' | 'class') || (el.classList.contains('class-pill') ? 'class' : 'node');
      if (linkId) {
        result.push({ type: 'node_link', link_id: linkId, ref_type: refType });
        continue;
      }
    }

    // BR = hard break
    if (el.tagName === 'BR') {
      result.push({ type: 'hard_break' });
      continue;
    }

    // Formatting elements
    const astType = el.dataset.ast;

    if (astType === 'strong' || el.tagName === 'STRONG' || el.tagName === 'B') {
      result.push({ type: 'strong', children: extractInlineNodes(el) });
      continue;
    }

    if (astType === 'em' || el.tagName === 'EM' || el.tagName === 'I') {
      result.push({ type: 'em', children: extractInlineNodes(el) });
      continue;
    }

    if (astType === 'code' || el.tagName === 'CODE') {
      const text = (el.textContent || '').replace(/\u200B/g, '');
      result.push({ type: 'code', text });
      continue;
    }

    if (astType === 'strikethrough' || el.tagName === 'S' || el.tagName === 'STRIKE' || el.tagName === 'DEL') {
      result.push({ type: 'strikethrough', children: extractInlineNodes(el) });
      continue;
    }

    if (astType === 'highlight' || el.tagName === 'MARK') {
      result.push({ type: 'highlight', children: extractInlineNodes(el) });
      continue;
    }

    if (astType === 'underline' || el.tagName === 'U') {
      result.push({ type: 'underline', children: extractInlineNodes(el) });
      continue;
    }

    if (astType === 'external_link' || (el.tagName === 'A' && !el.classList.contains('inline-link'))) {
      const url = el.dataset.url || el.getAttribute('href') || '';
      // Only treat as external link if it has an actual URL
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        result.push({ type: 'external_link', url, children: extractInlineNodes(el) });
        continue;
      }
    }

    // DIV, SPAN, or other wrapper — recurse into children (browser may wrap in divs)
    const inner = extractInlineNodes(el);
    result.push(...inner);
  }

  return result;
}

// ─── AST normalization ─────────────────────────────────────────────

/**
 * Normalize an AST document by merging adjacent text nodes.
 *
 * After DOM extraction, the browser may have split a logical text node
 * into multiple DOM text nodes. This function merges them back.
 */
export function normalizeAST(ast: ASTDocument): ASTDocument {
  return ast.map(block => ({
    ...block,
    children: mergeAdjacentText(block.children),
  }));
}

/**
 * Merge adjacent text nodes in an inline node array.
 */
function mergeAdjacentText(nodes: ASTInlineNode[]): ASTInlineNode[] {
  if (nodes.length === 0) return nodes;

  const result: ASTInlineNode[] = [];
  for (const node of nodes) {
    const prev = result[result.length - 1];
    if (node.type === 'text' && prev?.type === 'text') {
      // Merge with previous text node (create new immutable node)
      result[result.length - 1] = { type: 'text', text: prev.text + node.text };
    } else if ('children' in node) {
      // Recursively normalize children of mark nodes
      const normalized = { ...node, children: mergeAdjacentText((node as { children: ASTInlineNode[] }).children) };
      result.push(normalized as ASTInlineNode);
    } else {
      result.push(node);
    }
  }
  return result;
}

// ─── Cursor position helpers ──────────────────────────────────────

/**
 * Get the plain-text cursor position within a contenteditable element.
 * Pills count as a single character position.
 * ZWS characters are excluded from the count.
 */
export function getCursorPosition(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  return getOffsetInElement(element, range.startContainer, range.startOffset);
}

/**
 * Calculate the character offset of a DOM position within an element.
 * Pills count as 1 character. ZWS is excluded.
 */
function getOffsetInElement(
  root: HTMLElement,
  targetContainer: globalThis.Node,
  targetOffset: number,
): number {
  let position = 0;
  let found = false;

  function walk(node: globalThis.Node): boolean {
    if (found) return true;

    if (node === targetContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        const textBefore = (node.textContent || '').substring(0, targetOffset);
        position += textBefore.replace(/\u200B/g, '').length;
      } else {
        // Element node — count children up to targetOffset
        for (let i = 0; i < targetOffset && i < node.childNodes.length; i++) {
          position += nodeContentLength(node.childNodes[i]);
        }
      }
      found = true;
      return true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      position += (node.textContent || '').replace(/\u200B/g, '').length;
      return false;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      // Atomic pill — count as 1 character
      // Important: don't recurse into pill children (React portal content)
      if (isPillElement(el)) {
        // Check if target is inside this pill (e.g., inside portal content)
        if (el.contains(targetContainer as Node)) {
          // Target is inside pill content — count pill as 1 and mark found
          position += 1;
          found = true;
          return true;
        }
        // Target is not inside — just count and continue
        position += 1;
        return false;
      }

      // Recurse into children
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
    }

    return false;
  }

  walk(root);
  return position;
}

/**
 * Get the content length of a DOM node for cursor counting purposes.
 * Pills = 1, text = character count minus ZWS, other elements = sum of children.
 */
function nodeContentLength(node: globalThis.Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/\u200B/g, '').length;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (isPillElement(el)) return 1;
    if (el.tagName === 'BR') return 0; // hard break doesn't count as text for cursor purposes

    let len = 0;
    for (const child of node.childNodes) {
      len += nodeContentLength(child);
    }
    return len;
  }
  return 0;
}

/**
 * Set the cursor position within a contenteditable element.
 * Position is in logical characters (pills=1, ZWS excluded).
 */
export function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  const result = findDOMPosition(element, targetPosition);
  if (!result) {
    // Fallback: position at end
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return;
  }

  const range = document.createRange();
  range.setStart(result.node, result.offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Find the DOM node and offset corresponding to a logical character position.
 */
function findDOMPosition(
  root: HTMLElement,
  targetPosition: number,
): { node: globalThis.Node; offset: number } | null {
  let currentPos = 0;

  function walk(node: globalThis.Node): { node: globalThis.Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      const cleanLength = text.replace(/\u200B/g, '').length;

      if (currentPos + cleanLength >= targetPosition) {
        // Target is within this text node
        const targetInNode = targetPosition - currentPos;
        // Map logical offset to actual offset (accounting for ZWS)
        let actualOffset = 0;
        let logicalCount = 0;
        for (let i = 0; i < text.length && logicalCount < targetInNode; i++) {
          if (text[i] !== '\u200B') logicalCount++;
          actualOffset = i + 1;
        }
        // Skip leading ZWS if at position 0
        if (actualOffset === 0 && text[0] === '\u200B') {
          actualOffset = 1;
        }
        return { node, offset: Math.min(actualOffset, text.length) };
      }
      currentPos += cleanLength;
      return null;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;

      // Atomic pill (including node-link-mount placeholders with portal content)
      if (isPillElement(el)) {
        // For node-link-mount, count the portal content as 1 character
        if (currentPos + 1 >= targetPosition) {
          // Position after this pill — find next text node
          const next = el.nextSibling;
          if (next && next.nodeType === Node.TEXT_NODE) {
            const text = next.textContent || '';
            const skipZws = text[0] === '\u200B' ? 1 : 0;
            return { node: next, offset: skipZws };
          }
          // Fallback: position after pill in parent
          const parent = el.parentNode;
          if (parent) {
            const idx = Array.from(parent.childNodes).indexOf(el as ChildNode);
            return { node: parent, offset: idx + 1 };
          }
        }
        currentPos += 1;
        return null;
      }

      // BR tags
      if (el.tagName === 'BR') {
        return null;
      }

      // Recurse into children
      for (const child of el.childNodes) {
        const result = walk(child);
        if (result) return result;
      }
    }

    return null;
  }

  const result = walk(root);
  if (result) return result;

  // Past end — position at end of element
  return null;
}

/**
 * Check if an element is an atomic pill (node link, type pill, or tag pill).
 */
function isPillElement(el: HTMLElement): boolean {
  return (
    el.dataset.ast === 'node_link' ||
    el.classList.contains('inline-link') ||
    el.classList.contains('node-link-mount') ||
    el.classList.contains('tag-pill') ||
    el.classList.contains('class-pill') ||
    el.classList.contains('link-pill')
  );
}

/**
 * Get the content length of the entire contenteditable.
 * Used for cursor boundary checks.
 */
export function getContentLength(element: HTMLElement): number {
  let len = 0;
  for (const child of element.childNodes) {
    len += nodeContentLength(child);
  }
  return len;
}

/**
 * Get the X position of the current caret for vertical navigation.
 */
export function getCaretX(): number | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return undefined;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return rect.left || rect.right;
}

/**
 * Get caret coordinates for popup positioning.
 */
export function getCaretCoordinates(element: HTMLDivElement): { top: number; left: number } {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const rect = element.getBoundingClientRect();
    return { top: rect.top + 24, left: rect.left };
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect.width === 0 && rect.height === 0) {
    const elementRect = element.getBoundingClientRect();
    return { top: elementRect.top + 24, left: elementRect.left };
  }

  return { top: rect.bottom + 4, left: rect.left };
}

/**
 * Get the plain-text content of the contenteditable, excluding ZWS
 * and using pill positions. Used for trigger detection.
 */
export function getPlainText(element: HTMLElement): string {
  let text = '';
  for (const child of element.childNodes) {
    text += getNodePlainText(child);
  }
  return text;
}

function getNodePlainText(node: globalThis.Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').replace(/\u200B/g, '');
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (isPillElement(el)) return '\uFFFC'; // Object replacement character for pills
    if (el.tagName === 'BR') return '';

    let text = '';
    for (const child of node.childNodes) {
      text += getNodePlainText(child);
    }
    return text;
  }
  return '';
}

// ─── Line detection for vertical navigation ───────────────────────

/**
 * Find the offset closest to a target X on the first visual line.
 */
export function findOffsetAtXInFirstLine(
  element: HTMLElement,
  targetX: number,
): number {
  const contentLength = getContentLength(element);
  if (contentLength === 0) return 0;

  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24;
  let firstLineY = Infinity;
  let bestOffset = 0;
  let bestDistance = Infinity;

  // First pass: find first line Y
  for (let i = 0; i <= contentLength; i++) {
    const rect = getRectAtOffset(element, i);
    if (rect && rect.top < firstLineY) firstLineY = rect.top;
  }

  // Second pass: find closest X on first line
  for (let i = 0; i <= contentLength; i++) {
    const rect = getRectAtOffset(element, i);
    if (rect && Math.abs(rect.top - firstLineY) < lineHeight * 0.5) {
      const dist = Math.abs(rect.left - targetX);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestOffset = i;
      }
    }
  }

  return bestOffset;
}

/**
 * Find the offset closest to a target X on the last visual line.
 */
export function findOffsetAtXInLastLine(
  element: HTMLElement,
  targetX: number,
): number {
  const contentLength = getContentLength(element);
  if (contentLength === 0) return 0;

  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 24;
  let lastLineY = -Infinity;
  let bestOffset = contentLength;
  let bestDistance = Infinity;

  // First pass: find last line Y
  for (let i = 0; i <= contentLength; i++) {
    const rect = getRectAtOffset(element, i);
    if (rect && rect.top > lastLineY) lastLineY = rect.top;
  }

  // Second pass: find closest X on last line
  for (let i = 0; i <= contentLength; i++) {
    const rect = getRectAtOffset(element, i);
    if (rect && Math.abs(rect.top - lastLineY) < lineHeight * 0.5) {
      const dist = Math.abs(rect.left - targetX);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestOffset = i;
      }
    }
  }

  return bestOffset;
}

/**
 * Get the bounding rect at a logical offset (for line detection).
 */
function getRectAtOffset(element: HTMLElement, offset: number): DOMRect | null {
  const pos = findDOMPosition(element, offset);
  if (!pos) return null;

  try {
    const range = document.createRange();
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  } catch {
    return null;
  }
}

// ─── Performance: Cached HTML rendering ────────────────────────────

/**
 * Cache key for astToHtml — avoids re-rendering the same AST+context.
 * Uses a WeakMap keyed on the AST array reference and a string hash of
 * the resolve context's results for the link_ids present in the AST.
 */
const htmlCache = new WeakMap<ASTDocument, { key: string; html: string }>();

/**
 * Render AST to HTML with caching.
 * Returns the cached result if the AST reference and the resolution
 * context produce the same output. The cache is invalidated when
 * either the AST object identity changes or the link resolutions change.
 */
export function astToHtmlCached(ast: ASTDocument, ctx: ASTRenderContext): string {
  // Build a cache key from link resolutions
  const linkIds = collectLinkIds(ast);
  const keyParts: string[] = [];
  for (const { id, refType } of linkIds) {
    const r = ctx.resolveLink(id, refType);
    keyParts.push(r ? `${id}:${r.displayText}:${r.linkStatus ?? 'valid'}:${r.isTag}` : `${id}:null`);
  }
  const cacheKey = keyParts.join('|');

  const cached = htmlCache.get(ast);
  if (cached && cached.key === cacheKey) {
    return cached.html;
  }

  const html = astToHtml(ast, ctx);
  htmlCache.set(ast, { key: cacheKey, html });
  return html;
}

/**
 * Collect all link_ids from an AST document (for cache key building).
 */
function collectLinkIds(ast: ASTDocument): Array<{ id: string; refType: 'node' | 'class' }> {
  const result: Array<{ id: string; refType: 'node' | 'class' }> = [];
  for (const para of ast) {
    collectFromInlines(para.children, result);
  }
  return result;
}

function collectFromInlines(
  nodes: ASTInlineNode[],
  out: Array<{ id: string; refType: 'node' | 'class' }>,
): void {
  for (const node of nodes) {
    if (node.type === 'node_link') {
      out.push({ id: node.link_id, refType: node.ref_type });
    } else if ('children' in node) {
      collectFromInlines((node as { children: ASTInlineNode[] }).children, out);
    }
  }
}

// ─── Autocomplete: Text extraction around cursor ───────────────────

/**
 * Extract the word being typed at the cursor position for autocomplete.
 * Returns the trigger character and query text, or null if no trigger active.
 *
 * Triggers:
 *   @ → type suggestion
 *   # → tag suggestion
 *   [[ → link suggestion
 *   / → slash command
 */
export interface TriggerMatch {
  /** The trigger type */
  type: 'type' | 'tag' | 'link' | 'slash';
  /** The query text after the trigger character(s) */
  query: string;
  /** Logical offset of the trigger character in the content */
  triggerOffset: number;
  /** Current cursor offset */
  cursorOffset: number;
}

/**
 * Detect the active trigger from the plain text content at the cursor.
 * This is a pure function operating on extracted plain text — no DOM access.
 */
export function detectTrigger(plainText: string, cursorOffset: number): TriggerMatch | null {
  if (cursorOffset <= 0) return null;

  const before = plainText.substring(0, cursorOffset);

  // Slash command: / at word boundary
  const slashIdx = before.lastIndexOf('/');
  if (slashIdx >= 0 && (slashIdx === 0 || /\s/.test(before[slashIdx - 1]))) {
    const query = before.substring(slashIdx + 1);
    if (!/\s/.test(query)) {
      return { type: 'slash', query, triggerOffset: slashIdx, cursorOffset };
    }
  }

  // Link trigger: [[
  const linkIdx = before.lastIndexOf('[[');
  // @ trigger
  const atIdx = before.lastIndexOf('@');
  // # trigger
  const hashIdx = before.lastIndexOf('#');

  type Candidate = { type: 'type' | 'tag' | 'link'; index: number; length: number };
  const candidates: Candidate[] = [];

  if (atIdx >= 0 && (atIdx === 0 || /\s/.test(before[atIdx - 1]))) {
    const q = before.substring(atIdx + 1);
    if (!/\s/.test(q)) candidates.push({ type: 'type', index: atIdx, length: 1 });
  }
  if (hashIdx >= 0 && (hashIdx === 0 || /\s/.test(before[hashIdx - 1]))) {
    const q = before.substring(hashIdx + 1);
    if (!/\s/.test(q)) candidates.push({ type: 'tag', index: hashIdx, length: 1 });
  }
  if (linkIdx >= 0 && !before.substring(linkIdx + 2).includes(']]')) {
    candidates.push({ type: 'link', index: linkIdx, length: 2 });
  }

  // Pick the rightmost (most recent) trigger
  const best = candidates.reduce<Candidate | null>((b, c) => (!b || c.index > b.index) ? c : b, null);
  if (!best) return null;

  const query = before.substring(best.index + best.length);
  return { type: best.type, query, triggerOffset: best.index, cursorOffset };
}

// ─── Diff-based rendering ──────────────────────────────────────────

/**
 * Check if only text content changed between two ASTs (no structural changes).
 * If so, we can patch the DOM in-place instead of re-rendering innerHTML.
 * Returns true if the ASTs have the same structure (same pill positions,
 * same mark nesting) and only text node values differ.
 */
export function isTextOnlyChange(prev: ASTDocument, next: ASTDocument): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!inlinesStructureEqual(prev[i].children, next[i].children)) return false;
  }
  return true;
}

function inlinesStructureEqual(a: ASTInlineNode[], b: ASTInlineNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (a[i].type === 'node_link' && b[i].type === 'node_link') {
      if ((a[i] as ASTNodeLink).link_id !== (b[i] as ASTNodeLink).link_id) return false;
    }
    if ('children' in a[i] && 'children' in b[i]) {
      if (!inlinesStructureEqual(
        (a[i] as { children: ASTInlineNode[] }).children,
        (b[i] as { children: ASTInlineNode[] }).children,
      )) return false;
    }
  }
  return true;
}
