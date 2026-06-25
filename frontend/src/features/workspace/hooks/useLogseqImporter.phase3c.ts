import { batchUpdateNodes, batchGetNodesByUuid, createNode as createNodeApi, getNode, getOrCreateDaily } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries';
import { useNavigationStore } from '@/stores';
import type { BatchNodeUpdateItem } from '@/types/api';
import type { PhaseResult, ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';
import { buildAstFromLogseqText } from './useLogseqImporter.ast';
import { createBlocksRecursively } from './useLogseqImporter.blocks';

export async function runPhase3c(ctx: ImportContext, p3: PhaseResult): Promise<void> {
  const { parsed, titleToNodeInfo, uuidMap, tempIdxToNodeInfo, nodeIdToProperties, existingPageMap, regularPageClasses, setImportStatus, tickN } = ctx;

  const regularPages = parsed.pages.filter(p => !p.journal);

  // 3g: Combined update — name + parent + sequence + classes + properties
  {
    setImportStatus('Preparing node content…');
    const combinedItems: BatchNodeUpdateItem[] = [];

    for (let i = 0; i < regularPages.length; i++) {
      const page = regularPages[i];
      const nodeInfo = titleToNodeInfo.get(page.title);
      if (!nodeInfo) continue;
      const existingPage = existingPageMap.get(page.title);
      const item: BatchNodeUpdateItem = { id: nodeInfo.id };
      if (!existingPage) {
        item.name = page.title;
        if (regularPageClasses[i].length > 0) item.classes = regularPageClasses[i];
      } else {
        if (ctx.override && nodeNameToText(existingPage.name) !== page.title) item.name = page.title;
        const existing = new Set(existingPage.classes ?? []);
        const toAdd = regularPageClasses[i].filter(c => !existing.has(c));
        if (toAdd.length > 0) item.classes = [...(existingPage.classes ?? []), ...toAdd];
      }
      // Set icon from logseq.property/icon (already converted to camelCase MDI name)
      if (page.icon && (!existingPage || ctx.override || !existingPage.icon)) item.icon = page.icon;
      const pageNodeProps = nodeIdToProperties.get(nodeInfo.id);
      if (pageNodeProps && Object.keys(pageNodeProps).length > 0) item.properties = pageNodeProps;
      if (item.name !== undefined || item.icon !== undefined || item.classes !== undefined || item.properties !== undefined) combinedItems.push(item);
    }

    for (const item of ctx.flatBlocks) {
      const nodeInfo = tempIdxToNodeInfo.get(item.tempIdx);
      if (!nodeInfo) continue;
      let parentId: number | undefined;
      if (item.parent.kind === 'page') {
        parentId = titleToNodeInfo.get(item.parent.title)?.id;
      } else {
        parentId = tempIdxToNodeInfo.get(item.parent.tempIdx)?.id;
      }
      if (!parentId) continue;
      let name = '';
      if (item.block.title) {
        try {
          const ast = buildAstFromLogseqText(item.block.title, uuidMap, titleToNodeInfo);
          name = ast.length > 0 ? JSON.stringify(ast) : '';
        } catch {
          name = item.block.title;
        }
      }
      const updateItem: BatchNodeUpdateItem = { id: nodeInfo.id, name, parent_id: parentId, sequence: item.sequence };
      if (item.classes.length > 0) updateItem.classes = item.classes;
      const blockNodeProps = nodeIdToProperties.get(nodeInfo.id);
      if (blockNodeProps && Object.keys(blockNodeProps).length > 0) updateItem.properties = blockNodeProps;
      combinedItems.push(updateItem);
    }

    const CONCURRENT_WIRES = 4;
    const BATCH_CHUNK = 500;
    const wireChunks: BatchNodeUpdateItem[][] = [];
    for (let offset = 0; offset < combinedItems.length; offset += BATCH_CHUNK) {
      wireChunks.push(combinedItems.slice(offset, offset + BATCH_CHUNK));
    }
    setImportStatus(`Wiring ${combinedItems.length} nodes… (0/${combinedItems.length})`);
    let wiresDone = 0;
    for (let ci = 0; ci < wireChunks.length; ci += CONCURRENT_WIRES) {
      const group = wireChunks.slice(ci, ci + CONCURRENT_WIRES);
      await Promise.allSettled(
        group.map(async (chunk) => {
          try {
            await batchUpdateNodes({ nodes: chunk });
          } catch (e) {
            console.error('Failed combined update pass:', e);
          }
          wiresDone += chunk.length;
          tickN(chunk.length);
          setImportStatus(`Wiring nodes… (${wiresDone}/${combinedItems.length})`);
        })
      );
    }
  }

  // Standalone blocks
  if (parsed.standaloneBlocks && parsed.standaloneBlocks.length > 0) {
    let parentUuid: string | undefined;
    let parentId: number | undefined;
    const activeNodeUuid = useNavigationStore.getState().currentNodeUuid;
    if (activeNodeUuid) {
      setImportStatus('Adding block to current node…');
      try {
        const batchResult = await batchGetNodesByUuid({ uuids: [activeNodeUuid] });
        const node = Object.values(batchResult.nodes)[0];
        if (node) {
          parentUuid = node.uuid;
          parentId = node.id;
        }
      } catch (e) {
        p3.failed++;
        p3.errors.push({ item: 'Standalone block (current node)', message: errorMessage(e) });
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      setImportStatus(`Adding block to today's page (${today})…`);
      try {
        const dayNode = await getOrCreateDaily(today);
        parentUuid = dayNode.uuid;
        parentId = dayNode.id;
      } catch (e) {
        p3.failed++;
        p3.errors.push({ item: 'Standalone block (daily page)', message: errorMessage(e) });
      }
    }
    if (parentUuid && parentId) {
      try {
        const parentNode = await getNode(parentUuid, { include_children: true });
        const startSeq = parentNode.children?.length ?? 0;
        await createBlocksRecursively(
          parsed.standaloneBlocks, parentId, startSeq, uuidMap, ctx.classIdMap, ctx.contentQueue, p3, ctx.override,
        );
      } catch (e) {
        p3.failed++;
        p3.errors.push({ item: 'Standalone block', message: errorMessage(e) });
      }
    }
  }

  // 3b: Set page parents (namespace hierarchy)
  const pagesWithParent = parsed.pages.filter(p => p.parent);
  if (pagesWithParent.length > 0) {
    const p3b = createPhase('Set page parents');
    ctx.phases.push(p3b);
    const titleToNodeInfoLower = new Map<string, { id: number; uuid: string }>();
    for (const [title, info] of titleToNodeInfo) {
      titleToNodeInfoLower.set(title.toLowerCase(), info);
    }
    const batchItems: Array<{ id: number; parent_id: number }> = [];
    const batchMeta: Array<{ pageTitle: string; parentTitle: string }> = [];
    for (const page of pagesWithParent) {
      const pageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
      let parentInfo = titleToNodeInfo.get(page.parent!)
        ?? titleToNodeInfoLower.get(page.parent!.toLowerCase());
      if (!pageInfo) {
        p3b.failed++;
        p3b.errors.push({ item: `${page.title} → ${page.parent}`, message: 'Page not found' });
        continue;
      }
      if (!parentInfo) {
        try {
          const { searchNodes } = await import('@/api/nodes');
          const searchResults = await searchNodes(page.parent!);
          const existing = searchResults.find(
            n => n.is_page && nodeNameToText(n.name).toLowerCase() === page.parent!.toLowerCase()
          );
          if (existing) {
            parentInfo = { id: existing.id, uuid: existing.uuid };
          } else {
            const newParent = await createNodeApi({ name: page.parent!, classes: [ctx.pageClassId] });
            parentInfo = { id: newParent.id, uuid: newParent.uuid };
          }
          titleToNodeInfo.set(page.parent!, parentInfo);
          titleToNodeInfoLower.set(page.parent!.toLowerCase(), parentInfo);
        } catch (e) {
          p3b.failed++;
          p3b.errors.push({ item: `${page.title} → ${page.parent}`, message: `Failed to create parent "${page.parent}": ${errorMessage(e)}` });
          continue;
        }
      }
      batchItems.push({ id: pageInfo.id, parent_id: parentInfo.id });
      batchMeta.push({ pageTitle: page.title, parentTitle: page.parent! });
    }
    if (batchItems.length > 0) {
      setImportStatus(`Setting page parents (${batchItems.length} pages)…`);
      const batchResult = await batchUpdateNodes({ nodes: batchItems });
      for (const result of batchResult.results) {
        if (result.success) {
          p3b.succeeded++;
        } else {
          p3b.failed++;
          const meta = batchMeta[result.index];
          p3b.errors.push({ item: `${meta?.pageTitle} → ${meta?.parentTitle}`, message: result.error || 'Unknown error' });
        }
      }
    }
  }
}
