import { getOrCreateDaily, searchNodes, getNodeByUuid, createNode as createNodeApi, getNode, removeProperty } from '@/api/nodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { NodeInfo, PhaseResult } from './useLogseqImporter.types';
import { buildAstFromLogseqText } from './useLogseqImporter.ast';
import { errorMessage } from './useLogseqImporter.utils';

export async function resolvePropertyValueForImport(
  value: unknown,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, number>,
  pageClassId: number,
): Promise<unknown> {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) {
      const r = await resolvePropertyValueForImport(item, uuidMap, titleToNodeInfo, classIdMap, pageClassId);
      if (r !== undefined) resolved.push(r);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  if (typeof value === 'object' && value !== null && '__type' in value) {
    const typed = value as { __type: string; [key: string]: unknown };
    switch (typed.__type) {
      case 'page-ref': {
        const title = typed.title as string;
        const tags = (typed.tags as string[] | undefined) ?? [];
        const info = titleToNodeInfo.get(title);
        if (info) return info.id;
        try {
          const searchResults = await searchNodes(title);
          const titleMatches = searchResults.filter(n =>
            nodeNameToText(n.name).toLowerCase() === title.toLowerCase()
          );
          let existing = titleMatches[0];
          if (titleMatches.length > 1) {
            const pages = titleMatches.filter(n => n.is_page);
            if (pages.length > 0) {
              existing = pages[0];
              if (pages.length > 1 && tags.length > 0) {
                const expectedClassIds = new Set(
                  tags.map(t => classIdMap.get(t)).filter((id): id is number => id !== undefined)
                );
                if (expectedClassIds.size > 0) {
                  const best = pages.find(n => n.classes?.some(cid => expectedClassIds.has(cid)));
                  if (best) existing = best;
                }
              }
            }
          }
          if (existing) {
            titleToNodeInfo.set(title, { id: existing.id, uuid: existing.uuid });
            return existing.id;
          }
        } catch (searchErr) {
          console.error(`[IMPORT] page-ref "${title}": search failed`, searchErr);
        }
        try {
          const classes = [pageClassId];
          for (const tag of tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) classes.push(mapped);
          }
          const newPage = await createNodeApi({ name: title, classes });
          titleToNodeInfo.set(title, { id: newPage.id, uuid: newPage.uuid });
          return newPage.id;
        } catch (createErr) {
          console.error(`[IMPORT] page-ref "${title}": failed to create page`, createErr);
        }
        return undefined;
      }
      case 'date-ref': {
        try {
          const dayNode = await getOrCreateDaily(typed.date as string);
          return dayNode.id;
        } catch {
          return undefined;
        }
      }
      case 'uuid-ref': {
        const uuid = typed.uuid as string;
        const fallbackTitle = typed.title as string | undefined;
        const info = uuidMap.get(uuid);
        if (info) return info.id;
        try {
          const existing = await getNodeByUuid(uuid);
          if (existing) {
            uuidMap.set(uuid, { id: existing.id, uuid: existing.uuid });
            if (fallbackTitle) titleToNodeInfo.set(fallbackTitle, { id: existing.id, uuid: existing.uuid });
            return existing.id;
          }
        } catch { /* not found */ }
        if (fallbackTitle) {
          const titleInfo = titleToNodeInfo.get(fallbackTitle);
          if (titleInfo) return titleInfo.id;
          try {
            const searchResults = await searchNodes(fallbackTitle);
            const existing = searchResults.find(
              n => nodeNameToText(n.name).toLowerCase() === fallbackTitle.toLowerCase()
            );
            if (existing) {
              titleToNodeInfo.set(fallbackTitle, { id: existing.id, uuid: existing.uuid });
              uuidMap.set(uuid, { id: existing.id, uuid: existing.uuid });
              return existing.id;
            }
          } catch { /* search failed */ }
          try {
            const newPage = await createNodeApi({ name: fallbackTitle, classes: [pageClassId] });
            titleToNodeInfo.set(fallbackTitle, { id: newPage.id, uuid: newPage.uuid });
            uuidMap.set(uuid, { id: newPage.id, uuid: newPage.uuid });
            return newPage.id;
          } catch (createErr) {
            console.error(`[IMPORT] uuid-ref fallback: failed to create "${fallbackTitle}"`, createErr);
          }
        }
        return undefined;
      }
    }
  }

  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value || undefined;
  return undefined;
}

export async function assignProperties(
  properties: Record<string, unknown>,
  nodeId: number,
  label: string,
  propIdMap: Map<string, number>,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, number>,
  pageClassId: number,
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeId: number; propertyId: number; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
  override = false,
  isExistingNode = false,
  textPropIds: Set<number> = new Set(),
) {
  let existingProperties: Record<number, unknown> | undefined;
  if (isExistingNode) {
    try {
      const fullNode = await getNode(nodeId, { include_properties: true });
      existingProperties = fullNode.properties ?? {};
    } catch {
      existingProperties = {};
    }
    if (override) {
      const importedPropIds = new Set(
        Object.keys(properties)
          .map(logseqId => propIdMap.get(logseqId))
          .filter((id): id is number => id !== undefined)
      );
      for (const existingPropIdStr of Object.keys(existingProperties!)) {
        const existingPropId = Number(existingPropIdStr);
        if (!importedPropIds.has(existingPropId)) {
          try {
            setImportStatus(`Removing old property from: ${label}`);
            await removeProperty(nodeId, existingPropId);
          } catch { /* ignore */ }
        }
      }
    }
  }

  for (const [logseqPropId, rawValue] of Object.entries(properties)) {
    const noteesPropId = propIdMap.get(logseqPropId);
    if (!noteesPropId) continue;

    if (isExistingNode && !override && existingProperties && noteesPropId in existingProperties) {
      const existingVal = existingProperties[noteesPropId];
      const hasValue = existingVal !== null && existingVal !== undefined && existingVal !== ''
        && !(Array.isArray(existingVal) && existingVal.length === 0);
      if (hasValue) {
        phase.succeeded++;
        continue;
      }
    }

    try {
      let resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeInfo, classIdMap, pageClassId);

      if (resolved !== undefined && textPropIds.has(noteesPropId)) {
        const strValues = Array.isArray(resolved)
          ? resolved.filter((v): v is string => typeof v === 'string')
          : (typeof resolved === 'string' ? [resolved] : []);
        if (strValues.length > 0) {
          const blockIds: number[] = [];
          for (const strVal of strValues) {
            try {
              const ast = buildAstFromLogseqText(strVal, uuidMap, titleToNodeInfo);
              const astName = ast.length > 0 ? JSON.stringify(ast) : strVal;
              const textBlock = await createNodeApi({ name: astName, parent_id: nodeId });
              blockIds.push(textBlock.id);
            } catch (blockErr) {
              console.error(`[IMPORT] Failed to create text block for ${logseqPropId} on ${label}:`, blockErr);
            }
          }
          resolved = blockIds.length === 1 ? blockIds[0] : blockIds.length > 1 ? blockIds : undefined;
        }
      }

      if (resolved !== undefined) {
        setImportStatus(`Setting property on: ${label}`);
        await setNodePropertyMutation.mutateAsync({ nodeId, propertyId: noteesPropId, value: resolved });
        phase.succeeded++;
      } else {
        phase.failed++;
        phase.errors.push({ item: `${label} ← ${logseqPropId}`, message: 'Property value resolved to undefined' });
      }
    } catch (e) {
      phase.failed++;
      phase.errors.push({ item: `${label} ← ${logseqPropId}`, message: errorMessage(e) });
    }
  }
}

export async function assignBlockProperties(
  blocks: { uuid?: string; properties?: Record<string, unknown>; title?: string; children?: unknown[] }[],
  propIdMap: Map<string, number>,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, number>,
  pageClassId: number,
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeId: number; propertyId: number; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
  override = false,
  existingNodeIds: Set<number> = new Set(),
  textPropIds: Set<number> = new Set(),
) {
  for (const block of blocks) {
    if (block.properties && block.uuid) {
      const nodeInfo = uuidMap.get(block.uuid);
      if (nodeInfo) {
        const isExisting = existingNodeIds.has(nodeInfo.id);
        const blockLabel = `${block.title || '(block)'} [${block.uuid}]`;
        await assignProperties(
          block.properties, nodeInfo.id, blockLabel,
          propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus,
          setNodePropertyMutation, phase, override, isExisting, textPropIds,
        );
      }
    }
    if (block.children && Array.isArray(block.children)) {
      await assignBlockProperties(
        block.children as { uuid?: string; properties?: Record<string, unknown>; title?: string; children?: unknown[] }[],
        propIdMap, uuidMap, titleToNodeInfo, classIdMap,
        pageClassId, setImportStatus, setNodePropertyMutation, phase,
        override, existingNodeIds, textPropIds,
      );
    }
  }
}
