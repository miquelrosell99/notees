/**
 * ImportOptionsModal
 *
 * Unified single-step import modal for JSON workspace dumps, Markdown workspaces,
 * single Markdown files, and plugin importers.
 *
 * Layout:
 *   1. Workspace name (with live availability check) for workspace-creating sources
 *   2. RadioGroup source selector
 *   3. Source input (file drop or description)
 *   4. Footer: Cancel | Import
 *
 * Progress overlay:
 *   While a workspace import/create mutation is running, the modal body is replaced
 *   by a simple spinner so the user has clear feedback.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';

import { type WorkspaceInfo } from '@/features/workspace/api/workspaces';
import { useWorkspaceImport, useWorkspaceNameCheck, useWorkspaces } from '@/features/workspace';
import { useImportMarkdown } from '@/features/workspace';
import type { MarkdownImportResult } from '@/features/workspace/api/import';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { SelectionRadio, type RadioOption } from '@/components/ui/SelectionRadio';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { Icon, SyncIcon, AlertIcon } from '@/components/ui/icons';
import { useImporters, useRunImporter, type ImporterRunResult } from '@/plugins/core';
import './ImportOptionsModal.css';

// -- Types -----------------------------------------------------------------

export type ImportType = string;

export interface ImportResult {
  workspace: WorkspaceInfo;
  type: ImportType;
}

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the workspace is created / imported (non-direct types). Caller handles switch + navigation. */
  onSuccess: (result: ImportResult) => void;
  /** Called after a direct/plugin import completes and user clicks "Done". */
  onFinish?: () => void;
}

// -- Source options --------------------------------------------------------

const BUILTIN_SOURCE_OPTIONS: RadioOption[] = [
  {
    value: 'json',
    label: 'Notees Dump',
    description: 'Restore from a workspace export file',
    badge: 'file',
  },
  {
    value: 'markdown',
    label: 'Markdown',
    description: 'Import .md files from Logseq or Obsidian',
    badge: 'file',
  },
  {
    value: 'markdown-file',
    label: 'Markdown file',
    description: 'Import a single Markdown file into the current workspace',
    badge: 'file',
  },
];

const BUILTIN_IMPORT_TYPES = new Set(BUILTIN_SOURCE_OPTIONS.map((o) => o.value));

function isBuiltInImportType(type: string): boolean {
  return BUILTIN_IMPORT_TYPES.has(type);
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
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
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Plugin importer state
  const [pluginFile, setPluginFile] = useState<File | null>(null);
  const [pluginReport, setPluginReport] = useState<ImporterRunResult | null>(null);

  // Direct file import state (Markdown into current workspace)
  const [singleImportFile, setSingleImportFile] = useState<File | null>(null);
  const [directReport, setDirectReport] = useState<MarkdownImportResult[] | null>(null);
  const [directImportError, setDirectImportError] = useState<string | null>(null);
  const [directImportType, setDirectImportType] = useState<ImportType | null>(null);
  const [directImportLoading, setDirectImportLoading] = useState(false);

  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Modal phase: 'form' or 'report'
  type ModalPhase = 'form' | 'report';
  const [phase, setPhase] = useState<ModalPhase>('form');

  useEffect(() => {
    if (!isOpen || phase !== 'form') return;
    if (selectedType === 'json' || selectedType === 'markdown') {
      nameInputRef.current?.focus();
    }
  }, [isOpen, phase, selectedType]);

  const { workspaceUuid } = useParams<{ workspaceUuid?: string }>();
  const { data: pluginImporters = [] } = useImporters(isOpen);
  const runPluginImporter = useRunImporter();

  const sourceOptions = useMemo<RadioOption[]>(() => {
    const pluginOptions: RadioOption[] = pluginImporters.map((imp) => ({
      value: imp.id,
      label: imp.label,
      description: imp.file_extensions?.length
        ? `Import ${imp.file_extensions.map((e) => `.${e}`).join(', ')} files`
        : 'Plugin import source',
      badge: 'plugin',
    }));
    return [...BUILTIN_SOURCE_OPTIONS, ...pluginOptions];
  }, [pluginImporters]);

  // Direct file import mutations
  const importMarkdownMutation = useImportMarkdown();

  // Current workspace lookup for direct file imports
  const { data: workspacesData } = useWorkspaces({ enabled: isOpen });
  const currentWorkspace = useMemo(() => {
    if (!workspacesData || !workspaceUuid) return null;
    return workspacesData.items.find((w) => w.uuid === workspaceUuid) ?? null;
  }, [workspacesData, workspaceUuid]);

  // -- Reset when modal opens ---------------------------------------------
  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelectedType('json');
      setJsonFile(null);
      setSubmitError(null);
      setPhase('form');
      setPluginFile(null);
      setPluginReport(null);
      setSingleImportFile(null);
      setDirectReport(null);
      setDirectImportError(null);
      setDirectImportType(null);
      setDirectImportLoading(false);
    }
  }, [isOpen]);

  // Reset parsed state when source type changes
  useEffect(() => {
    setPluginFile(null);
    setPluginReport(null);
    setSingleImportFile(null);
    setDirectReport(null);
    setDirectImportError(null);
    setDirectImportType(null);
    setDirectImportLoading(false);
  }, [selectedType]);

  // -- Live name availability check --------------------------------------
  const { data: nameCheck, isLoading: isCheckingName } = useWorkspaceNameCheck(name);

  const nameIsValid = name.length >= 2 && nameCheck?.available !== false;

  // -- Workspace import / creation mutations -------------------------------
  const { importWorkspace, createWorkspace } = useWorkspaceImport();

  const isPending = importWorkspace.isPending || createWorkspace.isPending || runPluginImporter.isPending || directImportLoading;

  const isSubmitEnabled = (() => {
    if (isPending) return false;
    if (isBuiltInImportType(selectedType)) {
      if (selectedType === 'markdown-file') return singleImportFile !== null && !!workspaceUuid;
      if (!nameIsValid || isCheckingName) return false;
      if (selectedType === 'json') return jsonFile !== null;
      if (selectedType === 'markdown') return true;
      return false;
    }
    // Plugin importer source
    return pluginFile !== null && !!workspaceUuid;
  })();

  const handleSubmit = useCallback(async () => {
    if (!isSubmitEnabled) return;
    setSubmitError(null);
    setDirectImportError(null);
    const trimmedName = name.trim();

    if (selectedType === 'markdown-file') {
      if (!singleImportFile || !workspaceUuid || !currentWorkspace) return;
      setDirectImportLoading(true);
      try {
        const content = await readTextFile(singleImportFile);
        const results = await importMarkdownMutation.mutateAsync({ items: [{ content }] });
        setDirectReport(results);
        setDirectImportType(selectedType);
        setPhase('report');
      } catch (err: unknown) {
        setDirectImportError(err instanceof Error ? err.message : 'Import failed');
      } finally {
        setDirectImportLoading(false);
      }
      return;
    }

    if (!isBuiltInImportType(selectedType)) {
      if (!pluginFile || !workspaceUuid) return;
      runPluginImporter.mutate(
        { importerId: selectedType, file: pluginFile, workspaceUuid: workspaceUuid },
        {
          onSuccess: (result) => {
            setPluginReport(result);
            setPhase('report');
          },
          onError: (err: Error) => {
            setSubmitError(err.message || 'Import failed');
          },
        }
      );
      return;
    }

    if (selectedType === 'json' && jsonFile) {
      importWorkspace.mutate(
        { name: trimmedName, file: jsonFile },
        {
          onSuccess: (workspace) => {
            onSuccess({ workspace, type: 'json' });
          },
          onError: (err: Error) => {
            setSubmitError(err.message || 'Failed to import workspace');
          },
        }
      );
    } else if (selectedType === 'markdown') {
      createWorkspace.mutate(trimmedName, {
        onSuccess: (workspace) => {
          onSuccess({ workspace, type: 'markdown' });
        },
        onError: (err: Error) => {
          setSubmitError(err.message || 'Failed to create workspace');
        },
      });
    }
  }, [isSubmitEnabled, name, selectedType, jsonFile, importWorkspace, createWorkspace, pluginFile, workspaceUuid, runPluginImporter, onSuccess, singleImportFile, currentWorkspace, importMarkdownMutation]);

  // Enter anywhere inside the modal = submit (capture phase)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA') return;
      const target = e.target as HTMLElement;
      if (!target.closest('.import-unified')) return;
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isOpen, handleSubmit]);

  // -- Open workspace handler (report phase)
  const handleOpenWorkspace = useCallback(() => {
    if (directReport && currentWorkspace && directImportType) {
      onSuccess({ workspace: currentWorkspace, type: directImportType });
    }
    onFinish?.();
    onClose();
  }, [directReport, currentWorkspace, directImportType, onSuccess, onFinish, onClose]);

  // -- Progress overlay (workspace creation mutation running) ------------
  if (isPending) {
    return (
      <Modal isOpen={isOpen} onClose={() => {}} title="Import Workspace" size="md">
        <div className="import-unified__progress-overlay">
          <SyncIcon size="lg" className="import-unified__progress-spin" />
          <p className="import-unified__progress-label">
            {selectedType === 'json'
              ? 'Importing workspace'
              : selectedType === 'markdown-file'
              ? 'Importing file'
              : 'Creating workspace'}
          </p>
        </div>
      </Modal>
    );
  }

  // -- Report phase ------------------------------------------------------
  if (phase === 'report') {
    if (directReport) {
      const created = directReport.filter((r) => r.created).length;
      const existing = directReport.filter((r) => r.existing).length;
      return (
        <Modal
          isOpen={isOpen}
          onClose={handleOpenWorkspace}
          title="Import Complete"
          size="md"
          footer={
            <Button variant="primary" onClick={handleOpenWorkspace}>
              Done
            </Button>
          }
        >
          <div className="import-unified__report-message">
            <p className="import-unified__report-success">
              Imported {directReport.length} item{directReport.length !== 1 ? 's' : ''}.
            </p>
            <ul className="import-unified__preview-list">
              <li><span>Created</span><span>{created}</span></li>
              {existing > 0 && <li><span>Existing</span><span>{existing}</span></li>}
            </ul>
            {directReport.length > 0 && (
              <details className="import-unified__preview">
                <summary className="import-unified__preview-summary">Imported nodes</summary>
                <ul className="import-unified__preview-list">
                  {directReport.map((r) => (
                    <li key={r.node_uuid}><span title={r.node_uuid}>{r.title}</span></li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Modal>
      );
    }

    if (pluginReport) {
      const total =
        pluginReport.created_node_ids.length +
        pluginReport.updated_node_ids.length +
        pluginReport.skipped_count +
        pluginReport.error_count;
      return (
        <Modal
          isOpen={isOpen}
          onClose={handleOpenWorkspace}
          title="Import Complete"
          size="md"
          footer={
            <Button variant="primary" onClick={handleOpenWorkspace}>
              Done
            </Button>
          }
        >
          <div className="import-unified__report-message">
            <p className="import-unified__report-success">
              Imported {total} record{total !== 1 ? 's' : ''}.
            </p>
            <ul className="import-unified__preview-list">
              <li><span>Created</span><span>{pluginReport.created_node_ids.length}</span></li>
              <li><span>Updated</span><span>{pluginReport.updated_node_ids.length}</span></li>
              <li><span>Skipped</span><span>{pluginReport.skipped_count}</span></li>
              {pluginReport.error_count > 0 && (
                <li><span>Errors</span><span>{pluginReport.error_count}</span></li>
              )}
            </ul>
            {pluginReport.messages.length > 0 && (
              <details className="import-unified__preview">
                <summary className="import-unified__preview-summary">Messages</summary>
                <ul className="import-unified__preview-list">
                  {pluginReport.messages.map((msg, idx) => (
                    <li key={idx}><span>{msg}</span></li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Modal>
      );
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import Workspace"
      size="md"
      className="import-unified"
      footer={
        <div className="import-unified__footer">
          {isBuiltInImportType(selectedType) && selectedType !== 'markdown-file' && (
            <div className="import-unified__footer-name">
            <TextField
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-notes"
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
                    path={nameCheck?.available ? "mdi mdi-check" : "mdi mdi-close"}
                    size={0.6}
                    color={nameCheck?.available ? 'var(--color-success)' : 'var(--color-error)'}
                  />
                ) : undefined
              }
            />
            </div>
          )}
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
      <div className="import-unified__body">

        {/* -- 1. Source selector ---------------------------------------- */}
        <div className="import-unified__field-group">
          <span className="import-unified__section-label">Source</span>
          <SelectionRadio
            options={sourceOptions}
            value={selectedType}
            onChange={(v) => {
              setSelectedType(v);
              setSubmitError(null);
            }}
            layout="vertical"
            disabled={isPending}
          />
        </div>

        {/* -- 2. Source input ------------------------------------------- */}
        {selectedType === 'json' && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Notees export file</span>
            <FileDropZone
              file={jsonFile}
              accept=".json,.zip"
              onSelect={setJsonFile}
              onClear={() => setJsonFile(null)}
              placeholder="Drop the export here (.json or .zip)"
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

        {selectedType === 'markdown-file' && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Markdown file</span>
            <FileDropZone
              file={singleImportFile}
              accept=".md"
              onSelect={setSingleImportFile}
              onClear={() => setSingleImportFile(null)}
              placeholder="Drop your .md file here"
              disabled={isPending}
            />
            {!workspaceUuid && (
              <div className="import-unified__error">
                <AlertIcon size="sm" />
                Open a workspace before importing files.
              </div>
            )}
          </div>
        )}

        {!isBuiltInImportType(selectedType) && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Import file</span>
            <FileDropZone
              file={pluginFile}
              accept={
                pluginImporters
                  .find((imp) => imp.id === selectedType)
                  ?.file_extensions?.map((ext) => `.${ext}`)
                  .join(',') ?? '*'
              }
              onSelect={setPluginFile}
              onClear={() => setPluginFile(null)}
              placeholder="Drop the file to import"
              disabled={isPending}
            />
          </div>
        )}

        {/* -- 3. Submit error ------------------------------------------- */}
        {submitError && (
          <div className="import-unified__error">
            <AlertIcon size="sm" />
            {submitError}
          </div>
        )}

        {directImportError && (
          <div className="import-unified__error">
            <AlertIcon size="sm" />
            {directImportError}
          </div>
        )}
      </div>
    </Modal>
  );
}
