/**
 * ImportLogseqModal - Modal for importing Logseq EDN graph exports
 *
 * Import flow (7 phases):
 * 1. Create classes (type nodes)
 * 2. Create properties (with correct backend field names)
 * 3. Create all nodes (pages + blocks) with classes assigned at creation,
 *    using plain-text names initially — builds UUID→nodeInfo map
 * 4. Bind properties to classes
 * 5. Assign property values to nodes
 * 6. Update node content with proper AST containing node_link entries,
 *    which triggers the backend to create link records automatically
 * 7. Assign aliases between pages (from logseq.property/alias)
 *
 * Every operation is wrapped in try/catch so a single failure never aborts
 * the import. Errors are collected and presented in a status report modal
 * at the end.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport, mdiCheckCircleOutline, mdiAlertCircleOutline, mdiChevronDown, mdiChevronUp } from '@mdi/js';
import Icon from '@mdi/react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { parseLogseqEdn, type LogseqExport, type LogseqBlock } from '@/utils/ednParser';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useAddClass, useCreateProperty, useSetNodeProperty, useAddPropertyToClass } from '@/hooks';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useAppStore } from '@/stores/appStore';
import { getOrCreateDaily, listClasses, searchNodes, addAlias, getNode, removeProperty, batchCreateNodes, batchUpdateNodes, createNode as createNodeApi } from '@/api/nodes';
import { listProperties, updateProperty, addClassExtends } from '@/api/properties';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { text as astText, nodeLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import type { PropertyType } from '@/types/api';
import './ImportLogseqModal.css';

// ── Error tracking types ───────────────────────────────────────

interface ImportError {
  item: string;   // e.g. "Class: Book" or "Property: Author"
  message: string; // error description
}

interface PhaseResult {
  label: string;
  succeeded: number;
  failed: number;
  errors: ImportError[];
}

interface ImportReport {
  phases: PhaseResult[];
  totalSucceeded: number;
  totalFailed: number;
}

function createPhase(label: string): PhaseResult {
  return { label, succeeded: 0, failed: 0, errors: [] };
}

function errorMessage(e: unknown): string {
  // Check for Axios-style response detail FIRST (before generic Error.message)
  if (typeof e === 'object' && e !== null && 'response' in e) {
    const resp = (e as { response?: { data?: { detail?: string } } }).response;
    if (resp?.data?.detail) return resp.data.detail;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Info stored per created Notees node, keyed by Logseq UUID */
interface NodeInfo {
  id: number;
  uuid: string; // Notees UUID (from the created node)
}

/** Import mode: additive only adds new entities, override also updates existing ones */
type ImportMode = 'additive' | 'override';

interface ImportLogseqModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportLogseqModal({ isOpen, onClose }: ImportLogseqModalProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<LogseqExport | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('additive');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const queryClient = useQueryClient();
  const createNodeMutation = useCreateNode();
  const updateNodeMutation = useUpdateNode();
  const createPropertyMutation = useCreateProperty();
  const setNodePropertyMutation = useSetNodeProperty();
  const addPropertyToClassMutation = useAddPropertyToClass();
  const addClassMutation = useAddClass();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { openNode } = useAppStore();

  // Reset state and focus when opened
  useEffect(() => {
    if (isOpen) {
      setContent('');
      setError(null);
      setParsed(null);
      setImporting(false);
      setImportStatus('');
      setReport(null);
      setImportMode('additive');
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Validate EDN as user types (debounced by paste)
  useEffect(() => {
    if (!content.trim()) {
      setError(null);
      setParsed(null);
      return;
    }
    try {
      const result = parseLogseqEdn(content);
      setParsed(result);
      setError(null);
    } catch (e) {
      setParsed(null);
      if (content.trim().length > 20) {
        setError(e instanceof Error ? e.message : 'Invalid EDN format');
      }
    }
  }, [content]);

  const handleImport = useCallback(async () => {
    if (!parsed || !pageClassId) return;
    setImporting(true);
    setReport(null);

    const override = importMode === 'override';
    const phases: PhaseResult[] = [];

    try {
      // ── Maps built during import ─────────────────────────────
      const uuidMap = new Map<string, NodeInfo>();
      const propIdMap = new Map<string, number>();
      const classIdMap = new Map<string, number>();
      const titleToNodeInfo = new Map<string, NodeInfo>();

      // ── Pre-populate classIdMap with Logseq built-in → Notees system class mappings ──
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
        }
      }
      const contentQueue: Array<{ id: number; title: string }> = [];
      /** Track node IDs that already existed before import */
      const existingNodeIds = new Set<number>();

      // ──────────────────────────────────────────────────────────
      // PHASE 1: Create classes (as type nodes)
      // ──────────────────────────────────────────────────────────
      const p1 = createPhase('Create classes');
      phases.push(p1);
      if (classClassId) {
        // Use the existingClasses already fetched above for system class mapping
        const existingClassByName = new Map(
          existingClasses.map(c => [nodeNameToText(c.name).toLowerCase(), c])
        );

        for (const cls of parsed.classes) {
          setImportStatus(`Creating class: ${cls.title}`);
          try {
            const existing = existingClassByName.get(cls.title.toLowerCase());
            if (existing) {
              classIdMap.set(cls.id, existing.id);
              if (cls.uuid) {
                uuidMap.set(cls.uuid, { id: existing.id, uuid: existing.uuid });
              }
              // Override mode: update name if it differs (case-sensitive)
              if (override && nodeNameToText(existing.name) !== cls.title) {
                await updateNodeMutation.mutateAsync({ id: existing.id, data: { name: cls.title } });
              }
              p1.succeeded++;
              continue;
            }
            const node = await createNodeMutation.mutateAsync({
              name: cls.title,
              classes: [classClassId, pageClassId],
            });
            classIdMap.set(cls.id, node.id);
            if (cls.uuid) {
              uuidMap.set(cls.uuid, { id: node.id, uuid: node.uuid });
            }
            p1.succeeded++;
          } catch (e) {
            p1.failed++;
            p1.errors.push({ item: cls.title, message: errorMessage(e) });
          }
        }

        // Set class extends (inheritance) relationships
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
          } catch (e) {
            const msg = errorMessage(e);
            if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
              p1b.succeeded++;
            } else {
              p1b.failed++;
              p1b.errors.push({ item: `${cls.title} extends ${cls.extends}`, message: msg });
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 2: Create properties
      // ──────────────────────────────────────────────────────────
      const p2 = createPhase('Create properties');
      phases.push(p2);

      // Pre-fetch existing properties to avoid 409 conflicts
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
          const finalType = noteesType === 'float' && prop.selectionOptions
            ? 'selection' as PropertyType
            : noteesType;

          const existingProp = existingPropByName.get(prop.title.toLowerCase());
          if (existingProp) {
            propIdMap.set(prop.id, existingProp.id);

            // Update is_multi flag if it changed
            if (existingProp.multi !== isMulti) {
              try {
                await updateProperty(existingProp.id, { multi: isMulti });
              } catch (e) {
                p2.errors.push({ item: prop.title, message: `Failed to update multi flag: ${errorMessage(e)}` });
              }
            }

            // Map selection option UUIDs for existing properties
            if (prop.selectionOptions && existingProp.options) {
              for (let i = 0; i < prop.selectionOptions.length && i < existingProp.options.length; i++) {
                const opt = prop.selectionOptions[i];
                if (opt.uuid) {
                  uuidMap.set(opt.uuid, { id: existingProp.options[i].id, uuid: '' });
                }
              }
            }
            p2.succeeded++;
            continue;
          }

          const created = await createPropertyMutation.mutateAsync({
            name: prop.title,
            type: finalType,
            is_multi: isMulti,
            selection_lines: selectionLines,
          } as Record<string, unknown> & { name: string });
          propIdMap.set(prop.id, created.id);

          if (prop.selectionOptions && created.options) {
            for (let i = 0; i < prop.selectionOptions.length && i < created.options.length; i++) {
              const opt = prop.selectionOptions[i];
              if (opt.uuid) {
                uuidMap.set(opt.uuid, { id: created.options[i].id, uuid: '' });
              }
            }
          }
          p2.succeeded++;
        } catch (e) {
          p2.failed++;
          p2.errors.push({ item: prop.title, message: errorMessage(e) });
        }
      }

      // Map logseq.property/description → Notees description system property
      const descriptionProp = existingProperties.find(p => p.uuid === SYSTEM_PROPERTY_UUIDS.description);
      if (descriptionProp) {
        propIdMap.set('logseq.property/description', descriptionProp.id);
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 3: Create all nodes (pages + blocks) with classes
      // ──────────────────────────────────────────────────────────
      const p3 = createPhase('Create nodes');
      phases.push(p3);
      for (const page of parsed.pages) {
        setImportStatus(`Creating page: ${page.title}`);

        const pageClasses = [pageClassId];
        if (page.tags) {
          for (const tag of page.tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) pageClasses.push(mapped);
          }
        }

        try {
          // Handle journal/daily pages via getOrCreateDaily
          if (page.journal) {
            try {
              const dayNode = await getOrCreateDaily(page.journal);
              existingNodeIds.add(dayNode.id); // Daily nodes may pre-exist
              if (page.uuid) {
                uuidMap.set(page.uuid, { id: dayNode.id, uuid: dayNode.uuid });
              }
              titleToNodeInfo.set(page.title, { id: dayNode.id, uuid: dayNode.uuid });
              p3.succeeded++;

              if (page.blocks.length > 0) {
                setImportStatus(`Creating blocks for journal: ${page.journal}`);
                await createBlocksRecursively(
                  page.blocks, dayNode.id, 0, uuidMap, classIdMap, contentQueue, p3,
                );
              }
            } catch (e) {
              p3.failed++;
              p3.errors.push({ item: `Journal: ${page.journal}`, message: errorMessage(e) });
            }
            continue;
          }

          // Check if a page with this exact name already exists
          const searchResults = await searchNodes(page.title);
          const existingPage = searchResults.find(
            n => n.is_page && nodeNameToText(n.name).toLowerCase() === page.title.toLowerCase()
          );

          if (existingPage) {
            existingNodeIds.add(existingPage.id);
            if (page.uuid) {
              uuidMap.set(page.uuid, { id: existingPage.id, uuid: existingPage.uuid });
            }
            titleToNodeInfo.set(page.title, { id: existingPage.id, uuid: existingPage.uuid });

            // Override mode: update name if different (case-sensitive)
            if (override && nodeNameToText(existingPage.name) !== page.title) {
              await updateNodeMutation.mutateAsync({ id: existingPage.id, data: { name: page.title } });
            }

            // Add missing classes (both modes — classes are always additive)
            const existingClassIds = new Set(existingPage.classes ?? []);
            for (const classId of pageClasses) {
              if (!existingClassIds.has(classId)) {
                try {
                  await addClassMutation.mutateAsync({ nodeId: existingPage.id, classId });
                } catch { /* already has class, ignore */ }
              }
            }

            p3.succeeded++;

            // Still create blocks under the existing page
            if (page.blocks.length > 0) {
              setImportStatus(`Creating blocks for: ${page.title}`);
              await createBlocksRecursively(
                page.blocks, existingPage.id, 0, uuidMap, classIdMap, contentQueue, p3,
              );
            }
            continue;
          }

          const pageNode = await createNodeMutation.mutateAsync({
            name: page.title,
            classes: pageClasses,
          });
          if (page.uuid) {
            uuidMap.set(page.uuid, { id: pageNode.id, uuid: pageNode.uuid });
          }
          titleToNodeInfo.set(page.title, { id: pageNode.id, uuid: pageNode.uuid });
          p3.succeeded++;

          if (page.blocks.length > 0) {
            setImportStatus(`Creating blocks for: ${page.title}`);
            await createBlocksRecursively(
              page.blocks, pageNode.id, 0, uuidMap, classIdMap, contentQueue, p3,
            );
          }
        } catch (e) {
          p3.failed++;
          p3.errors.push({ item: `Page: ${page.title}`, message: errorMessage(e) });
        }
      }

      // ── Standalone blocks (block-only EDN export) ──────────────
      // Attach to the currently active node, or today's daily page if none.
      if (parsed.standaloneBlocks && parsed.standaloneBlocks.length > 0) {
        let parentId: number | undefined;
        const activeNodeId = useAppStore.getState().currentNodeId;

        if (activeNodeId) {
          parentId = activeNodeId;
          setImportStatus('Adding block to current node…');
        } else {
          // No active node → use today's daily page
          const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
            await createBlocksRecursively(
              parsed.standaloneBlocks, parentId, 0, uuidMap, classIdMap, contentQueue, p3,
            );
          } catch (e) {
            p3.failed++;
            p3.errors.push({ item: 'Standalone block', message: errorMessage(e) });
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 3b: Set page parents (namespace hierarchy) — batched
      // ──────────────────────────────────────────────────────────
      const pagesWithParent = parsed.pages.filter(p => p.parent);
      if (pagesWithParent.length > 0) {
        const p3b = createPhase('Set page parents');
        phases.push(p3b);

        // Build batch update items, skipping unresolved pages
        const batchItems: Array<{ id: number; parent_id: number }> = [];
        const batchMeta: Array<{ pageTitle: string; parentTitle: string }> = [];

        for (const page of pagesWithParent) {
          const pageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
          const parentInfo = titleToNodeInfo.get(page.parent!);
          if (!pageInfo || !parentInfo) {
            p3b.failed++;
            p3b.errors.push({
              item: `${page.title} → ${page.parent}`,
              message: parentInfo ? 'Page not found' : `Parent page "${page.parent}" not found`,
            });
            continue;
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
              p3b.errors.push({
                item: `${meta?.pageTitle} → ${meta?.parentTitle}`,
                message: result.error || 'Unknown error',
              });
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 4: Bind properties to classes (idempotent — duplicates are OK)
      // ──────────────────────────────────────────────────────────
      const p4 = createPhase('Bind properties to classes');
      phases.push(p4);
      for (const cls of parsed.classes) {
        const noteesClassId = classIdMap.get(cls.id);
        if (!noteesClassId || !cls.properties) continue;
        for (const logseqPropId of cls.properties) {
          if (logseqPropId.startsWith('logseq.property')) continue;
          const noteesPropId = propIdMap.get(logseqPropId);
          if (!noteesPropId) continue;
          setImportStatus(`Binding property to class: ${cls.title}`);
          try {
            await addPropertyToClassMutation.mutateAsync({
              classId: noteesClassId,
              propertyId: noteesPropId,
            });
            p4.succeeded++;
          } catch (e) {
            // Treat "already bound" / conflict as success
            const msg = errorMessage(e);
            if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
              p4.succeeded++;
            } else {
              p4.failed++;
              p4.errors.push({ item: `${cls.title} ← ${logseqPropId}`, message: msg });
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 5: Assign property values to pages and blocks
      // ──────────────────────────────────────────────────────────
      const p5 = createPhase('Assign property values');
      phases.push(p5);
      console.log('[IMPORT] Phase 5: Starting property assignment');
      console.log('[IMPORT] titleToNodeInfo has', titleToNodeInfo.size, 'entries');
      console.log('[IMPORT] Sample titles:', Array.from(titleToNodeInfo.keys()).slice(0, 20));
      for (const page of parsed.pages) {
        if (!page.properties) continue;
        // Look up node by UUID first, then fall back to title
        const nodeInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
        if (!nodeInfo) {
          console.warn(`[IMPORT] Cannot find node for page: ${page.title}`);
          continue;
        }
        const isExisting = existingNodeIds.has(nodeInfo.id);
        console.log(`[IMPORT] Assigning properties to page: ${page.title} (id=${nodeInfo.id}, isExisting=${isExisting}, override=${override})`);
        await assignProperties(page.properties, nodeInfo.id, page.title, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, p5, override, isExisting);
      }
      for (const page of parsed.pages) {
        await assignBlockProperties(page.blocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, p5, override, existingNodeIds);
      }
      // Also assign properties for standalone blocks (block-only EDN)
      if (parsed.standaloneBlocks) {
        await assignBlockProperties(parsed.standaloneBlocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, p5, override, existingNodeIds);
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 6: Update node content with proper AST + links — batched
      // ──────────────────────────────────────────────────────────
      const p6 = createPhase('Set content & links');
      phases.push(p6);
      if (contentQueue.length > 0) {
        // Build batch items, converting content to AST ahead of time
        const batchItems: Array<{ id: number; name: string }> = [];
        const BATCH_SIZE = 50; // Send in chunks to avoid oversized requests

        for (const { id, title } of contentQueue) {
          if (!title) continue;
          try {
            const ast = buildAstFromLogseqText(title, uuidMap, titleToNodeInfo);
            batchItems.push({ id, name: JSON.stringify(ast) });
          } catch (e) {
            p6.failed++;
            p6.errors.push({ item: `Node ${id}`, message: errorMessage(e) });
          }
        }

        // Send in chunks
        for (let offset = 0; offset < batchItems.length; offset += BATCH_SIZE) {
          const chunk = batchItems.slice(offset, offset + BATCH_SIZE);
          setImportStatus(`Setting content with links (${offset + 1}–${offset + chunk.length} of ${batchItems.length})…`);
          const batchResult = await batchUpdateNodes({ nodes: chunk });
          for (const result of batchResult.results) {
            if (result.success) {
              p6.succeeded++;
            } else {
              p6.failed++;
              const item = chunk[result.index];
              p6.errors.push({ item: `Node ${item?.id}`, message: result.error || 'Unknown error' });
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

          // Handle logseq.property/alias — page.aliases lists alias page titles
          for (const aliasTitle of page.aliases ?? []) {
            const aliasInfo = titleToNodeInfo.get(aliasTitle);
            if (!aliasInfo) {
              // Create the alias page if it doesn't exist yet
              setImportStatus(`Creating alias page: ${aliasTitle}`);
              try {
                const aliasNode = await createNodeMutation.mutateAsync({
                  name: aliasTitle,
                });
                titleToNodeInfo.set(aliasTitle, { id: aliasNode.id, uuid: aliasNode.uuid });
                await addAlias(mainInfo.id, aliasNode.id);
                p7.succeeded++;
              } catch (e) {
                p7.failed++;
                p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}`, message: errorMessage(e) });
              }
            } else {
              setImportStatus(`Assigning alias: ${aliasTitle} → ${page.title}`);
              try {
                await addAlias(mainInfo.id, aliasInfo.id);
                p7.succeeded++;
              } catch (e) {
                const msg = errorMessage(e);
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
                  p7.succeeded++;
                } else {
                  p7.failed++;
                  p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}`, message: msg });
                }
              }
            }
          }

          // Handle :block/alias — this page is an alias OF the target UUIDs
          if (page.aliasOfUuids) {
            for (const targetUuid of page.aliasOfUuids) {
              const targetInfo = uuidMap.get(targetUuid);
              if (!targetInfo) {
                p7.failed++;
                p7.errors.push({ item: `Alias: ${page.title} → UUID ${targetUuid}`, message: 'Target page UUID not found' });
                continue;
              }
              const thisPageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
              if (!thisPageInfo) continue;
              setImportStatus(`Assigning alias: ${page.title} → target UUID ${targetUuid}`);
              try {
                // :block/alias means THIS page is an alias OF the target,
                // so target is the main node (first arg) and this page is the alias (second arg)
                await addAlias(targetInfo.id, thisPageInfo.id);
                p7.succeeded++;
              } catch (e) {
                const msg = errorMessage(e);
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
                  p7.succeeded++;
                } else {
                  p7.failed++;
                  p7.errors.push({ item: `Alias: ${page.title} → UUID ${targetUuid}`, message: msg });
                }
              }
            }
          }
        }
      }

      // ── Build final report ────────────────────────────────────
      const totalSucceeded = phases.reduce((s, p) => s + p.succeeded, 0);
      const totalFailed = phases.reduce((s, p) => s + p.failed, 0);

      // Invalidate queries to refresh UI with imported data
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
      queryClient.invalidateQueries({ queryKey: propertyKeys.all });

      // Single-page import: navigate directly to the page and close
      if (parsed.pages.length === 1 && totalFailed === 0) {
        const singlePage = parsed.pages[0];
        const info = singlePage.uuid ? uuidMap.get(singlePage.uuid) : titleToNodeInfo.get(singlePage.title);
        if (info) {
          openNode(info.id);
          onClose();
          return;
        }
      }

      setReport({ phases, totalSucceeded, totalFailed });
      setImportStatus('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [parsed, pageClassId, classClassId, importMode, createNodeMutation, updateNodeMutation, createPropertyMutation, setNodePropertyMutation, addPropertyToClassMutation, addClassMutation, onClose]);

  /** Recursively create blocks under a parent using batch API, tracking content for phase 6.
   *  Sibling blocks are created in a single batch request. Children are processed
   *  after the batch returns (they need the parent node ID from the result).
   */
  const createBlocksRecursively = async (
    blocks: LogseqBlock[],
    parentId: number,
    startSequence: number,
    uuidMap: Map<string, NodeInfo>,
    classIdMap: Map<string, number>,
    contentQueue: Array<{ id: number; title: string }>,
    phase: PhaseResult,
  ) => {
    if (blocks.length === 0) return;

    // Build batch items for all siblings at this level
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
      };
    });

    // Create all siblings in one batch request
    const batchResult = await batchCreateNodes({ nodes: batchItems });

    // Process results and queue children
    const childWork: Array<{ block: LogseqBlock; parentNodeId: number }> = [];

    for (const result of batchResult.results) {
      const block = blocks[result.index];
      if (result.success && result.node) {
        phase.succeeded++;

        if (block.uuid) {
          uuidMap.set(block.uuid, { id: result.node.id, uuid: result.node.uuid });
        }
        if (block.title) {
          contentQueue.push({ id: result.node.id, title: block.title });
        }

        // Queue children for recursive processing
        if (block.children && block.children.length > 0) {
          childWork.push({ block, parentNodeId: result.node.id });
        }
      } else {
        phase.failed++;
        phase.errors.push({
          item: `Block: ${block.title?.slice(0, 60) || '(empty)'}`,
          message: result.error || 'Unknown error',
        });
      }
    }

    // Recursively create children (each group is batched too)
    for (const { block, parentNodeId } of childWork) {
      await createBlocksRecursively(
        block.children!, parentNodeId, 0, uuidMap, classIdMap, contentQueue, phase,
      );
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && parsed && !importing) {
        e.preventDefault();
        handleImport();
      }
    },
    [parsed, importing, handleImport],
  );

  const journalCount = parsed?.pages.filter(p => p.journal).length ?? 0;
  const pageCount = (parsed?.pages.length ?? 0) - journalCount;
  const classCount = parsed?.classes.length ?? 0;
  const propCount = parsed?.properties.length ?? 0;
  const blockCount =
    (parsed?.pages.reduce((sum, p) => sum + countBlocks(p.blocks), 0) ?? 0)
    + (parsed?.standaloneBlocks ? countBlocks(parsed.standaloneBlocks) : 0);

  // ── Report view (shown after import completes) ────────────────
  if (report) {
    const hasErrors = report.totalFailed > 0;
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Import Report"
        size="lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <div className="import-logseq__report">
          <div className={`import-logseq__report-summary ${hasErrors ? 'import-logseq__report-summary--warning' : 'import-logseq__report-summary--success'}`}>
            <Icon path={hasErrors ? mdiAlertCircleOutline : mdiCheckCircleOutline} size={1} />
            <div>
              <strong>{hasErrors ? 'Import completed with errors' : 'Import completed successfully'}</strong>
              <span className="import-logseq__report-totals">
                {report.totalSucceeded} succeeded{report.totalFailed > 0 ? `, ${report.totalFailed} failed` : ''}
              </span>
            </div>
          </div>

          <div className="import-logseq__report-phases">
            {report.phases.map((phase, idx) => (
              <ReportPhaseRow key={idx} phase={phase} />
            ))}
          </div>
        </div>
      </Modal>
    );
  }

  // ── Input view (default) ──────────────────────────────────────
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import Logseq EDN"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!parsed || importing}
            icon={mdiImport}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-logseq__body" onKeyDown={handleKeyDown}>
        <p className="import-logseq__description">
          Paste the raw EDN content from a Logseq database graph export.
        </p>

        <textarea
          ref={textareaRef}
          className={`import-logseq__textarea${
            error ? ' import-logseq__textarea--error' : ''
          }${parsed ? ' import-logseq__textarea--valid' : ''}`}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder='{:pages-and-blocks [...] :properties {...} :classes {...}}'
          spellCheck={false}
        />

        {parsed && (
          <div className="import-logseq__mode-selector">
            <ToggleSwitch
              size="sm"
              leftLabel="ADDITIVE"
              rightLabel="OVERRIDE"
              checked={importMode === 'override'}
              onChange={(checked) => setImportMode(checked ? 'override' : 'additive')}
              disabled={importing}
            />
            <span className="import-logseq__mode-hint">
              {importMode === 'additive'
                ? 'Adds new entities and merges new properties into existing nodes'
                : 'Replaces existing node properties with imported data'}
            </span>
          </div>
        )}

        {error && <div className="import-logseq__error">{error}</div>}

        {parsed && (
          <div className="import-logseq__preview">
            <span className="import-logseq__preview-badge">
              {pageCount} page{pageCount !== 1 ? 's' : ''}
            </span>
            {journalCount > 0 && (
              <span className="import-logseq__preview-badge">
                {journalCount} journal{journalCount !== 1 ? 's' : ''}
              </span>
            )}
            <span className="import-logseq__preview-badge">
              {blockCount} block{blockCount !== 1 ? 's' : ''}
            </span>
            <span className="import-logseq__preview-badge">
              {classCount} class{classCount !== 1 ? 'es' : ''}
            </span>
            <span className="import-logseq__preview-badge">
              {propCount} propert{propCount !== 1 ? 'ies' : 'y'}
            </span>
          </div>
        )}

        {importing && importStatus && (
          <div className="import-logseq__status">{importStatus}</div>
        )}
      </div>
    </Modal>
  );
}

// ── Report phase row (collapsible error details) ───────────────

function ReportPhaseRow({ phase }: { phase: PhaseResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasErrors = phase.failed > 0;
  const total = phase.succeeded + phase.failed;

  if (total === 0) return null;

  return (
    <div className="import-logseq__phase">
      <div
        className={`import-logseq__phase-header ${hasErrors ? 'import-logseq__phase-header--error' : ''}`}
        onClick={() => hasErrors && setExpanded(!expanded)}
        role={hasErrors ? 'button' : undefined}
        tabIndex={hasErrors ? 0 : undefined}
        onKeyDown={(e) => { if (hasErrors && (e.key === 'Enter' || e.key === ' ')) setExpanded(!expanded); }}
      >
        <span className="import-logseq__phase-label">{phase.label}</span>
        <span className="import-logseq__phase-counts">
          <span className="import-logseq__phase-ok">{phase.succeeded} <Icon path={mdiCheckCircleOutline} size={0.6} /></span>
          {hasErrors && (
            <>
              <span className="import-logseq__phase-fail">{phase.failed} failed</span>
              <Icon path={expanded ? mdiChevronUp : mdiChevronDown} size={0.7} />
            </>
          )}
        </span>
      </div>
      {expanded && phase.errors.length > 0 && (
        <ul className="import-logseq__phase-errors">
          {phase.errors.map((err, i) => (
            <li key={i} className="import-logseq__phase-error">
              <strong>{err.item}</strong>: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Helpers (outside component) ────────────────────────────────

function countBlocks(blocks: LogseqBlock[]): number {
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

/**
 * Build AST document from Logseq block text, converting [[uuid]] and ((uuid))
 * references to proper node_link AST nodes with compound link_id (nodeUuid:linkUuid).
 *
 * Also handles labeled links: [label]([[uuid]]) → node_link (label is dropped
 * since the AST doesn't carry labels; the pill will show the target node name).
 *
 * ((uuid)) is Logseq's block reference syntax — these are resolved to the same
 * node_link AST nodes as [[uuid]] since Notees treats all references uniformly.
 *
 * The backend will parse these node_link entries and automatically create
 * records in the node_link DB table.
 */
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Matches #[[uuid]] (inline class), [label]([[uuid]]), bare [[uuid]], ((uuid)) block refs, and bare [[name]]
// Group 1 = #[[uuid]] inline class, Group 2 = labeled form uuid, Group 3 = bare [[uuid]],
// Group 4 = ((uuid)) block ref, Group 5 = [[name]]
const NODE_LINK_RE = new RegExp(
  `#\\[\\[(${UUID_RE})\\]\\]|\\[[^\\]]+\\]\\(\\[\\[(${UUID_RE})\\]\\]\\)|\\[\\[(${UUID_RE})\\]\\]|\\(\\((${UUID_RE})\\)\\)|\\[\\[([^\\]]+)\\]\\]`,
  'gi'
);

function buildAstFromLogseqText(
  rawText: string,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo?: Map<string, NodeInfo>,
): Array<{ type: string; children: ASTInlineNode[] }> {
  if (!rawText) return [];

  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  // Find all #[[uuid]] (inline class), [[uuid]], ((uuid)), [label]([[uuid]]), and [[name]] patterns → node_link AST nodes
  for (const match of rawText.matchAll(NODE_LINK_RE)) {
    // Group 1 = #[[uuid]] inline class, Group 2 = labeled form uuid,
    // Group 3 = bare [[uuid]], Group 4 = ((uuid)) block ref, Group 5 = name-based link
    const inlineClassUuid = match[1];
    const logseqUuid = match[2] ?? match[3] ?? match[4];
    const linkName = match[5];
    const matchStart = match.index ?? 0;

    // Add preceding plain text
    if (matchStart > lastIndex) {
      children.push(astText(rawText.slice(lastIndex, matchStart)));
    }

    if (inlineClassUuid) {
      // #[[uuid]] → inline class reference (ref_type: 'class')
      const target = uuidMap.get(inlineClassUuid);
      if (target) {
        const linkInstanceUuid = crypto.randomUUID();
        const linkId = buildLinkId(target.uuid, linkInstanceUuid);
        children.push(nodeLink(linkId, 'class'));
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
        // Build compound link_id: "targetNodeUuid:newLinkInstanceUuid"
        const linkInstanceUuid = crypto.randomUUID();
        const linkId = buildLinkId(target.uuid, linkInstanceUuid);
        children.push(nodeLink(linkId, 'node'));
      } else if (linkName) {
        // Name-based link with no matching node — keep as plain text without brackets
        children.push(astText(linkName));
      } else {
        // Unresolved UUID reference — keep original syntax as plain text
        // so the block doesn't end up empty
        children.push(astText(match[0]));
      }
    }

    lastIndex = matchStart + match[0].length;
  }

  // Add trailing plain text
  if (lastIndex < rawText.length) {
    children.push(astText(rawText.slice(lastIndex)));
  }

  // If no children were generated, produce empty doc
  if (children.length === 0) return [];

  return [paragraph(...children)];
}

/** Assign properties to a single node */
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
  override: boolean = false,
  isExistingNode: boolean = false,
) {
  // For existing nodes, fetch current properties to determine what to skip/delete
  let existingProperties: Record<number, unknown> | undefined;
  if (isExistingNode) {
    try {
      const fullNode = await getNode(nodeId, { include_properties: true });
      existingProperties = fullNode.properties ?? {};
    } catch {
      existingProperties = {};
    }

    if (override) {
      // Override mode: delete all existing properties that are NOT in the import set
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
          } catch { /* property may already be gone, ignore */ }
        }
      }
    }
  }

  for (const [logseqPropId, rawValue] of Object.entries(properties)) {
    const noteesPropId = propIdMap.get(logseqPropId);
    if (!noteesPropId) {
      console.warn(`[IMPORT] Property ${logseqPropId} not found in propIdMap`);
      continue;
    }

    // Additive mode on existing node: skip properties that already have a non-empty value
    if (isExistingNode && !override && existingProperties && noteesPropId in existingProperties) {
      const existingVal = existingProperties[noteesPropId];
      const hasValue = existingVal !== null && existingVal !== undefined && existingVal !== ''
        && !(Array.isArray(existingVal) && existingVal.length === 0);
      if (hasValue) {
        console.log(`[IMPORT] Skipping property ${logseqPropId} on ${label} - already has value in additive mode`);
        phase.succeeded++;
        continue;
      }
      console.log(`[IMPORT] Property ${logseqPropId} on ${label} exists but is empty — will set from import`);
    }

    try {
      const resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeInfo, classIdMap, pageClassId);
      console.log(`[IMPORT] Property ${logseqPropId} on ${label}:`, { 
        rawValue, 
        resolved, 
        resolvedType: typeof resolved,
        isArray: Array.isArray(resolved),
        arrayContents: Array.isArray(resolved) ? JSON.stringify(resolved) : 'N/A',
        isExistingNode, 
        override 
      });
      if (resolved !== undefined) {
        setImportStatus(`Setting property on: ${label}`);
        try {
          await setNodePropertyMutation.mutateAsync({
            nodeId,
            propertyId: noteesPropId,
            value: resolved,
          });
          console.log(`[IMPORT] ✓ Successfully set property ${logseqPropId} on ${label}`);
          phase.succeeded++;
        } catch (propError) {
          console.error(`[IMPORT] ✗ Failed to set property ${logseqPropId} on ${label}:`, propError);
          throw propError;
        }
      } else {
        console.warn(`[IMPORT] Skipping property ${logseqPropId} on ${label} - resolved to undefined`);
        phase.failed++;
        phase.errors.push({ item: `${label} ← ${logseqPropId}`, message: 'Property value resolved to undefined (referenced page may not exist)' });
      }
    } catch (e) {
      console.error(`[IMPORT] Error setting property ${logseqPropId} on ${label}:`, e);
      phase.failed++;
      phase.errors.push({ item: `${label} ← ${logseqPropId}`, message: errorMessage(e) });
    }
  }
}

/** Recursively assign properties to blocks */
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
  override: boolean = false,
  existingNodeIds: Set<number> = new Set(),
) {
  for (const block of blocks) {
    if (block.properties && block.uuid) {
      const nodeInfo = uuidMap.get(block.uuid);
      if (nodeInfo) {
        const isExisting = existingNodeIds.has(nodeInfo.id);
        await assignProperties(
          block.properties, nodeInfo.id, block.title || '(block)',
          propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, phase,
          override, isExisting,
        );
      }
    }
    if (block.children) {
      await assignBlockProperties(block.children, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, phase, override, existingNodeIds);
    }
  }
}

/**
 * Resolve a parsed EDN property value to a Notees-compatible value.
 * Handles structured markers from the EDN parser:
 * - { __type: 'page-ref', title } → find node ID by title
 * - { __type: 'date-ref', date } → create/get day page, return node ID
 * - { __type: 'uuid-ref', uuid } → look up in uuidMap (selection line IDs)
 * - boolean/number/string → pass through
 * - arrays → resolve each element (multi-value)
 */
async function resolvePropertyValueForImport(
  value: unknown,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo: Map<string, NodeInfo>,
  classIdMap: Map<string, number>,
  pageClassId: number,
): Promise<unknown> {
  if (value === null || value === undefined) return undefined;

  // Array → resolve each element for multi-value properties
  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) {
      const r = await resolvePropertyValueForImport(item, uuidMap, titleToNodeInfo, classIdMap, pageClassId);
      if (r !== undefined) resolved.push(r);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  // Structured markers from EDN parser
  if (typeof value === 'object' && value !== null && '__type' in value) {
    const typed = value as { __type: string; [key: string]: unknown };
    switch (typed.__type) {
      case 'page-ref': {
        const title = typed.title as string;
        const tags = (typed.tags as string[] | undefined) ?? [];
        const info = titleToNodeInfo.get(title);
        if (info) return info.id;
        // Fallback: search the database for an existing node with this title
        // (handles pages imported in a previous session)
        try {
          const searchResults = await searchNodes(title);
          console.log(`[IMPORT] page-ref "${title}": search returned ${searchResults.length} results`);
          // Match by extracted text name — don't require is_page since the node
          // might have been created without the page class
          const titleMatches = searchResults.filter(n => {
            const nodeName = nodeNameToText(n.name).toLowerCase();
            const match = nodeName === title.toLowerCase();
            if (!match) {
              console.log(`[IMPORT]   candidate id=${n.id} name="${nodeName}" — no match`);
            }
            return match;
          });
          console.log(`[IMPORT] page-ref "${title}": ${titleMatches.length} exact title matches`);
          let existing = titleMatches[0];
          // If multiple nodes match the title, prefer pages, then match by tags
          if (titleMatches.length > 1) {
            // Prefer pages over blocks
            const pages = titleMatches.filter(n => n.is_page);
            if (pages.length > 0) {
              existing = pages[0];
              // Further disambiguate by tags if available
              if (pages.length > 1 && tags.length > 0) {
                const expectedClassIds = new Set(
                  tags.map(t => classIdMap.get(t)).filter((id): id is number => id !== undefined)
                );
                if (expectedClassIds.size > 0) {
                  const best = pages.find(n =>
                    n.classes?.some(cid => expectedClassIds.has(cid))
                  );
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
        // Auto-create the referenced page if it doesn't exist
        console.log(`[IMPORT] page-ref "${title}": not found, auto-creating page`);
        try {
          const classes = [pageClassId];
          for (const tag of tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) classes.push(mapped);
          }
          const newPage = await createNodeApi({ name: title, classes });
          titleToNodeInfo.set(title, { id: newPage.id, uuid: newPage.uuid });
          console.log(`[IMPORT] page-ref "${title}": created page id=${newPage.id}`);
          return newPage.id;
        } catch (createErr) {
          console.error(`[IMPORT] page-ref "${title}": failed to create page`, createErr);
        }
        return undefined;
      }
      case 'date-ref': {
        // Create/get day page and return its node ID (dates are relation values)
        try {
          const dayNode = await getOrCreateDaily(typed.date as string);
          return dayNode.id;
        } catch {
          console.warn(`Failed to resolve date: ${typed.date}`);
          return undefined;
        }
      }
      case 'uuid-ref': {
        const info = uuidMap.get(typed.uuid as string);
        if (!info) {
          console.warn(`[IMPORT] UUID reference not found: ${typed.uuid}`);
        }
        return info?.id ?? undefined;
      }
    }
  }

  // Primitives: boolean, number, string
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value || undefined;

  return undefined;
}
