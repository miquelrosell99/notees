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
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { parseLogseqEdn, type LogseqExport, type LogseqBlock } from '@/utils/ednParser';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useAddClass, useCreateProperty, useSetNodeProperty, useAddPropertyToClass } from '@/hooks';
import { getOrCreateDaily } from '@/api/nodes';
import { text as astText, nodeLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import type { PropertyType } from '@/types/api';
import './ImportLogseqModal.css';

/** Info stored per created Notees node, keyed by Logseq UUID */
interface NodeInfo {
  id: number;
  uuid: string; // Notees UUID (from the created node)
}

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

    try {
      // ── Maps built during import ─────────────────────────────
      // Logseq UUID → Notees {id, uuid}
      const uuidMap = new Map<string, NodeInfo>();
      // Logseq property id → Notees property id
      const propIdMap = new Map<string, number>();
      // Logseq class id → Notees node id
      const classIdMap = new Map<string, number>();
      // Page title → Notees node info (for property value resolution)
      const titleToNodeInfo = new Map<string, NodeInfo>();
      // All created nodes that need content update: {notees id, original title text}
      const contentQueue: Array<{ id: number; title: string }> = [];

      // ──────────────────────────────────────────────────────────
      // PHASE 1: Create classes (as type nodes)
      // ──────────────────────────────────────────────────────────
      if (classClassId) {
        for (const cls of parsed.classes) {
          setImportStatus(`Creating class: ${cls.title}`);
          try {
            const node = await createNodeMutation.mutateAsync({
              name: cls.title,
              classes: [classClassId, pageClassId],
            });
            classIdMap.set(cls.id, node.id);
            if (cls.uuid) {
              uuidMap.set(cls.uuid, { id: node.id, uuid: node.uuid });
            }
          } catch {
            console.warn(`Failed to create class: ${cls.title}`);
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 2: Create properties
      // ──────────────────────────────────────────────────────────
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

          // Send backend field names directly (is_multi, selection_lines)
          const created = await createPropertyMutation.mutateAsync({
            name: prop.title,
            type: finalType,
            is_multi: isMulti,
            selection_lines: selectionLines,
          } as Record<string, unknown> & { name: string });
          propIdMap.set(prop.id, created.id);

          // Map selection option UUIDs → selection line IDs
          if (prop.selectionOptions && created.options) {
            for (let i = 0; i < prop.selectionOptions.length && i < created.options.length; i++) {
              const opt = prop.selectionOptions[i];
              if (opt.uuid) {
                uuidMap.set(opt.uuid, { id: created.options[i].id, uuid: '' });
              }
            }
          }
        } catch {
          console.warn(`Failed to create property: ${prop.title}`);
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 3: Create all nodes (pages + blocks) with classes,
      //          using plain-text names (no links yet)
      // ──────────────────────────────────────────────────────────
      for (const page of parsed.pages) {
        setImportStatus(`Creating page: ${page.title}`);

        // Resolve class IDs for this page
        const pageClasses = [pageClassId];
        if (page.tags) {
          for (const tag of page.tags) {
            const mapped = classIdMap.get(tag);
            if (mapped) pageClasses.push(mapped);
          }
        }

        try {
          const pageNode = await createNodeMutation.mutateAsync({
            name: page.title,
            classes: pageClasses,
          });
          if (page.uuid) {
            uuidMap.set(page.uuid, { id: pageNode.id, uuid: pageNode.uuid });
          }
          titleToNodeInfo.set(page.title, { id: pageNode.id, uuid: pageNode.uuid });

          // Create blocks recursively under this page
          if (page.blocks.length > 0) {
            setImportStatus(`Creating blocks for: ${page.title}`);
            await createBlocksRecursively(
              page.blocks, pageNode.id, 0, uuidMap, classIdMap, contentQueue,
            );
          }
        } catch {
          console.warn(`Failed to create page: ${page.title}`);
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 4: Bind properties to classes
      // ──────────────────────────────────────────────────────────
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
          } catch {
            console.warn(`Failed to bind property ${logseqPropId} to class ${cls.title}`);
          }
        }
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 5: Assign property values to pages and blocks
      // ──────────────────────────────────────────────────────────
      // Pages
      for (const page of parsed.pages) {
        if (!page.properties || !page.uuid) continue;
        const nodeInfo = uuidMap.get(page.uuid);
        if (!nodeInfo) continue;
        await assignProperties(page.properties, nodeInfo.id, page.title, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation);
      }
      // Blocks (recursive)
      for (const page of parsed.pages) {
        await assignBlockProperties(page.blocks, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation);
      }

      // ──────────────────────────────────────────────────────────
      // PHASE 6: Update node content with proper AST + links
      // ──────────────────────────────────────────────────────────
      if (contentQueue.length > 0) {
        setImportStatus(`Setting content with links (${contentQueue.length} nodes)…`);
        for (const { id, title } of contentQueue) {
          if (!title) continue;
          try {
            const ast = buildAstFromLogseqText(title, uuidMap);
            const astJson = JSON.stringify(ast);
            await updateNodeMutation.mutateAsync({ id, data: { name: astJson } });
          } catch {
            console.warn(`Failed to set content for node ${id}`);
          }
        }
      }

      setImportStatus('Import complete!');
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [parsed, pageClassId, classClassId, createNodeMutation, updateNodeMutation, createPropertyMutation, setNodePropertyMutation, addPropertyToClassMutation, addClassMutation, onClose]);

  /** Recursively create blocks under a parent, tracking content for phase 6 */
  const createBlocksRecursively = async (
    blocks: LogseqBlock[],
    parentId: number,
    startSequence: number,
    uuidMap: Map<string, NodeInfo>,
    classIdMap: Map<string, number>,
    contentQueue: Array<{ id: number; title: string }>,
  ) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // Resolve class IDs for this block
      const blockClasses: number[] = [];
      if (block.tags) {
        for (const tag of block.tags) {
          const mapped = classIdMap.get(tag);
          if (mapped) blockClasses.push(mapped);
        }
      }

      // Create with plain-text name (or empty) — content set in phase 6
      const node = await createNodeMutation.mutateAsync({
        name: '',
        parent_id: parentId,
        sequence: startSequence + i,
        ...(blockClasses.length > 0 ? { classes: blockClasses } : {}),
      });

      if (block.uuid) {
        uuidMap.set(block.uuid, { id: node.id, uuid: node.uuid });
      }

      // Queue for content update in phase 6 (after all UUIDs are mapped)
      if (block.title) {
        contentQueue.push({ id: node.id, title: block.title });
      }

      if (block.children && block.children.length > 0) {
        await createBlocksRecursively(
          block.children, node.id, 0, uuidMap, classIdMap, contentQueue,
        );
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
      }
    } catch {
      console.warn(`Failed to set property ${logseqPropId} on ${label}`);
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
) {
  for (const block of blocks) {
    if (block.properties && block.uuid) {
      const nodeInfo = uuidMap.get(block.uuid);
      if (nodeInfo) {
        await assignProperties(
          block.properties, nodeInfo.id, block.title || '(block)',
          propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation,
        );
      }
    }
    if (block.children) {
      await assignBlockProperties(block.children, propIdMap, uuidMap, titleToNodeInfo, setImportStatus, setNodePropertyMutation);
    }
  }
}

/**
 * Resolve a parsed EDN property value to a Notees-compatible value.
 * Handles structured markers from the EDN parser:
 * - { __type: 'page-ref', title } → find node ID by title
 * - { __type: 'date-ref', date } → get/create daily node, return ID
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
