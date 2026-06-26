import { getOrCreateDaily, searchNodes, getNodeByUuid, createNode as createNodeApi, getNode, removeProperty } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries';
import type { NodeInfo, PhaseResult } from './useLogseqImporter.types';
import { buildAstFromLogseqText } from './useLogseqImporter.ast';
import { errorMessage } from './useLogseqImporter.utils';

export function findNodeUuid(
  nodeUuid: string,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
): string | null {
  for (const info of uuidMap.values()) {
    if (info.nodeUuid === nodeUuid) return info.uuid;
  }
  for (const info of titleToNodeInfo.values()) {
    if (info.nodeUuid === nodeUuid) return info.uuid;
  }
  return null;
}

export async function resolvePropertyValueForImport(
  value: unknown,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, string>,
  pageClassUuid: string,
): Promise<unknown> {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) {
      const r = await resolvePropertyValueForImport(item, uuidMap, titleToNodeInfo, classIdMap, pageClassUuid);
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
        if (info) return info.nodeUuid;
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
                const expectedClassUuids = new Set(
                  tags.map(t => classIdMap.get(t)).filter((uuid): uuid is string => uuid !== undefined)
                );
                if (expectedClassUuids.size > 0) {
                  const best = pages.find(n => n.classes_uuid?.some(uuid => expectedClassUuids.has(uuid)));
                  if (best) existing = best;
                }
              }
            }
          }
          if (existing) {
            titleToNodeInfo.set(title, { nodeUuid: existing.uuid, uuid: existing.uuid });
            return existing.uuid;
          }
        } catch (searchErr) {
          console.error(`[IMPORT] page-ref "${title}": search failed`, searchErr);
        }
        try {
          const classUuids = [pageClassUuid];
          for (const tag of tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) classUuids.push(mapped);
          }
          const newPage = await createNodeApi({ name: title, class_uuids: classUuids });
          titleToNodeInfo.set(title, { nodeUuid: newPage.uuid, uuid: newPage.uuid });
          return newPage.uuid;
        } catch (createErr) {
          console.error(`[IMPORT] page-ref "${title}": failed to create page`, createErr);
        }
        return undefined;
      }
      case 'date-ref': {
        try {
          const dayNode = await getOrCreateDaily(typed.date as string);
          return dayNode.uuid;
        } catch {
          return undefined;
        }
      }
      case 'uuid-ref': {
        const nodeUuid = typed.uuid as string;
        const fallbackTitle = typed.title as string | undefined;
        const info = uuidMap.get(nodeUuid);
        if (info) return info.nodeUuid;
        try {
          const existing = await getNodeByUuid(nodeUuid);
          if (existing) {
            uuidMap.set(nodeUuid, { nodeUuid: existing.uuid, uuid: existing.uuid });
            if (fallbackTitle) titleToNodeInfo.set(fallbackTitle, { nodeUuid: existing.uuid, uuid: existing.uuid });
            return existing.uuid;
          }
        } catch { /* not found */ }
        if (fallbackTitle) {
          const titleInfo = titleToNodeInfo.get(fallbackTitle);
          if (titleInfo) return titleInfo.nodeUuid;
          try {
            const searchResults = await searchNodes(fallbackTitle);
            const existing = searchResults.find(
              n => nodeNameToText(n.name).toLowerCase() === fallbackTitle.toLowerCase()
            );
            if (existing) {
              titleToNodeInfo.set(fallbackTitle, { nodeUuid: existing.uuid, uuid: existing.uuid });
              uuidMap.set(nodeUuid, { nodeUuid: existing.uuid, uuid: existing.uuid });
              return existing.uuid;
            }
          } catch { /* search failed */ }
          try {
            const newPage = await createNodeApi({ name: fallbackTitle, class_uuids: [pageClassUuid] });
            titleToNodeInfo.set(fallbackTitle, { nodeUuid: newPage.uuid, uuid: newPage.uuid });
            uuidMap.set(nodeUuid, { nodeUuid: newPage.uuid, uuid: newPage.uuid });
            return newPage.uuid;
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
  nodeUuid: string,
  label: string,
  propIdMap: Map<string, string>,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, string>,
  pageClassUuid: string,
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeUuid: string; propertyId: string; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
  override = false,
  isExistingNode = false,
  textPropIds: Set<string> = new Set(),
) {
  let existingProperties: Record<string, unknown> | undefined;
  if (isExistingNode) {
    try {
      const fullNode = nodeUuid ? await getNode(nodeUuid, { include_properties: true }) : null;
      existingProperties = fullNode?.properties_uuid ?? {};
    } catch {
      existingProperties = {};
    }
    if (override) {
      const importedPropIds = new Set(
        Object.keys(properties)
          .map(logseqId => propIdMap.get(logseqId))
          .filter((id): id is string => id !== undefined)
      );
      for (const existingPropIdStr of Object.keys(existingProperties!)) {
        const existingPropId = existingPropIdStr;
        if (!importedPropIds.has(existingPropId)) {
          try {
            setImportStatus(`Removing old property from: ${label}`);
            if (nodeUuid && existingPropId) {
              await removeProperty(nodeUuid, existingPropId);
            }
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
      let resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeInfo, classIdMap, pageClassUuid);

      if (resolved !== undefined && textPropIds.has(noteesPropId)) {
        const strValues = Array.isArray(resolved)
          ? resolved.filter((v): v is string => typeof v === 'string')
          : (typeof resolved === 'string' ? [resolved] : []);
        if (strValues.length > 0) {
          const blockIds: string[] = [];
          for (const strVal of strValues) {
            try {
              const ast = buildAstFromLogseqText(strVal, uuidMap, titleToNodeInfo);
              const astName = ast.length > 0 ? JSON.stringify(ast) : strVal;
              const textParentUuid = findNodeUuid(nodeUuid, uuidMap, titleToNodeInfo);
              if (!textParentUuid) {
                console.error(`[IMPORT] Text property parent UUID not found for node ${nodeUuid}`);
                continue;
              }
              const textBlock = await createNodeApi({ name: astName, parent_uuid: textParentUuid });
              blockIds.push(textBlock.uuid);
            } catch (blockErr) {
              console.error(`[IMPORT] Failed to create text block for ${logseqPropId} on ${label}:`, blockErr);
            }
          }
          resolved = blockIds.length === 1 ? blockIds[0] : blockIds.length > 1 ? blockIds : undefined;
        }
      }

      if (resolved !== undefined) {
        setImportStatus(`Setting property on: ${label}`);
        await setNodePropertyMutation.mutateAsync({ nodeUuid, propertyId: noteesPropId, value: resolved });
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
  propIdMap: Map<string, string>,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, string>,
  pageClassUuid: string,
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeUuid: string; propertyId: string; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
  override = false,
  existingNodeIds: Set<string> = new Set(),
  textPropIds: Set<string> = new Set(),
) {
  for (const block of blocks) {
    if (block.properties && block.uuid) {
      const nodeInfo = uuidMap.get(block.uuid);
      if (nodeInfo) {
        const isExisting = existingNodeIds.has(nodeInfo.nodeUuid);
        const blockLabel = `${block.title || '(block)'} [${block.uuid}]`;
        await assignProperties(
          block.properties, nodeInfo.nodeUuid, blockLabel,
          propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassUuid, setImportStatus,
          setNodePropertyMutation, phase, override, isExisting, textPropIds,
        );
      }
    }
    if (block.children && Array.isArray(block.children)) {
      await assignBlockProperties(
        block.children as { uuid?: string; properties?: Record<string, unknown>; title?: string; children?: unknown[] }[],
        propIdMap, uuidMap, titleToNodeInfo, classIdMap,
        pageClassUuid, setImportStatus, setNodePropertyMutation, phase,
        override, existingNodeIds, textPropIds,
      );
    }
  }
}
