import { listProperties, updateProperty, addSelectionOption } from '@/api/properties';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import type { Property } from '@/types/api';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage, mapPropertyType } from './useLogseqImporter.utils';

export async function runPhase2(ctx: ImportContext): Promise<void> {
  const { parsed, mutations, propIdMap, uuidMap, phases, setImportStatus, tick } = ctx;

  const p2 = createPhase('Create properties');
  phases.push(p2);

  const existingProperties = await listProperties();
  const existingPropByName = new Map(
    existingProperties.map(p => [p.name.toLowerCase(), p])
  );

  for (const prop of parsed.properties) {
    setImportStatus(`Creating property: ${prop.title}`);
    try {
      const noteesType = mapPropertyType(prop.type);
      const isMulti = prop.cardinality === 'db.cardinality/many';
      const selectionLines = prop.selectionOptions
        ? prop.selectionOptions.map(o => String(o.value))
        : [];
      const finalType = prop.selectionOptions ? 'selection' as ReturnType<typeof mapPropertyType> : noteesType;

      const existingProp = existingPropByName.get(prop.title.toLowerCase());
      if (existingProp) {
        propIdMap.set(prop.id, existingProp.uuid);
        if (existingProp.multi !== isMulti && !existingProp.is_system) {
          try {
            await updateProperty(existingProp.uuid, { multi: isMulti });
          } catch (e) {
            p2.errors.push({ item: prop.title, message: `Failed to update multi flag: ${errorMessage(e)}` });
          }
        }
        if (prop.selectionOptions && existingProp.options) {
          for (const opt of prop.selectionOptions) {
            if (!opt.uuid) continue;
            const optValue = String(opt.value).toLowerCase();
            const matching = existingProp.options.find(o => o.name.toLowerCase() === optValue);
            if (matching) {
              uuidMap.set(opt.uuid, { nodeUuid: matching.uuid, uuid: '' });
            } else {
              try {
                const newOpt = await addSelectionOption(existingProp.uuid, String(opt.value));
                uuidMap.set(opt.uuid, { nodeUuid: newOpt.uuid, uuid: '' });
              } catch (optErr) {
                console.warn(`[IMPORT] Failed to create selection option "${opt.value}" on property "${prop.title}":`, optErr);
              }
            }
          }
        }
        p2.succeeded++;
        tick();
        continue;
      }

      let created: Property | undefined;
      try {
        created = await mutations.createProperty.mutateAsync({
          name: prop.title,
          type: finalType,
          is_multi: isMulti,
          selection_lines: selectionLines,
        }) as Property;
      } catch (createErr) {
        const resp = (createErr as { response?: { status?: number } }).response;
        if (resp?.status === 409) {
          const refreshed = await listProperties();
          const found = refreshed.find(p => p.name.toLowerCase() === prop.title.toLowerCase());
          if (found) {
            propIdMap.set(prop.id, found.uuid);
            existingPropByName.set(prop.title.toLowerCase(), found);
            if (prop.selectionOptions && found.options) {
              for (const opt of prop.selectionOptions) {
                if (!opt.uuid) continue;
                const optValue = String(opt.value).toLowerCase();
                const matching = found.options.find(o => o.name.toLowerCase() === optValue);
                if (matching) {
                  uuidMap.set(opt.uuid, { nodeUuid: matching.uuid, uuid: '' });
                } else {
                  try {
                    const newOpt = await addSelectionOption(found.uuid, String(opt.value));
                    uuidMap.set(opt.uuid, { nodeUuid: newOpt.uuid, uuid: '' });
                  } catch (optErr) {
                    console.warn(`[IMPORT] Failed to create selection option "${opt.value}":`, optErr);
                  }
                }
              }
            }
            p2.succeeded++;
            tick();
            continue;
          }
        }
        throw createErr;
      }
      propIdMap.set(prop.id, created!.uuid);

      if (prop.selectionOptions && created!.options) {
        for (const opt of prop.selectionOptions) {
          if (!opt.uuid) continue;
          const optValue = String(opt.value).toLowerCase();
          const matching = created!.options.find(o => o.name.toLowerCase() === optValue);
          if (matching) {
            uuidMap.set(opt.uuid, { nodeUuid: matching.uuid, uuid: '' });
          } else {
            try {
              const newOpt = await addSelectionOption(created!.uuid, String(opt.value));
              uuidMap.set(opt.uuid, { nodeUuid: newOpt.uuid, uuid: '' });
            } catch (optErr) {
              console.warn(`[IMPORT] Failed to create selection option "${opt.value}":`, optErr);
            }
          }
        }
      }
      p2.succeeded++;
      tick();
    } catch (e) {
      p2.failed++;
      tick();
      p2.errors.push({ item: prop.title, message: errorMessage(e) });
    }
  }

  // Map logseq.property/description → Notees description system property
  const descriptionProp = existingProperties.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.description);
  if (descriptionProp) propIdMap.set('logseq.property/description', descriptionProp.uuid);

  // Map logseq system task properties
  const LOGSEQ_SYSTEM_PROP_MAP: Array<{ logseqId: string; notesUuid: string }> = [
    { logseqId: 'logseq.property/status',   notesUuid: SYSTEM_PROPERTY_UUIDS.task_status },
    { logseqId: 'logseq.property/priority',  notesUuid: SYSTEM_PROPERTY_UUIDS.task_priority },
  ];
  for (const { logseqId, notesUuid } of LOGSEQ_SYSTEM_PROP_MAP) {
    const sysProp = existingProperties.find(p => p.uuid === notesUuid);
    if (!sysProp) continue;
    propIdMap.set(logseqId, sysProp.uuid);
    const logseqProp = parsed.properties.find(lp => lp.id === logseqId);
    if (logseqProp?.selectionOptions && sysProp.options) {
      const LOGSEQ_TO_NOTEES_NAME: Record<string, string> = {
        'todo': 'pending',
        'in review': 'reviewing',
        'canceled': 'cancelled',
      };
      for (const lsOpt of logseqProp.selectionOptions) {
        if (!lsOpt.uuid) continue;
        const lsName = String(lsOpt.value).toLowerCase();
        const notesName = LOGSEQ_TO_NOTEES_NAME[lsName] ?? lsName;
        const notesOpt = sysProp.options.find(o => o.name.toLowerCase() === notesName);
        if (notesOpt) uuidMap.set(lsOpt.uuid, { nodeUuid: notesOpt.uuid, uuid: '' });
      }
    }
  }

  ctx.textPropIds = new Set<string>(
    existingProperties.filter(p => p.type === 'text').map(p => p.uuid)
  );
}
