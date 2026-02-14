/**
 * ImportLogseqModal - Modal for importing Logseq EDN graph exports
 *
 * Provides a code-block style textarea where users paste raw EDN,
 * parses it and creates pages/blocks via the existing API.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { parseLogseqEdn, type LogseqExport } from '@/utils/ednParser';
import { useCreateNode, useUpdateNode, usePageClass, useClassClass, useCreateProperty, useSetNodeProperty, useAddPropertyToClass } from '@/hooks';
import { getOrCreateDaily } from '@/api/nodes';
import type { PropertyType } from '@/types/api';
import './ImportLogseqModal.css';

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
      // UUID → Notees node ID map (for resolving [[uuid]] links)
      const uuidMap = new Map<string, number>();
      // Logseq property id → Notees property id
      const propIdMap = new Map<string, number>();
      // Page title → Notees node ID (for resolving node-type property values)
      const titleToNodeId = new Map<string, number>();

      // Helper: replace [[logseq-uuid]] references with [[notees-node-id]]
      const UUID_LINK_RE = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi;
      const resolveLinks = (text: string): string =>
        text.replace(UUID_LINK_RE, (_match, uuid: string) => {
          const nodeId = uuidMap.get(uuid);
          return nodeId ? `[[${nodeId}]]` : '';
        });
      const hasUnresolvedLinks = (text: string): boolean =>
        /\[\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]\]/i.test(text);

      // Map logseq property type → Notees property type
      const mapPropertyType = (logseqType: string): PropertyType => {
        switch (logseqType) {
          case 'checkbox': return 'boolean';
          case 'date': return 'date';
          case 'node': return 'node';
          case 'number': return 'float';
          default: return 'text';
        }
      };

      // 1. Create properties
      for (const prop of parsed.properties) {
        setImportStatus(`Creating property: ${prop.title}`);
        try {
          const noteesType = mapPropertyType(prop.type);
          const isMulti = prop.cardinality === 'db.cardinality/many';

          // Build selection options for number-type properties with closed values
          const options = prop.selectionOptions
            ? prop.selectionOptions.map(o => String(o.value))
            : undefined;

          const created = await createPropertyMutation.mutateAsync({
            name: prop.title,
            type: noteesType === 'float' && prop.selectionOptions ? 'selection' : noteesType,
            multi: isMulti,
            options: options,
          });
          propIdMap.set(prop.id, created.id);

          // Map selection option UUIDs → selection line IDs
          if (prop.selectionOptions && created.options) {
            for (let i = 0; i < prop.selectionOptions.length && i < created.options.length; i++) {
              const opt = prop.selectionOptions[i];
              if (opt.uuid) {
                uuidMap.set(opt.uuid, created.options[i].id);
              }
            }
          }
        } catch {
          console.warn(`Failed to create property: ${prop.title}`);
        }
      }

      // 2. Create classes (as type nodes)
      const classIdMap = new Map<string, number>(); // logseq class id → notees node id
      if (classClassId) {
        for (const cls of parsed.classes) {
          setImportStatus(`Creating class: ${cls.title}`);
          try {
            const node = await createNodeMutation.mutateAsync({
              name: cls.title,
              classes: [classClassId, pageClassId],
            });
            classIdMap.set(cls.id, node.id);
            if (cls.uuid) uuidMap.set(cls.uuid, node.id);

            // Bind properties to this class
            if (cls.properties) {
              for (const logseqPropId of cls.properties) {
                // Skip logseq system properties
                if (logseqPropId.startsWith('logseq.property')) continue;
                const noteesPropId = propIdMap.get(logseqPropId);
                if (noteesPropId) {
                  try {
                    await addPropertyToClassMutation.mutateAsync({
                      classId: node.id,
                      propertyId: noteesPropId,
                    });
                  } catch {
                    console.warn(`Failed to bind property ${logseqPropId} to class ${cls.title}`);
                  }
                }
              }
            }
          } catch {
            console.warn(`Failed to create class: ${cls.title}`);
          }
        }
      }

      // 3. Create all pages first (without blocks) to build UUID map
      const pageNodes = new Map<number, typeof parsed.pages[number]>(); // notees id → page data
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
          const pageNode = await createNodeMutation.mutateAsync({
            name: page.title,
            classes: pageClasses,
          });
          if (page.uuid) uuidMap.set(page.uuid, pageNode.id);
          if (page.title) titleToNodeId.set(page.title, pageNode.id);
          pageNodes.set(pageNode.id, page);
        } catch {
          console.warn(`Failed to create page: ${page.title}`);
        }
      }

      // 4. Set property values on pages
      for (const [pageNodeId, page] of pageNodes) {
        if (!page.properties) continue;
        for (const [logseqPropId, rawValue] of Object.entries(page.properties)) {
          const noteesPropId = propIdMap.get(logseqPropId);
          if (!noteesPropId) continue;

          try {
            const resolved = await resolvePropertyValueForImport(rawValue, uuidMap, titleToNodeId);
            if (resolved !== undefined) {
              setImportStatus(`Setting property on: ${page.title}`);
              await setNodePropertyMutation.mutateAsync({
                nodeId: pageNodeId,
                propertyId: noteesPropId,
                value: resolved,
              });
            }
          } catch {
            console.warn(`Failed to set property ${logseqPropId} on ${page.title}`);
          }
        }
      }

      // 5. Create blocks for each page, resolving page/class [[uuid]] links
      const pendingUpdates: Array<{ nodeId: number; originalTitle: string }> = [];
      for (const [pageNodeId, page] of pageNodes) {
        if (page.blocks.length > 0) {
          setImportStatus(`Creating blocks for: ${page.title}`);
          await createBlocksRecursively(page.blocks, pageNodeId, 0, resolveLinks, pendingUpdates, uuidMap, hasUnresolvedLinks);
        }
      }

      // 6. Second pass: resolve block-to-block links
      if (pendingUpdates.length > 0) {
        setImportStatus(`Resolving block links (${pendingUpdates.length} blocks)…`);
        for (const { nodeId, originalTitle } of pendingUpdates) {
          const resolved = resolveLinks(originalTitle);
          if (resolved !== originalTitle) {
            try {
              await updateNodeMutation.mutateAsync({ id: nodeId, data: { name: resolved } });
            } catch {
              console.warn(`Failed to update block links for node ${nodeId}`);
            }
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
  }, [parsed, pageClassId, classClassId, createNodeMutation, updateNodeMutation, createPropertyMutation, setNodePropertyMutation, addPropertyToClassMutation, onClose]);

  const createBlocksRecursively = async (
    blocks: LogseqExport['pages'][0]['blocks'],
    parentId: number,
    startSequence: number,
    resolveLinks: (text: string) => string,
    pendingUpdates: Array<{ nodeId: number; originalTitle: string }>,
    uuidMap: Map<string, number>,
    hasUnresolvedLinks: (text: string) => boolean,
  ) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const resolved = resolveLinks(block.title);
      const node = await createNodeMutation.mutateAsync({
        name: resolved,
        parent_id: parentId,
        sequence: startSequence + i,
      });
      // Map block UUID so later blocks/updates can reference it
      if (block.uuid) uuidMap.set(block.uuid, node.id);
      // If the resolved text still has UUID links, queue for pass 4
      if (hasUnresolvedLinks(resolved)) {
        pendingUpdates.push({ nodeId: node.id, originalTitle: block.title });
      }
      if (block.children && block.children.length > 0) {
        await createBlocksRecursively(block.children, node.id, 0, resolveLinks, pendingUpdates, uuidMap, hasUnresolvedLinks);
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

function countBlocks(blocks: LogseqExport['pages'][0]['blocks']): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.children) n += countBlocks(b.children);
  }
  return n;
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
  uuidMap: Map<string, number>,
  titleToNodeId: Map<string, number>,
): Promise<unknown> {
  if (value === null || value === undefined) return undefined;

  // Array → resolve each element for multi-value properties
  if (Array.isArray(value)) {
    const resolved = [];
    for (const item of value) {
      const r = await resolvePropertyValueForImport(item, uuidMap, titleToNodeId);
      if (r !== undefined) resolved.push(r);
    }
    return resolved.length > 0 ? resolved : undefined;
  }

  // Structured markers from EDN parser
  if (typeof value === 'object' && value !== null && '__type' in value) {
    const typed = value as { __type: string; [key: string]: unknown };
    switch (typed.__type) {
      case 'page-ref': {
        // Node-type property: find the target node by title
        const nodeId = titleToNodeId.get(typed.title as string);
        return nodeId ?? undefined;
      }
      case 'date-ref': {
        // Date-type property: get or create the daily node
        try {
          const dayNode = await getOrCreateDaily(typed.date as string);
          return dayNode.id;
        } catch {
          console.warn(`Failed to resolve date: ${typed.date}`);
          return undefined;
        }
      }
      case 'uuid-ref': {
        // Selection option or other UUID ref
        const id = uuidMap.get(typed.uuid as string);
        return id ?? undefined;
      }
    }
  }

  // Primitives: boolean, number, string
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value || undefined;

  return undefined;
}
