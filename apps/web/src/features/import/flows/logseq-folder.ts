/**
 * logseq-folder flow — the v1 client-side Logseq Markdown-folder importer
 * ported 1:1 (spec §2): the folder walk (FileList + webkitRelativePath,
 * pages/ + journals/ + assets/), the pageMap seeded from page titles then
 * wiki-link stub pages, `[[links]]` → mention tokens when the target
 * resolves (literal text otherwise), pure-asset blocks and inline refs →
 * asset uploads + asset_ref tokens (literal when unresolvable), journals
 * parented under the v2 date chain's day node. Re-runs duplicate pages —
 * the v1 sharp edge, documented in the feature doc, not silently fixed.
 *
 * The parse/preview half is pure (client-free) so the grammar round-trips
 * without a store; the write half rides the ordinary client op path.
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";
import {
  collectWikiLinks,
  countMdBlocks,
  extractAssetFilename,
  parseJournalDate,
  parseLogseqMd,
  type LogseqMdBlock,
  type LogseqMdPage,
} from "@notees/export";
import { uuidv7 } from "uuidv7";

import type { AnyClient } from "../../collection/types.js";
import type { AssetUploadResult } from "@/core/workspace-client/index.js";
import { createNodeWithId, runImportTasks, type ImportTask } from "../import-writes.js";

export interface LogseqFolderParsed {
  pages: LogseqMdPage[];
  journals: LogseqMdPage[];
  /** All unique wiki-link targets across pages and journals. */
  allLinks: Set<string>;
  /** Asset files found in the assets/ subfolder (folder-relative name → file). */
  assetFiles: Map<string, File>;
}

function normalizePageTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** File → text, with a FileReader fallback for jsdom (whose Blob lacks text()). */
async function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * The v1 `parseLogseqFolder` traversal: file entries carry
 * `webkitRelativePath` like "Graph/pages/My Page.md"; files outside
 * pages/ and journals/ are ignored; assets/ files are kept as File
 * objects for the upload phase.
 */
export async function parseLogseqFolderFiles(
  files: Iterable<File>,
): Promise<LogseqFolderParsed> {
  const pageFiles: Array<{ name: string; content: string }> = [];
  const journalFiles: Array<{ name: string; content: string }> = [];
  const assetFiles = new Map<string, File>();
  const reads: Promise<void>[] = [];

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split("/");
    // parts[0] = the picked root folder; parts[1] = the subfolder.
    if (parts.length < 3) continue;
    const subfolder = parts[1]!.toLowerCase();
    const fileName = parts.slice(2).join("/");

    if (subfolder === "assets") {
      assetFiles.set(fileName, file);
      continue;
    }
    if (!file.name.toLowerCase().endsWith(".md")) continue;
    if (subfolder !== "pages" && subfolder !== "journals") continue;

    const target = subfolder === "pages" ? pageFiles : journalFiles;
    reads.push(
      readText(file).then((content) => {
        target.push({ name: fileName, content });
      }),
    );
  }
  await Promise.all(reads);

  const pages = pageFiles.map((f) => parseLogseqMd(f.name, f.content));
  const journals = journalFiles
    .map((f) => {
      const page = parseLogseqMd(f.name, f.content);
      const date = parseJournalDate(f.name);
      if (date !== null) {
        page.isJournal = true;
        page.journalDate = date;
      }
      return page;
    })
    .filter((p) => p.isJournal === true);

  const allLinks = new Set<string>();
  for (const page of [...pages, ...journals]) {
    for (const link of collectWikiLinks(page.blocks)) allLinks.add(link);
  }

  return { pages, journals, allLinks, assetFiles };
}

/**
 * The v1 pageMap: normalized title → fresh id, explicit pages first
 * (pages + journals), then wiki-link targets that named no page get STUB
 * pages (v1 semantics — the stubs are real pages with the link's title).
 */
export function buildPageMap(
  parsed: Pick<LogseqFolderParsed, "pages" | "journals" | "allLinks">,
  newId: () => string = uuidv7,
): Map<string, string> {
  const pageMap = new Map<string, string>();
  for (const page of [...parsed.pages, ...parsed.journals]) {
    const key = normalizePageTitle(page.title);
    if (!pageMap.has(key)) pageMap.set(key, newId());
  }
  for (const title of parsed.allLinks) {
    const key = normalizePageTitle(title);
    if (!pageMap.has(key)) pageMap.set(key, newId());
  }
  return pageMap;
}

/** An uploaded asset's identity for the token map. */
export interface ImportedAssetRef {
  /** The CAS asset id the asset_ref token references. */
  assetId: string;
}

const ASSET_INLINE_RE = /!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)/g;
const WIKI_OR_ASSET_RE = /(\[\[([^\]]+)\]\])|(!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\))/g;

/**
 * Block content → the v2 inline token stream (the v1 `parseInlineContent`
 * port): `[[page]]` becomes a mention token when the target resolves in
 * the pageMap, an inline asset ref becomes an asset_ref token when the
 * file uploaded, and anything unresolved stays LITERAL text (never
 * guessed). Multi-line blocks join lines with hard breaks (the v1
 * per-line paragraphs collapsed into one block row).
 */
export function blockContentToContentAst(
  content: string,
  pageMap: ReadonlyMap<string, string>,
  assetMap: ReadonlyMap<string, ImportedAssetRef>,
): ContentAst {
  const pureAsset = extractAssetFilename(content);
  if (pureAsset !== null) {
    const asset = assetMap.get(pureAsset);
    if (asset !== undefined) return [{ type: "asset_ref", assetId: asset.assetId }];
  }

  const lines = content.split("\n");
  const out: ContentAst = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) out.push({ type: "hard_break" });
    let pos = 0;
    WIKI_OR_ASSET_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKI_OR_ASSET_RE.exec(line)) !== null) {
      if (match.index > pos) out.push({ type: "text", text: line.slice(pos, match.index) });
      if (match[2] !== undefined) {
        const target = pageMap.get(normalizePageTitle(match[2]));
        out.push(
          target !== undefined
            ? { type: "mention", targetNodeId: target }
            : { type: "text", text: match[0] },
        );
      } else {
        const asset = assetMap.get(match[4]!);
        out.push(
          asset !== undefined
            ? { type: "asset_ref", assetId: asset.assetId }
            : { type: "text", text: match[0] },
        );
      }
      pos = match.index + match[0].length;
    }
    if (pos < line.length) out.push({ type: "text", text: line.slice(pos) });
  });
  return out;
}

/** Count the link tokens an AST carries (the v1 linksCreated metric). */
export function countLinkTokens(ast: ContentAst): number {
  return ast.filter((token) => token.type === "mention" || token.type === "asset_ref").length;
}

export interface LogseqFolderProgress {
  current: number;
  total: number;
  message: string;
}

export interface LogseqFolderReport {
  pagesCreated: number;
  blocksCreated: number;
  linksCreated: number;
  assetsUploaded: number;
  errors: string[];
}

export interface ImportLogseqFolderOptions {
  /** Asset upload override (tests inject; default rides client.uploadAsset). */
  uploadAsset?: (file: File) => Promise<ImportedAssetRef>;
  onProgress?: (progress: LogseqFolderProgress) => void;
}

/** Every asset filename referenced by the pages (pure-asset blocks + inline refs). */
export function collectAssetReferences(pages: readonly LogseqMdPage[]): Set<string> {
  const refs = new Set<string>();
  const scan = (block: LogseqMdBlock): void => {
    const pure = extractAssetFilename(block.content);
    if (pure !== null) refs.add(pure);
    ASSET_INLINE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ASSET_INLINE_RE.exec(block.content)) !== null) {
      refs.add(match[1]!);
    }
    for (const child of block.children) scan(child);
  };
  for (const page of pages) for (const block of page.blocks) scan(block);
  return refs;
}

async function defaultUploadAsset(client: AnyClient, file: File): Promise<ImportedAssetRef> {
  const uploaded: AssetUploadResult = await client.uploadAsset(file, file.name);
  // The Zotero-style asset node (the AssetUploadModal convention): the
  // asset class names the node, attachAsset ties it to the CAS bytes.
  const assetNodeId = await client.createObject({
    isEmbedded: false,
    name: uploaded.originalName,
    classIds: [SYSTEM_CLASS_UUIDS.asset],
  });
  await client.attachAsset(assetNodeId, uploaded);
  return { assetId: uploaded.assetId };
}

/**
 * The v1 `importLogseqFolderToStore` write phase: upload referenced
 * assets, create every page (journals under their date-chain day node),
 * then the nested blocks with per-parent afterId ordering. Per-item
 * failures land in the report's error list and the import continues.
 */
export async function importLogseqFolder(
  client: AnyClient,
  parsed: LogseqFolderParsed,
  options: ImportLogseqFolderOptions = {},
): Promise<LogseqFolderReport> {
  const report: LogseqFolderReport = {
    pagesCreated: 0,
    blocksCreated: 0,
    linksCreated: 0,
    assetsUploaded: 0,
    errors: [],
  };
  const notify = (current: number, total: number, message: string): void =>
    options.onProgress?.({ current, total, message });
  const allPages = [...parsed.pages, ...parsed.journals];

  // --- assets -------------------------------------------------------------
  const assetRefs = collectAssetReferences(allPages);
  const assetMap = new Map<string, ImportedAssetRef>();
  let done = 0;
  for (const filename of assetRefs) {
    const file = parsed.assetFiles.get(filename);
    if (file === undefined) {
      report.errors.push(`Asset file not found: ${filename}`);
      continue;
    }
    try {
      const uploaded =
        options.uploadAsset !== undefined
          ? await options.uploadAsset(file)
          : await defaultUploadAsset(client, file);
      assetMap.set(filename, uploaded);
      report.assetsUploaded += 1;
      done += 1;
      notify(done, assetRefs.size, `Uploaded ${filename}`);
    } catch (error) {
      report.errors.push(
        `Failed to upload asset ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- page ids -------------------------------------------------------------
  const pageMap = buildPageMap(parsed);
  const titles = new Map<string, string>();
  for (const page of allPages) {
    const id = pageMap.get(normalizePageTitle(page.title));
    if (id !== undefined) titles.set(id, page.title);
  }
  for (const title of parsed.allLinks) {
    const id = pageMap.get(normalizePageTitle(title));
    if (id !== undefined && !titles.has(id)) titles.set(id, title);
  }

  // --- pages ---------------------------------------------------------------
  const journalDayOf = new Map<string, string>();
  for (const journal of parsed.journals) {
    if (journal.journalDate !== undefined) {
      const id = pageMap.get(normalizePageTitle(journal.title));
      if (id !== undefined) journalDayOf.set(id, journal.journalDate);
    }
  }

  let pagesDone = 0;

  // Pages sequentially (journal pages need their day chain ensured in order).
  for (const [pageId, title] of titles) {
    try {
      const journalDate = journalDayOf.get(pageId);
      let parentId: string | null = null;
      if (journalDate !== undefined) {
        const { day } = await client.ensureDateChain(journalDate);
        parentId = day;
      }
      await createNodeWithId(client, { id: pageId, name: title, parentId, isEmbedded: false });
      report.pagesCreated += 1;
      pagesDone += 1;
      notify(pagesDone, titles.size, `Created page: ${title}`);
    } catch (error) {
      report.errors.push(
        `Failed to create page "${title}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- blocks ---------------------------------------------------------------
  // The whole tree is planned upfront with PRE-MINTED ids: every task knows
  // its own id, its parent chain, and its afterId anchor, so the bounded
  // scheduler can run pages in parallel while each chain authors its
  // siblings in order. A task awaits its parent's readiness before writing
  // (a child chain may be picked up by another worker before the parent's
  // task has run); failures mark the subtree and resolve the waiters, so
  // one bad block never hangs the import.
  const totalBlocks = allPages.reduce((sum, p) => sum + countMdBlocks(p.blocks), 0);
  let blocksDone = 0;

  interface PlannedBlock {
    id: string;
    parentId: string;
    afterId: string | undefined;
    block: LogseqMdBlock;
  }
  const plan: PlannedBlock[] = [];
  const planBlocks = (blocks: LogseqMdBlock[], parentId: string): void => {
    let previousId: string | undefined;
    for (const block of blocks) {
      const id = uuidv7();
      plan.push({ id, parentId, afterId: previousId, block });
      planBlocks(block.children, id);
      previousId = id;
    }
  };
  for (const page of allPages) {
    const pageId = pageMap.get(normalizePageTitle(page.title));
    if (pageId === undefined) continue;
    planBlocks(page.blocks, pageId);
  }

  const ready = new Map<string, Promise<boolean>>();
  const readyResolve = new Map<string, (value: boolean) => void>();
  for (const entry of plan) {
    ready.set(
      entry.id,
      new Promise<boolean>((resolve) => {
        readyResolve.set(entry.id, resolve);
      }),
    );
  }

  const tasks: ImportTask[] = plan.map((entry) => ({
    parentKey: entry.parentId,
    run: async () => {
      // Page parents predate the scheduler run; block parents resolve through
      // the readiness map (undefined = a page id = already created).
      const parentOk = (await ready.get(entry.parentId)) ?? true;
      if (parentOk === false) {
        report.errors.push("Failed to create block: parent block failed");
        readyResolve.get(entry.id)?.(false);
        return;
      }
      try {
        const ast = blockContentToContentAst(entry.block.content, pageMap, assetMap);
        await createNodeWithId(client, {
          id: entry.id,
          parentId: entry.parentId,
          ...(entry.afterId !== undefined ? { afterId: entry.afterId } : {}),
          contentAst: ast,
        });
        report.blocksCreated += 1;
        report.linksCreated += countLinkTokens(ast);
        blocksDone += 1;
        notify(blocksDone, totalBlocks, `Created block ${blocksDone}/${totalBlocks}`);
        readyResolve.get(entry.id)?.(true);
      } catch (error) {
        report.errors.push(
          `Failed to create block: ${error instanceof Error ? error.message : String(error)}`,
        );
        readyResolve.get(entry.id)?.(false);
      }
    },
  }));

  await runImportTasks(tasks, { parallelism: 4 });

  return report;
}
