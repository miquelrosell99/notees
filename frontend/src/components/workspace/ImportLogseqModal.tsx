/**
 * ImportLogseqModal - Modal for importing Logseq EDN graph exports
 *
 * Import flow (6 phases):
 * 1. Create classes (type nodes)
 * 2. Create properties (with correct backend field names)
 * 3. Create all nodes (pages + blocks) with classes assigned at creation,
 *    using plain-text names initially — builds UUID→nodeInfo map
 * 4. Bind properties to classes
 * 5. Assign property values to nodes
 * 6. Update node content with proper AST containing node_link entries,
 *    which triggers the backend to create link records automatically
 *
 * Every operation is wrapped in try/catch so a single failure never aborts
 * the import. Errors are collected and presented in a status report modal
 * at the end.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport, mdiCheckCircleOutline, mdiAlertCircleOutline, mdiChevronDown, mdiChevronUp } from '@mdi/js';
import Icon from '@mdi/react';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { parseLogseqEdn, type LogseqExport, type LogseqBlock } from '@/utils/ednParser';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useAddClass, useCreateProperty, useSetNodeProperty, useAddPropertyToClass } from '@/hooks';
import { getOrCreateDaily, listClasses, searchNodes } from '@/api/nodes';
import { listProperties } from '@/api/properties';
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
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'response' in e) {
    const resp = (e as { response?: { data?: { detail?: string } } }).response;
    if (resp?.data?.detail) return resp.data.detail;
  }
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

  const createNodeMutation = useCreateNode();
  const updateNodeMutation = useUpdateNode();
  const createPropertyMutation = useCreateProperty();
  const setNodePropertyMutation = useSetNodeProperty();
  const addPropertyToClassMutation = useAddPropertyToClass();
  const addClassMutation = useAddClass();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

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
      const contentQueue: Array<{ id: number; title: string }> = [];

      // ──────────────────────────────────────────────────────────
      // PHASE 1: Create classes (as type nodes)
      // ──────────────────────────────────────────────────────────
      const p1 = createPhase('Create classes');
      phases.push(p1);
      if (classClassId) {
        // Pre-fetch existing classes to avoid 409 conflicts
        const existingClasses = await listClasses();
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
          // Check if a page with this exact name already exists
          const searchResults = await searchNodes(page.title);
          const existingPage = searchResults.find(
            n => n.is_page && nodeNameToText(n.name).toLowerCase() === page.title.toLowerCase()
          );

          if (existingPage) {
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
      for (const page of parsed.pages) {
        if (!page.properties || !page.uuid) continue;
        const nodeInfo = uuidMap.get(page.uuid);
        if (!nodeInfo) continue;
        await assignProperties(page.properties, nodeInfo.id, page.title, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation, p5);
      }
      for (const page of parsed.pages) {
        await assignBlockProperties(page.blocks, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation, p5);
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 6: Update node content with proper AST + links
      // ──────────────────────────────────────────────────────────
      const p6 = createPhase('Set content & links');
      phases.push(p6);
      if (contentQueue.length > 0) {
        setImportStatus(`Setting content with links (${contentQueue.length} nodes)…`);
        for (const { id, title } of contentQueue) {
          if (!title) continue;
          try {
            const ast = buildAstFromLogseqText(title, uuidMap);
            const astJson = JSON.stringify(ast);
            await updateNodeMutation.mutateAsync({ id, data: { name: astJson } });
            p6.succeeded++;
          } catch (e) {
            p6.failed++;
            p6.errors.push({ item: `Node ${id}`, message: errorMessage(e) });
          }
        }
      }

      // ── Build final report ────────────────────────────────────
      const totalSucceeded = phases.reduce((s, p) => s + p.succeeded, 0);
      const totalFailed = phases.reduce((s, p) => s + p.failed, 0);
      setReport({ phases, totalSucceeded, totalFailed });
      setImportStatus('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [parsed, pageClassId, classClassId, importMode, createNodeMutation, updateNodeMutation, createPropertyMutation, setNodePropertyMutation, addPropertyToClassMutation, addClassMutation, onClose]);

  /** Recursively create blocks under a parent, tracking content for phase 6 */
  const createBlocksRecursively = async (
    blocks: LogseqBlock[],
    parentId: number,
    startSequence: number,
    uuidMap: Map<string, NodeInfo>,
    classIdMap: Map<string, number>,
    contentQueue: Array<{ id: number; title: string }>,
    phase: PhaseResult,
  ) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      const blockClasses: number[] = [];
      if (block.tags) {
        for (const tag of block.tags) {
          const mapped = classIdMap.get(tag);
          if (mapped) blockClasses.push(mapped);
        }
      }

      try {
        const node = await createNodeMutation.mutateAsync({
          name: '',
          parent_id: parentId,
          sequence: startSequence + i,
          ...(blockClasses.length > 0 ? { classes: blockClasses } : {}),
        });

        if (block.uuid) {
          uuidMap.set(block.uuid, { id: node.id, uuid: node.uuid });
        }

        if (block.title) {
          contentQueue.push({ id: node.id, title: block.title });
        }

        phase.succeeded++;

        if (block.children && block.children.length > 0) {
          await createBlocksRecursively(
            block.children, node.id, 0, uuidMap, classIdMap, contentQueue, phase,
          );
        }
      } catch (e) {
        phase.failed++;
        phase.errors.push({ item: `Block: ${block.title.slice(0, 60) || '(empty)'}`, message: errorMessage(e) });
      }
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

  const pageCount = parsed?.pages.length ?? 0;
  const classCount = parsed?.classes.length ?? 0;
  const propCount = parsed?.properties.length ?? 0;
  const blockCount =
    parsed?.pages.reduce((sum, p) => sum + countBlocks(p.blocks), 0) ?? 0;

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
            <span className="import-logseq__mode-label">Mode:</span>
            <div className="import-logseq__mode-buttons">
              <button
                className={`import-logseq__mode-btn${importMode === 'additive' ? ' import-logseq__mode-btn--active' : ''}`}
                onClick={() => setImportMode('additive')}
                disabled={importing}
                type="button"
              >
                Additive
              </button>
              <button
                className={`import-logseq__mode-btn${importMode === 'override' ? ' import-logseq__mode-btn--active' : ''}`}
                onClick={() => setImportMode('override')}
                disabled={importing}
                type="button"
              >
                Override
              </button>
            </div>
            <span className="import-logseq__mode-hint">
              {importMode === 'additive'
                ? 'Only creates new entities; skips existing ones'
                : 'Updates existing entities with imported data'}
            </span>
          </div>
        )}

        {error && <div className="import-logseq__error">{error}</div>}

        {parsed && (
          <div className="import-logseq__preview">
            <span className="import-logseq__preview-badge">
              {pageCount} page{pageCount !== 1 ? 's' : ''}
            </span>
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
          <span className="import-logseq__phase-ok">{phase.succeeded} ok</span>
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
 * Build AST document from Logseq block text, converting [[uuid]] references
 * to proper node_link AST nodes with compound link_id (nodeUuid:linkUuid).
 *
 * The backend will parse these node_link entries and automatically create
 * records in the node_link DB table.
 */
const UUID_LINK_RE = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi;

function buildAstFromLogseqText(
  rawText: string,
  uuidMap: Map<string, NodeInfo>,
): Array<{ type: string; children: ASTInlineNode[] }> {
  if (!rawText) return [];

  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  // Find all [[uuid]] patterns and convert to node_link AST nodes
  for (const match of rawText.matchAll(UUID_LINK_RE)) {
    const logseqUuid = match[1];
    const matchStart = match.index ?? 0;

    // Add preceding plain text
    if (matchStart > lastIndex) {
      children.push(astText(rawText.slice(lastIndex, matchStart)));
    }

    const target = uuidMap.get(logseqUuid);
    if (target) {
      // Build compound link_id: "targetNodeUuid:newLinkInstanceUuid"
      const linkInstanceUuid = crypto.randomUUID();
      const linkId = buildLinkId(target.uuid, linkInstanceUuid);
      children.push(nodeLink(linkId, 'node'));
    }
    // If target not found, skip the [[uuid]] entirely (remove dead link)

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
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeId: number; propertyId: number; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
) {
  for (const [logseqPropId, rawValue] of Object.entries(properties)) {
    const noteesPropId = propIdMap.get(logseqPropId);
    if (!noteesPropId) continue;
    try {
      const resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeInfo);
      if (resolved !== undefined) {
        setImportStatus(`Setting property on: ${label}`);
        await setNodePropertyMutation.mutateAsync({
          nodeId,
          propertyId: noteesPropId,
          value: resolved,
        });
        phase.succeeded++;
      }
    } catch (e) {
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
  setImportStatus: (s: string) => void,
  setNodePropertyMutation: { mutateAsync: (args: { nodeId: number; propertyId: number; value: unknown }) => Promise<unknown> },
  phase: PhaseResult,
) {
  for (const block of blocks) {
    if (block.properties && block.uuid) {
      const nodeInfo = uuidMap.get(block.uuid);
      if (nodeInfo) {
        await assignProperties(
          block.properties, nodeInfo.id, block.title || '(block)',
          propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation, phase,
        );
      }
    }
    if (block.children) {
      await assignBlockProperties(block.children, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation, phase);
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
): Promise<unknown> {
  if (value === null || value === undefined) return undefined;

  // Array → resolve each element for multi-value properties
  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) {
      const r = await resolvePropertyValueForImport(item, uuidMap, titleToNodeInfo);
      if (r !== undefined) resolved.push(r);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  // Structured markers from EDN parser
  if (typeof value === 'object' && value !== null && '__type' in value) {
    const typed = value as { __type: string; [key: string]: unknown };
    switch (typed.__type) {
      case 'page-ref': {
        const info = titleToNodeInfo.get(typed.title as string);
        return info?.id ?? undefined;
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
        return info?.id ?? undefined;
      }
    }
  }

  // Primitives: boolean, number, string
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value || undefined;

  return undefined;
}
