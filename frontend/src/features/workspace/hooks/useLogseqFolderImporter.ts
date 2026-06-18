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
import { usePageClass } from '@/features/content';
import { nodeKeys } from '@/hooks/queryKeys';
import {
  batchCreateNodes,
  batchGetOrCreateDaily,
} from '@/api/nodes';
import { uploadAsset } from '@/features/assets';
import {
  countMdBlocks,
  type LogseqFolderResult,
} from '@/utils/logseqMdParser';
import { generateUUID } from '@/utils/uuid';
import type { FolderImportState, PageInfo } from './useLogseqFolderImporter.types';
import {
  BATCH_SIZE,
  BULK_HEADERS,
  parseDateLink,
  registerDateVariants,
  collectBlockAssetRefs,
  createBlocksRecursively,
} from './useLogseqFolderImporter.utils';

export type { FolderImportState };

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

    const referencedAssets = new Set<string>();
    for (const p of [...pages, ...journals]) {
      for (const ref of collectBlockAssetRefs(p.blocks)) {
        if (assetFiles.has(ref)) referencedAssets.add(ref);
      }
    }

    const hasAssets = referencedAssets.size > 0;
    const pjEnd = hasAssets ? 30 : 50;
    const assetEnd = hasAssets ? 55 : 50;
    const blockStart = assetEnd;
    let completed = 0;
    const titleMap = new Map<string, PageInfo>();
    const assetMap = new Map<string, PageInfo>();

    try {
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

      {
        const missingDates = new Map<string, string>();
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
