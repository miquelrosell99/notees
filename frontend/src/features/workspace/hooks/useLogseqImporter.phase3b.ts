import { batchCreateNodes } from '@/api/nodes';
import type { LogseqBlock } from '@/utils/ednParser';
import type { NodeInfo, PhaseResult, ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';
import { assignProperties, assignBlockProperties } from './useLogseqImporter.properties';

export async function runPhase3b(ctx: ImportContext, p3: PhaseResult): Promise<void> {
  const { parsed, classIdMap, titleToNodeInfo, uuidMap, tempIdxToNodeInfo, nodeIdToProperties, journalStartSeqs, setImportStatus, tick } = ctx;

  const journalPages = parsed.pages.filter(p => p.journal);
  const regularPages = parsed.pages.filter(p => !p.journal);

  // 3f: Flatten ALL block trees
  type FlatBlock = {
    block: LogseqBlock;
    classes: number[];
    parent: { kind: 'page'; title: string } | { kind: 'block'; tempIdx: number };
    sequence: number;
    tempIdx: number;
  };
  const flatBlocks: FlatBlock[] = [];
  let nextTempIdx = 0;

  const collectFlatBlocks = (
    blocks: LogseqBlock[],
    parent: FlatBlock['parent'],
    startSeq: number,
  ) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const classes: number[] = [];
      if (block.tags) {
        for (const tag of block.tags) {
          const mapped = classIdMap.get(tag);
          if (mapped) classes.push(mapped);
        }
      }
      const tempIdx = nextTempIdx++;
      flatBlocks.push({ block, classes, parent, sequence: startSeq + i, tempIdx });
      if (block.children?.length) {
        collectFlatBlocks(block.children, { kind: 'block', tempIdx }, 0);
      }
    }
  };

  for (const page of regularPages) {
    if (page.blocks.length === 0) continue;
    if (!titleToNodeInfo.has(page.title)) continue;
    collectFlatBlocks(page.blocks, { kind: 'page', title: page.title }, 0);
  }
  for (const page of journalPages) {
    if (page.blocks.length === 0) continue;
    if (!titleToNodeInfo.has(page.title)) continue;
    const startSeq = journalStartSeqs.get(page.title) ?? 0;
    collectFlatBlocks(page.blocks, { kind: 'page', title: page.title }, startSeq);
  }

  ctx.flatBlocks = flatBlocks;

  // 3h: Batch-create all blocks (no parent_id yet)
  const BATCH_CHUNK = 500;

  if (flatBlocks.length > 0) {
    setImportStatus(`Creating ${flatBlocks.length} blocks… (0/${flatBlocks.length})`);
    for (let offset = 0; offset < flatBlocks.length; offset += BATCH_CHUNK) {
      const chunk = flatBlocks.slice(offset, offset + BATCH_CHUNK);
      const endIdx = Math.min(offset + BATCH_CHUNK, flatBlocks.length);
      setImportStatus(`Creating blocks… (${offset}/${flatBlocks.length})`);
      try {
        const batchResult = await batchCreateNodes({
          nodes: chunk.map(item => ({
            ...(item.block.uuid ? { uuid: item.block.uuid } : {}),
          })),
          uuid_conflict_mode: 'return_existing',
        }, { headers: { 'X-Bulk-Import': 'true' } });
        for (const result of batchResult.results) {
          const item = chunk[result.index];
          if (result.success && result.node) {
            const info: NodeInfo = { id: result.node.id, uuid: result.node.uuid };
            tempIdxToNodeInfo.set(item.tempIdx, info);
            if (item.block.uuid) uuidMap.set(item.block.uuid, info);
            p3.succeeded++;
          } else {
            p3.failed++;
            p3.errors.push({
              item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}${item.block.uuid ? ` [${item.block.uuid}]` : ''}`,
              message: result.error ?? 'Unknown error',
            });
          }
          tick();
        }
      } catch (e) {
        for (const item of chunk) {
          p3.failed++;
          p3.errors.push({ item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}`, message: errorMessage(e) });
          tick();
        }
      }
      setImportStatus(`Creating blocks… (${endIdx}/${flatBlocks.length})`);
    }
  }

  // Collect property values per node so they can be merged into the combined update pass below.
  const p5 = createPhase('Assign property values');
  ctx.phases.push(p5);
  {
    const propertyCollector = {
      mutateAsync: async (args: { nodeId: string | number; propertyId: string | number; value: unknown }) => {
        const nodeId = args.nodeId as number;
        let props = nodeIdToProperties.get(nodeId);
        if (!props) { props = {}; nodeIdToProperties.set(nodeId, props); }
        props[args.propertyId as number] = args.value;
        return {} as unknown;
      },
    };
    for (const page of parsed.pages) {
      if (!page.properties) continue;
      const nodeInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
      if (!nodeInfo) continue;
      const isExisting = ctx.existingNodeIds.has(nodeInfo.id);
      const pageLabel = `${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`;
      await assignProperties(page.properties, nodeInfo.id, pageLabel, ctx.propIdMap, uuidMap, titleToNodeInfo, classIdMap, ctx.pageClassId, setImportStatus, propertyCollector, p5, ctx.override, isExisting, ctx.textPropIds);
      tick();
    }
    for (const page of parsed.pages) {
      await assignBlockProperties(page.blocks, ctx.propIdMap, uuidMap, titleToNodeInfo, classIdMap, ctx.pageClassId, setImportStatus, propertyCollector, p5, ctx.override, ctx.existingNodeIds, ctx.textPropIds);
    }
    if (parsed.standaloneBlocks) {
      await assignBlockProperties(parsed.standaloneBlocks, ctx.propIdMap, uuidMap, titleToNodeInfo, classIdMap, ctx.pageClassId, setImportStatus, propertyCollector, p5, ctx.override, ctx.existingNodeIds, ctx.textPropIds);
    }
  }
}
