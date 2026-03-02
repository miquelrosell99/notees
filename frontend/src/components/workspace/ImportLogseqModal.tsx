/**
 * ImportLogseqModal - Manual import from Logseq (opened via command palette).
 *
 * The 7-phase import pipeline lives in useLogseqImporter so it can also be
 * called by ImportOptionsModal (workspace-creation flow) without opening this modal.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { CodeTextarea } from '../core/CodeTextarea';
import { TaskProgress } from '../core/TaskProgress';
import { TaskReport } from '../core/TaskReport';
import { type LogseqExport } from '@/utils/ednParser';
import { parseEdnInWorker, parseSqliteInWorker } from '@/utils/logseqParserClient';
import { useLogseqImporter, countBlocks } from '@/hooks/useLogseqImporter';
import type { ImportMode } from '@/hooks/useLogseqImporter';
import './ImportLogseqModal.css';

/** Input source: EDN text paste or SQLite file upload */
type InputSource = 'edn' | 'sqlite';

interface ImportLogseqModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ImportLogseqModal({ isOpen, onClose }: ImportLogseqModalProps) {
  //  Form state 
  const [content, setContent] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<LogseqExport | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>(
    () => (localStorage.getItem('logseq-import-mode') as ImportMode | null) ?? 'additive'
  );
  const [inputSource, setInputSource] = useState<InputSource>('edn');
  const [sqliteFileName, setSqliteFileName] = useState<string | null>(null);
  const [sqliteParsing, setSqliteParsing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  //  Import logic 
  const { importing, importStatus, importProgress, report, error: importError, reset, runImport } = useLogseqImporter();

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setContent('');
      setParseError(null);
      setParsed(null);
      setSqliteFileName(null);
      setSqliteParsing(false);
      reset();
      if (inputSource === 'edn') {
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Validate EDN as user types (debounced by paste)
  useEffect(() => {
    if (inputSource !== 'edn') return;
    if (!content.trim()) {
      setParseError(null);
      setParsed(null);
      return;
    }
    const { promise, cancel } = parseEdnInWorker(content);
    let active = true;
    promise
      .then((result) => {
        if (!active) return;
        setParsed(result);
        setParseError(null);
      })
      .catch((e) => {
        if (!active) return;
        setParsed(null);
        if (content.trim().length > 20) {
          setParseError(e instanceof Error ? e.message : 'Invalid EDN format');
        }
      });
    return () => { active = false; cancel(); };
  }, [content, inputSource]);

  const handleSqliteFile = useCallback((file: File) => {
    setSqliteFileName(file.name);
    setSqliteParsing(true);
    setParseError(null);
    setParsed(null);

    let cancelParse: () => void = () => {};
    file.arrayBuffer().then((buffer) => {
      const handle = parseSqliteInWorker(buffer);
      cancelParse = handle.cancel;
      return handle.promise;
    })
      .then((result) => { setParsed(result); setParseError(null); })
      .catch((e) => { setParsed(null); setParseError(e instanceof Error ? e.message : 'Failed to parse SQLite file'); })
      .finally(() => setSqliteParsing(false));

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
        setParseError('Please drop a Logseq .sqlite database file');
      }
    },
    [handleSqliteFile],
  );

  const handleInputSourceChange = useCallback((source: InputSource) => {
    setInputSource(source);
    setParseError(null);
    setParsed(null);
    setContent('');
    setSqliteFileName(null);
  }, []);

  const handleImportModeChange = (checked: boolean) => {
    const mode: ImportMode = checked ? 'override' : 'additive';
    setImportMode(mode);
    localStorage.setItem('logseq-import-mode', mode);
  };

  const handleImport = useCallback(async () => {
    if (!parsed) return;
    await runImport(parsed, { importMode });
  }, [parsed, importMode, runImport]);

  // Ctrl+Enter anywhere inside the modal = import (capture phase)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      if (!parsed || importing) return;
      const target = e.target as HTMLElement;
      if (!target.closest('.import-logseq')) return;
      e.preventDefault();
      e.stopPropagation();
      handleImport();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen, parsed, importing, handleImport]);

  //  Preview counts 
  const journalCount = parsed?.pages.filter(p => p.journal).length ?? 0;
  const pageCount = (parsed?.pages.length ?? 0) - journalCount;
  const classCount = parsed?.classes.length ?? 0;
  const propCount = parsed?.properties.length ?? 0;
  const blockCount =
    (parsed?.pages.reduce((sum, p) => sum + countBlocks(p.blocks), 0) ?? 0)
    + (parsed?.standaloneBlocks ? countBlocks(parsed.standaloneBlocks) : 0);

  //  Report view 
  if (report) {
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
        <TaskReport
          report={report}
          successMessage="Import completed successfully"
          warningMessage="Import completed with errors"
        />
      </Modal>
    );
  }

  //  Input view 
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import from Logseq"
      size="lg"
      className="import-logseq"
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
            {importing ? 'Importing' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-logseq__body">
        {/*  Input source tabs  */}
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
              error={!!parseError}
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
                parseError ? ' import-logseq__dropzone--error' : ''
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
                <span className="import-logseq__dropzone-text">Parsing database</span>
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

        {(parseError || importError) && (
          <div className="import-logseq__error">{parseError ?? importError}</div>
        )}

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
