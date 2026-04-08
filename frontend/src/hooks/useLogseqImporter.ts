/**
 * useLogseqImporter — shared hook that contains the full 7-phase Logseq import logic.
 *
 * Extract from ImportLogseqModal so both ImportLogseqModal (standalone use via command
 * palette) and ImportOptionsModal (workspace-creation flow) can run the same pipeline
 * without the circular dependency of one modal opening the other.
 *
 * Import flow (7 phases):
 * 1. Create classes (type nodes)
 * 2. Create properties (with correct backend field names)
 * 3. Create all nodes (pages + blocks) with UUID-only skeletons
 * 4. Bind properties to classes
 * 5. Resolve property values per node (collected into a map, merged into phase 6)
 * 6. Combined update pass: name (with [[uuid]] links resolved) + parent + sequence + classes + properties
 * 7. Assign aliases between pages
 *
 * Usage:
 *   const { importing, importStatus, importProgress, report, error, reset, runImport, pageClassId } = useLogseqImporter();
 *   await runImport(parsedExport, { importMode: 'additive' });
 */
import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useCreateProperty } from '@/hooks';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useNavigationStore } from '@/stores';
import {
  getOrCreateDaily,
  listClasses,
  searchNodes,
  addAlias,
  getNode,
  getNodeByUuid,
  updateNode,
  removeProperty,
  batchCreateNodes,
  batchUpdateNodes,
  batchGetOrCreateDaily,
  createNode as createNodeApi,
  batchDeleteNodes,
  batchPermanentlyDeleteNodes,
} from '@/api/nodes';
import { listProperties, updateProperty, addClassExtends, addSelectionOption } from '@/api/properties';
import { batchAddClassProperties } from '@/api/properties';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { text as astText, nodeLink, externalLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import type { PropertyType, Property, Node, BatchNodeUpdateItem } from '@/types/api';
import type { LogseqExport, LogseqBlock } from '@/utils/ednParser';
import type { QueryClient } from '@tanstack/react-query';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { generateUUID } from '@/utils/uuid';
import type { TaskReportData, TaskPhaseResult } from '@/components/core/TaskReport';

// ── Public types ──────────────────────────────────────────────

export type ImportMode = 'additive' | 'override';

export type { TaskReportData as LogseqImportReport };

// ── Internal types ────────────────────────────────────────────

/** Info stored per created Notees node, keyed by Logseq UUID */
interface NodeInfo {
  id: number;
  uuid: string; // Notees UUID (from the created node)
}

type PhaseResult = TaskPhaseResult;

// ── Helpers ───────────────────────────────────────────────────

function createPhase(label: string): PhaseResult {
  return { label, succeeded: 0, failed: 0, errors: [] };
}

function errorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'response' in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (detail) {
      if (typeof detail === 'string') return detail;
      if (Array.isArray(detail)) {
        return detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join('; ');
      }
      if (typeof detail === 'object' && detail !== null && 'message' in detail) {
        return String((detail as { message: unknown }).message);
      }
      return JSON.stringify(detail);
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Collect UUIDs and IDs recursively from children for deletion.
 * Used in override mode to delete existing blocks before importing.
 */
function collectChildInfo(node: Node): { uuids: string[]; ids: number[] } {
  const uuids: string[] = [];
  const ids: number[] = [];
  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      uuids.push(child.uuid);
      ids.push(child.id);
      const childInfo = collectChildInfo(child);
      uuids.push(...childInfo.uuids);
      ids.push(...childInfo.ids);
    }
  }
  return { uuids, ids };
}

/**
 * Delete all children of a page in override mode.
 * Two-step: soft-delete first, then hard-delete to free UUIDs.
 */
async function deleteExistingBlocks(pageId: number, queryClient: QueryClient): Promise<number> {
  const fullPage = await getNode(pageId, { include_children: true });
  const { uuids: childUuids, ids: childIds } = collectChildInfo(fullPage);

  if (childUuids.length === 0) return 0;

  const result = await batchDeleteNodes({ uuids: childUuids });

  if (childIds.length > 0) {
    try {
      await batchPermanentlyDeleteNodes({ ids: childIds });
    } catch (e) {
      console.warn('[IMPORT] Hard-delete of old blocks failed (non-critical):', e);
    }
  }

  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(pageId) });

  return result.deleted;
}

/** Count blocks recursively — exported so UI components can show preview counts */
export function countBlocks(blocks: LogseqBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.children) n += countBlocks(b.children);
  }
  return n;
}

/** Map Logseq property type → Notees property type */
function mapPropertyType(logseqType: string): PropertyType {
  switch (logseqType) {
    case 'checkbox': return 'boolean';
    case 'date': return 'date';
    case 'node': return 'node';
    case 'number': return 'float';
    default: return 'text';
  }
}

// ── AST builder helpers ────────────────────────────────────────

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NODE_LINK_RE = new RegExp(
  `#\\[\\[(${UUID_RE})\\]\\]|\\[([^\\]]+)\\]\\(\\[\\[(${UUID_RE})\\]\\]\\)|\\[\\[(${UUID_RE})\\]\\]|\\(\\((${UUID_RE})\\)\\)|\\[\\[([^\\]]+)\\]\\]`,
  'gi'
);
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function textSegmentToNodes(
  segment: string,
  uuidMap: Map<string, NodeInfo>,
): ASTInlineNode[] {
  if (!segment) return [];
  const nodes: ASTInlineNode[] = [];
  let last = 0;
  const regex = new RegExp(MD_LINK_RE.source, MD_LINK_RE.flags);
  for (const match of segment.matchAll(regex)) {
    const matchStart = match.index ?? 0;
    if (matchStart > last) nodes.push(astText(segment.slice(last, matchStart)));
    const label = match[1];
    const url = match[2];
    const noteesUuid = url.startsWith('notees:') ? url.slice('notees:'.length) : null;
    if (noteesUuid) {
      const target = uuidMap.get(noteesUuid);
      if (target) {
        const linkInstanceUuid = generateUUID();
        nodes.push(nodeLink(buildLinkId(target.uuid, linkInstanceUuid), 'node', label));
      } else {
        nodes.push(externalLink(url, astText(label)));
      }
    } else {
      nodes.push(externalLink(url, astText(label)));
    }
    last = matchStart + match[0].length;
  }
  if (last < segment.length) nodes.push(astText(segment.slice(last)));
  return nodes;
}

export function buildAstFromLogseqText(
  rawText: string,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo?: Map<string, NodeInfo>,
): Array<{ type: string; children: ASTInlineNode[] }> {
  if (!rawText) return [];
  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  for (const match of rawText.matchAll(NODE_LINK_RE)) {
    const inlineClassUuid = match[1];
    const labeledLink_label = match[2];
    const labeledLink_uuid = match[3];
    const bareUuid = match[4];
    const blockRefUuid = match[5];
    const linkName = match[6];
    const logseqUuid = labeledLink_uuid ?? bareUuid ?? blockRefUuid;
    const matchStart = match.index ?? 0;

    if (matchStart > lastIndex) {
      children.push(...textSegmentToNodes(rawText.slice(lastIndex, matchStart), uuidMap));
    }

    if (inlineClassUuid) {
      const target = uuidMap.get(inlineClassUuid);
      if (target) {
        const linkInstanceUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkInstanceUuid), 'class'));
      } else {
        children.push(astText(match[0]));
      }
    } else {
      let target: NodeInfo | undefined;
      if (logseqUuid) {
        target = uuidMap.get(logseqUuid);
      } else if (linkName && titleToNodeInfo) {
        target = titleToNodeInfo.get(linkName);
      }
      if (target) {
        const linkInstanceUuid = generateUUID();
        const linkId = buildLinkId(target.uuid, linkInstanceUuid);
        const label = labeledLink_label ?? null;
        children.push(nodeLink(linkId, 'node', label));
      } else if (linkName) {
        children.push(astText(linkName));
      } else {
        children.push(astText(match[0]));
      }
    }

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < rawText.length) {
    children.push(...textSegmentToNodes(rawText.slice(lastIndex), uuidMap));
  }

  if (children.length === 0) return [];
  return [paragraph(...children)];
}

// ── Property assignment helpers ────────────────────────────────

async function resolvePropertyValueForImport(
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

async function assignProperties(
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

async function assignBlockProperties(
  blocks: LogseqBlock[],
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
    if (block.children) {
      await assignBlockProperties(
        block.children, propIdMap, uuidMap, titleToNodeInfo, classIdMap,
        pageClassId, setImportStatus, setNodePropertyMutation, phase,
        override, existingNodeIds, textPropIds,
      );
    }
  }
}

async function createBlocksRecursively(
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
              await updateNode(existing.id, { parent_id: parentId, sequence: startSequence + result.index });
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

// ── Main hook ─────────────────────────────────────────────────

export function useLogseqImporter() {
  const queryClient = useQueryClient();
  const createNodeMutation = useCreateNode();
  const updateNodeMutation = useUpdateNode();
  const createPropertyMutation = useCreateProperty();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [importProgress, setImportProgress] = useState(0);
  const [report, setReport] = useState<TaskReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setImporting(false);
    setImportStatus('');
    setImportProgress(0);
    setReport(null);
    setError(null);
  }, []);

  const runImport = useCallback(async (
    parsed: LogseqExport,
    options: { importMode: ImportMode },
  ) => {
    if (!parsed || !pageClassId) return;

    setImporting(true);
    setReport(null);
    setImportProgress(0);
    setError(null);

    const override = options.importMode === 'override';
    const phases: PhaseResult[] = [];

    // ── Progress tracking ─────────────────────────────────────
    const classExtends = parsed.classes.filter(c => c.extends).length;
    const propBindings = parsed.classes.reduce((s, c) => s + (c.properties?.length ?? 0), 0);
    const pagesWithProps = parsed.pages.filter(p => p.properties && Object.keys(p.properties).length > 0).length;
    const pagesWithAliases = parsed.pages.filter(p => (p.aliases && p.aliases.length > 0) || (p.aliasOfUuids && p.aliasOfUuids.length > 0)).length;
    const totalBlocks = parsed.pages.reduce((s, p) => s + countBlocks(p.blocks), 0)
      + (parsed.standaloneBlocks ? countBlocks(parsed.standaloneBlocks) : 0);
    const regularPagesCount = parsed.pages.filter(p => !p.journal).length;
    const estimatedTotal = Math.max(1,
      parsed.classes.length + classExtends + parsed.properties.length
      + parsed.pages.length + propBindings + pagesWithProps
      + totalBlocks + pagesWithAliases
      // wiring pass: all blocks get parent/sequence, regular pages get name/classes
      + totalBlocks + regularPagesCount
    );
    let completedItems = 0;
    const tick = () => {
      completedItems++;
      setImportProgress(Math.min(99, Math.round((completedItems / estimatedTotal) * 100)));
    };
    const tickN = (n: number) => {
      completedItems += n;
      setImportProgress(Math.min(99, Math.round((completedItems / estimatedTotal) * 100)));
    };

    try {
      // ── Maps built during import ──────────────────────────────
      const uuidMap = new Map<string, NodeInfo>();
      const propIdMap = new Map<string, number>();
      const classIdMap = new Map<string, number>();
      const titleToNodeInfo = new Map<string, NodeInfo>();

      // ── Pre-populate classIdMap with system class mappings ────
      const LOGSEQ_BUILTIN_CLASS_MAP: Record<string, string> = {
        'logseq.class/Quote-block': SYSTEM_CLASS_UUIDS.quote,
        'logseq.class/Query': SYSTEM_CLASS_UUIDS.query,
        'logseq.class/Code': SYSTEM_CLASS_UUIDS.code,
        'logseq.class/Task': SYSTEM_CLASS_UUIDS.task,
        'logseq.class/Whiteboard': SYSTEM_CLASS_UUIDS.whiteboard,
        'logseq.class/Card': SYSTEM_CLASS_UUIDS.card,
        'logseq.class/Template': SYSTEM_CLASS_UUIDS.template,
        'logseq.class/Table': SYSTEM_CLASS_UUIDS.table,
        'logseq.class/Asset': SYSTEM_CLASS_UUIDS.asset,
      };
      const existingClasses = await listClasses();
      for (const [logseqKey, noteesUuid] of Object.entries(LOGSEQ_BUILTIN_CLASS_MAP)) {
        const systemClass = existingClasses.find(c => c.uuid === noteesUuid);
        if (systemClass) {
          classIdMap.set(logseqKey, systemClass.id);
          const info = { id: systemClass.id, uuid: systemClass.uuid };
          const displayName = nodeNameToText(systemClass.name);
          if (displayName) {
            titleToNodeInfo.set(displayName, info);
            titleToNodeInfo.set(displayName.toLowerCase(), info);
          }
          const lsClass = parsed.classes.find(c => c.id === logseqKey);
          if (lsClass?.uuid) uuidMap.set(lsClass.uuid, info);
        }
      }
      const contentQueue: Array<{ id: number; title: string }> = [];
      const existingNodeIds = new Set<number>();

      // ──────────────────────────────────────────────────────────
      // PHASE 1: Create classes (as type nodes)
      // ──────────────────────────────────────────────────────────
      const p1 = createPhase('Create classes');
      phases.push(p1);
      if (classClassId) {
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
                await updateNodeMutation.mutateAsync({ id: existing.id, data: { name: cls.title } });
              }
              p1.succeeded++;
              tick();
              continue;
            }
            const node = await createNodeMutation.mutateAsync({
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

      // ──────────────────────────────────────────────────────────
      // PHASE 2: Create properties
      // ──────────────────────────────────────────────────────────
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
          const finalType = prop.selectionOptions ? 'selection' as PropertyType : noteesType;

          const existingProp = existingPropByName.get(prop.title.toLowerCase());
          if (existingProp) {
            propIdMap.set(prop.id, existingProp.id);
            if (existingProp.multi !== isMulti && !existingProp.is_system) {
              try {
                await updateProperty(existingProp.id, { multi: isMulti });
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
                  uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
                } else {
                  try {
                    const newOpt = await addSelectionOption(existingProp.id, String(opt.value));
                    uuidMap.set(opt.uuid, { id: newOpt.id, uuid: '' });
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
            created = await createPropertyMutation.mutateAsync({
              name: prop.title,
              type: finalType,
              is_multi: isMulti,
              selection_lines: selectionLines,
            } as Record<string, unknown> & { name: string });
          } catch (createErr) {
            const resp = (createErr as { response?: { status?: number } }).response;
            if (resp?.status === 409) {
              const refreshed = await listProperties();
              const found = refreshed.find(p => p.name.toLowerCase() === prop.title.toLowerCase());
              if (found) {
                propIdMap.set(prop.id, found.id);
                existingPropByName.set(prop.title.toLowerCase(), found);
                if (prop.selectionOptions && found.options) {
                  for (const opt of prop.selectionOptions) {
                    if (!opt.uuid) continue;
                    const optValue = String(opt.value).toLowerCase();
                    const matching = found.options.find(o => o.name.toLowerCase() === optValue);
                    if (matching) {
                      uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
                    } else {
                      try {
                        const newOpt = await addSelectionOption(found.id, String(opt.value));
                        uuidMap.set(opt.uuid, { id: newOpt.id, uuid: '' });
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
          propIdMap.set(prop.id, created!.id);

          if (prop.selectionOptions && created!.options) {
            for (const opt of prop.selectionOptions) {
              if (!opt.uuid) continue;
              const optValue = String(opt.value).toLowerCase();
              const matching = created!.options.find(o => o.name.toLowerCase() === optValue);
              if (matching) {
                uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
              } else {
                try {
                  const newOpt = await addSelectionOption(created!.id, String(opt.value));
                  uuidMap.set(opt.uuid, { id: newOpt.id, uuid: '' });
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
      if (descriptionProp) propIdMap.set('logseq.property/description', descriptionProp.id);

      // Map logseq system task properties
      const LOGSEQ_SYSTEM_PROP_MAP: Array<{ logseqId: string; notesUuid: string }> = [
        { logseqId: 'logseq.property/status',   notesUuid: SYSTEM_PROPERTY_UUIDS.task_status },
        { logseqId: 'logseq.property/priority',  notesUuid: SYSTEM_PROPERTY_UUIDS.task_priority },
      ];
      for (const { logseqId, notesUuid } of LOGSEQ_SYSTEM_PROP_MAP) {
        const sysProp = existingProperties.find(p => p.uuid === notesUuid);
        if (!sysProp) continue;
        propIdMap.set(logseqId, sysProp.id);
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
            if (notesOpt) uuidMap.set(lsOpt.uuid, { id: notesOpt.id, uuid: '' });
          }
        }
      }

      const textPropIds = new Set<number>(
        existingProperties.filter(p => p.type === 'text').map(p => p.id)
      );

      // ──────────────────────────────────────────────────────────
      // PHASE 3: Create all nodes (pages + blocks)
      // ──────────────────────────────────────────────────────────
      const p3 = createPhase('Create nodes');
      phases.push(p3);

      const journalPages = parsed.pages.filter(p => p.journal);
      const regularPages = parsed.pages.filter(p => !p.journal);

      // 3a: Journal pages — batch getOrCreateDaily
      const PAGE_CHUNK = 500;
      const CONCURRENT_PAGES = 4;
      if (journalPages.length > 0) {
        let journalsDone = 0;
        setImportStatus(`Creating journal pages… (0/${journalPages.length})`);
        const journalChunks: typeof journalPages[] = [];
        for (let offset = 0; offset < journalPages.length; offset += PAGE_CHUNK) {
          journalChunks.push(journalPages.slice(offset, offset + PAGE_CHUNK));
        }
        for (let ci = 0; ci < journalChunks.length; ci += CONCURRENT_PAGES) {
          const group = journalChunks.slice(ci, ci + CONCURRENT_PAGES);
          await Promise.allSettled(
            group.map(async (chunk) => {
              let batchDailyResult: Awaited<ReturnType<typeof batchGetOrCreateDaily>>;
              try {
                batchDailyResult = await batchGetOrCreateDaily(chunk.map(p => p.journal!));
              } catch (e) {
                for (const page of chunk) {
                  p3.failed++;
                  p3.errors.push({ item: `Journal: ${page.journal}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
                  tick();
                }
                journalsDone += chunk.length;
                setImportStatus(`Creating journal pages… (${journalsDone}/${journalPages.length})`);
                return;
              }
              for (let i = 0; i < batchDailyResult.results.length; i++) {
                const result = batchDailyResult.results[i];
                const page = chunk[i];
                if (result.success && result.node) {
                  existingNodeIds.add(result.node.id);
                  if (page.uuid) uuidMap.set(page.uuid, { id: result.node.id, uuid: result.node.uuid });
                  titleToNodeInfo.set(page.title, { id: result.node.id, uuid: result.node.uuid });
                  p3.succeeded++;
                } else {
                  p3.failed++;
                  p3.errors.push({ item: `Journal: ${page.journal}${page.uuid ? ` [${page.uuid}]` : ''}`, message: result.error ?? 'Unknown error' });
                }
                tick();
              }
              journalsDone += chunk.length;
              setImportStatus(`Creating journal pages… (${journalsDone}/${journalPages.length})`);
            })
          );
        }
      }

      // 3b: Journal additive — fetch existing child counts
      const journalStartSeqs = new Map<string, number>();
      if (!override) {
        await Promise.all(journalPages.map(async (page) => {
          if (page.blocks.length === 0) return;
          const nodeInfo = titleToNodeInfo.get(page.title);
          if (!nodeInfo) return;
          try {
            const fullDay = await getNode(nodeInfo.id, { include_children: true });
            journalStartSeqs.set(page.title, fullDay.children?.length ?? 0);
          } catch { /* default to 0 */ }
        }));
      }

      // 3c: Batch-create regular pages (UUID-based dedup)
      const existingPageMap = new Map<string, Node>();
      const regularPageClasses = regularPages.map(page => {
        const cls = [pageClassId];
        if (page.tags) {
          for (const tag of page.tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) cls.push(mapped);
          }
        }
        return cls;
      });

      if (regularPages.length > 0) {
        let pagesDone = 0;
        setImportStatus(`Creating pages… (0/${regularPages.length})`);
        const pageChunks: typeof regularPages[] = [];
        for (let offset = 0; offset < regularPages.length; offset += PAGE_CHUNK) {
          pageChunks.push(regularPages.slice(offset, offset + PAGE_CHUNK));
        }
        for (let ci = 0; ci < pageChunks.length; ci += CONCURRENT_PAGES) {
          const group = pageChunks.slice(ci, ci + CONCURRENT_PAGES);
          await Promise.allSettled(
            group.map(async (chunk) => {
              try {
                const batchResult = await batchCreateNodes({
                  nodes: chunk.map(page => ({
                    ...(page.uuid ? { uuid: page.uuid } : {}),
                  })),
                  uuid_conflict_mode: 'return_existing',
                }, { headers: { 'X-Bulk-Import': 'true' } });
                for (let i = 0; i < batchResult.results.length; i++) {
                  const result = batchResult.results[i];
                  const page = chunk[i];
                  if (result.success && result.node) {
                    if (result.existing) {
                      existingNodeIds.add(result.node.id);
                      existingPageMap.set(page.title, result.node);
                    }
                    if (page.uuid) uuidMap.set(page.uuid, { id: result.node.id, uuid: result.node.uuid });
                    titleToNodeInfo.set(page.title, { id: result.node.id, uuid: result.node.uuid });
                    p3.succeeded++;
                  } else {
                    p3.failed++;
                    p3.errors.push({ item: `Page: ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: result.error ?? 'Unknown error' });
                  }
                  tick();
                }
              } catch (e) {
                for (const page of chunk) {
                  p3.failed++;
                  p3.errors.push({ item: `Page: ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
                  tick();
                }
              }
              pagesDone += chunk.length;
              setImportStatus(`Creating pages… (${pagesDone}/${regularPages.length})`);
            })
          );
        }
      }

      // 3d: Override mode — delete existing blocks
      if (override) {
        const existingPageIds = [...existingPageMap.values()].map(p => p.id);
        const journalIdsToDelete = journalPages
          .filter(p => p.blocks.length > 0)
          .map(p => titleToNodeInfo.get(p.title)?.id)
          .filter((id): id is number => id != null);
        const idsToDelete = [...new Set([...journalIdsToDelete, ...existingPageIds])];
        if (idsToDelete.length > 0) {
          await Promise.all(
            idsToDelete.map(async (id) => {
              try { await deleteExistingBlocks(id, queryClient); } catch (e) {
                console.error('Failed to delete existing blocks:', e);
              }
            }),
          );
        }
      }

      // 3f: Flatten ALL block trees
      type FlatBlock = {
        block: LogseqBlock;
        classes: number[];
        parent: { kind: 'page'; title: string } | { kind: 'block'; tempIdx: number };
        sequence: number;
        tempIdx: number;
      };
      const flatBlocks: FlatBlock[] = [];
      let nextTempIdx = 0;

      const collectFlatBlocks = (
        blocks: LogseqBlock[],
        parent: FlatBlock['parent'],
        startSeq: number,
      ) => {
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          const classes: number[] = [];
          if (block.tags) {
            for (const tag of block.tags) {
              const mapped = classIdMap.get(tag);
              if (mapped) classes.push(mapped);
            }
          }
          const tempIdx = nextTempIdx++;
          flatBlocks.push({ block, classes, parent, sequence: startSeq + i, tempIdx });
          if (block.children?.length) {
            collectFlatBlocks(block.children, { kind: 'block', tempIdx }, 0);
          }
        }
      };

      for (const page of regularPages) {
        if (page.blocks.length === 0) continue;
        if (!titleToNodeInfo.has(page.title)) continue;
        collectFlatBlocks(page.blocks, { kind: 'page', title: page.title }, 0);
      }
      for (const page of journalPages) {
        if (page.blocks.length === 0) continue;
        if (!titleToNodeInfo.has(page.title)) continue;
        const startSeq = journalStartSeqs.get(page.title) ?? 0;
        collectFlatBlocks(page.blocks, { kind: 'page', title: page.title }, startSeq);
      }

      // 3h: Batch-create all blocks (no parent_id yet)
      const BATCH_CHUNK = 500;
      const tempIdxToNodeInfo = new Map<number, NodeInfo>();

      if (flatBlocks.length > 0) {
        setImportStatus(`Creating ${flatBlocks.length} blocks… (0/${flatBlocks.length})`);
        for (let offset = 0; offset < flatBlocks.length; offset += BATCH_CHUNK) {
          const chunk = flatBlocks.slice(offset, offset + BATCH_CHUNK);
          const endIdx = Math.min(offset + BATCH_CHUNK, flatBlocks.length);
          setImportStatus(`Creating blocks… (${offset}/${flatBlocks.length})`);
          try {
            const batchResult = await batchCreateNodes({
              nodes: chunk.map(item => ({
                ...(item.block.uuid ? { uuid: item.block.uuid } : {}),
              })),
              uuid_conflict_mode: 'return_existing',
            }, { headers: { 'X-Bulk-Import': 'true' } });
            for (const result of batchResult.results) {
              const item = chunk[result.index];
              if (result.success && result.node) {
                const info: NodeInfo = { id: result.node.id, uuid: result.node.uuid };
                tempIdxToNodeInfo.set(item.tempIdx, info);
                if (item.block.uuid) uuidMap.set(item.block.uuid, info);
                p3.succeeded++;
              } else {
                p3.failed++;
                p3.errors.push({
                  item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}${item.block.uuid ? ` [${item.block.uuid}]` : ''}`,
                  message: result.error ?? 'Unknown error',
                });
              }
              tick();
            }
          } catch (e) {
            for (const item of chunk) {
              p3.failed++;
              p3.errors.push({ item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}`, message: errorMessage(e) });
              tick();
            }
          }
          setImportStatus(`Creating blocks… (${endIdx}/${flatBlocks.length})`);
        }
      }

      // Collect property values per node so they can be merged into the combined update pass below.
      // This avoids a separate batchSetPropertyValues round-trip — properties travel together with
      // name, parent_id, sequence, and classes in the same batchUpdateNodes request.
      const nodeIdToProperties = new Map<number, Record<number, unknown>>();
      const p5 = createPhase('Assign property values');
      phases.push(p5);
      {
        const propertyCollector = {
          mutateAsync: async (args: { nodeId: number; propertyId: number; value: unknown }) => {
            let props = nodeIdToProperties.get(args.nodeId);
            if (!props) { props = {}; nodeIdToProperties.set(args.nodeId, props); }
            props[args.propertyId] = args.value;
            return {} as unknown;
          },
        };
        for (const page of parsed.pages) {
          if (!page.properties) continue;
          const nodeInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
          if (!nodeInfo) continue;
          const isExisting = existingNodeIds.has(nodeInfo.id);
          const pageLabel = `${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`;
          await assignProperties(page.properties, nodeInfo.id, pageLabel, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertyCollector, p5, override, isExisting, textPropIds);
          tick();
        }
        for (const page of parsed.pages) {
          await assignBlockProperties(page.blocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertyCollector, p5, override, existingNodeIds, textPropIds);
        }
        if (parsed.standaloneBlocks) {
          await assignBlockProperties(parsed.standaloneBlocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertyCollector, p5, override, existingNodeIds, textPropIds);
        }
      }

      // 3g: Combined update — name + parent + sequence + classes + properties
      {
        setImportStatus('Preparing node content…');
        const combinedItems: BatchNodeUpdateItem[] = [];

        for (let i = 0; i < regularPages.length; i++) {
          const page = regularPages[i];
          const nodeInfo = titleToNodeInfo.get(page.title);
          if (!nodeInfo) continue;
          const existingPage = existingPageMap.get(page.title);
          const item: BatchNodeUpdateItem = { id: nodeInfo.id };
          if (!existingPage) {
            item.name = page.title;
            if (regularPageClasses[i].length > 0) item.classes = regularPageClasses[i];
          } else {
            if (override && nodeNameToText(existingPage.name) !== page.title) item.name = page.title;
            const existing = new Set(existingPage.classes ?? []);
            const toAdd = regularPageClasses[i].filter(c => !existing.has(c));
            if (toAdd.length > 0) item.classes = [...(existingPage.classes ?? []), ...toAdd];
          }
          // Set icon from logseq.property/icon (already converted to camelCase MDI name)
          if (page.icon && (!existingPage || override || !existingPage.icon)) item.icon = page.icon;
          const pageNodeProps = nodeIdToProperties.get(nodeInfo.id);
          if (pageNodeProps && Object.keys(pageNodeProps).length > 0) item.properties = pageNodeProps;
          if (item.name !== undefined || item.icon !== undefined || item.classes !== undefined || item.properties !== undefined) combinedItems.push(item);
        }

        for (const item of flatBlocks) {
          const nodeInfo = tempIdxToNodeInfo.get(item.tempIdx);
          if (!nodeInfo) continue;
          let parentId: number | undefined;
          if (item.parent.kind === 'page') {
            parentId = titleToNodeInfo.get(item.parent.title)?.id;
          } else {
            parentId = tempIdxToNodeInfo.get(item.parent.tempIdx)?.id;
          }
          if (!parentId) continue;
          let name = '';
          if (item.block.title) {
            try {
              const ast = buildAstFromLogseqText(item.block.title, uuidMap, titleToNodeInfo);
              name = ast.length > 0 ? JSON.stringify(ast) : '';
            } catch {
              name = item.block.title;
            }
          }
          const updateItem: BatchNodeUpdateItem = { id: nodeInfo.id, name, parent_id: parentId, sequence: item.sequence };
          if (item.classes.length > 0) updateItem.classes = item.classes;
          const blockNodeProps = nodeIdToProperties.get(nodeInfo.id);
          if (blockNodeProps && Object.keys(blockNodeProps).length > 0) updateItem.properties = blockNodeProps;
          combinedItems.push(updateItem);
        }

        const CONCURRENT_WIRES = 4;
        const wireChunks: BatchNodeUpdateItem[][] = [];
        for (let offset = 0; offset < combinedItems.length; offset += BATCH_CHUNK) {
          wireChunks.push(combinedItems.slice(offset, offset + BATCH_CHUNK));
        }
        setImportStatus(`Wiring ${combinedItems.length} nodes… (0/${combinedItems.length})`);
        let wiresDone = 0;
        for (let ci = 0; ci < wireChunks.length; ci += CONCURRENT_WIRES) {
          const group = wireChunks.slice(ci, ci + CONCURRENT_WIRES);
          await Promise.allSettled(
            group.map(async (chunk) => {
              try {
                await batchUpdateNodes({ nodes: chunk });
              } catch (e) {
                console.error('Failed combined update pass:', e);
              }
              wiresDone += chunk.length;
              tickN(chunk.length);
              setImportStatus(`Wiring nodes… (${wiresDone}/${combinedItems.length})`);
            })
          );
        }
      }

      // Standalone blocks
      if (parsed.standaloneBlocks && parsed.standaloneBlocks.length > 0) {
        let parentId: number | undefined;
        const activeNodeId = useNavigationStore.getState().currentNodeId;
        if (activeNodeId) {
          parentId = activeNodeId;
          setImportStatus('Adding block to current node…');
        } else {
          const today = new Date().toISOString().slice(0, 10);
          setImportStatus(`Adding block to today's page (${today})…`);
          try {
            const dayNode = await getOrCreateDaily(today);
            parentId = dayNode.id;
          } catch (e) {
            p3.failed++;
            p3.errors.push({ item: 'Standalone block (daily page)', message: errorMessage(e) });
          }
        }
        if (parentId) {
          try {
            const parentNode = await getNode(parentId, { include_children: true });
            const startSeq = parentNode.children?.length ?? 0;
            await createBlocksRecursively(
              parsed.standaloneBlocks, parentId, startSeq, uuidMap, classIdMap, contentQueue, p3, override,
            );
          } catch (e) {
            p3.failed++;
            p3.errors.push({ item: 'Standalone block', message: errorMessage(e) });
          }
        }
      }

      // 3b: Set page parents (namespace hierarchy)
      const pagesWithParent = parsed.pages.filter(p => p.parent);
      if (pagesWithParent.length > 0) {
        const p3b = createPhase('Set page parents');
        phases.push(p3b);
        const titleToNodeInfoLower = new Map<string, NodeInfo>();
        for (const [title, info] of titleToNodeInfo) {
          titleToNodeInfoLower.set(title.toLowerCase(), info);
        }
        const batchItems: Array<{ id: number; parent_id: number }> = [];
        const batchMeta: Array<{ pageTitle: string; parentTitle: string }> = [];
        for (const page of pagesWithParent) {
          const pageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
          let parentInfo = titleToNodeInfo.get(page.parent!)
            ?? titleToNodeInfoLower.get(page.parent!.toLowerCase());
          if (!pageInfo) {
            p3b.failed++;
            p3b.errors.push({ item: `${page.title} → ${page.parent}`, message: 'Page not found' });
            continue;
          }
          if (!parentInfo) {
            try {
              const searchResults = await searchNodes(page.parent!);
              const existing = searchResults.find(
                n => n.is_page && nodeNameToText(n.name).toLowerCase() === page.parent!.toLowerCase()
              );
              if (existing) {
                parentInfo = { id: existing.id, uuid: existing.uuid };
              } else {
                const newParent = await createNodeApi({ name: page.parent!, classes: [pageClassId] });
                parentInfo = { id: newParent.id, uuid: newParent.uuid };
              }
              titleToNodeInfo.set(page.parent!, parentInfo);
              titleToNodeInfoLower.set(page.parent!.toLowerCase(), parentInfo);
            } catch (e) {
              p3b.failed++;
              p3b.errors.push({ item: `${page.title} → ${page.parent}`, message: `Failed to create parent "${page.parent}": ${errorMessage(e)}` });
              continue;
            }
          }
          batchItems.push({ id: pageInfo.id, parent_id: parentInfo.id });
          batchMeta.push({ pageTitle: page.title, parentTitle: page.parent! });
        }
        if (batchItems.length > 0) {
          setImportStatus(`Setting page parents (${batchItems.length} pages)…`);
          const batchResult = await batchUpdateNodes({ nodes: batchItems });
          for (const result of batchResult.results) {
            if (result.success) {
              p3b.succeeded++;
            } else {
              p3b.failed++;
              const meta = batchMeta[result.index];
              p3b.errors.push({ item: `${meta?.pageTitle} → ${meta?.parentTitle}`, message: result.error || 'Unknown error' });
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 4: Bind properties to classes
      // ──────────────────────────────────────────────────────────
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

      // ──────────────────────────────────────────────────────────
      // PHASE 6: Set content for standalone blocks
      // ──────────────────────────────────────────────────────────
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

      // ──────────────────────────────────────────────────────────
      // PHASE 7: Assign aliases between pages
      // ──────────────────────────────────────────────────────────
      const pagesWithAliases = parsed.pages.filter(p => (p.aliases && p.aliases.length > 0) || (p.aliasOfUuids && p.aliasOfUuids.length > 0));
      if (pagesWithAliases.length > 0) {
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
                const aliasNode = await createNodeMutation.mutateAsync({ name: aliasTitle, classes: [pageClassId] });
                titleToNodeInfo.set(aliasTitle, { id: aliasNode.id, uuid: aliasNode.uuid });
                await addAlias(mainInfo.id, aliasNode.id);
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
                await addAlias(mainInfo.id, aliasInfo.id);
                p7.succeeded++;
                tick();
              } catch (e) {
                const msg = errorMessage(e);
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict') || msg.includes('itself an alias')) {
                  p7.succeeded++;
                } else if (msg.includes('page nodes') || msg.includes('is_page')) {
                  try {
                    await updateNode(mainInfo.id, { classes: [pageClassId] });
                    await updateNode(aliasInfo.id, { classes: [pageClassId] });
                    await addAlias(mainInfo.id, aliasInfo.id);
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
                await addAlias(thisPageInfo.id, aliasInfo.id);
                p7.succeeded++;
                tick();
              } catch (e) {
                const msg = errorMessage(e);
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict') || msg.includes('itself an alias')) {
                  p7.succeeded++;
                } else if (msg.includes('page nodes') || msg.includes('is_page')) {
                  try {
                    await updateNode(thisPageInfo.id, { classes: [pageClassId] });
                    await updateNode(aliasInfo.id, { classes: [pageClassId] });
                    await addAlias(thisPageInfo.id, aliasInfo.id);
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

      // ── Build final report ────────────────────────────────────
      const totalSucceeded = phases.reduce((s, p) => s + p.succeeded, 0);
      const totalFailed = phases.reduce((s, p) => s + p.failed, 0);

      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
      queryClient.invalidateQueries({ queryKey: propertyKeys.all });
      queryClient.invalidateQueries({ queryKey: ['property-nodes'] });

      setReport({ phases, totalSucceeded, totalFailed });
      setImportProgress(100);
      setImportStatus('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      setError(msg);
    } finally {
      setImporting(false);
    }
  }, [createNodeMutation, updateNodeMutation, createPropertyMutation, pageClassId, classClassId, queryClient]);

  return {
    importing,
    importStatus,
    importProgress,
    report,
    error,
    reset,
    runImport,
    /** null until system classes are loaded — callers should wait before calling runImport */
    pageClassId,
    classClassId,
  };
}
