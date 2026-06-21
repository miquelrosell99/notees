/**
 * ImportLogseqFolderModal — Import from a Logseq markdown graph folder.
 *
 * The user selects an entire Logseq graph folder (containing pages/ and journals/
 * subdirectories). The modal parses all .md files, creates pages and journal entries,
 * resolves [[wiki-links]] to proper node links, and creates the block hierarchy.
 *
 * The import pipeline lives in useLogseqFolderImporter so it can also be used
 * by ImportOptionsModal (workspace-creation flow).
 */
import { useState, useCallback, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TaskProgress } from '@/components/ui/TaskProgress';
import { SyncIcon } from '@/components/ui/icons';
import {
  parseLogseqFolder,
  countMdBlocks,
  type LogseqFolderResult,
} from '../utils/logseqMdParser';
import { useLogseqFolderImporter } from '../hooks/useLogseqFolderImporter';
import './ImportLogseqFolderModal.css';

interface ImportLogseqFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportLogseqFolderModal({ isOpen, onClose }: ImportLogseqFolderModalProps) {
  const [folderResult, setFolderResult] = useState<LogseqFolderResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    importing,
    progress,
    statusText,
    error: importError,
    reset: resetImporter,
    runImport,
    pageClassId,
  } = useLogseqFolderImporter();

  const handleReset = useCallback(() => {
    setFolderResult(null);
    setParseError(null);
    setFolderName(null);
    setIsParsing(false);
    resetImporter();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [resetImporter]);

  const handleFolderChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    setParseError(null);
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) {
      setFolderResult(null);
      setFolderName(null);
      return;
    }

    const firstPath = fileList[0].webkitRelativePath || '';
    const rootFolder = firstPath.split('/')[0] || 'Unknown';
    setFolderName(rootFolder);

    setIsParsing(true);
    try {
      const result = await parseLogseqFolder(fileList);
      if (result.pages.length === 0 && result.journals.length === 0) {
        setParseError('No pages or journals found. Make sure you selected a Logseq graph folder containing pages/ and/or journals/ subfolders.');
        setFolderResult(null);
        return;
      }
      setFolderResult(result);
    } catch (err) {
      setFolderResult(null);
      setParseError(err instanceof Error ? err.message : 'Failed to parse folder');
    } finally {
      setIsParsing(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!folderResult) return;
    await runImport(folderResult);
    setTimeout(() => {
      handleReset();
      onClose();
    }, 800);
  }, [folderResult, runImport, onClose, handleReset]);

  const error = parseError || importError;

  const totalPages = folderResult?.pages.length ?? 0;
  const totalJournals = folderResult?.journals.length ?? 0;
  const totalAssets = folderResult?.assetFiles.size ?? 0;
  const totalBlocks = folderResult
    ? [...folderResult.pages, ...folderResult.journals].reduce(
        (s, p) => s + countMdBlocks(p.blocks),
        0,
      )
    : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { handleReset(); onClose(); }}
      title="Import Logseq Folder"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => { handleReset(); onClose(); }} disabled={importing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!folderResult || importing || !pageClassId}
            icon={"mdi mdi-import"}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-folder__body">
        <p className="import-folder__description">
          Select your Logseq graph folder. It should contain <code>pages/</code> and/or{' '}
          <code>journals/</code> subfolders with <code>.md</code> files.
        </p>

        <button
          type="button"
          className={`import-folder__dropzone${folderResult ? ' import-folder__dropzone--valid' : ''}${error ? ' import-folder__dropzone--error' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          <input
            ref={fileInputRef}
            type="file"
            /* @ts-expect-error webkitdirectory is non-standard but widely supported */
            webkitdirectory=""
            directory=""
            className="import-folder__file-input"
            onChange={handleFolderChange}
            onClick={(e) => e.stopPropagation()}
            disabled={importing}
          />
          {folderName ? (
            <span className="import-folder__dropzone-text">
              <strong>{folderName}</strong>
              <br />
              {isParsing ? (
                <span className="import-folder__parsing">
                  <SyncIcon size="xs" className="import-folder__parsing-spin" /> Reading files…
                </span>
              ) : folderResult ? 'Ready to import' : 'Click to choose a different folder'}
            </span>
          ) : (
            <span className="import-folder__dropzone-text">
              Click to select a Logseq graph folder
            </span>
          )}
        </button>

        {error && <div className="import-folder__error">{error}</div>}

        {folderResult && (
          <div className="import-folder__summary">
            <div className="import-folder__badges">
              {totalPages > 0 && (
                <span className="import-folder__badge">
                  {totalPages} page{totalPages !== 1 ? 's' : ''}
                </span>
              )}
              {totalJournals > 0 && (
                <span className="import-folder__badge">
                  {totalJournals} journal{totalJournals !== 1 ? 's' : ''}
                </span>
              )}
              <span className="import-folder__badge">
                {totalBlocks} block{totalBlocks !== 1 ? 's' : ''}
              </span>
              {totalAssets > 0 && (
                <span className="import-folder__badge">
                  {totalAssets} asset{totalAssets !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <ul className="import-folder__page-list">
              {folderResult.pages.slice(0, 8).map((p, i) => (
                <li key={`p-${i}`} className="import-folder__page-item">
                  {p.title}
                  <span className="import-folder__page-blocks">
                    {countMdBlocks(p.blocks)} blocks
                  </span>
                </li>
              ))}
              {folderResult.pages.length > 8 && (
                <li className="import-folder__page-item import-folder__page-item--more">
                  …and {folderResult.pages.length - 8} more pages
                </li>
              )}
              {folderResult.journals.slice(0, 4).map((j, i) => (
                <li key={`j-${i}`} className="import-folder__page-item import-folder__page-item--journal">
                  📅 {j.journalDate}
                  <span className="import-folder__page-blocks">
                    {countMdBlocks(j.blocks)} blocks
                  </span>
                </li>
              ))}
              {folderResult.journals.length > 4 && (
                <li className="import-folder__page-item import-folder__page-item--more">
                  …and {folderResult.journals.length - 4} more journals
                </li>
              )}
            </ul>
          </div>
        )}

        {importing && (
          <TaskProgress progress={progress} statusText={statusText} />
        )}
      </div>
    </Modal>
  );
}
