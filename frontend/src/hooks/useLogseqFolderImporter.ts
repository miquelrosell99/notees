/**
 * useLogseqFolderImporter — shared hook for importing a parsed Logseq markdown folder.
 *
 * Extracted so both ImportLogseqFolderModal (standalone, command palette) and
 * ImportOptionsModal (workspace-creation flow) can run the same pipeline.
 *
 * Import phases:
 *  1. Create journal pages via batch daily API
 *  2. Create regular pages via batch create API
 *  3. Create blocks for each page/journal with wiki-link resolution
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePageClass } from '@/hooks';
import { nodeKeys } from '@/hooks/queryKeys';
import {
  batchCreateNodes,
  batchGetOrCreateDaily,
} from '@/api/nodes';
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

// ── AST helpers ──────────────────────────────────────────────────────

function buildBlockAst(
  content: string,
  titleMap: Map<string, PageInfo>,
): string {
  const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;
  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      children.push(astText(content.slice(lastIndex, matchStart)));
    }
    const pageName = match[1];
    const target = titleMap.get(pageName) ?? titleMap.get(pageName.toLowerCase());
    if (target) {
      const linkUuid = generateUUID();
      children.push(nodeLink(buildLinkId(target.uuid, linkUuid), 'node', pageName));
    } else {
      children.push(astText(match[0]));
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
  onProgress: (count: number) => void,
): Promise<void> {
  if (blocks.length === 0) return;

  const createItems = blocks.map((block, i) => {
    const cleaned = cleanBlockContent(block.content);
    if (!cleaned) return { name: '', sequence: startSeq + i };
    const name = buildBlockAst(cleaned, titleMap);
    return { name, parent_id: parentId, sequence: startSeq + i };
  });

  const resp = await batchCreateNodes({
    nodes: createItems,
    uuid_conflict_mode: 'return_existing',
  });

  onProgress(blocks.length);

  for (let i = 0; i < resp.results.length; i++) {
    const item = resp.results[i];
    if (item.success && item.node && blocks[i].children.length > 0) {
      await createBlocksRecursively(
        blocks[i].children,
        item.node.id,
        0,
        titleMap,
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

    const { pages, journals } = folderResult;
    const totalItems = pages.length + journals.length;
    let completed = 0;
    const titleMap = new Map<string, PageInfo>();

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
                titleMap.set(journal.title, { id: item.node.id, uuid: item.node.uuid });
                titleMap.set(journal.title.toLowerCase(), { id: item.node.id, uuid: item.node.uuid });
              }
            }
          }
          completed += batch.length;
          setProgress(Math.round((completed / totalItems) * 50));
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
          });

          for (let j = 0; j < resp.results.length; j++) {
            const item = resp.results[j];
            if (item.success && item.node) {
              const page = batch[j];
              titleMap.set(page.title, { id: item.node.id, uuid: item.node.uuid });
              titleMap.set(page.title.toLowerCase(), { id: item.node.id, uuid: item.node.uuid });
            }
          }

          completed += batch.length;
          setProgress(Math.round((completed / totalItems) * 50));
        }
      }

      // Phase 3: Create blocks
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
          (count) => {
            blocksDone += count;
            setProgress(50 + Math.round((blocksDone / Math.max(totalBlocks, 1)) * 50));
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
