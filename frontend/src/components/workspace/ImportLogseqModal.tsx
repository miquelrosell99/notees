/**
 * ImportLogseqModal - Modal for importing Logseq graph exports
 *
 * Import flow (7 phases):
 * 1. Create classes (type nodes)
 * 2. Create properties (with correct backend field names)
 * 3. Create all nodes (pages + blocks) with UUID-only skeletons (no name, no
 *    parent, no classes) — registers every UUID in DB before any content is written
 * 4. Bind properties to classes
 * 5. Assign property values to nodes
 * 6. Combined update pass: name (with [[uuid]] links resolved) + parent +
 *    sequence + classes for every page and block created in step 3.
 *    Because all UUIDs exist at this point, every link resolves correctly.
 * 7. Standalone-block content (from EDN block exports) — Phase 7 in old numbering
 * 7. Assign aliases between pages (from logseq.property/alias)
 *
 * Every operation is wrapped in try/catch so a single failure never aborts
 * the import. Errors are collected and presented in a status report modal
 * at the end.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport } from '@mdi/js';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { CodeTextarea } from '../core/CodeTextarea';
import { TaskProgress } from '../core/TaskProgress';
import { TaskReport } from '../core/TaskReport';
import { type LogseqExport, type LogseqBlock, type LogseqPage } from '@/utils/ednParser';
import { parseEdnInWorker, parseSqliteInWorker } from '@/utils/logseqParserClient';
import { consumePendingLogseqImport, consumeImportCompleteCallback, consumeWorkspaceToDelete, notifyImportProgress, notifyImportReport, notifyImportError, isAutoImportActive, setAutoImportActive } from '@/utils/importState';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useAddClass, useCreateProperty } from '@/hooks';
import { nodeKeys, propertyKeys } from '@/hooks/queryKeys';
import { useAppStore } from '@/stores/appStore';
import { getOrCreateDaily, listClasses, searchNodes, addAlias, getNode, getNodeByUuid, updateNode, removeProperty, batchCreateNodes, batchUpdateNodes, batchGetOrCreateDaily, createNode as createNodeApi, batchDeleteNodes, batchPermanentlyDeleteNodes } from '@/api/nodes';

import { listProperties, updateProperty, addClassExtends } from '@/api/properties';
import { batchSetPropertyValues, batchAddClassProperties } from '@/api/properties';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { text as astText, nodeLink, externalLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import type { PropertyType, Property, Node, BatchNodeUpdateItem } from '@/types/api';
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
 * Two-step: soft-delete first, then hard-delete to free UUIDs so
 * new blocks can be created with the same Logseq UUIDs.
 * Returns number of blocks deleted.
 */
async function deleteExistingBlocks(pageId: number, queryClient: QueryClient): Promise<number> {
  // Fetch the page with all children
  const fullPage = await getNode(pageId, { include_children: true });
  const { uuids: childUuids, ids: childIds } = collectChildInfo(fullPage);
  
  if (childUuids.length === 0) {
    return 0;
  }

  // Step 1: Soft-delete (sets is_deleted = TRUE)
  const result = await batchDeleteNodes({ uuids: childUuids });
  
  // Step 2: Hard-delete to free UUID uniqueness constraints
  // This allows re-creating blocks with the same Logseq UUIDs
  if (childIds.length > 0) {
    try {
      await batchPermanentlyDeleteNodes({ ids: childIds });
    } catch (e) {
      console.warn('[IMPORT] Hard-delete of old blocks failed (non-critical):', e);
    }
  }

  // Invalidate queries for this page to ensure UI updates
  queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(pageId) });
  
  return result.deleted;
}

/** Info stored per created Notees node, keyed by Logseq UUID */
interface NodeInfo {
  id: number;
  uuid: string; // Notees UUID (from the created node)
}

/** Import mode: additive only adds new entities, override also updates existing ones */
type ImportMode = 'additive' | 'override';

/** Input source: EDN text paste or SQLite file upload */
type InputSource = 'edn' | 'sqlite';

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
  const [importProgress, setImportProgress] = useState(0);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>(
    () => (localStorage.getItem('logseq-import-mode') as ImportMode | null) ?? 'additive'
  );
  const [inputSource, setInputSource] = useState<InputSource>('edn');
  const [sqliteFileName, setSqliteFileName] = useState<string | null>(null);
  const [sqliteParsing, setSqliteParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** True when the modal was opened in auto-import mode (no form shown). */
  const [isAutoImportMode, setIsAutoImportMode] = useState(false);
  const isAutoImportModeRef = useRef(false);
  const shouldAutoImportRef = useRef(false);
  /** Prevents a flash of the input form before the open-effect fires. */
  const hasInitializedRef = useRef(false);
  /** UUID of the workspace to delete if user cancels (auto-import mode only). */
  const workspaceToDeleteRef = useRef<string | null>(null);

  const handleImportModeChange = (checked: boolean) => {
    const mode: ImportMode = checked ? 'override' : 'additive';
    setImportMode(mode);
    localStorage.setItem('logseq-import-mode', mode);
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const queryClient = useQueryClient();
  const createNodeMutation = useCreateNode();
  const updateNodeMutation = useUpdateNode();
  const createPropertyMutation = useCreateProperty();
  const addClassMutation = useAddClass();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  // Reset state and focus when opened
  useEffect(() => {
    if (isOpen) {
      // Check for pre-collected state from the unified ImportOptionsModal
      const pending = consumePendingLogseqImport();

      setError(null);
      setParsed(null);
      setImporting(false);
      setImportStatus('');
      setImportProgress(0);
      setReport(null);
      setIsAutoImportMode(false);
      isAutoImportModeRef.current = false;
      shouldAutoImportRef.current = false;
      hasInitializedRef.current = true;

      if (pending && pending.autoImport && pending.parsedExport) {
        // ── Auto-import mode: skip the configuration form, start immediately ──
        setIsAutoImportMode(true);
        isAutoImportModeRef.current = true;
        setInputSource(pending.source);
        if (pending.source === 'edn') setSqliteFileName(null);
        else setSqliteFileName(pending.sqliteFile?.name ?? null);
        setSqliteParsing(false);
        setParsed(pending.parsedExport);
        shouldAutoImportRef.current = true;
        workspaceToDeleteRef.current = consumeWorkspaceToDelete();
      } else if (pending) {
        setInputSource(pending.source);
        if (pending.source === 'edn') {
          setContent(pending.ednContent);
          setSqliteFileName(null);
          setSqliteParsing(false);
          setTimeout(() => textareaRef.current?.focus(), 0);
        } else {
          setContent('');
          setSqliteFileName(pending.sqliteFile.name);
          setSqliteParsing(true);
          let active = true;
          let cancelParse: () => void = () => {};
          pending.sqliteFile
            .arrayBuffer()
            .then((buf) => {
              if (!active) return Promise.reject(new Error('cancelled'));
              const handle = parseSqliteInWorker(buf);
              cancelParse = handle.cancel;
              return handle.promise;
            })
            .then((result) => {
              if (!active) return;
              setParsed(result);
              setError(null);
            })
            .catch((e) => {
              if (!active) return;
              setParsed(null);
              setError(e instanceof Error ? e.message : 'Failed to parse SQLite file');
            })
            .finally(() => { if (active) setSqliteParsing(false); });
          return () => { active = false; cancelParse(); };
        }
      } else {
        setContent('');
        setSqliteFileName(null);
        setSqliteParsing(false);
        if (inputSource === 'edn') {
          setTimeout(() => textareaRef.current?.focus(), 0);
        }
      }
    } else {
      hasInitializedRef.current = false;
    }
  }, [isOpen]);

  // Forward progress and status to importState so ImportOptionsModal can display them
  useEffect(() => {
    if (isAutoImportModeRef.current) {
      notifyImportProgress({ status: importStatus, progress: importProgress });
    }
  }, [importStatus, importProgress]);

  // Validate EDN as user types (debounced by paste) — runs in a worker so the UI stays responsive
  useEffect(() => {
    if (inputSource !== 'edn') return;
    if (!content.trim()) {
      setError(null);
      setParsed(null);
      return;
    }
    const { promise, cancel } = parseEdnInWorker(content);
    let active = true;
    promise
      .then((result) => {
        if (!active) return;
        setParsed(result);
        setError(null);
      })
      .catch((e) => {
        if (!active) return;
        setParsed(null);
        if (content.trim().length > 20) {
          setError(e instanceof Error ? e.message : 'Invalid EDN format');
        }
      });
    return () => { active = false; cancel(); };
  }, [content, inputSource]);

  /** Handle SQLite file selection — parsing runs in a worker so the UI stays responsive. */
  const handleSqliteFile = useCallback((file: File) => {
    setSqliteFileName(file.name);
    setSqliteParsing(true);
    setError(null);
    setParsed(null);

    let cancelParse: () => void = () => {};
    file.arrayBuffer().then((buffer) => {
      const handle = parseSqliteInWorker(buffer);
      cancelParse = handle.cancel;
      return handle.promise;
    })
      .then((result) => {
        setParsed(result);
        setError(null);
      })
      .catch((e) => {
        setParsed(null);
        setError(e instanceof Error ? e.message : 'Failed to parse SQLite file');
      })
      .finally(() => setSqliteParsing(false));

    // Return cancel in case the caller needs it (e.g. file changed before parsing done)
    return () => cancelParse();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleSqliteFile(file);
    },
    [handleSqliteFile],
  );

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file && (file.name.endsWith('.sqlite') || file.name.endsWith('.sqlite3') || file.name.endsWith('.db'))) {
        handleSqliteFile(file);
      } else {
        setError('Please drop a Logseq .sqlite database file');
      }
    },
    [handleSqliteFile],
  );

  const handleInputSourceChange = useCallback((source: InputSource) => {
    setInputSource(source);
    setError(null);
    setParsed(null);
    setContent('');
    setSqliteFileName(null);
  }, []);

  const handleImport = useCallback(async () => {
    if (!parsed || !pageClassId) return;
    setImporting(true);
    setReport(null);
    setImportProgress(0);

    const override = importMode === 'override';
    const phases: PhaseResult[] = [];

    // ── Progress tracking ──────────────────────────────────────
    // Estimate total work items for percentage calculation.
    // Counts: classes + class-extends + properties + pages + prop-bindings
    //       + pages-with-props + contentQueue (≈blocks) + aliases
    const classExtends = parsed.classes.filter(c => c.extends).length;
    const propBindings = parsed.classes.reduce((s, c) => s + (c.properties?.length ?? 0), 0);
    const pagesWithProps = parsed.pages.filter(p => p.properties && Object.keys(p.properties).length > 0).length;
    const pagesWithAliases = parsed.pages.filter(p => (p.aliases && p.aliases.length > 0) || (p.aliasOfUuids && p.aliasOfUuids.length > 0)).length;
    const totalBlocks = parsed.pages.reduce((s, p) => s + countBlocks(p.blocks), 0)
      + (parsed.standaloneBlocks ? countBlocks(parsed.standaloneBlocks) : 0);
    const estimatedTotal = Math.max(1,
      parsed.classes.length + classExtends + parsed.properties.length
      + parsed.pages.length + propBindings + pagesWithProps
      + totalBlocks + pagesWithAliases
    );
    let completedItems = 0;
    const tick = () => {
      completedItems++;
      setImportProgress(Math.min(99, Math.round((completedItems / estimatedTotal) * 100)));
    };

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
          const info = { id: systemClass.id, uuid: systemClass.uuid };
          // Register display name so title-based alias/link lookups resolve correctly
          const displayName = nodeNameToText(systemClass.name);
          if (displayName) {
            titleToNodeInfo.set(displayName, info);
            titleToNodeInfo.set(displayName.toLowerCase(), info);
          }
          // Register the Logseq-side UUID so UUID-based lookups (e.g. aliasOfUuids)
          // resolve without needing a fallback scan.
          const lsClass = parsed.classes.find(c => c.id === logseqKey);
          if (lsClass?.uuid) {
            uuidMap.set(lsClass.uuid, info);
          }
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
              tick();
              continue;
            }
            const node = await createNodeMutation.mutateAsync({
              name: cls.title,
              classes: [classClassId, pageClassId],
              ...(cls.uuid ? { uuid: cls.uuid } : {}),
            });
            classIdMap.set(cls.id, node.id);
            if (cls.uuid) {
              uuidMap.set(cls.uuid, { id: node.id, uuid: node.uuid });
            }
            p1.succeeded++;
            tick();
          } catch (e) {
            p1.failed++;
            tick();
            p1.errors.push({ item: `${cls.title}${cls.uuid ? ` [${cls.uuid}]` : ''}`, message: errorMessage(e) });
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
          const finalType = prop.selectionOptions
            ? 'selection' as PropertyType
            : noteesType;

          const existingProp = existingPropByName.get(prop.title.toLowerCase());
          if (existingProp) {
            propIdMap.set(prop.id, existingProp.id);

            // Update is_multi flag if it changed (skip for system properties — they can't be modified)
            if (existingProp.multi !== isMulti && !existingProp.is_system) {
              try {
                await updateProperty(existingProp.id, { multi: isMulti });
              } catch (e) {
                p2.errors.push({ item: prop.title, message: `Failed to update multi flag: ${errorMessage(e)}` });
              }
            }

            // Map selection option UUIDs for existing properties (match by name, not index)
            if (prop.selectionOptions && existingProp.options) {
              for (const opt of prop.selectionOptions) {
                if (!opt.uuid) continue;
                const optValue = String(opt.value).toLowerCase();
                const matching = existingProp.options.find(o => o.name.toLowerCase() === optValue);
                if (matching) {
                  uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
                } else {
                  console.warn(`[IMPORT] Selection option "${opt.value}" not found in existing property "${prop.title}"`);
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
            // If 409 (property already exists), re-fetch and reuse the existing one
            const resp = (createErr as { response?: { status?: number } }).response;
            if (resp?.status === 409) {
              const refreshed = await listProperties();
              const found = refreshed.find(p => p.name.toLowerCase() === prop.title.toLowerCase());
              if (found) {
                propIdMap.set(prop.id, found.id);
                existingPropByName.set(prop.title.toLowerCase(), found);
                // Map selection option UUIDs for the found property
                if (prop.selectionOptions && found.options) {
                  for (const opt of prop.selectionOptions) {
                    if (!opt.uuid) continue;
                    const optValue = String(opt.value).toLowerCase();
                    const matching = found.options.find(o => o.name.toLowerCase() === optValue);
                    if (matching) {
                      uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
                    }
                  }
                }
                p2.succeeded++;
                tick();
                continue;
              }
            }
            // Re-throw if not a 409 or if the property wasn't found after refresh
            throw createErr;
          }
          propIdMap.set(prop.id, created.id);

          if (prop.selectionOptions && created.options) {
            // Match by name since the created options should mirror the input order,
            // but name-matching is more robust against API ordering differences.
            for (const opt of prop.selectionOptions) {
              if (!opt.uuid) continue;
              const optValue = String(opt.value).toLowerCase();
              const matching = created.options.find(o => o.name.toLowerCase() === optValue);
              if (matching) {
                uuidMap.set(opt.uuid, { id: matching.id, uuid: '' });
              } else {
                console.warn(`[IMPORT] Created selection option "${opt.value}" not found in response for "${prop.title}"`);
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
      if (descriptionProp) {
        propIdMap.set('logseq.property/description', descriptionProp.id);
      }

      // Map logseq.property/status and logseq.property/priority → Notees task system properties.
      // Option UUIDs are matched by value name (case-insensitive) since Logseq UUIDs differ from Notees.
      const LOGSEQ_SYSTEM_PROP_MAP: Array<{ logseqId: string; notesUuid: string }> = [
        { logseqId: 'logseq.property/status',   notesUuid: SYSTEM_PROPERTY_UUIDS.task_status },
        { logseqId: 'logseq.property/priority',  notesUuid: SYSTEM_PROPERTY_UUIDS.task_priority },
      ];
      for (const { logseqId, notesUuid } of LOGSEQ_SYSTEM_PROP_MAP) {
        const sysProp = existingProperties.find(p => p.uuid === notesUuid);
        if (!sysProp) continue;
        propIdMap.set(logseqId, sysProp.id);
        // Match Logseq closed-value UUIDs to Notees option node IDs by value name
        const logseqProp = parsed.properties.find(lp => lp.id === logseqId);
        if (logseqProp?.selectionOptions && sysProp.options) {
          // Logseq→Notees name translations for values that don't match exactly
          const LOGSEQ_TO_NOTEES_NAME: Record<string, string> = {
            'todo': 'pending',
            'in review': 'reviewing',
            'canceled': 'cancelled',
          };
          for (const lsOpt of logseqProp.selectionOptions) {
            if (!lsOpt.uuid) continue;
            const lsName = String(lsOpt.value).toLowerCase();
            const notesName = LOGSEQ_TO_NOTEES_NAME[lsName] ?? lsName;
            const notesOpt = sysProp.options.find(
              o => o.name.toLowerCase() === notesName
            );
            if (notesOpt) {
              uuidMap.set(lsOpt.uuid, { id: notesOpt.id, uuid: '' });
            }
          }
        }
      }

      // Build set of notees property IDs that are text-type (stored as block node references)
      const textPropIds = new Set<number>(
        existingProperties.filter(p => p.type === 'text').map(p => p.id)
      );

      // ──────────────────────────────────────────────────────────
      // PHASE 3: Create all nodes (pages + blocks) + wire hierarchy
      //
      // Strategy:
      //   3a) Journal pages: batch getOrCreateDaily
      //   3b) Journal additive: fetch existing child counts
      //   3c) Regular pages: parallel existence checks
      //   3d) Override: parallel delete of existing blocks
      //   3e) Batch-create new pages — UUID skeleton only (no name, no classes)
      //   3f) Batch-create all blocks — UUID skeleton only (no name, no parent)
      //   3g) Combined update: name + parent + sequence + classes for everything
      //       [[uuid]] links resolve fully because all UUIDs are in the DB now
      // ──────────────────────────────────────────────────────────
      const p3 = createPhase('Create nodes');
      phases.push(p3);

      const journalPages = parsed.pages.filter(p => p.journal);
      const regularPages = parsed.pages.filter(p => !p.journal);

      // ── 3a: Journal pages — one batch call ────────────────────
      if (journalPages.length > 0) {
        setImportStatus(`Creating ${journalPages.length} journal pages…`);
        const batchDailyResult = await batchGetOrCreateDaily(journalPages.map(p => p.journal!));
        for (let i = 0; i < batchDailyResult.results.length; i++) {
          const result = batchDailyResult.results[i];
          const page = journalPages[i];
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
      }

      // ── 3b: Journal additive — fetch existing child counts ──────
      const journalStartSeqs = new Map<string, number>(); // title → firstFreeSeq
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

      // ── 3c: Parallel existence checks for regular pages ─────────
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
      const pagesToCreate: Array<{ page: LogseqPage; pageClasses: number[] }> = [];

      if (regularPages.length > 0) {
        setImportStatus(`Checking ${regularPages.length} existing pages…`);
        const searchResultsAll = await Promise.allSettled(
          regularPages.map(page => searchNodes(page.title))
        );
        for (let i = 0; i < regularPages.length; i++) {
          const page = regularPages[i];
          const result = searchResultsAll[i];
          const existingPage = result.status === 'fulfilled'
            ? result.value.find(n => n.is_page && nodeNameToText(n.name).toLowerCase() === page.title.toLowerCase())
            : undefined;
          if (existingPage) {
            existingNodeIds.add(existingPage.id);
            if (page.uuid) uuidMap.set(page.uuid, { id: existingPage.id, uuid: existingPage.uuid });
            titleToNodeInfo.set(page.title, { id: existingPage.id, uuid: existingPage.uuid });
            existingPageMap.set(page.title, existingPage);
            p3.succeeded++;
            tick();
          } else {
            pagesToCreate.push({ page, pageClasses: regularPageClasses[i] });
          }
        }
      }

      // ── 3d: Override mode — parallel delete of existing blocks ───
      if (override) {
        await Promise.all([
          ...journalPages.map(async (page) => {
            const nodeInfo = titleToNodeInfo.get(page.title);
            if (!nodeInfo || page.blocks.length === 0) return;
            try { await deleteExistingBlocks(nodeInfo.id, queryClient); } catch (e) {
              console.error('Failed to delete journal blocks:', e);
            }
          }),
          ...[...existingPageMap.values()].map(async (existingPage) => {
            try { await deleteExistingBlocks(existingPage.id, queryClient); } catch (e) {
              console.error('Failed to delete existing page blocks:', e);
            }
          }),
        ]);
      }

      // ── 3e: Batch-create new pages — UUID skeleton only ─────────
      if (pagesToCreate.length > 0) {
        setImportStatus(`Creating ${pagesToCreate.length} new pages…`);
        try {
          const batchResult = await batchCreateNodes({
            nodes: pagesToCreate.map(({ page }) => ({
              ...(page.uuid ? { uuid: page.uuid } : {}),
            })),
          });
          for (let i = 0; i < batchResult.results.length; i++) {
            const result = batchResult.results[i];
            const { page } = pagesToCreate[i];
            if (result.success && result.node) {
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
          for (const { page } of pagesToCreate) {
            p3.failed++;
            p3.errors.push({ item: `Page: ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: errorMessage(e) });
            tick();
          }
        }
      }

      // ── 3f: Flatten ALL block trees into one list ─────────────────
      type FlatBlock = {
        block: LogseqBlock;
        classes: number[];
        parent: { kind: 'page'; title: string } | { kind: 'block'; tempIdx: number };
        sequence: number;
        tempIdx: number;
      };
      const flatBlocks: FlatBlock[] = [];
      let nextTempIdx = 0;

      const collectBlocks = (
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
            collectBlocks(block.children, { kind: 'block', tempIdx }, 0);
          }
        }
      };

      for (const page of regularPages) {
        if (page.blocks.length === 0) continue;
        if (!titleToNodeInfo.has(page.title)) continue; // page creation failed
        collectBlocks(page.blocks, { kind: 'page', title: page.title }, 0);
      }
      for (const page of journalPages) {
        if (page.blocks.length === 0) continue;
        if (!titleToNodeInfo.has(page.title)) continue;
        const startSeq = journalStartSeqs.get(page.title) ?? 0;
        collectBlocks(page.blocks, { kind: 'page', title: page.title }, startSeq);
      }

      // ── 3h: Batch-create all blocks (no parent_id yet) ──────────
      const BATCH_CHUNK = 500;
      const tempIdxToNodeInfo = new Map<number, NodeInfo>();

      if (flatBlocks.length > 0) {
        setImportStatus(`Creating ${flatBlocks.length} blocks…`);
        for (let offset = 0; offset < flatBlocks.length; offset += BATCH_CHUNK) {
          const chunk = flatBlocks.slice(offset, offset + BATCH_CHUNK);
          try {
            const batchResult = await batchCreateNodes({
              nodes: chunk.map(item => ({
                ...(item.block.uuid ? { uuid: item.block.uuid } : {}),
              })),
            });
            for (const result of batchResult.results) {
              const item = chunk[result.index];
              if (result.success && result.node) {
                const info: NodeInfo = { id: result.node.id, uuid: result.node.uuid };
                tempIdxToNodeInfo.set(item.tempIdx, info);
                if (item.block.uuid) uuidMap.set(item.block.uuid, info);
                p3.succeeded++;
              } else {
                // UUID conflict: try to recover the existing node
                let recovered = false;
                if (item.block.uuid) {
                  try {
                    const existing = await getNodeByUuid(item.block.uuid);
                    if (existing) {
                      const info: NodeInfo = { id: existing.id, uuid: existing.uuid };
                      tempIdxToNodeInfo.set(item.tempIdx, info);
                      uuidMap.set(item.block.uuid, info);
                      p3.succeeded++;
                      recovered = true;
                    }
                  } catch { /* fall through */ }
                }
                if (!recovered) {
                  p3.failed++;
                  p3.errors.push({
                    item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}${item.block.uuid ? ` [${item.block.uuid}]` : ''}`,
                    message: result.error ?? 'Unknown error',
                  });
                }
              }
            }
          } catch (e) {
            for (const item of chunk) {
              p3.failed++;
              p3.errors.push({
                item: `Block: ${item.block.title?.slice(0, 60) || '(empty)'}`,
                message: errorMessage(e),
              });
            }
          }
        }
      }

      // ── 3g: Combined update — name + parent + sequence + classes ─
      // All UUIDs are now registered, so [[uuid]] links resolve fully.
      {
        setImportStatus('Setting content and wiring nodes…');
        const combinedItems: BatchNodeUpdateItem[] = [];

        // Regular pages: new → name + classes; existing → conditional name + class union
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
          if (item.name !== undefined || item.classes !== undefined) combinedItems.push(item);
        }

        // Blocks: name (AST w/ links resolved) + parent_id + sequence + classes
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
          combinedItems.push(updateItem);
        }

        for (let offset = 0; offset < combinedItems.length; offset += BATCH_CHUNK) {
          try {
            await batchUpdateNodes({ nodes: combinedItems.slice(offset, offset + BATCH_CHUNK) });
          } catch (e) {
            console.error('Failed combined update pass:', e);
          }
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
            // Fetch existing children to append after them
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

      // ──────────────────────────────────────────────────────────
      // PHASE 3b: Set page parents (namespace hierarchy) — batched
      // ──────────────────────────────────────────────────────────
      const pagesWithParent = parsed.pages.filter(p => p.parent);
      if (pagesWithParent.length > 0) {
        const p3b = createPhase('Set page parents');
        phases.push(p3b);

        // Build case-insensitive lookup for parent resolution
        const titleToNodeInfoLower = new Map<string, NodeInfo>();
        for (const [title, info] of titleToNodeInfo) {
          titleToNodeInfoLower.set(title.toLowerCase(), info);
        }

        // Build batch update items, auto-creating missing parent pages
        const batchItems: Array<{ id: number; parent_id: number }> = [];
        const batchMeta: Array<{ pageTitle: string; parentTitle: string }> = [];

        for (const page of pagesWithParent) {
          const pageInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
          let parentInfo = titleToNodeInfo.get(page.parent!)
            ?? titleToNodeInfoLower.get(page.parent!.toLowerCase());
          if (!pageInfo) {
            p3b.failed++;
            p3b.errors.push({ item: `${page.title}${page.uuid ? ` [${page.uuid}]` : ''} → ${page.parent}`, message: 'Page not found' });
            continue;
          }
          // Auto-create missing parent page
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
              p3b.errors.push({
                item: `${page.title} → ${page.parent}`,
                message: `Failed to create parent "${page.parent}": ${errorMessage(e)}`,
              });
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
              p3b.errors.push({
                item: `${meta?.pageTitle} → ${meta?.parentTitle}`,
                message: result.error || 'Unknown error',
              });
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 4: Bind properties to classes — batched
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
              if (r.success) {
                p4.succeeded++;
              } else {
                p4.failed++;
                p4.errors.push({ item: chunk[r.index].label, message: r.error || 'Unknown error' });
              }
              tick();
            }
          } catch (e) {
            // If the whole batch fails, count each item as failed
            for (const item of chunk) {
              p4.failed++;
              p4.errors.push({ item: item.label, message: errorMessage(e) });
              tick();
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 5: Assign property values to pages and blocks — batched
      // ──────────────────────────────────────────────────────────
      const p5 = createPhase('Assign property values');
      phases.push(p5);
      console.log('[IMPORT] Phase 5: Starting property assignment');
      console.log('[IMPORT] titleToNodeInfo has', titleToNodeInfo.size, 'entries');
      console.log('[IMPORT] Sample titles:', Array.from(titleToNodeInfo.keys()).slice(0, 20));

      // Collector: instead of sending one-by-one, we gather all resolved
      // (node_id, property_id, value) tuples and batch-send at the end.
      const pendingPropertySets: Array<{ node_id: number; property_id: number; value: unknown }> = [];
      const propertySetCollector = {
        mutateAsync: async (args: { nodeId: number; propertyId: number; value: unknown }) => {
          pendingPropertySets.push({ node_id: args.nodeId, property_id: args.propertyId, value: args.value });
          return {} as unknown;
        },
      };

      for (const page of parsed.pages) {
        if (!page.properties) continue;
        const nodeInfo = page.uuid ? uuidMap.get(page.uuid) : titleToNodeInfo.get(page.title);
        if (!nodeInfo) {
          console.warn(`[IMPORT] Cannot find node for page: ${page.title}`);
          continue;
        }
        const isExisting = existingNodeIds.has(nodeInfo.id);
        const pageLabel = `${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`;
        console.log(`[IMPORT] Assigning properties to page: ${page.title} (id=${nodeInfo.id}, isExisting=${isExisting}, override=${override})`);
        await assignProperties(page.properties, nodeInfo.id, pageLabel, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertySetCollector, p5, override, isExisting, textPropIds);
        tick();
      }
      for (const page of parsed.pages) {
        await assignBlockProperties(page.blocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertySetCollector, p5, override, existingNodeIds, textPropIds);
      }
      if (parsed.standaloneBlocks) {
        await assignBlockProperties(parsed.standaloneBlocks, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, propertySetCollector, p5, override, existingNodeIds, textPropIds);
      }

      // Now send all collected property values in batches
      if (pendingPropertySets.length > 0) {
        setImportStatus(`Sending ${pendingPropertySets.length} property values in batch…`);
        const PROP_BATCH_SIZE = 100;
        for (let i = 0; i < pendingPropertySets.length; i += PROP_BATCH_SIZE) {
          const chunk = pendingPropertySets.slice(i, i + PROP_BATCH_SIZE);
          try {
            const res = await batchSetPropertyValues(chunk);
            for (const r of res.results) {
              if (!r.success) {
                console.error(`[IMPORT] Batch property set failed for item ${r.index}:`, r.error);
                // Don't double-count — the resolve phase already tallied succeeded/failed
              }
            }
          } catch (e) {
            console.error('[IMPORT] Batch property set request failed:', e);
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 6: Set content for standalone blocks (main import uses combined pass in step 3g)
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
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
                  p7.succeeded++;
                } else {
                  p7.failed++;
                  p7.errors.push({ item: `Alias: ${aliasTitle} → ${page.title}${page.uuid ? ` [${page.uuid}]` : ''}`, message: msg });
                }
                tick();
              }
            }
          }

          // Handle :block/alias — the referenced UUIDs are aliases OF this page
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
                // :block/alias means the referenced pages are aliases OF this page,
                // so this page is the main node (first arg) and the referenced page is the alias (second arg)
                await addAlias(thisPageInfo.id, aliasInfo.id);
                p7.succeeded++;
                tick();
              } catch (e) {
                const msg = errorMessage(e);
                if (msg.includes('already') || msg.includes('409') || msg.includes('conflict')) {
                  p7.succeeded++;
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

      // Invalidate queries to refresh UI with imported data
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
      queryClient.invalidateQueries({ queryKey: propertyKeys.all });
      // Invalidate "nodes with this property" queries (uses separate key prefix)
      queryClient.invalidateQueries({ queryKey: ['property-nodes'] });

      const finalReport = { phases, totalSucceeded, totalFailed };
      setReport(finalReport);
      setImportProgress(100);
      setImportStatus('');
      if (isAutoImportModeRef.current) {
        notifyImportProgress({ status: '', progress: 100 });
        notifyImportReport(finalReport);
        setAutoImportActive(false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      setError(msg);
      if (isAutoImportModeRef.current) {
        notifyImportError(msg);
        setAutoImportActive(false);
      }
    } finally {
      setImporting(false);
    }
  }, [parsed, pageClassId, classClassId, importMode, createNodeMutation, updateNodeMutation, createPropertyMutation, addClassMutation, onClose]);

  // Auto-import trigger: fires once when opened in auto-import mode
  useEffect(() => {
    if (shouldAutoImportRef.current && parsed && !importing && !report) {
      shouldAutoImportRef.current = false;
      handleImport();
    }
  }, [parsed, importing, report, handleImport]);

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
    override: boolean,
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
        ...(block.uuid ? { uuid: block.uuid } : {}),
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
        // If the block has a UUID, the failure may be a conflict with an existing node.
        // Try to recover by looking it up and moving it to the correct parent.
        let recovered = false;
        if (block.uuid) {
          try {
            const existing = await getNodeByUuid(block.uuid);
            if (existing) {
              // Move to new parent if different
              if (existing.parent_id !== parentId) {
                await updateNode(existing.id, { parent_id: parentId, sequence: startSequence + result.index });
              }
              uuidMap.set(block.uuid, { id: existing.id, uuid: existing.uuid });
              if (block.title) {
                if (override) {
                  // Override mode: always replace content with the import version
                  contentQueue.push({ id: existing.id, title: block.title });
                } else {
                  // Additive mode: keep original content if it differs from the import
                  const existingText = nodeNameToText(existing.name);
                  if (existingText === block.title) {
                    contentQueue.push({ id: existing.id, title: block.title });
                  }
                  // else: content differs → keep original, don't push to contentQueue
                }
              }
              if (block.children && block.children.length > 0) {
                childWork.push({ block, parentNodeId: existing.id });
              }
              phase.succeeded++;
              recovered = true;
            }
          } catch {
            // lookup failed — fall through to error
          }
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

    // Recursively create children in parallel (each group is independent)
    await Promise.all(
      childWork.map(({ block, parentNodeId }) =>
        createBlocksRecursively(
          block.children!, parentNodeId, 0, uuidMap, classIdMap, contentQueue, phase, override,
        )
      )
    );
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

  // ── Auto-import mode OR not yet initialized: render nothing visible ────────
  // In auto-import mode, ImportOptionsModal acts as the visible UI.
  // Before the open-effect fires, hasInitializedRef is false so we avoid a
  // flash of the input form.
  // isAutoImportActive() is a module-level flag that survives component
  // unmount/remount caused by view transitions during the async workspace switch.
  if (isAutoImportMode || isAutoImportActive() || (isOpen && !hasInitializedRef.current)) {
    return null;
  }

  // ── Report view (shown after import completes, manual mode only) ──
  if (report) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Import Report"
        size="lg"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              if (isAutoImportMode) {
                const cb = consumeImportCompleteCallback();
                cb?.();
              }
              onClose();
            }}
          >
            Open Workspace
          </Button>
        }
      >
        <TaskReport
          report={report}
          successMessage="Import completed successfully"
          warningMessage="Import completed with errors"
        />
      </Modal>
    );
  }

  // ── Input view (default) ──────────────────────────────────────
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import from Logseq"
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
        {/* ── Input source tabs ────────────────────────────── */}
        <div className="import-logseq__source-tabs">
          <button
            className={`import-logseq__source-tab${inputSource === 'edn' ? ' import-logseq__source-tab--active' : ''}`}
            onClick={() => handleInputSourceChange('edn')}
            disabled={importing}
          >
            EDN Paste
          </button>
          <button
            className={`import-logseq__source-tab${inputSource === 'sqlite' ? ' import-logseq__source-tab--active' : ''}`}
            onClick={() => handleInputSourceChange('sqlite')}
            disabled={importing}
          >
            SQLite File
          </button>
        </div>

        {inputSource === 'edn' ? (
          <>
            <p className="import-logseq__description">
              Paste the raw EDN content from a Logseq database graph export.
            </p>
            <CodeTextarea
              ref={textareaRef}
              value={content}
              onChange={setContent}
              placeholder='{:pages-and-blocks [...] :properties {...} :classes {...}}'
              error={!!error}
              valid={!!parsed}
              disabled={importing}
              minHeight={260}
            />
          </>
        ) : (
          <>
            <p className="import-logseq__description">
              Upload a Logseq SQLite database file (<code>.sqlite</code>). These are
              found in your Logseq data directory for DB-based graphs.
            </p>
            <div
              className={`import-logseq__dropzone${
                error ? ' import-logseq__dropzone--error' : ''
              }${parsed ? ' import-logseq__dropzone--valid' : ''
              }${sqliteParsing ? ' import-logseq__dropzone--loading' : ''}`}
              onDrop={handleFileDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".sqlite,.sqlite3,.db"
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
              />
              {sqliteParsing ? (
                <span className="import-logseq__dropzone-text">Parsing database…</span>
              ) : sqliteFileName ? (
                <span className="import-logseq__dropzone-text">
                  <strong>{sqliteFileName}</strong>
                  <br />
                  {parsed ? 'Ready to import' : 'Click to choose a different file'}
                </span>
              ) : (
                <span className="import-logseq__dropzone-text">
                  Drop a <code>.sqlite</code> file here or click to browse
                </span>
              )}
            </div>
          </>
        )}

        {parsed && (
          <div className="import-logseq__mode-selector">
            <ToggleSwitch
              size="sm"
              leftLabel="ADDITIVE"
              rightLabel="OVERRIDE"
              checked={importMode === 'override'}
              onChange={handleImportModeChange}
              disabled={importing}
            />
            <span className="import-logseq__mode-hint">
              {importMode === 'additive'
                ? 'Adds new entities and merges new properties into existing nodes'
                : 'Replaces existing blocks and properties with imported data'}
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

        {importing && (
          <TaskProgress
            progress={importProgress}
            statusText={importStatus}
          />
        )}
      </div>
    </Modal>
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
// Group 1 = #[[uuid]] inline class
// Group 2 = label from [label]([[uuid]])
// Group 3 = uuid from [label]([[uuid]])
// Group 4 = bare [[uuid]]
// Group 5 = ((uuid)) block ref
// Group 6 = [[name]]
const NODE_LINK_RE = new RegExp(
  `#\\[\\[(${UUID_RE})\\]\\]|\\[([^\\]]+)\\]\\(\\[\\[(${UUID_RE})\\]\\]\\)|\\[\\[(${UUID_RE})\\]\\]|\\(\\((${UUID_RE})\\)\\)|\\[\\[([^\\]]+)\\]\\]`,
  'gi'
);

// Matches standard markdown links: [label](url) where url is not a [[...]] pattern
// Group 1 = label, Group 2 = url
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Convert a plain text segment (no Logseq [[]] patterns) to inline AST nodes,
 * resolving standard markdown links [label](url) to either node_link (notees: URI)
 * or external_link nodes.
 */
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
    if (matchStart > last) {
      nodes.push(astText(segment.slice(last, matchStart)));
    }
    const label = match[1];
    const url = match[2];
    const noteesUuid = url.startsWith('notees:') ? url.slice('notees:'.length) : null;
    if (noteesUuid) {
      // notees: URI → resolve to node_link
      const target = uuidMap.get(noteesUuid);
      if (target) {
        const linkInstanceUuid = crypto.randomUUID();
        const linkId = buildLinkId(target.uuid, linkInstanceUuid);
        nodes.push(nodeLink(linkId, 'node', label));
      } else {
        // UUID not in map — store as external link so it's not lost
        nodes.push(externalLink(url, astText(label)));
      }
    } else {
      // Plain external URL
      nodes.push(externalLink(url, astText(label)));
    }
    last = matchStart + match[0].length;
  }
  if (last < segment.length) {
    nodes.push(astText(segment.slice(last)));
  }
  return nodes;
}

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
    // Group 1 = #[[uuid]] inline class
    // Group 2 = label from [label]([[uuid]])
    // Group 3 = uuid from [label]([[uuid]])
    // Group 4 = bare [[uuid]]
    // Group 5 = ((uuid)) block ref
    // Group 6 = [[name]]
    const inlineClassUuid = match[1];
    const labeledLink_label = match[2];
    const labeledLink_uuid = match[3];
    const bareUuid = match[4];
    const blockRefUuid = match[5];
    const linkName = match[6];
    
    const logseqUuid = labeledLink_uuid ?? bareUuid ?? blockRefUuid;
    const matchStart = match.index ?? 0;

    // Add preceding plain text (with markdown link conversion)
    if (matchStart > lastIndex) {
      children.push(...textSegmentToNodes(rawText.slice(lastIndex, matchStart), uuidMap));
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
        // Pass label if this is a [label]([[uuid]]) pattern
        const label = labeledLink_label ?? null;
        children.push(nodeLink(linkId, 'node', label));
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

  // Add trailing plain text (with markdown link conversion)
  if (lastIndex < rawText.length) {
    children.push(...textSegmentToNodes(rawText.slice(lastIndex), uuidMap));
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
  textPropIds: Set<number> = new Set(),
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
      let resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeInfo, classIdMap, pageClassId);

      // Text-type properties are stored as block node references.
      // If the resolved value is a string, create a block node with AST content.
      if (resolved !== undefined && textPropIds.has(noteesPropId)) {
        const strValues = Array.isArray(resolved) ? resolved.filter((v): v is string => typeof v === 'string') : (typeof resolved === 'string' ? [resolved] : []);
        if (strValues.length > 0) {
          const blockIds: number[] = [];
          for (const strVal of strValues) {
            try {
              const ast = buildAstFromLogseqText(strVal, uuidMap, titleToNodeInfo);
              const astName = ast.length > 0 ? JSON.stringify(ast) : strVal;
              const textBlock = await createNodeApi({ name: astName, parent_id: nodeId });
              blockIds.push(textBlock.id);
              console.log(`[IMPORT] Created text block id=${textBlock.id} for text property ${logseqPropId} on ${label}`);
            } catch (blockErr) {
              console.error(`[IMPORT] Failed to create text block for ${logseqPropId} on ${label}:`, blockErr);
            }
          }
          if (blockIds.length === 1) {
            resolved = blockIds[0];
          } else if (blockIds.length > 1) {
            resolved = blockIds;
          } else {
            resolved = undefined;
          }
        }
      }

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
          propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, phase,
          override, isExisting, textPropIds,
        );
      }
    }
    if (block.children) {
      await assignBlockProperties(block.children, propIdMap, uuidMap, titleToNodeInfo, classIdMap, pageClassId, setImportStatus, setNodePropertyMutation, phase, override, existingNodeIds, textPropIds);
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
        const uuid = typed.uuid as string;
        const fallbackTitle = typed.title as string | undefined;

        // 1. Check uuidMap (nodes imported in this session)
        const info = uuidMap.get(uuid);
        if (info) return info.id;

        // 2. Try database lookup by UUID (nodes from a previous import)
        try {
          const existing = await getNodeByUuid(uuid);
          if (existing) {
            uuidMap.set(uuid, { id: existing.id, uuid: existing.uuid });
            if (fallbackTitle) titleToNodeInfo.set(fallbackTitle, { id: existing.id, uuid: existing.uuid });
            return existing.id;
          }
        } catch { /* not found — continue */ }

        // 3. Fallback: look up by title
        if (fallbackTitle) {
          const titleInfo = titleToNodeInfo.get(fallbackTitle);
          if (titleInfo) return titleInfo.id;

          // Search database by title
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
          } catch { /* search failed — continue */ }

          // 4. Auto-create the referenced page
          try {
            const newPage = await createNodeApi({ name: fallbackTitle, classes: [pageClassId] });
            titleToNodeInfo.set(fallbackTitle, { id: newPage.id, uuid: newPage.uuid });
            uuidMap.set(uuid, { id: newPage.id, uuid: newPage.uuid });
            console.log(`[IMPORT] uuid-ref fallback: created page "${fallbackTitle}" id=${newPage.id}`);
            return newPage.id;
          } catch (createErr) {
            console.error(`[IMPORT] uuid-ref fallback: failed to create "${fallbackTitle}"`, createErr);
          }
        }

        console.warn(`[IMPORT] UUID reference not found: ${uuid}${fallbackTitle ? ` (title: ${fallbackTitle})` : ''}`);
        return undefined;
      }
    }
  }

  // Primitives: boolean, number, string
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value || undefined;

  return undefined;
}
