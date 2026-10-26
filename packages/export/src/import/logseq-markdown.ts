/**
 * Logseq Markdown grammar — the v1 client-side parser ported 1:1
 * (v1-archive: frontend/src/plugins/builtin/logseq_importer/utils/logseqMdParser.ts).
 * File-level only: folder traversal (FileList/webkitRelativePath) lives in the
 * web feature. `id::` properties parse like any page-level property; the
 * importer flow ignores them (fresh uuidv7 everywhere, per v1).
 */

export interface LogseqMdBlock {
  content: string;
  children: LogseqMdBlock[];
}

export interface LogseqMdPage {
  title: string;
  properties: Record<string, string>;
  blocks: LogseqMdBlock[];
  /** True when this page was parsed from the journals/ folder. */
  isJournal?: boolean;
  /** ISO date string (YYYY-MM-DD) for journal pages. */
  journalDate?: string;
}

/**
 * Derive a page title from a filename: strip `.md`, decode `___` → `/`
 * (Logseq's slash encoding) and percent-encoding.
 */
export function titleFromFilename(filename: string): string {
  let name = filename;
  if (name.toLowerCase().endsWith(".md")) name = name.slice(0, -3);
  name = name.replace(/___/g, "/");
  try {
    name = decodeURIComponent(name);
  } catch {
    // ignore decode errors
  }
  return name;
}

/** Parse a single Logseq markdown file into a LogseqMdPage. */
export function parseLogseqMd(filename: string, content: string): LogseqMdPage {
  const title = titleFromFilename(filename);
  const properties: Record<string, string> = {};
  const blocks: LogseqMdBlock[] = [];
  const lines = content.split("\n");
  let i = 0;

  // Page-level properties at the top (before any `- ` block), blank lines skipped.
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const propMatch = line.match(/^([a-zA-Z_-][\w-]*):: (.*)$/);
    if (propMatch) {
      properties[propMatch[1]!] = propMatch[2]!.trim();
      i++;
      continue;
    }
    break;
  }

  // Outline: `- ` bullets, nesting by indentation depth (any unit).
  const stack: { depth: number; block: LogseqMdBlock }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const bulletMatch = line.match(/^(\s*)- (.*)$/);
    if (!bulletMatch) {
      if (stack.length > 0) {
        const lastBlock = stack[stack.length - 1]!.block;
        lastBlock.content += "\n" + line.trimStart();
      }
      continue;
    }
    const indent = bulletMatch[1]!.length;
    const newBlock: LogseqMdBlock = { content: bulletMatch[2]!, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= indent) {
      stack.pop();
    }
    if (stack.length === 0) {
      blocks.push(newBlock);
    } else {
      stack[stack.length - 1]!.block.children.push(newBlock);
    }
    stack.push({ depth: indent, block: newBlock });
  }

  return { title, properties, blocks };
}

/** Parse multiple Logseq markdown files. */
export function parseLogseqMdFiles(files: { name: string; content: string }[]): LogseqMdPage[] {
  return files.map((f) => parseLogseqMd(f.name, f.content));
}

/** Count total blocks (including nested) across pages. */
export function countMdBlocks(blocks: LogseqMdBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) n += countMdBlocks(b.children);
  return n;
}

/** Extract all unique `[[page name]]` references from block content, recursively. */
export function collectWikiLinks(blocks: LogseqMdBlock[]): Set<string> {
  const links = new Set<string>();
  const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
  const walk = (block: LogseqMdBlock) => {
    for (const m of block.content.matchAll(WIKI_LINK_RE)) links.add(m[1]!);
    for (const child of block.children) walk(child);
  };
  for (const b of blocks) walk(b);
  return links;
}

const ASSET_REF_RE = /^!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?\s*$/;

/**
 * Extract the asset filename from a block's content if it is a pure-asset
 * reference (`![alt](../assets/filename){:attrs}`); null otherwise.
 */
export function extractAssetFilename(content: string): string | null {
  const m = content.match(ASSET_REF_RE);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse a journal filename (YYYY_MM_DD.md) into an ISO date; null when the
 * name doesn't match or the month/day is out of range.
 */
export function parseJournalDate(filename: string): string | null {
  const base = filename.replace(/\.md$/i, "");
  const m = base.match(/^(\d{4})_(\d{2})_(\d{2})$/);
  if (!m) return null;
  const y = m[1]!;
  const mo = m[2]!;
  const d = m[3]!;
  const month = parseInt(mo, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}
