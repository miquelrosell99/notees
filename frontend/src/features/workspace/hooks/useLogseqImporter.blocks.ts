import { batchCreateNodes, getNodeByUuid, updateNode } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries';
import type { LogseqBlock } from '@/utils/ednParser';
import type { NodeInfo, PhaseResult } from './useLogseqImporter.types';

function findUuidById(uuidMap: Map<string, NodeInfo>, nodeUuid: string): string | null {
  for (const info of uuidMap.values()) {
    if (info.nodeUuid === nodeUuid) return info.uuid;
  }
  return null;
}

export async function createBlocksRecursively(
  blocks: LogseqBlock[],
  parentUuid: string,
  startSequence: number,
  uuidMap: Map<string, NodeInfo>,
  classIdMap: Map<string, string>,
  contentQueue: Array<{ nodeUuid: string; title: string }>,
  phase: PhaseResult,
  override: boolean,
) {
  if (blocks.length === 0) return;

  const batchItems = blocks.map((block, i) => {
    const blockClassUuids: string[] = [];
    if (block.tags) {
      for (const tag of block.tags) {
        const mapped = classIdMap.get(tag);
        if (mapped) blockClassUuids.push(mapped);
      }
    }
    return {
      name: '',
      parent_uuid: parentUuid,
      sequence: startSequence + i,
      ...(blockClassUuids.length > 0 ? { class_uuids: blockClassUuids } : {}),
      ...(block.uuid ? { uuid: block.uuid } : {}),
    };
  });

  const batchResult = await batchCreateNodes({ nodes: batchItems }, { headers: { 'X-Bulk-Import': 'true' } });
  const childWork: Array<{ block: LogseqBlock; parentNodeId: string }> = [];

  for (const result of batchResult.results) {
    const block = blocks[result.index];
    if (result.success && result.node) {
      phase.succeeded++;
      if (block.uuid) uuidMap.set(block.uuid, { nodeUuid: result.node.uuid, uuid: result.node.uuid });
      if (block.title) contentQueue.push({ nodeUuid: result.node.uuid, title: block.title });
      if (block.children && block.children.length > 0) {
        childWork.push({ block, parentNodeId: result.node.uuid });
      }
    } else {
      let recovered = false;
      if (block.uuid) {
        try {
          const existing = await getNodeByUuid(block.uuid);
          if (existing) {
            if (existing.parent_uuid !== parentUuid) {
              await updateNode(existing.uuid, { parent_uuid: parentUuid, sequence: startSequence + result.index });
            }
            uuidMap.set(block.uuid, { nodeUuid: existing.uuid, uuid: existing.uuid });
            if (block.title) {
              if (override) {
                contentQueue.push({ nodeUuid: existing.uuid, title: block.title });
              } else {
                const existingText = nodeNameToText(existing.name);
                if (existingText === block.title) {
                  contentQueue.push({ nodeUuid: existing.uuid, title: block.title });
                }
              }
            }
            if (block.children && block.children.length > 0) {
              childWork.push({ block, parentNodeId: existing.uuid });
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
    childWork.map(({ block, parentNodeId }) => {
      const childParentUuid = findUuidById(uuidMap, parentNodeId);
      if (!childParentUuid) return Promise.resolve();
      return createBlocksRecursively(block.children!, childParentUuid, 0, uuidMap, classIdMap, contentQueue, phase, override);
    })
  );
}
