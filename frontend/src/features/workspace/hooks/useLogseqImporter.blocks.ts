import { batchCreateNodes, getNodeByUuid, updateNode } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries';
import type { LogseqBlock } from '@/utils/ednParser';
import type { NodeInfo, PhaseResult } from './useLogseqImporter.types';

export async function createBlocksRecursively(
  blocks: LogseqBlock[],
  parentId: number,
  startSequence: number,
  uuidMap: Map<string, NodeInfo>,
  classIdMap: Map<string, number>,
  contentQueue: Array<{ id: number; title: string }>,
  phase: PhaseResult,
  override: boolean,
) {
  if (blocks.length === 0) return;

  const batchItems = blocks.map((block, i) => {
    const blockClasses: number[] = [];
    if (block.tags) {
      for (const tag of block.tags) {
        const mapped = classIdMap.get(tag);
        if (mapped) blockClasses.push(mapped);
      }
    }
    return {
      name: '',
      parent_id: parentId,
      sequence: startSequence + i,
      ...(blockClasses.length > 0 ? { classes: blockClasses } : {}),
      ...(block.uuid ? { uuid: block.uuid } : {}),
    };
  });

  const batchResult = await batchCreateNodes({ nodes: batchItems }, { headers: { 'X-Bulk-Import': 'true' } });
  const childWork: Array<{ block: LogseqBlock; parentNodeId: number }> = [];

  for (const result of batchResult.results) {
    const block = blocks[result.index];
    if (result.success && result.node) {
      phase.succeeded++;
      if (block.uuid) uuidMap.set(block.uuid, { id: result.node.id, uuid: result.node.uuid });
      if (block.title) contentQueue.push({ id: result.node.id, title: block.title });
      if (block.children && block.children.length > 0) {
        childWork.push({ block, parentNodeId: result.node.id });
      }
    } else {
      let recovered = false;
      if (block.uuid) {
        try {
          const existing = await getNodeByUuid(block.uuid);
          if (existing) {
            if (existing.parent_id !== parentId) {
              await updateNode(existing.uuid, { parent_id: parentId, sequence: startSequence + result.index });
            }
            uuidMap.set(block.uuid, { id: existing.id, uuid: existing.uuid });
            if (block.title) {
              if (override) {
                contentQueue.push({ id: existing.id, title: block.title });
              } else {
                const existingText = nodeNameToText(existing.name);
                if (existingText === block.title) {
                  contentQueue.push({ id: existing.id, title: block.title });
                }
              }
            }
            if (block.children && block.children.length > 0) {
              childWork.push({ block, parentNodeId: existing.id });
            }
            phase.succeeded++;
            recovered = true;
          }
        } catch { /* lookup failed */ }
      }
      if (!recovered) {
        phase.failed++;
        phase.errors.push({
          item: `Block: ${block.title?.slice(0, 60) || '(empty)'}${block.uuid ? ` [${block.uuid}]` : ''}`,
          message: result.error || 'Unknown error',
        });
      }
    }
  }

  await Promise.all(
    childWork.map(({ block, parentNodeId }) =>
      createBlocksRecursively(block.children!, parentNodeId, 0, uuidMap, classIdMap, contentQueue, phase, override)
    )
  );
}
