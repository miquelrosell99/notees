/**
 * ImportOptionsModal
 *
 * Unified single-step import modal.
 *
 * Layout:
 *   1. Workspace name (with live availability check)
 *   2. RadioGroup — source selector (JSON file / Logseq EDN text /
 *                                    Logseq SQLite file / Markdown files)
 *   3. Source input — CodeTextarea for EDN, file picker for file-based sources
 *   4. Footer — Cancel | Import
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiCheck, mdiClose } from '@mdi/js';
import {
  checkWorkspaceName,
  importWorkspace as importWorkspaceApi,
  createWorkspace,
  type WorkspaceInfo,
} from '@/api/workspaces';
import { setPendingLogseqImport } from '@/utils/importState';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';
import { SelectionRadio, type RadioOption } from '../core/SelectionRadio';
import { CodeTextarea } from '../core/CodeTextarea';
import { FileDropZone } from '../core/FileDropZone';
import { AlertIcon, SyncIcon } from '../core/icons';
import './ImportOptionsModal.css';

// ── Types ─────────────────────────────────────────────────────

export type ImportType = 'json' | 'logseq-edn' | 'logseq-sqlite' | 'markdown';

export interface ImportResult {
  workspace: WorkspaceInfo;
  type: ImportType;
}

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the workspace is created / imported. Caller handles switch + navigation. */
  onSuccess: (result: ImportResult) => void;
}

// ── Source options ────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────

export function ImportOptionsModal({
  isOpen,
  onClose,
  onSuccess,
}: ImportOptionsModalProps) {
  const [name, setName] = useState('');
  const [selectedType, setSelectedType] = useState<ImportType>('json');
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [sqliteFile, setSqliteFile] = useState<File | null>(null);
  const [ednContent, setEdnContent] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelectedType('json');
      setJsonFile(null);
      setSqliteFile(null);
      setEdnContent('');
      setSubmitError(null);
    }
  }, [isOpen]);

  // Live name availability check
  const { data: nameCheck, isLoading: isCheckingName } = useQuery({
    queryKey: ['workspace-name-check', name],
    queryFn: () => checkWorkspaceName(name),
    enabled: name.length >= 2,
    staleTime: 5000,
  });

  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  // JSON import mutation (file → /workspaces/import)
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

  // Workspace creation mutation (logseq / markdown)
  const createMutation = useMutation({
    mutationFn: (n: string) => createWorkspace(n),
    onSuccess: (workspace) => {
      const type = selectedType;
      if (type === 'logseq-edn') {
        setPendingLogseqImport({ source: 'edn', ednContent: ednContent.trim() });
      } else if (type === 'logseq-sqlite' && sqliteFile) {
        setPendingLogseqImport({ source: 'sqlite', sqliteFile });
      }
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
    if (selectedType === 'logseq-edn') return ednContent.trim().length > 0;
    if (selectedType === 'logseq-sqlite') return sqliteFile !== null;
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import Workspace"
      size="md"
      footer={
        <>
          <Button variant="default" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!isSubmitEnabled}
          >
            {isPending ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      <div className="import-unified__body" onKeyDown={handleKeyDown}>

        {/* ── 1. Name ──────────────────────────────────────── */}
        <div className="import-unified__field-group">
          <TextField
            label="Name"
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
            containerClassName={
              name.length >= 2 && nameCheck?.available && !isCheckingName
                ? 'text-field__container--valid'
                : ''
            }
            icon={
              isCheckingName ? (
                <SyncIcon size="xs" />
              ) : name.length >= 2 ? (
                <Icon
                  path={nameCheck?.available ? mdiCheck : mdiClose}
                  size={0.6}
                />
              ) : undefined
            }
          />
        </div>

        {/* ── 2. Source selector ───────────────────────────── */}
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

        {/* ── 3. Source input ──────────────────────────────── */}
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
              onClear={() => setSqliteFile(null)}
              placeholder="Drop the database here"
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

        {/* ── 4. Error ────────────────────────────────────── */}
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
