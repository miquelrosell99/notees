/**
 * ImportOptionsModal
 *
 * Unified single-step import modal.
 *
 * Layout:
 *   1. Workspace name (with live availability check)
 *   2. RadioGroup  source selector (JSON file / Logseq EDN text /
 *                                    Logseq SQLite file / Markdown files)
 *   3. Source input  CodeTextarea for EDN, file picker for file-based sources
 *   4. Parsed-data preview (page/block/class/property counts) for Logseq sources
 *   5. Footer  Cancel | Import
 *
 * Progress overlay:
 *   When preparing (workspace switch) or importing (Logseq pipeline), the modal
 *   body is replaced by a TaskProgress so the user has clear feedback.
 *   The report phase shows TaskReport with a working close button.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import {
  checkWorkspaceName,
  importWorkspace as importWorkspaceApi,
  createWorkspace,
  deleteWorkspace,
  switchWorkspace,
  type WorkspaceInfo,
} from '@/api/workspaces';
import { useAppStore } from '@/stores/appStore';
import { useFavoritesStore } from '@/stores';
import type { LogseqExport, LogseqBlock } from '@/utils/ednParser';
import { parseEdnInWorker, parseSqliteInWorker } from '@/utils/logseqParserClient';
import { useLogseqImporter } from '@/hooks/useLogseqImporter';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';
import { SelectionRadio, type RadioOption } from '../core/SelectionRadio';
import { CodeTextarea } from '../core/CodeTextarea';
import { FileDropZone } from '../core/FileDropZone';
import { TaskProgress } from '../core/TaskProgress';
import { TaskReport } from '../core/TaskReport';
import { AlertIcon, SyncIcon } from '../core/icons';
import './ImportOptionsModal.css';

// -- Types -----------------------------------------------------------------

export type ImportType = 'json' | 'logseq-edn' | 'logseq-sqlite' | 'markdown';

export interface ImportResult {
  workspace: WorkspaceInfo;
  type: ImportType;
}

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the workspace is created / imported (non-logseq types). Caller handles switch + navigation. */
  onSuccess: (result: ImportResult) => void;
  /** Called after Logseq import completes and user clicks "Open Workspace". Navigates to workspace. */
  onFinish?: () => void;
}

// -- Source options --------------------------------------------------------

const SOURCE_OPTIONS: RadioOption[] = [
  {
    value: 'json',
    label: 'Notees Dump',
    description: 'Restore from a workspace export file',
    badge: 'file',
  },
  {
    value: 'logseq-edn',
    label: 'Logseq EDN',
    description: 'Paste EDN content from a Logseq database export',
    badge: 'text',
  },
  {
    value: 'logseq-sqlite',
    label: 'Logseq SQLite',
    description: 'Upload a Logseq SQLite database file',
    badge: 'file',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'Import .md files from Logseq or Obsidian',
    badge: 'file',
  },
];

// -- Helpers ---------------------------------------------------------------

function countBlocks(blocks: LogseqBlock[]): number {
  let n = blocks.length;
  for (const b of blocks) {
    if (b.children) n += countBlocks(b.children);
  }
  return n;
}

// -- Main component --------------------------------------------------------

export function ImportOptionsModal({
  isOpen,
  onClose,
  onSuccess,
  onFinish,
}: ImportOptionsModalProps) {
  const [name, setName] = useState('');
  const [selectedType, setSelectedType] = useState<ImportType>('json');
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [sqliteFile, setSqliteFile] = useState<File | null>(null);
  const [ednContent, setEdnContent] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Parsing state for Logseq sources
  const [parsedExport, setParsedExport] = useState<LogseqExport | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  // Modal phase  'preparing' = workspace switch in progress
  type ModalPhase = 'form' | 'preparing' | 'importing' | 'report';
  const [phase, setPhase] = useState<ModalPhase>('form');

  const workspaceUuidRef = useRef<string | null>(null);
  const pendingParsedRef = useRef<LogseqExport | null>(null);
  const pendingWorkspaceRef = useRef<WorkspaceInfo | null>(null);

  const queryClient = useQueryClient();

  // Logseq import pipeline  shared hook
  const {
    importing,
    importStatus,
    importProgress,
    report: hookReport,
    error: hookError,
    reset: resetImport,
    runImport,
    pageClassId,
  } = useLogseqImporter();

  // -- Reset when modal opens ---------------------------------------------
  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelectedType('json');
      setJsonFile(null);
      setSqliteFile(null);
      setEdnContent('');
      setSubmitError(null);
      setParsedExport(null);
      setPhase('form');
      workspaceUuidRef.current = null;
      pendingParsedRef.current = null;
      pendingWorkspaceRef.current = null;
      setIsParsing(false);
      setParseError(null);
      resetImport();
    }
  }, [isOpen, resetImport]);

  // Reset parsed state when source type changes
  useEffect(() => {
    setParsedExport(null);
    setParseError(null);
  }, [selectedType]);

  // -- Workspace switch (phase === 'preparing') ----------------------------
  useEffect(() => {
    if (phase !== 'preparing') return;
    const workspace = pendingWorkspaceRef.current;
    if (!workspace) return;
    let cancelled = false;
    async function prepare() {
      workspaceUuidRef.current = workspace!.uuid;
      useAppStore.getState().setShowWorkspaceManager(true);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      await switchWorkspace(workspace!.uuid);
      useAppStore.setState({
        currentNodeId: null,
        activeNode: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });
      useFavoritesStore.getState().clear();
      queryClient.clear();
      window.history.replaceState(null, '', '/');
      if (!cancelled) setPhase('importing');
    }
    prepare().catch(() => { if (!cancelled) setPhase('form'); });
    return () => { cancelled = true; };
  }, [phase, queryClient]);

  // -- Start import once workspace is ready and pageClassId available ------
  useEffect(() => {
    if (phase !== 'importing' || !pendingParsedRef.current || !pageClassId || importing) return;
    // Clear ref BEFORE calling runImport to prevent double-invocation:
    // when the import finishes, `importing` flips false → the effect re-fires,
    // but pendingParsedRef is already null so the guard exits early.
    const parsed = pendingParsedRef.current;
    pendingParsedRef.current = null;
    runImport(parsed, { importMode: 'additive' });
  }, [phase, pageClassId, importing, runImport]);

  // -- Transition to report when hook finishes ----------------------------
  useEffect(() => {
    if (hookReport) setPhase('report');
  }, [hookReport]);

  // -- Parse SQLite file eagerly -----------------------------------------
  useEffect(() => {
    if (!sqliteFile) {
      setParsedExport(null);
      setParseError(null);
      return;
    }
    let cancelParse: () => void = () => {};
    let active = true;
    setIsParsing(true);
    setParsedExport(null);
    setParseError(null);
    sqliteFile.arrayBuffer().then(buf => {
      if (!active) return Promise.reject(new Error('cancelled'));
      const handle = parseSqliteInWorker(buf);
      cancelParse = handle.cancel;
      return handle.promise;
    })
      .then(result => { if (!active) return; setParsedExport(result); setParseError(null); })
      .catch(e => { if (!active) return; setParsedExport(null); setParseError(e instanceof Error ? e.message : 'Failed to parse SQLite file'); })
      .finally(() => { if (!active) return; setIsParsing(false); });
    return () => { active = false; cancelParse(); };
  }, [sqliteFile]);

  // -- Parse EDN content as user types -----------------------------------
  useEffect(() => {
    if (selectedType !== 'logseq-edn') return;
    if (!ednContent.trim()) {
      setParsedExport(null);
      setParseError(null);
      return;
    }
    setIsParsing(true);
    const { promise, cancel } = parseEdnInWorker(ednContent);
    let active = true;
    promise
      .then(result => { if (!active) return; setParsedExport(result); setParseError(null); })
      .catch(e => {
        if (!active) return;
        setParsedExport(null);
        if (ednContent.trim().length > 20) {
          setParseError(e instanceof Error ? e.message : 'Invalid EDN format');
        }
      })
      .finally(() => { if (!active) return; setIsParsing(false); });
    return () => { active = false; cancel(); };
  }, [ednContent, selectedType]);

  // -- Live name availability check --------------------------------------
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['workspace-name-check', name],
    queryFn: () => checkWorkspaceName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
  });

  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  // -- JSON import mutation ----------------------------------------------
  const importMutation = useMutation({
    mutationFn: ({ n, file }: { n: string; file: File }) =>
      importWorkspaceApi(n, file),
    onSuccess: (workspace) => {
      onSuccess({ workspace, type: 'json' });
    },
    onError: (err: Error) => {
      setSubmitError(err.message || 'Failed to import workspace');
    },
  });

  // -- Workspace creation mutation (logseq / markdown) -------------------
  const createMutation = useMutation({
    mutationFn: (n: string) => createWorkspace(n),
    onSuccess: (workspace) => {
      const type = selectedType;
      workspaceUuidRef.current = workspace.uuid;
      if (type === 'logseq-edn' || type === 'logseq-sqlite') {
        // Store parsed data for the import step
        pendingParsedRef.current = parsedExport;
        pendingWorkspaceRef.current = workspace;
        // Switch workspace first, then import  ImportOptionsModal handles everything
        setPhase('preparing');
        return;
      }
      // markdown / other non-logseq: let parent handle navigation
      onSuccess({ workspace, type });
    },
    onError: (err: Error) => {
      setSubmitError(err.message || 'Failed to create workspace');
    },
  });

  const isPending = importMutation.isPending || createMutation.isPending;

  const isSubmitEnabled = (() => {
    if (!nameIsValid || isCheckingName || isPending) return false;
    if (selectedType === 'json') return jsonFile !== null;
    if (selectedType === 'logseq-edn') return parsedExport !== null;
    if (selectedType === 'logseq-sqlite') return parsedExport !== null && !isParsing;
    if (selectedType === 'markdown') return true;
    return false;
  })();

  const handleSubmit = () => {
    if (!isSubmitEnabled) return;
    setSubmitError(null);
    const trimmedName = name.trim();
    if (selectedType === 'json' && jsonFile) {
      importMutation.mutate({ n: trimmedName, file: jsonFile });
    } else {
      createMutation.mutate(trimmedName);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'TEXTAREA') handleSubmit();
    }
  };

  // -- Derived preview counts -------------------------------------------
  const previewCounts = parsedExport ? (() => {
    const journalCount = parsedExport.pages.filter(p => p.journal).length;
    const pageCount = parsedExport.pages.length - journalCount;
    const classCount = parsedExport.classes.length;
    const propCount = parsedExport.properties.length;
    const blockCount =
      parsedExport.pages.reduce((sum, p) => sum + countBlocks(p.blocks), 0) +
      (parsedExport.standaloneBlocks ? countBlocks(parsedExport.standaloneBlocks) : 0);
    return { pageCount, journalCount, classCount, propCount, blockCount };
  })() : null;

  // -- Cancel import handler --------------------------------------------
  const handleCancelImport = useCallback(async () => {
    const wsUuid = workspaceUuidRef.current;
    workspaceUuidRef.current = null;
    pendingParsedRef.current = null;
    pendingWorkspaceRef.current = null;
    resetImport();
    if (wsUuid) {
      try { await deleteWorkspace(wsUuid); } catch { /* ignore */ }
    }
    setPhase('form');
  }, [resetImport]);

  // -- Open workspace handler (report phase)  fixes both bugs -----------
  // Bug 1: X button was wired to () => {}  now wired to this handler.
  // Bug 2: was missing onFinish() call  workspace opened but ImportLogseqModal
  //        would reappear because isImportLogseqModalOpen stayed true.
  const handleOpenWorkspace = useCallback(() => {
    onFinish?.();
    onClose();
  }, [onFinish, onClose]);

  // -- Progress overlay (workspace creation mutation running) ------------
  if (isPending) {
    return (
      <Modal isOpen={isOpen} onClose={() => {}} title="Import Workspace" size="md">
        <div className="import-unified__progress-overlay">
          <SyncIcon size="lg" className="import-unified__progress-spin" />
          <p className="import-unified__progress-label">
            {selectedType === 'json' ? 'Importing workspace' : 'Creating workspace'}
          </p>
        </div>
      </Modal>
    );
  }

  // -- Preparing phase (workspace switch in progress) -------------------
  if (phase === 'preparing') {
    return (
      <Modal isOpen={isOpen} onClose={() => {}} title="Preparing Workspace" size="md">
        <div className="import-unified__progress-overlay">
          <SyncIcon size="lg" className="import-unified__progress-spin" />
          <p className="import-unified__progress-label">Switching to new workspace</p>
        </div>
      </Modal>
    );
  }

  // -- Importing phase (Logseq pipeline running) -------------------------
  if (phase === 'importing') {
    return (
      <Modal
        isOpen={isOpen}
        onClose={() => {}}
        title="Importing from Logseq"
        size="md"
        footer={
          <Button variant="default" onClick={handleCancelImport}>
            Cancel
          </Button>
        }
      >
        <div style={{ padding: '8px 0' }}>
          <TaskProgress
            progress={importProgress}
            statusText={importStatus}
            error={hookError ?? undefined}
          />
        </div>
      </Modal>
    );
  }

  // -- Report phase (Logseq import completed) ----------------------------
  if (phase === 'report' && hookReport) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleOpenWorkspace}
        title="Import Report"
        size="lg"
        footer={
          <Button variant="primary" onClick={handleOpenWorkspace}>
            Open Workspace
          </Button>
        }
      >
        <TaskReport
          report={hookReport}
          successMessage="Import completed successfully"
          warningMessage="Import completed with errors"
        />
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import Workspace"
      size="md"
      footer={
        <div className="import-unified__footer">
          <div className="import-unified__footer-name">
          <TextField
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-notes"
            autoFocus
            disabled={isPending}
            error={name.length >= 2 && nameCheck?.available === false}
            errorMessage={
              name.length >= 2 && nameCheck?.available === false
                ? 'This name is already taken'
                : undefined
            }
            containerClassName=''
            icon={
              isCheckingName ? (
                <SyncIcon size="xs" />
              ) : name.length >= 2 ? (
                <Icon
                  path={nameCheck?.available ? mdiCheck : mdiClose}
                  size={0.6}
                  color={nameCheck?.available ? 'var(--color-success)' : 'var(--color-error)'}
                />
              ) : undefined
            }
          />
          </div>
          <div className="import-unified__footer-actions">
            <Button variant="default" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!isSubmitEnabled}
            >
              Import
            </Button>
          </div>
        </div>
      }
    >
      <div className="import-unified__body" onKeyDown={handleKeyDown}>

        {/* -- 1. Source selector ---------------------------------------- */}
        <div className="import-unified__field-group">
          <span className="import-unified__section-label">Source</span>
          <SelectionRadio
            options={SOURCE_OPTIONS}
            value={selectedType}
            onChange={(v) => {
              setSelectedType(v as ImportType);
              setSubmitError(null);
            }}
            layout="vertical"
            disabled={isPending}
          />
        </div>

        {/* -- 3. Source input ------------------------------------------- */}
        {selectedType === 'json' && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Notees export file</span>
            <FileDropZone
              file={jsonFile}
              accept=".json"
              onSelect={setJsonFile}
              onClear={() => setJsonFile(null)}
              placeholder="Drop the export here"
              disabled={isPending}
            />
          </div>
        )}

        {selectedType === 'logseq-edn' && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">EDN content</span>
            <CodeTextarea
              value={ednContent}
              onChange={setEdnContent}
              placeholder='{:pages-and-blocks [...] :properties {...} :classes {...}}'
              disabled={isPending}
              error={!!parseError}
              valid={!!parsedExport}
              autoFocus
              minHeight={200}
            />
          </div>
        )}

        {selectedType === 'logseq-sqlite' && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">SQLite database file</span>
            <FileDropZone
              file={sqliteFile}
              accept=".sqlite,.sqlite3,.db"
              onSelect={setSqliteFile}
              onClear={() => { setSqliteFile(null); setParsedExport(null); }}
              placeholder={isParsing ? 'Parsing database' : 'Drop the database here'}
              disabled={isPending}
            />
          </div>
        )}

        {selectedType === 'markdown' && (
          <div className="import-unified__field-group">
            <p className="import-unified__hint">
              A workspace will be created and an import panel will open where you
              can select your Markdown files.
            </p>
          </div>
        )}

        {/* -- 4. Parse error -------------------------------------------- */}
        {parseError && (
          <div className="import-unified__error">
            <AlertIcon size="sm" />
            {parseError}
          </div>
        )}

        {/* -- 5. Parsed preview (Logseq sources) ------------------------- */}
        {previewCounts && (
          <details className="import-unified__preview">
            <summary className="import-unified__preview-summary">
              Parsed content
            </summary>
            <ul className="import-unified__preview-list">
              <li><span>Pages</span><span>{previewCounts.pageCount}</span></li>
              {previewCounts.journalCount > 0 && (
                <li><span>Journals</span><span>{previewCounts.journalCount}</span></li>
              )}
              <li><span>Blocks</span><span>{previewCounts.blockCount}</span></li>
              <li><span>Classes</span><span>{previewCounts.classCount}</span></li>
              <li><span>Properties</span><span>{previewCounts.propCount}</span></li>
            </ul>
          </details>
        )}

        {/* -- 6. Submit error ------------------------------------------- */}
        {submitError && (
          <div className="import-unified__error">
            <AlertIcon size="sm" />
            {submitError}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ImportOptionsModal;
