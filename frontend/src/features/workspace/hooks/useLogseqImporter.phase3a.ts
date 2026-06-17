import { batchCreateNodes, batchGetOrCreateDaily, getNode } from '@/api/nodes';
import type { PhaseResult, ImportContext } from './useLogseqImporter.types';
import { errorMessage } from './useLogseqImporter.utils';

export async function runPhase3a(ctx: ImportContext, p3: PhaseResult): Promise<void> {
  const { parsed, options, override, uuidMap, titleToNodeInfo, existingNodeIds, existingPageMap, regularPageClasses, journalStartSeqs, setImportStatus, tick } = ctx;

  const journalPages = parsed.pages.filter(p => p.journal);
  const regularPages = parsed.pages.filter(p => !p.journal);

  // 3a: Journal pages — batch getOrCreateDaily
  const PAGE_CHUNK = 500;
  const CONCURRENT_PAGES = 4;
  if (journalPages.length > 0) {
    let journalsDone = 0;
    setImportStatus(`Creating journal pages… (0/${journalPages.length})`);
    const journalChunks: typeof journalPages[] = [];
    for (let offset = 0; offset < journalPages.length; offset += PAGE_CHUNK) {
      journalChunks.push(journalPages.slice(offset, offset + PAGE_CHUNK));
    }
    for (let ci = 0; ci < journalChunks.length; ci += CONCURRENT_PAGES) {
      const group = journalChunks.slice(ci, ci + CONCURRENT_PAGES);
      await Promise.allSettled(
        group.map(async (chunk) => {
          let batchDailyResult: Awaited<ReturnType<typeof batchGetOrCreateDaily>>;
          try {
            batchDailyResult = await batchGetOrCreateDaily(chunk.map(p => p.journal!));
          } catch (e) {
            for (const page of chunk) {
              p3.failed++;
              p3.errors.push({ item: `Journal: ${page.journal}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
              tick();
            }
            journalsDone += chunk.length;
            setImportStatus(`Creating journal pages… (${journalsDone}/${journalPages.length})`);
            return;
          }
          for (let i = 0; i < batchDailyResult.results.length; i++) {
            const result = batchDailyResult.results[i];
            const page = chunk[i];
            if (result.success && result.node) {
              existingNodeIds.add(result.node.id);
              if (page.uuid) uuidMap.set(page.uuid, { id: result.node.id, uuid: result.node.uuid });
              titleToNodeInfo.set(page.title, { id: result.node.id, uuid: result.node.uuid });
              p3.succeeded++;
            } else {
              p3.failed++;
              p3.errors.push({ item: `Journal: ${page.journal}${page.uuid ? ` [${page.uuid}]` : ''}`, message: result.error ?? 'Unknown error' });
            }
            tick();
          }
          journalsDone += chunk.length;
          setImportStatus(`Creating journal pages… (${journalsDone}/${journalPages.length})`);
        })
      );
    }
  }

  // 3b: Journal additive — fetch existing child counts
  if (!override) {
    await Promise.all(journalPages.map(async (page) => {
      if (page.blocks.length === 0) return;
      const nodeInfo = titleToNodeInfo.get(page.title);
      if (!nodeInfo) return;
      try {
        const fullDay = await getNode(nodeInfo.id, { include_children: true });
        journalStartSeqs.set(page.title, fullDay.children?.length ?? 0);
      } catch { /* default to 0 */ }
    }));
  }

  // 3c: Batch-create regular pages (UUID-based dedup)
  regularPageClasses.length = 0;
  regularPageClasses.push(...regularPages.map(page => {
    const cls = [ctx.pageClassId];
    if (page.tags) {
      for (const tag of page.tags) {
        const mapped = ctx.classIdMap.get(tag);
        if (mapped) cls.push(mapped);
      }
    }
    return cls;
  }));

  if (regularPages.length > 0) {
    let pagesDone = 0;
    setImportStatus(`Creating pages… (0/${regularPages.length})`);
    const pageChunks: typeof regularPages[] = [];
    for (let offset = 0; offset < regularPages.length; offset += PAGE_CHUNK) {
      pageChunks.push(regularPages.slice(offset, offset + PAGE_CHUNK));
    }
    for (let ci = 0; ci < pageChunks.length; ci += CONCURRENT_PAGES) {
      const group = pageChunks.slice(ci, ci + CONCURRENT_PAGES);
      await Promise.allSettled(
        group.map(async (chunk) => {
          try {
            const batchResult = await batchCreateNodes({
              nodes: chunk.map(page => {
                const overrideUuid = options.uuidOverrides?.[page.title];
                return {
                  ...(page.uuid ? { uuid: page.uuid } : overrideUuid ? { uuid: overrideUuid } : {}),
                };
              }),
              uuid_conflict_mode: 'return_existing',
            }, { headers: { 'X-Bulk-Import': 'true' } });
            for (let i = 0; i < batchResult.results.length; i++) {
              const result = batchResult.results[i];
              const page = chunk[i];
              if (result.success && result.node) {
                if (result.existing) {
                  existingNodeIds.add(result.node.id);
                  existingPageMap.set(page.title, result.node);
                }
                if (page.uuid) uuidMap.set(page.uuid, { id: result.node.id, uuid: result.node.uuid });
                titleToNodeInfo.set(page.title, { id: result.node.id, uuid: result.node.uuid });
                p3.succeeded++;
              } else {
                p3.failed++;
                p3.errors.push({ item: `Page: ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: result.error ?? 'Unknown error' });
              }
              tick();
            }
          } catch (e) {
            for (const page of chunk) {
              p3.failed++;
              p3.errors.push({ item: `Page: ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
              tick();
            }
          }
          pagesDone += chunk.length;
          setImportStatus(`Creating pages… (${pagesDone}/${regularPages.length})`);
        })
      );
    }
  }

  // 3d: Override mode — delete existing blocks
  if (override) {
    const { deleteExistingBlocks } = await import('./useLogseqImporter.utils');
    const existingPageIds = [...existingPageMap.values()].map(p => p.id);
    const journalIdsToDelete = journalPages
      .filter(p => p.blocks.length > 0)
      .map(p => titleToNodeInfo.get(p.title)?.id)
      .filter((id): id is number => id != null);
    const idsToDelete = [...new Set([...journalIdsToDelete, ...existingPageIds])];
    if (idsToDelete.length > 0) {
      await Promise.all(
        idsToDelete.map(async (id) => {
          try { await deleteExistingBlocks(id, ctx.queryClient); } catch (e) {
            console.error('Failed to delete existing blocks:', e);
          }
        }),
      );
    }
  }
}
