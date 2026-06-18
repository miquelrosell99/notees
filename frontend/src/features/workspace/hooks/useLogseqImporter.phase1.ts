import { addClassExtends } from '@/api/properties';
import { nodeNameToText } from '@/features/queries';
import type { Node } from '@/types/api';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';

export async function runPhase1(ctx: ImportContext, existingClasses: Node[]): Promise<void> {
  const { parsed, classClassId, pageClassId, mutations, classIdMap, uuidMap, phases, override, setImportStatus, tick } = ctx;

  if (!classClassId) return;

  const p1 = createPhase('Create classes');
  phases.push(p1);

  const existingClassByName = new Map(
    existingClasses.map(c => [nodeNameToText(c.name).toLowerCase(), c])
  );

  for (const cls of parsed.classes) {
    setImportStatus(`Creating class: ${cls.title}`);
    try {
      const existing = existingClassByName.get(cls.title.toLowerCase());
      if (existing) {
        classIdMap.set(cls.id, existing.id);
        if (cls.uuid) uuidMap.set(cls.uuid, { id: existing.id, uuid: existing.uuid });
        if (override && nodeNameToText(existing.name) !== cls.title) {
          await mutations.updateNode.mutateAsync({ id: existing.id, data: { name: cls.title } });
        }
        p1.succeeded++;
        tick();
        continue;
      }
      const node = await mutations.createNode.mutateAsync({
        name: cls.title,
        classes: [classClassId, pageClassId],
        ...(cls.uuid ? { uuid: cls.uuid } : {}),
      });
      classIdMap.set(cls.id, node.id);
      if (cls.uuid) uuidMap.set(cls.uuid, { id: node.id, uuid: node.uuid });
      p1.succeeded++;
      tick();
    } catch (e) {
      p1.failed++;
      tick();
      p1.errors.push({ item: `${cls.title}${cls.uuid ? ` [${cls.uuid}]` : ''}`, message: errorMessage(e) });
    }
  }

  const p1b = createPhase('Set class extends');
  phases.push(p1b);
  for (const cls of parsed.classes) {
    if (!cls.extends) continue;
    const noteesClassId = classIdMap.get(cls.id);
    const noteesParentClassId = classIdMap.get(cls.extends);
    if (!noteesClassId || !noteesParentClassId) continue;
    setImportStatus(`Setting class extends: ${cls.title}`);
    try {
      await addClassExtends(noteesClassId, noteesParentClassId);
      p1b.succeeded++;
      tick();
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
        p1b.succeeded++;
      } else {
        p1b.failed++;
        p1b.errors.push({ item: `${cls.title}${cls.uuid ? ` [${cls.uuid}]` : ''} extends ${cls.extends}`, message: msg });
      }
      tick();
    }
  }
}
