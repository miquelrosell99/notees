import { batchAddClassProperties } from '@/api/properties';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';

export async function runPhase4(ctx: ImportContext): Promise<void> {
  const { parsed, classIdMap, propIdMap, phases, setImportStatus, tick } = ctx;

  const p4 = createPhase('Bind properties to classes');
  phases.push(p4);
  const PHASE4_WHITELIST = new Set(['logseq.property/description', 'logseq.property/status', 'logseq.property/priority']);
  const classPropertyItems: Array<{ class_node_id: number; property_id: number; label: string }> = [];
  for (const cls of parsed.classes) {
    const noteesClassId = classIdMap.get(cls.id);
    if (!noteesClassId || !cls.properties) continue;
    for (const logseqPropId of cls.properties) {
      if (logseqPropId.startsWith('logseq.property') && !PHASE4_WHITELIST.has(logseqPropId)) continue;
      const noteesPropId = propIdMap.get(logseqPropId);
      if (!noteesPropId) continue;
      classPropertyItems.push({ class_node_id: noteesClassId, property_id: noteesPropId, label: `${cls.title} ← ${logseqPropId}` });
    }
  }
  if (classPropertyItems.length > 0) {
    setImportStatus(`Binding ${classPropertyItems.length} properties to classes…`);
    const BATCH_SIZE = 100;
    for (let i = 0; i < classPropertyItems.length; i += BATCH_SIZE) {
      const chunk = classPropertyItems.slice(i, i + BATCH_SIZE);
      try {
        const res = await batchAddClassProperties(chunk.map(({ class_node_id, property_id }) => ({ class_node_id, property_id })));
        for (const r of res.results) {
          if (r.success) { p4.succeeded++; } else {
            p4.failed++;
            p4.errors.push({ item: chunk[r.index].label, message: r.error || 'Unknown error' });
          }
          tick();
        }
      } catch (e) {
        for (const item of chunk) {
          p4.failed++;
          p4.errors.push({ item: item.label, message: errorMessage(e) });
          tick();
        }
      }
    }
  }
}
