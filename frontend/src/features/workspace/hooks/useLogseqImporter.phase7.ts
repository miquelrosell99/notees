import { addAlias, updateNode } from '@/api/nodes';
import type { ImportContext } from './useLogseqImporter.types';
import { createPhase, errorMessage } from './useLogseqImporter.utils';

export async function runPhase7(ctx: ImportContext): Promise<void> {
  const { parsed, uuidMap, titleToNodeInfo, pageClassUuid, mutations, phases, setImportStatus, tick } = ctx;

  const pagesWithAliases = parsed.pages.filter(p => (p.aliases && p.aliases.length > 0) || (p.aliasOfUuids && p.aliasOfUuids.length > 0));
  if (pagesWithAliases.length === 0) return;

  const p7 = createPhase('Assign aliases');
  phases.push(p7);

  for (const page of pagesWithAliases) {
    const mainInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
    if (!mainInfo) continue;

    for (const aliasTitle of page.aliases ?? []) {
      const aliasInfo = titleToNodeInfo.get(aliasTitle);
      if (!aliasInfo) {
        setImportStatus(`Creating alias page: ${aliasTitle}`);
        try {
          const aliasNode = await mutations.createNode.mutateAsync({ name: aliasTitle, class_uuids: [pageClassUuid] });
          titleToNodeInfo.set(aliasTitle, { nodeUuid: aliasNode.uuid, uuid: aliasNode.uuid });
          await addAlias(mainInfo.uuid, aliasNode.uuid);
          p7.succeeded++;
          tick();
        } catch (e) {
          p7.failed++;
          tick();
          p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
        }
      } else {
        setImportStatus(`Assigning alias: ${aliasTitle} → ${page.title}`);
        try {
          await addAlias(mainInfo.uuid, aliasInfo.uuid);
          p7.succeeded++;
          tick();
        } catch (e) {
          const msg = errorMessage(e);
          if (msg.includes('already') || msg.includes('409') || msg.includes('conflict') || msg.includes('itself an alias')) {
            p7.succeeded++;
          } else if (msg.includes('page nodes') || msg.includes('is_page')) {
            try {
              await updateNode(mainInfo.uuid, { class_uuids: [pageClassUuid] });
              await updateNode(aliasInfo.uuid, { class_uuids: [pageClassUuid] });
              await addAlias(mainInfo.uuid, aliasInfo.uuid);
              p7.succeeded++;
            } catch (retryErr) {
              const retryMsg = errorMessage(retryErr);
              if (retryMsg.includes('already') || retryMsg.includes('409') || retryMsg.includes('conflict')) {
                p7.succeeded++;
              } else {
                p7.failed++;
                p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: retryMsg });
              }
            }
          } else {
            p7.failed++;
            p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: msg });
          }
          tick();
        }
      }
    }

    if (page.aliasOfUuids) {
      for (const aliasUuid of page.aliasOfUuids) {
        const aliasInfo = uuidMap.get(aliasUuid);
        if (!aliasInfo) {
          p7.failed++;
          p7.errors.push({ item: `Alias: UUID ${aliasUuid} → ${page.title}`, message: 'Alias page UUID not found' });
          continue;
        }
        const thisPageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
        if (!thisPageInfo) continue;
        setImportStatus(`Assigning alias: UUID ${aliasUuid} → ${page.title}`);
        try {
          await addAlias(thisPageInfo.uuid, aliasInfo.uuid);
          p7.succeeded++;
          tick();
        } catch (e) {
          const msg = errorMessage(e);
          if (msg.includes('already') || msg.includes('409') || msg.includes('conflict') || msg.includes('itself an alias')) {
            p7.succeeded++;
          } else if (msg.includes('page nodes') || msg.includes('is_page')) {
            try {
              await updateNode(thisPageInfo.uuid, { class_uuids: [pageClassUuid] });
              await updateNode(aliasInfo.uuid, { class_uuids: [pageClassUuid] });
              await addAlias(thisPageInfo.uuid, aliasInfo.uuid);
              p7.succeeded++;
            } catch (retryErr) {
              const retryMsg = errorMessage(retryErr);
              if (retryMsg.includes('already') || retryMsg.includes('409') || retryMsg.includes('conflict') || retryMsg.includes('itself an alias')) {
                p7.succeeded++;
              } else {
                p7.failed++;
                p7.errors.push({ item: `Alias: UUID ${aliasUuid} → ${page.title}`, message: retryMsg });
              }
            }
          } else {
            p7.failed++;
            p7.errors.push({ item: `Alias: UUID ${aliasUuid} → ${page.title}`, message: msg });
          }
          tick();
        }
      }
    }
  }
}
