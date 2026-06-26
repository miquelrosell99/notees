import { batchUpdateNodes } from '@/api/nodes';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';
import { buildAstFromLogseqText } from './useLogseqImporter.ast';

export async function runPhase6(ctx: ImportContext): Promise<void> {
  const { uuidMap, titleToNodeInfo, contentQueue, phases, setImportStatus, tick } = ctx;

  const p6 = createPhase('Set standalone block content');
  phases.push(p6);

  if (contentQueue.length > 0) {
    const batchItems: Array<{ uuid: string; name: string }> = [];
    const BATCH_SIZE = 50;

    for (const { nodeUuid, title } of contentQueue) {
      if (!title) continue;
      if (!nodeUuid) {
        p6.failed++;
        p6.errors.push({ item: `Node ${nodeUuid}`, message: 'UUID not found for content update' });
        continue;
      }
      try {
        const ast = buildAstFromLogseqText(title, uuidMap, titleToNodeInfo);
        batchItems.push({ uuid: nodeUuid, name: JSON.stringify(ast) });
      } catch (e) {
        p6.failed++;
        p6.errors.push({ item: `Node ${nodeUuid}`, message: errorMessage(e) });
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
          p6.errors.push({ item: `Node ${item?.uuid}`, message: result.error || 'Unknown error' });
        }
      }
    }
  }
}
