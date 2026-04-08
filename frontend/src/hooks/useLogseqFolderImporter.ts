/**
 * useLogseqFolderImporter — shared hook for importing a parsed Logseq markdown folder.
 *
 * Extracted so both ImportLogseqFolderModal (standalone, command palette) and
 * ImportOptionsModal (workspace-creation flow) can run the same pipeline.
 *
 * Import phases:
 *  1. Create journal pages via batch daily API
 *  2. Create regular pages via batch create API
 *  3. Upload assets — each ![...](../assets/file) is uploaded, building an assetMap
 *  4. Create blocks — wiki-links AND asset references resolved to node_link AST nodes
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePageClass } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import {
  batchCreateNodes,
  batchGetOrCreateDaily,
} from '@/api/nodes';
import { uploadAsset } from '@/api/assets';
import {
  countMdBlocks,
  type LogseqFolderResult,
  type LogseqMdBlock,
} from '@/utils/logseqMdParser';
import { text as astText, nodeLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';

// ── Types ────────────────────────────────────────────────────────────

interface PageInfo {
  id: number;
  uuid: string;
}

export interface FolderImportState {
  importing: boolean;
  progress: number;
  statusText: string;
  error: string | null;
  done: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

const BATCH_SIZE = 50;

/** Header to bypass rate limiting on batch endpoints during import. */
const BULK_HEADERS = { 'X-Bulk-Import': 'true' };

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Regex matching:
 *  1) [custom label]([[page name]])         → match[1] = label, match[2] = page name
 *  2) ![alt](../assets/filename){:attrs}    → match[3] = filename, match[4] = attrs
 *  3) [[wiki-links]]                        → match[5] = page name
 *
 * Ordered so the labelled-link alternative is tried FIRST (it contains [[…]]
 * inside, so putting plain [[…]] first would consume the inner link prematurely).
 */
const LINK_OR_ASSET_RE = /\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)|!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?|\[\[([^\]]+)\]\]/g;

/**
 * Try to interpret a wiki-link target as a date in any common format.
 * Returns an ISO date string (YYYY-MM-DD) on success, or null.
 */
function parseDateLink(link: string): string | null {
  // Accept both `/` and `-` as separators
  const m = link.match(/^(\d{1,4})[/\-](\d{1,2})[/\-](\d{1,4})$/);
  if (!m) return null;

  const [, a, b, c] = m;
  // Build candidates: YYYY/MM/DD, DD/MM/YYYY, MM/DD/YYYY
  const candidates: [number, number, number][] = [];
  if (a.length === 4) candidates.push([+a, +b, +c]);       // YYYY MM DD
  if (c.length === 4) {
    candidates.push([+c, +b, +a]);   // DD/MM/YYYY
    candidates.push([+c, +a, +b]);   // MM/DD/YYYY
  }

  for (const [y, mo, d] of candidates) {
    if (y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

/** Register all common date format variants for a daily page in the titleMap. */
function registerDateVariants(isoDate: string, info: PageInfo, titleMap: Map<string, PageInfo>) {
  const [y, m, d] = isoDate.split('-');
  const variants = [
    `${y}/${m}/${d}`, `${y}-${m}-${d}`,
    `${d}/${m}/${y}`, `${d}-${m}-${y}`,
    `${m}/${d}/${y}`, `${m}-${d}-${y}`,
  ];
  for (const v of variants) {
    if (!titleMap.has(v)) titleMap.set(v, info);
  }
}

/** Collect all unique asset filenames referenced in block trees. */
function collectBlockAssetRefs(blocks: LogseqMdBlock[]): Set<string> {
  const refs = new Set<string>();
  const ASSET_RE = /!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?/g;
  function walk(block: LogseqMdBlock) {
    for (const m of block.content.matchAll(ASSET_RE)) {
      refs.add(m[1]);
    }
    for (const child of block.children) walk(child);
  }
  for (const b of blocks) walk(b);
  return refs;
}

// ── AST helpers ──────────────────────────────────────────────────────

function buildBlockAst(
  content: string,
  titleMap: Map<string, PageInfo>,
  assetMap: Map<string, PageInfo>,
): string {
  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(LINK_OR_ASSET_RE)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      children.push(astText(content.slice(lastIndex, matchStart)));
    }

    if (match[1] !== undefined) {
      // Labelled link: [custom label]([[page name]])
      const label = match[1];
      const pageName = match[2];
      const target = titleMap.get(pageName) ?? titleMap.get(pageName.toLowerCase());
      if (target) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkUuid), 'node', label));
      } else {
        children.push(astText(match[0]));
      }
    } else if (match[3] !== undefined) {
      // Asset reference: ![alt](../assets/filename){:optional}
      const filename = match[3];
      const asset = assetMap.get(filename);
      if (asset) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(asset.uuid, linkUuid), 'node'));
      } else {
        children.push(astText(match[0]));
      }
    } else if (match[5] !== undefined) {
      // Plain wiki-link: [[page name]] — no label, editor resolves display name
      const pageName = match[5];
      const target = titleMap.get(pageName) ?? titleMap.get(pageName.toLowerCase());
      if (target) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkUuid), 'node'));
      } else {
        children.push(astText(match[0]));
      }
    }

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < content.length) {
    children.push(astText(content.slice(lastIndex)));
  }

  if (children.length === 0) return '';
  return JSON.stringify([paragraph(...children)]);
}

function cleanBlockContent(content: string): string {
  return content
    .replace(/\n?\s*collapsed:: (true|false)/g, '')
    .replace(/\n?\s*id:: [0-9a-f-]+/g, '')
    .replace(/\n?\s*background-color:: \w+/g, '')
    .trim();
}

async function createBlocksRecursively(
  blocks: LogseqMdBlock[],
  parentId: number,
  startSeq: number,
  titleMap: Map<string, PageInfo>,
  assetMap: Map<string, PageInfo>,
  onProgress: (count: number) => void,
): Promise<void> {
  if (blocks.length === 0) return;

  const createItems = blocks.map((block, i) => {
    const cleaned = cleanBlockContent(block.content);
    if (!cleaned) return { name: '', sequence: startSeq + i };
    const name = buildBlockAst(cleaned, titleMap, assetMap);
    return { name, parent_id: parentId, sequence: startSeq + i };
  });

  const resp = await batchCreateNodes({
    nodes: createItems,
    uuid_conflict_mode: 'return_existing',
  }, { headers: BULK_HEADERS });

  onProgress(blocks.length);

  for (let i = 0; i < resp.results.length; i++) {
    const item = resp.results[i];
    if (item.success && item.node && blocks[i].children.length > 0) {
      await createBlocksRecursively(
        blocks[i].children,
        item.node.id,
        0,
        titleMap,
        assetMap,
        onProgress,
      );
    }
  }
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useLogseqFolderImporter() {
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const queryClient = useQueryClient();
  const { pageClassId } = usePageClass();

  const reset = useCallback(() => {
    setImporting(false);
    setProgress(0);
    setStatusText('');
    setError(null);
    setDone(false);
  }, []);

  const runImport = useCallback(async (folderResult: LogseqFolderResult) => {
    if (!pageClassId) {
      setError('Page class not available. Please try again.');
      return;
    }

    setImporting(true);
    setError(null);
    setDone(false);
    setProgress(0);

    const { pages, journals, assetFiles, allLinks } = folderResult;
    const totalItems = pages.length + journals.length;

    // Collect all asset filenames actually referenced in blocks
    const referencedAssets = new Set<string>();
    for (const p of [...pages, ...journals]) {
      for (const ref of collectBlockAssetRefs(p.blocks)) {
        if (assetFiles.has(ref)) referencedAssets.add(ref);
      }
    }

    const hasAssets = referencedAssets.size > 0;
    // Progress: pages/journals 0-30%, assets 30-55%, blocks 55-100%
    // No assets: pages/journals 0-50%, blocks 50-100%
    const pjEnd = hasAssets ? 30 : 50;
    const assetEnd = hasAssets ? 55 : 50;
    const blockStart = assetEnd;
    let completed = 0;
    const titleMap = new Map<string, PageInfo>();
    const assetMap = new Map<string, PageInfo>();

    try {
      // Phase 1: Create journal pages
      if (journals.length > 0) {
        setStatusText(`Creating ${journals.length} journal pages…`);
        const dates = journals.map((j) => j.journalDate!);

        for (let i = 0; i < dates.length; i += BATCH_SIZE) {
          const batch = dates.slice(i, i + BATCH_SIZE);
          const resp = await batchGetOrCreateDaily(batch);
          for (const item of resp.results) {
            if (item.success && item.node) {
              const journal = journals.find((j) => j.journalDate === item.date);
              if (journal) {
                const info = { id: item.node.id, uuid: item.node.uuid };
                titleMap.set(journal.title, info);
                titleMap.set(journal.title.toLowerCase(), info);
                if (journal.journalDate) {
                  registerDateVariants(journal.journalDate, info, titleMap);
                }
              }
            }
          }
          completed += batch.length;
          setProgress(Math.round((completed / totalItems) * pjEnd));
        }
      }

      // Phase 2: Create regular pages
      if (pages.length > 0) {
        setStatusText(`Creating ${pages.length} pages…`);

        for (let i = 0; i < pages.length; i += BATCH_SIZE) {
          const batch = pages.slice(i, i + BATCH_SIZE);
          const createItems = batch.map((p) => ({
            name: p.title,
            classes: [pageClassId],
            uuid: generateUUID(),
          }));

          const resp = await batchCreateNodes({
            nodes: createItems,
            uuid_conflict_mode: 'return_existing',
          }, { headers: BULK_HEADERS });

          for (let j = 0; j < resp.results.length; j++) {
            const item = resp.results[j];
            if (item.success && item.node) {
              const page = batch[j];
              titleMap.set(page.title, { id: item.node.id, uuid: item.node.uuid });
              titleMap.set(page.title.toLowerCase(), { id: item.node.id, uuid: item.node.uuid });
            }
          }

          completed += batch.length;
          setProgress(Math.round((completed / totalItems) * pjEnd));
        }
      }

      // Phase 2b: Create daily pages for date links that have no journal file
      //   e.g. [[2026/04/08]] referenced in blocks but 2026_04_08.md doesn't exist
      {
        const missingDates = new Map<string, string>(); // ISO date → original link text
        for (const link of allLinks) {
          if (titleMap.has(link) || titleMap.has(link.toLowerCase())) continue;
          const iso = parseDateLink(link);
          if (iso && !missingDates.has(iso)) {
            missingDates.set(iso, link);
          }
        }
        if (missingDates.size > 0) {
          setStatusText(`Creating ${missingDates.size} referenced daily pages…`);
          const isoDates = [...missingDates.keys()];
          for (let i = 0; i < isoDates.length; i += BATCH_SIZE) {
            const batch = isoDates.slice(i, i + BATCH_SIZE);
            const resp = await batchGetOrCreateDaily(batch);
            for (const item of resp.results) {
              if (item.success && item.node) {
                const info = { id: item.node.id, uuid: item.node.uuid };
                registerDateVariants(item.date, info, titleMap);
              }
            }
          }
        }
      }

      // Phase 3: Upload referenced assets
      if (referencedAssets.size > 0) {
        const assetList = [...referencedAssets];
        let assetsDone = 0;

        for (const filename of assetList) {
          const file = assetFiles.get(filename)!;
          try {
            setStatusText(`Uploading asset: ${filename}`);
            const asset = await uploadAsset(file);
            assetMap.set(filename, { id: asset.node_id, uuid: asset.uuid });
          } catch (err) {
            console.warn(`[FolderImport] Failed to upload asset ${filename}:`, err);
          }
          assetsDone++;
          setProgress(pjEnd + Math.round((assetsDone / assetList.length) * (assetEnd - pjEnd)));
        }
      }

      // Phase 4: Create blocks (with wiki-link + asset-link resolution)
      const allEntries = [
        ...pages.map((p) => ({ page: p, key: p.title })),
        ...journals.map((j) => ({ page: j, key: j.title })),
      ];
      let blocksDone = 0;
      const totalBlocks = allEntries.reduce((s, e) => s + countMdBlocks(e.page.blocks), 0);

      for (const entry of allEntries) {
        const parentInfo = titleMap.get(entry.key);
        if (!parentInfo || entry.page.blocks.length === 0) continue;

        setStatusText(`Adding blocks to: ${entry.key}`);

        await createBlocksRecursively(
          entry.page.blocks,
          parentInfo.id,
          0,
          titleMap,
          assetMap,
          (count) => {
            blocksDone += count;
            setProgress(blockStart + Math.round((blocksDone / Math.max(totalBlocks, 1)) * (100 - blockStart)));
          },
        );
      }

      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
      setProgress(100);
      setStatusText('Import complete!');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [pageClassId, queryClient]);

  return { importing, progress, statusText, error, done, reset, runImport, pageClassId };
}
