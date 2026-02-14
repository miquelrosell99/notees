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
import { useCreateNode, usePageClass, useClassClass } from '@/hooks';
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
      // 1. Create classes first (as type nodes)
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
          } catch {
            console.warn(`Failed to create class: ${cls.title}`);
          }
        }
      }

      // 2. Create pages with blocks
      for (const page of parsed.pages) {
        setImportStatus(`Creating page: ${page.title}`);

        // Build class IDs for this page
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

          // Create child blocks
          if (page.blocks.length > 0) {
            await createBlocksRecursively(page.blocks, pageNode.id, 0);
          }
        } catch {
          console.warn(`Failed to create page: ${page.title}`);
        }
      }

      setImportStatus('Import complete!');
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [parsed, pageClassId, classClassId, createNodeMutation, onClose]);

  const createBlocksRecursively = async (
    blocks: LogseqExport['pages'][0]['blocks'],
    parentId: number,
    startSequence: number,
  ) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const node = await createNodeMutation.mutateAsync({
        name: block.title,
        parent_id: parentId,
        sequence: startSequence + i,
      });
      if (block.children && block.children.length > 0) {
        await createBlocksRecursively(block.children, node.id, 0);
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
