/**
 * Parser for Logseq Markdown (.md) page files.
 *
 * Logseq MD format:
 *  - Filename (without .md) = page title
 *  - Lines starting with `- ` are top-level blocks
 *  - Indented `  - ` (tab or 2-space increments) create nested child blocks
 *  - `key:: value` at the page top are page-level properties
 *  - `key:: value` inside a block line are block-level properties (kept inline)
 *  - `[[page name]]` are wiki-links (preserved as-is in block text)
 */

export interface LogseqMdBlock {
  content: string;
  children: LogseqMdBlock[];
}

export interface LogseqMdPage {
  title: string;
  properties: Record<string, string>;
  blocks: LogseqMdBlock[];
}

/**
 * Derive a page title from a filename.
 * Strips the .md extension and decodes URI-style `%2F` → `/`, `___` → `/` (Logseq conventions).
 */
function titleFromFilename(filename: string): string {
  let name = filename;
  // Remove .md extension
  if (name.toLowerCase().endsWith('.md')) {
    name = name.slice(0, -3);
  }
  // Logseq encodes `/` as `___` in filenames
  name = name.replace(/___/g, '/');
  // Decode any percent-encoded chars
  try {
    name = decodeURIComponent(name);
  } catch {
    // ignore decode errors
  }
  return name;
}

/**
 * Parse a single Logseq markdown file into a LogseqMdPage.
 */
export function parseLogseqMd(filename: string, content: string): LogseqMdPage {
  const title = titleFromFilename(filename);
  const properties: Record<string, string> = {};
  const blocks: LogseqMdBlock[] = [];

  const lines = content.split('\n');
  let i = 0;

  // 1. Parse page-level properties at the top (before any `- ` block)
  //    Logseq properties look like `key:: value` (no leading dash)
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines at the top
    if (line.trim() === '') { i++; continue; }
    // Property line: `key:: value`
    const propMatch = line.match(/^([a-zA-Z_-][\w-]*):: (.*)$/);
    if (propMatch) {
      properties[propMatch[1]] = propMatch[2].trim();
      i++;
      continue;
    }
    // If it starts with `- `, we've hit blocks — stop property parsing
    break;
  }

  // 2. Parse outline blocks
  //    Each `- ` line (with optional leading whitespace) is a block.
  //    Indentation depth determines nesting.
  const stack: { depth: number; block: LogseqMdBlock }[] = [];

  for (; i < lines.length; i++) {
    const line = lines[i];

    // Match a bullet line: optional leading whitespace, then `- `
    const bulletMatch = line.match(/^(\s*)- (.*)$/);
    if (!bulletMatch) {
      // Continuation line — append to the last block if there is one
      if (stack.length > 0) {
        const lastBlock = stack[stack.length - 1].block;
        // Preserve line break in content
        lastBlock.content += '\n' + line.trimStart();
      }
      continue;
    }

    const indent = bulletMatch[1].length;
    const text = bulletMatch[2];

    const newBlock: LogseqMdBlock = { content: text, children: [] };

    // Find parent: pop stack until we find a shallower depth
    while (stack.length > 0 && stack[stack.length - 1].depth >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      // Top-level block
      blocks.push(newBlock);
    } else {
      // Child of the block on top of stack
      stack[stack.length - 1].block.children.push(newBlock);
    }

    stack.push({ depth: indent, block: newBlock });
  }

  return { title, properties, blocks };
}

/**
 * Parse multiple Logseq markdown files.
 */
export function parseLogseqMdFiles(
  files: { name: string; content: string }[],
): LogseqMdPage[] {
  return files.map((f) => parseLogseqMd(f.name, f.content));
}

/**
 * Count total blocks (including nested) across pages.
 */
export function countMdBlocks(blocks: LogseqMdBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    n += countMdBlocks(b.children);
  }
  return n;
}
