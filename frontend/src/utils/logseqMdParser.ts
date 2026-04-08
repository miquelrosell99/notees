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
  /** True when this page was parsed from the journals/ folder */
  isJournal?: boolean;
  /** ISO date string (YYYY-MM-DD) for journal pages */
  journalDate?: string;
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

/**
 * Extract all unique `[[page name]]` references from block content, recursively.
 */
export function collectWikiLinks(blocks: LogseqMdBlock[]): Set<string> {
  const links = new Set<string>();
  const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
  function walk(block: LogseqMdBlock) {
    for (const m of block.content.matchAll(WIKI_LINK_RE)) {
      links.add(m[1]);
    }
    for (const child of block.children) walk(child);
  }
  for (const b of blocks) walk(b);
  return links;
}

/**
 * Try to parse a journal filename (YYYY_MM_DD.md) into an ISO date.
 * Returns null if the filename doesn't match the expected pattern.
 */
function parseJournalDate(filename: string): string | null {
  const base = filename.replace(/\.md$/i, '');
  const m = base.match(/^(\d{4})_(\d{2})_(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = parseInt(mo, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** Result of parsing a whole Logseq markdown folder */
export interface LogseqFolderResult {
  pages: LogseqMdPage[];
  journals: LogseqMdPage[];
  /** All unique wiki-link targets found across all pages and journals */
  allLinks: Set<string>;
}

/**
 * Parse a Logseq folder uploaded via `webkitdirectory`.
 *
 * Expects file entries with `webkitRelativePath` like:
 *   "GraphName/pages/My Page.md"
 *   "GraphName/journals/2025_06_04.md"
 *
 * Files outside pages/ and journals/ are ignored.
 */
export function parseLogseqFolder(files: FileList): Promise<LogseqFolderResult> {
  const pageFiles: { name: string; content: string }[] = [];
  const journalFiles: { name: string; content: string }[] = [];

  const readPromises: Promise<void>[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file.name.toLowerCase().endsWith('.md')) continue;

    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split('/');
    // parts[0] = root folder, parts[1] = subfolder (pages/journals/...), parts[2..] = file
    if (parts.length < 3) continue;
    const subfolder = parts[1].toLowerCase();

    if (subfolder === 'pages' || subfolder === 'journals') {
      const fileName = parts.slice(2).join('/');
      readPromises.push(
        file.text().then((content) => {
          const entry = { name: fileName, content };
          if (subfolder === 'pages') {
            pageFiles.push(entry);
          } else {
            journalFiles.push(entry);
          }
        }),
      );
    }
  }

  return Promise.all(readPromises).then(() => {
    const pages: LogseqMdPage[] = pageFiles.map((f) => parseLogseqMd(f.name, f.content));

    const journals: LogseqMdPage[] = journalFiles.map((f) => {
      const page = parseLogseqMd(f.name, f.content);
      const date = parseJournalDate(f.name);
      if (date) {
        page.isJournal = true;
        page.journalDate = date;
      }
      return page;
    }).filter((p) => p.isJournal);

    // Collect all wiki-links across all parsed content
    const allLinks = new Set<string>();
    for (const p of [...pages, ...journals]) {
      for (const link of collectWikiLinks(p.blocks)) {
        allLinks.add(link);
      }
    }

    return { pages, journals, allLinks };
  });
}
