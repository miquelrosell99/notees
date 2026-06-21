/**
 * ImportMarkdownModal - Modal for importing Markdown (.md) files from
 * various outliner/note-taking apps.
 *
 * Currently supports:
 *   - Logseq (outline-style markdown with `- ` bullets)
 *   - Obsidian (planned, disabled for now)
 *
 * Uses a file picker that accepts multiple .md files, parses them with
 * the selected source parser, and creates pages + blocks via the existing API.
 */
import { useState, useCallback, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import {
  parseLogseqMdFiles,
  countMdBlocks,
  type LogseqMdPage,
  type LogseqMdBlock,
} from '@/plugins/builtin/logseq_importer/utils/logseqMdParser';
import { useCreateNode, usePageClass } from '@/features/content';
import './ImportMarkdownModal.css';

type MdSource = 'logseq' | 'obsidian';

const SOURCE_OPTIONS: { value: MdSource; label: string; disabled?: boolean }[] = [
  { value: 'logseq', label: 'Logseq' },
  { value: 'obsidian', label: 'Obsidian (coming soon)', disabled: true },
];

interface ImportMarkdownModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportMarkdownModal({ isOpen, onClose }: ImportMarkdownModalProps) {
  const [source, setSource] = useState<MdSource>('logseq');
  const [pages, setPages] = useState<LogseqMdPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();

  const handleReset = useCallback(() => {
    setPages([]);
    setError(null);
    setImporting(false);
    setImportStatus('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleFilesChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) {
        setPages([]);
        return;
      }

      try {
        const fileData: { name: string; content: string }[] = [];
        for (let i = 0; i < fileList.length; i++) {
          const file = fileList[i];
          const text = await file.text();
          fileData.push({ name: file.name, content: text });
        }

        // Parse using the selected source format
        // (for now only Logseq; Obsidian will be added here)
        const parsed = parseLogseqMdFiles(fileData);
        setPages(parsed);
      } catch (err) {
        setPages([]);
        setError(err instanceof Error ? err.message : 'Failed to read files');
      }
    },
    [],
  );

  const handleImport = useCallback(async () => {
    if (pages.length === 0 || !pageClassId) return;
    setImporting(true);
    setError(null);

    const createBlocksRecursively = async (
      blocks: LogseqMdBlock[],
      parentId: number,
      startSeq: number,
    ) => {
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const node = await createNodeMutation.mutateAsync({
          name: block.content,
          parent_id: parentId,
          sequence: startSeq + i,
        });
        if (block.children.length > 0) {
          await createBlocksRecursively(block.children, node.id, 0);
        }
      }
    };

    try {
      for (const page of pages) {
        setImportStatus(`Creating page: ${page.title}`);
        try {
          const pageNode = await createNodeMutation.mutateAsync({
            name: page.title,
            classes: [pageClassId],
          });

          if (page.blocks.length > 0) {
            await createBlocksRecursively(page.blocks, pageNode.id, 0);
          }
        } catch {
          console.warn(`Failed to create page: ${page.title}`);
        }
      }

      setImportStatus('Import complete!');
      setTimeout(() => {
        handleReset();
        onClose();
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [pages, pageClassId, createNodeMutation, onClose, handleReset]);

  const totalBlocks = pages.reduce((s, p) => s + countMdBlocks(p.blocks), 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { handleReset(); onClose(); }}
      title="Import Markdown"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { handleReset(); onClose(); }} disabled={importing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={pages.length === 0 || importing}
            icon={"mdi mdi-import"}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-md__body">
        <p className="import-md__description">
          Select one or more <code>.md</code> page files exported from another app.
          Each file will be created as a page with its outline blocks.
        </p>

        <div className="import-md__row">
          <label className="import-md__label" htmlFor="md-source-select">Source</label>
          <select
            id="md-source-select"
            className="import-md__select"
            value={source}
            onChange={(e) => { setSource(e.target.value as MdSource); handleReset(); }}
            disabled={importing}
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          multiple
          className="import-md__file-input"
          onChange={handleFilesChange}
          disabled={importing}
        />

        {error && <div className="import-md__error">{error}</div>}

        {pages.length > 0 && (
          <div className="import-md__summary">
            <div className="import-md__badges">
              <span className="import-md__badge">
                {pages.length} page{pages.length !== 1 ? 's' : ''}
              </span>
              <span className="import-md__badge">
                {totalBlocks} block{totalBlocks !== 1 ? 's' : ''}
              </span>
            </div>

            <ul className="import-md__page-list">
              {pages.slice(0, 12).map((p, i) => (
                <li key={i} className="import-md__page-item">
                  {p.title}
                  <span className="import-md__page-blocks">
                    {countMdBlocks(p.blocks)} blocks
                  </span>
                </li>
              ))}
              {pages.length > 12 && (
                <li className="import-md__page-item import-md__page-item--more">
                  …and {pages.length - 12} more
                </li>
              )}
            </ul>
          </div>
        )}

        {importing && importStatus && (
          <div className="import-md__status">{importStatus}</div>
        )}
      </div>
    </Modal>
  );
}
