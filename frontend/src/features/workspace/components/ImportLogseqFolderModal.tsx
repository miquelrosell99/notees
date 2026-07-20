/**
 * ImportLogseqFolderModal — Modal for importing a Logseq Markdown folder.
 *
 * Uses the client-side Logseq parser and WorkspaceStore to create pages,
 * nested blocks, wiki-links, and asset references without touching the legacy
 * nodes API.
 */
import { useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import {
  parseLogseqFolder,
  countMdBlocks,
  type LogseqFolderResult,
} from '@/plugins/builtin/logseq_importer/utils/logseqMdParser';
import { useLogseqMarkdownImporter } from '@/features/workspace/hooks/useLogseqMarkdownImporter';
import './ImportLogseqFolderModal.css';

interface ImportLogseqFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportLogseqFolderModal({ isOpen, onClose }: ImportLogseqFolderModalProps) {
  const { workspaceUuid } = useParams<{ workspaceUuid?: string }>();
  const { importFolder, isImporting, progress, report, error } =
    useLogseqMarkdownImporter(workspaceUuid);

  const [parsed, setParsed] = useState<LogseqFolderResult | null>(null);
  const [files, setFiles] = useState<FileList | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReset = useCallback(() => {
    setParsed(null);
    setFiles(null);
    setParseError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleClose = useCallback(() => {
    if (isImporting) return;
    handleReset();
    onClose();
  }, [handleReset, onClose, isImporting]);

  const handleFilesChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      setParseError(null);
      const list = e.target.files;
      if (!list || list.length === 0) {
        setFiles(null);
        setParsed(null);
        return;
      }
      try {
        const result = await parseLogseqFolder(list);
        setFiles(list);
        setParsed(result);
      } catch (err) {
        setFiles(null);
        setParsed(null);
        setParseError(err instanceof Error ? err.message : 'Failed to read folder');
      }
    },
    [],
  );

  const handleImport = useCallback(async () => {
    if (!files) return;
    try {
      await importFolder(files);
    } catch {
      // Error is surfaced via the `error` state.
    }
  }, [files, importFolder]);

  const allPages = parsed ? [...parsed.pages, ...parsed.journals] : [];
  const totalBlocks = allPages.reduce((s, p) => s + countMdBlocks(p.blocks), 0);
  const totalAssets = parsed ? parsed.assetFiles.size : 0;

  if (report) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Import Complete"
        size="md"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        }
      >
        <div className="import-logseq__report">
          <p className="import-logseq__report-success">
            Imported {report.pagesCreated} page{report.pagesCreated !== 1 ? 's' : ''} and{' '}
            {report.blocksCreated} block{report.blocksCreated !== 1 ? 's' : ''}.
          </p>
          <ul className="import-logseq__report-list">
            <li><span>Pages</span><span>{report.pagesCreated}</span></li>
            <li><span>Blocks</span><span>{report.blocksCreated}</span></li>
            <li><span>Wiki-links</span><span>{report.linksCreated}</span></li>
            <li><span>Assets uploaded</span><span>{report.assetsUploaded}</span></li>
          </ul>
          {report.errors.length > 0 && (
            <details className="import-logseq__report-errors">
              <summary>Warnings ({report.errors.length})</summary>
              <ul>
                {report.errors.map((msg, idx) => (
                  <li key={idx}>{msg}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import Logseq Folder"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={isImporting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!files || isImporting || !workspaceUuid}
            icon="mdi mdi-import"
          >
            {isImporting ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-logseq__body">
        <p className="import-logseq__description">
          Select a Logseq graph folder (the folder containing <code>pages/</code>,{' '}
          <code>journals/</code>, and <code>assets/</code>). Each Markdown page file becomes
          a Notees page; indented bullets become nested blocks.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          // webkitdirectory is non-standard but widely supported for folder pickers.
          // The directory attribute helps Safari/Firefox fall back behavior.
          {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
          className="import-logseq__file-input"
          onChange={handleFilesChange}
          disabled={isImporting}
        />

        {!workspaceUuid && (
          <div className="import-logseq__error">
            Open a workspace before importing a Logseq folder.
          </div>
        )}

        {(parseError || error) && (
          <div className="import-logseq__error">
            {parseError ?? error}
          </div>
        )}

        {parsed && (
          <div className="import-logseq__summary">
            <div className="import-logseq__badges">
              <span className="import-logseq__badge">
                {allPages.length} page{allPages.length !== 1 ? 's' : ''}
              </span>
              <span className="import-logseq__badge">
                {totalBlocks} block{totalBlocks !== 1 ? 's' : ''}
              </span>
              {totalAssets > 0 && (
                <span className="import-logseq__badge">
                  {totalAssets} asset{totalAssets !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <ul className="import-logseq__page-list">
              {allPages.slice(0, 12).map((p, i) => (
                <li key={i} className="import-logseq__page-item">
                  {p.title}
                  <span className="import-logseq__page-blocks">
                    {countMdBlocks(p.blocks)} blocks
                  </span>
                </li>
              ))}
              {allPages.length > 12 && (
                <li className="import-logseq__page-item import-logseq__page-item--more">
                  …and {allPages.length - 12} more
                </li>
              )}
            </ul>
          </div>
        )}

        {isImporting && progress && (
          <div className="import-logseq__status">
            <div className="import-logseq__status-bar">
              <div
                className="import-logseq__status-bar-fill"
                style={{
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <p className="import-logseq__status-message">{progress.message}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
