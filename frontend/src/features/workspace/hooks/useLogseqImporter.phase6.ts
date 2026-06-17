import { batchUpdateNodes } from '@/api/nodes';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';
import { buildAstFromLogseqText } from './useLogseqImporter.ast';

export async function runPhase6(ctx: ImportContext): Promise<void> {
  const { uuidMap, titleToNodeInfo, contentQueue, phases, setImportStatus, tick } = ctx;

  const p6 = createPhase('Set standalone block content');
  phases.push(p6);

  if (contentQueue.length > 0) {
    const nodeIdToUuid = new Map<number, string>();
    for (const [uuid, info] of uuidMap) nodeIdToUuid.set(info.id, uuid);

    const batchItems: Array<{ id: number; name: string }> = [];
    const BATCH_SIZE = 50;

    for (const { id, title } of contentQueue) {
      if (!title) continue;
      try {
        const ast = buildAstFromLogseqText(title, uuidMap, titleToNodeInfo);
        batchItems.push({ id, name: JSON.stringify(ast) });
      } catch (e) {
        p6.failed++;
        p6.errors.push({ item: `Node ${id}${nodeIdToUuid.has(id) ? ` [${nodeIdToUuid.get(id)}]` : ''}`, message: errorMessage(e) });
      }
    }

    for (let offset = 0; offset < batchItems.length; offset += BATCH_SIZE) {
      const chunk = batchItems.slice(offset, offset + BATCH_SIZE);
      setImportStatus(`Setting standalone block content (${offset + 1}–${offset + chunk.length} of ${batchItems.length})…`);
      const batchResult = await batchUpdateNodes({ nodes: chunk });
      for (const result of batchResult.results) {
        if (result.success) { p6.succeeded++; tick(); }
        else {
          p6.failed++; tick();
          const item = chunk[result.index];
          const itemUuid = item ? nodeIdToUuid.get(item.id) : undefined;
          p6.errors.push({ item: `Node ${item?.id}${itemUuid ? ` [${itemUuid}]` : ''}`, message: result.error || 'Unknown error' });
        }
      }
    }
  }
}
