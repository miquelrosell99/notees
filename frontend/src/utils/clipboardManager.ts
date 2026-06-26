/**
 * Clipboard Manager
 * 
 * Centralized clipboard handling for blocks in edit mode.
 * Handles:
 * - Plain text paste (single/multi-line)
 * - HTML paste with sanitization to markdown
 * - Image/file paste (delegates to asset upload)
 * - Internal format paste (JSON block data)
 * - HTML table conversion to block-based tables
 * 
 * Multi-line paste creates sibling blocks.
 * HTML lists are converted to nested blocks respecting indentation.
 */

import type { Node } from '@/types';
import { generateUUID } from '@/utils/uuid';

// ==================== Runtime Graph Node Interface ====================
// Minimal structural interface so this module doesn't import from runtime
// (avoids circular dependency: runtime → api → clipboardManager → runtime).

interface RuntimeNodeLike {
  blockId: string;
  parentId: string | null;
  contentAST: unknown;
  icon?: string | null;
  color?: string | null;
  collapsed: boolean;
  classIds: string[];
  tagIds: string[];
}

interface RuntimeLike {
  getNode(id: string): RuntimeNodeLike | undefined;
  getChildren(parentId: string): RuntimeNodeLike[];
}

// ==================== Internal Copy Format ====================

/**
 * Internal block data format for copy/paste operations.
 * Contains all data needed to reconstruct blocks including properties, classes, etc.
 */
export interface BlockCopyData {
  /** Format version for backwards compatibility */
  version: 1;
  /** Format identifier */
  format: 'notees-blocks';
  /** Timestamp when copied */
  timestamp: string;
  /** Array of block data */
  blocks: BlockData[];
}

/**
 * Individual block data in the copy format
 */
export interface BlockData {
  /** Block UUID (for reference, new UUIDs generated on paste) */
  uuid?: string;
  /** Block content/name */
  name: string;
  /** Block icon */
  icon?: string | null;
  /** Block color */
  color?: string | null;
  /** Whether block is collapsed */
  collapsed?: boolean;
  /** Class IDs (UUIDs for portability) */
  classUuids?: string[];
  /** Tag IDs (UUIDs for portability) */
  tagUuids?: string[];
  /** Properties as key-value pairs (property UUID -> value) */
  properties?: Record<string, unknown>;
  /** Nested children blocks */
  children?: BlockData[];
}

// ==================== Clipboard Detection ====================

/**
 * Detected clipboard content type
 */
export type ClipboardContentType = 
  | 'image'
  | 'audio'
  | 'file'
  | 'internal-blocks'
  | 'html-table'
  | 'html-list'
  | 'html-text'
  | 'plain-multiline'
  | 'plain-single';

/**
 * Result of clipboard analysis
 */
export interface ClipboardAnalysis {
  type: ClipboardContentType;
  /** File if type is image/audio/file */
  file?: File;
  /** Internal block data if type is internal-blocks */
  blockData?: BlockCopyData;
  /** Parsed blocks if type requires block creation */
  blocks?: ParsedBlock[];
  /** Raw text content */
  text?: string;
  /** Raw HTML content */
  html?: string;
}

/**
 * Parsed block from clipboard content
 */
export interface ParsedBlock {
  content: string;
  depth: number;
  children?: ParsedBlock[];
}

// ==================== Internal Format Validation ====================

/**
 * Check if data is valid internal block copy format
 */
export function isValidBlockCopyData(data: unknown): data is BlockCopyData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.version === 1 &&
    obj.format === 'notees-blocks' &&
    Array.isArray(obj.blocks)
  );
}

/**
 * Try to parse internal format from clipboard text
 */
export function tryParseInternalFormat(text: string): BlockCopyData | null {
  try {
    const data = JSON.parse(text);
    if (isValidBlockCopyData(data)) {
      return data;
    }
  } catch {
    // Not JSON or invalid format
  }
  return null;
}

// ==================== HTML Parsing ====================

/**
 * Convert HTML to markdown-style text with formatting preserved
 * Strips dangerous elements, converts basic formatting tags
 */
export function htmlToMarkdown(html: string): string {
  // Create a temporary element to parse HTML
  const doc = new DOMParser().parseFromString(html, 'text/html');
  
  // Process the body content
  return processHtmlNode(doc.body).trim();
}

/**
 * Process an HTML node and convert to markdown
 * Using globalThis.Node to access DOM Node type (distinct from app's Node type)
 */
function processHtmlNode(domNode: globalThis.Node): string {
  if (domNode.nodeType === globalThis.Node.TEXT_NODE) {
    return domNode.textContent || '';
  }
  
  if (domNode.nodeType !== globalThis.Node.ELEMENT_NODE) {
    return '';
  }
  
  const el = domNode as Element;
  const tagName = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map(child => processHtmlNode(child)).join('');
  
  switch (tagName) {
    // Bold
    case 'b':
    case 'strong':
      return `**${children}**`;
    
    // Italic
    case 'i':
    case 'em':
      return `*${children}*`;
    
    // Underline (not standard markdown, use custom syntax)
    case 'u':
      return `__${children}__`;
    
    // Strikethrough
    case 's':
    case 'strike':
    case 'del':
      return `~~${children}~~`;
    
    // Code
    case 'code':
      return `\`${children}\``;
    
    // Preformatted/code block
    case 'pre':
      return `\`\`\`\n${children}\n\`\`\``;
    
    // Links
    case 'a': {
      const href = el.getAttribute('href');
      if (href) {
        return `[${children}](${href})`;
      }
      return children;
    }
    
    // Headers (strip for block content, keep text)
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return children;
    
    // Line breaks
    case 'br':
      return '\n';
    
    // Paragraphs and divs add line breaks
    case 'p':
    case 'div':
      return children + '\n';
    
    // Lists are handled separately - just return children here
    case 'ul':
    case 'ol':
    case 'li':
      return children;
    
    // Tables handled separately
    case 'table':
    case 'thead':
    case 'tbody':
    case 'tr':
    case 'td':
    case 'th':
      return children;
    
    // Skip script, style, and other dangerous elements
    case 'script':
    case 'style':
    case 'iframe':
    case 'object':
    case 'embed':
      return '';
    
    default:
      return children;
  }
}

/**
 * Parse HTML list into nested blocks
 */
export function parseHtmlList(html: string): ParsedBlock[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lists = doc.querySelectorAll('ul, ol');
  
  if (lists.length === 0) {
    return [];
  }
  
  // Process the first top-level list
  const firstList = lists[0];
  return parseListElement(firstList, 0);
}

/**
 * Recursively parse a list element into blocks
 */
function parseListElement(list: Element, depth: number): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  
  const items = Array.from(list.children).filter(
    child => child.tagName.toLowerCase() === 'li'
  );
  
  for (const item of items) {
    // Get the text content (excluding nested lists)
    let content = '';
    const children: ParsedBlock[] = [];
    
    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType === globalThis.Node.TEXT_NODE) {
        content += child.textContent || '';
      } else if (child.nodeType === globalThis.Node.ELEMENT_NODE) {
        const el = child as Element;
        const tagName = el.tagName.toLowerCase();
        
        if (tagName === 'ul' || tagName === 'ol') {
          // Nested list - parse as children
          children.push(...parseListElement(el, depth + 1));
        } else {
          // Other elements - convert to markdown and add to content
          content += processHtmlNode(child);
        }
      }
    }
    
    // Clean up content - remove list markers, trim
    content = cleanListContent(content.trim());
    
    if (content || children.length > 0) {
      blocks.push({
        content,
        depth,
        children: children.length > 0 ? children : undefined,
      });
    }
  }
  
  return blocks;
}

/**
 * Clean list content by removing common list markers
 */
function cleanListContent(text: string): string {
  // Remove common list markers at the start
  // - bullet points: •, -, *, ·
  // - numbered lists: 1., 2., 1), 2), (1), (2)
  // - letter lists: a., b., a), b)
  return text
    .replace(/^[\s]*[•\-*·]\s*/, '')
    .replace(/^[\s]*\d+[.)]\s*/, '')
    .replace(/^[\s]*\(\d+\)\s*/, '')
    .replace(/^[\s]*[a-zA-Z][.)]\s*/, '')
    .replace(/^[\s]*\([a-zA-Z]\)\s*/, '')
    .trim();
}

/**
 * Check if HTML contains a table
 */
export function containsHtmlTable(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector('table') !== null;
}

/**
 * Check if HTML contains a list
 */
export function containsHtmlList(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector('ul, ol') !== null;
}

/**
 * Parse HTML table into table structure
 */
export interface TableData {
  /** Table name/title (if caption exists) */
  name?: string;
  /** Column headers */
  headers: string[];
  /** Rows of cell values */
  rows: string[][];
}

export function parseHtmlTable(html: string): TableData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  
  if (!table) return null;
  
  // Get caption if exists
  const caption = table.querySelector('caption');
  const name = caption?.textContent?.trim();
  
  // Get headers from thead or first row
  const headers: string[] = [];
  const thead = table.querySelector('thead');
  
  if (thead) {
    const ths = thead.querySelectorAll('th');
    ths.forEach(th => headers.push(cleanListContent(th.textContent?.trim() || '')));
  }
  
  // Get rows from tbody or all tr elements
  const tbody = table.querySelector('tbody') || table;
  const trs = tbody.querySelectorAll('tr');
  const rows: string[][] = [];
  
  let skipFirst = false;
  
  // If no thead, first row might be headers
  if (headers.length === 0 && trs.length > 0) {
    const firstRow = trs[0];
    const ths = firstRow.querySelectorAll('th');
    
    if (ths.length > 0) {
      // First row has th elements - use as headers
      ths.forEach(th => headers.push(cleanListContent(th.textContent?.trim() || '')));
      skipFirst = true;
    } else {
      // Use first row td elements as headers
      const tds = firstRow.querySelectorAll('td');
      if (tds.length > 0) {
        tds.forEach(td => headers.push(cleanListContent(td.textContent?.trim() || '')));
        skipFirst = true;
      }
    }
  }
  
  // Parse data rows
  trs.forEach((tr, index) => {
    if (skipFirst && index === 0) return;
    
    const tds = tr.querySelectorAll('td, th');
    const row: string[] = [];
    tds.forEach(td => row.push(cleanListContent(td.textContent?.trim() || '')));
    
    if (row.length > 0) {
      rows.push(row);
    }
  });
  
  // Ensure all rows have same number of columns
  const maxCols = Math.max(headers.length, ...rows.map(r => r.length));
  
  // Pad headers if needed
  while (headers.length < maxCols) {
    headers.push(`Column ${headers.length + 1}`);
  }
  
  // Pad rows if needed
  rows.forEach(row => {
    while (row.length < maxCols) {
      row.push('');
    }
  });
  
  return { name, headers, rows };
}

// ==================== Plain Text Parsing ====================

/**
 * Detect the indentation unit used in text (tabs or spaces)
 * Returns the number of characters per indent level
 */
function detectIndentUnit(lines: string[]): { char: string; size: number } {
  // Check for tabs first (common in outliners)
  for (const line of lines) {
    const tabMatch = line.match(/^\t+/);
    if (tabMatch) {
      return { char: '\t', size: 1 };
    }
  }
  
  // Check for space-based indentation
  const spaceCounts: number[] = [];
  for (const line of lines) {
    const spaceMatch = line.match(/^( +)/);
    if (spaceMatch) {
      spaceCounts.push(spaceMatch[1].length);
    }
  }
  
  if (spaceCounts.length > 0) {
    // Find the GCD of all space counts to determine indent size
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const indentSize = spaceCounts.reduce((a, b) => gcd(a, b));
    return { char: ' ', size: Math.max(indentSize, 2) }; // Minimum 2 spaces per indent
  }
  
  // Default to tabs
  return { char: '\t', size: 1 };
}

/**
 * Get the indentation depth of a line
 */
function getLineDepth(line: string, indentChar: string, indentSize: number): number {
  if (indentChar === '\t') {
    const match = line.match(/^\t*/);
    return match ? match[0].length : 0;
  } else {
    const match = line.match(/^ */);
    return match ? Math.floor(match[0].length / indentSize) : 0;
  }
}

/**
 * Parse plain text into blocks (one per line), respecting indentation for hierarchy
 */
export function parsePlainText(text: string): ParsedBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ParsedBlock[] = [];
  
  // Detect indentation style
  const { char: indentChar, size: indentSize } = detectIndentUnit(lines);
  
  // Track minimum depth to normalize (in case all lines are indented)
  let minDepth = Infinity;
  const lineData: Array<{ content: string; depth: number }> = [];
  
  for (const line of lines) {
    const depth = getLineDepth(line, indentChar, indentSize);
    // Remove indentation, then clean list markers
    const trimmedLine = indentChar === '\t' 
      ? line.replace(/^\t+/, '')
      : line.replace(/^ +/, '');
    const content = cleanListContent(trimmedLine);
    
    if (content) {
      minDepth = Math.min(minDepth, depth);
      lineData.push({ content, depth });
    }
  }
  
  // Normalize depths (subtract minimum so first item is at depth 0)
  if (minDepth === Infinity) minDepth = 0;
  
  for (const { content, depth } of lineData) {
    blocks.push({ content, depth: depth - minDepth });
  }
  
  return blocks;
}

/**
 * Check if text contains multiple lines
 */
export function isMultiLine(text: string): boolean {
  return /\r?\n/.test(text.trim());
}

// ==================== Clipboard Analysis ====================

/**
 * Analyze clipboard data and determine content type and parsed data
 */
export function analyzeClipboard(clipboardData: DataTransfer): ClipboardAnalysis {
  // Check for files first (images, audio, etc.)
  if (clipboardData.files.length > 0) {
    const file = clipboardData.files[0];
    
    if (file.type.startsWith('image/')) {
      return { type: 'image', file };
    }
    if (file.type.startsWith('audio/')) {
      return { type: 'audio', file };
    }
    return { type: 'file', file };
  }
  
  // Check for items that might be files (for images pasted from clipboard)
  const items = clipboardData.items;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        if (file.type.startsWith('image/')) {
          return { type: 'image', file };
        }
        if (file.type.startsWith('audio/')) {
          return { type: 'audio', file };
        }
        return { type: 'file', file };
      }
    }
  }
  
  // Get text content
  const text = clipboardData.getData('text/plain') || '';
  const html = clipboardData.getData('text/html') || '';
  
  // Check for internal format first
  const internalData = tryParseInternalFormat(text);
  if (internalData) {
    return {
      type: 'internal-blocks',
      blockData: internalData,
      text,
    };
  }
  
  // Check HTML content
  if (html) {
    // Check for tables
    if (containsHtmlTable(html)) {
      return {
        type: 'html-table',
        html,
        text,
      };
    }
    
    // Check for lists
    if (containsHtmlList(html)) {
      const blocks = parseHtmlList(html);
      return {
        type: 'html-list',
        blocks,
        html,
        text,
      };
    }
    
    // HTML text (might have formatting)
    const markdown = htmlToMarkdown(html);
    if (isMultiLine(markdown)) {
      const blocks = parsePlainText(markdown);
      return {
        type: 'html-text',
        blocks,
        html,
        text: markdown,
      };
    }
    
    return {
      type: 'html-text',
      text: markdown.replace(/\n/g, ' ').trim(),
      html,
    };
  }
  
  // Plain text
  if (isMultiLine(text)) {
    const blocks = parsePlainText(text);
    return {
      type: 'plain-multiline',
      blocks,
      text,
    };
  }
  
  return {
    type: 'plain-single',
    text: cleanListContent(text),
  };
}

// ==================== Copy Operations ====================

/**
 * Create internal copy format from nodes
 */
export function createBlockCopyData(nodes: Node[]): BlockCopyData {
  return {
    version: 1,
    format: 'notees-blocks',
    timestamp: new Date().toISOString(),
    blocks: nodes.map(nodeToBlockData),
  };
}

/**
 * Convert a node to block data format
 */
function nodeToBlockData(node: Node): BlockData {
  return {
    uuid: node.uuid,
    name: node.name,
    icon: node.icon,
    color: node.color,
    collapsed: node.collapsed,
    // Note: In a real implementation, we'd need to resolve these IDs to UUIDs
    // This would require access to the class and tag node data
    children: node.children?.map(nodeToBlockData),
  };
}

/**
 * Safely copy text to clipboard, with fallback for non-secure contexts (HTTP).
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for insecure contexts where navigator.clipboard is undefined
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

/**
 * Copy blocks to clipboard in internal format
 */
export async function copyBlocksToClipboard(nodes: Node[]): Promise<void> {
  const data = createBlockCopyData(nodes);
  const json = JSON.stringify(data, null, 2);
  
  // Try to use ClipboardItem for rich clipboard support
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/plain': new Blob([json], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch {
      // Fall back to simple text copy
    }
  }
  
  // Fallback: copy JSON as plain text
  await copyToClipboard(json);
}

/**
 * Copy blocks to clipboard as plain text (names only)
 */
export async function copyBlocksAsText(nodes: Node[]): Promise<void> {
  const text = nodes.map(n => n.name).join('\n');
  await copyToClipboard(text);
}

// ==================== Flatten Blocks ====================

/**
 * Flatten nested ParsedBlocks into a flat array with depth info
 */
export function flattenBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  const result: ParsedBlock[] = [];
  
  function flatten(block: ParsedBlock, depth: number) {
    result.push({ ...block, depth, children: undefined });
    if (block.children) {
      for (const child of block.children) {
        flatten(child, depth + 1);
      }
    }
  }
  
  for (const block of blocks) {
    flatten(block, block.depth);
  }
  
  return result;
}

// ==================== Link UUID Generation ====================

/**
 * Generate a new link UUID
 */
export function generateLinkUuid(): string {
  return generateUUID();
}

/**
 * Regenerate link UUIDs in content to create new link instances
 * Matches both [[nodeId]] and [[nodeUuid:oldUuid]] formats
 */
export function regenerateLinkUuids(content: string): string {
  return content.replace(/\[\[([^\]:\s]+)(?::[a-f0-9-]+)?\]\]/g, (_match, nodeId) => {
    const newUuid = generateLinkUuid();
    return `[[${nodeId}:${newUuid}]]`;
  });
}

// ==================== Runtime-Based Copy ====================

/**
 * Build a BlockData tree from a runtime node and its descendants.
 * Used to capture the full structure of a block for copy/paste.
 */
function runtimeNodeToBlockData(
  blockId: string,
  runtime: RuntimeLike,
): BlockData | null {
  const node = runtime.getNode(blockId);
  if (!node) return null;

  const children = runtime.getChildren(blockId)
    .map(child => runtimeNodeToBlockData(child.blockId, runtime))
    .filter((c): c is BlockData => c !== null);

  return {
    uuid: node.blockId,
    // Store content as JSON string (AST) — same format as DB
    name: JSON.stringify(node.contentAST),
    icon: node.icon ?? null,
    color: node.color ?? null,
    collapsed: node.collapsed,
    classUuids: node.classIds.length > 0 ? [...node.classIds] : undefined,
    tagUuids: node.tagIds.length > 0 ? [...node.tagIds] : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

/**
 * Build a BlockCopyData snapshot from a set of block IDs in the runtime.
 *
 * Only top-level blocks are included at the root; any block whose parent
 * is also in `blockIds` is omitted (it will appear as a child of its parent).
 * Child blocks are captured recursively regardless of whether their IDs
 * appear in the input set.
 */
export function buildBlockCopyDataFromRuntime(
  blockIds: string[],
  runtime: RuntimeLike,
): BlockCopyData {
  const blockIdSet = new Set(blockIds);

  // Keep only top-level blocks (those whose parent is NOT also selected)
  const topLevelIds = blockIds.filter(id => {
    const node = runtime.getNode(id);
    if (!node) return false;
    return !node.parentId || !blockIdSet.has(node.parentId);
  });

  const blocks = topLevelIds
    .map(id => runtimeNodeToBlockData(id, runtime))
    .filter((b): b is BlockData => b !== null);

  return {
    version: 1,
    format: 'notees-blocks',
    timestamp: new Date().toISOString(),
    blocks,
  };
}

/**
 * Copy a set of runtime blocks to the system clipboard as internal format.
 * Returns the BlockCopyData so callers can update their clipboard store.
 */
export async function copyRuntimeBlocksToClipboard(
  blockIds: string[],
  runtime: RuntimeLike,
): Promise<BlockCopyData> {
  const data = buildBlockCopyDataFromRuntime(blockIds, runtime);
  await copyToClipboard(JSON.stringify(data));
  return data;
}
