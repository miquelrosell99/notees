/**
 * ImportOptionsModal — the unified import hub (the v1 register ported 1:1
 * per spec §2, plus the new Logseq DB source): one form phase with the
 * workspace-name field (workspace-creating sources only, client-side
 * availability check via listWorkspaces), the source radio group in v1
 * order, a per-source input (FileDropZone / hints / folder picker), a
 * progress overlay (spinner + phase label; the Logseq DB run rides the
 * fleet Progress bar), and a per-source report phase with collapsible
 * failure/warning lists. Full state reset on open and on source change;
 * Enter submits (capture phase, never from TEXTAREA, Shift, or composing).
 *
 * Chrome composes ONLY fleet primitives; the per-source semantics live in
 * the flow modules (flows/*), this modal owns routing, phase, and chrome.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import {
  buildLogseqDbModel,
  countMdBlocks,
  decodeKvs,
  type LogseqDbModel,
} from "@notees/export";

import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import { Radio, RadioGroup } from "../../components/ui/fleet/Radio.js";
import { FileDropZone } from "../../components/ui/fleet/FileDropZone.js";
import { Spinner } from "../../components/ui/fleet/Spinner.js";
import { Progress } from "../../components/ui/fleet/Progress.js";
import { listWorkspaces, createWorkspace } from "@/core/auth-api.js";
import type { AnyClient } from "../collection/types.js";
import { importMarkdownFile, type MarkdownFileReport } from "./flows/markdown-file.js";
import {
  importLogseqFolder,
  parseLogseqFolderFiles,
  type LogseqFolderParsed,
  type LogseqFolderReport,
} from "./flows/logseq-folder.js";
import {
  planLogseqDbImport,
  runLogseqDbImport,
  type LogseqDbPlan,
  type LogseqDbReport,
} from "./flows/logseq-db.js";
import { importNoteesDump, type NoteesDumpResult } from "./flows/notees-dump.js";
import { importMarkdownWorkspace } from "./flows/markdown-workspace.js";
import "./ImportOptionsModal.css";

export type ImportSourceId =
  | "json"
  | "markdown"
  | "markdown-file"
  | "logseq-folder"
  | "logseq-db";

const SOURCE_OPTIONS: Array<{
  value: ImportSourceId;
  label: string;
  description: string;
  badge: "file" | "folder";
}> = [
  { value: "json", label: "Notees Dump", description: "Restore from a workspace export file", badge: "file" },
  { value: "markdown", label: "Markdown", description: "Import .md files from Logseq or Obsidian", badge: "file" },
  {
    value: "markdown-file",
    label: "Markdown file",
    description: "Import a single Markdown file into the current workspace",
    badge: "file",
  },
  {
    value: "logseq-folder",
    label: "Logseq folder",
    description: "Import a Logseq Markdown folder into the current workspace",
    badge: "folder",
  },
  {
    value: "logseq-db",
    label: "Logseq DB",
    description: "Import a Logseq .sqlite database into the current workspace",
    badge: "file",
  },
];

export interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: AnyClient;
  /** The sync server coordinates (null = offline — server sources fail loud). */
  serverUrl: string | null;
  credential: string;
  /** Switch the app to a freshly created/imported workspace (json/markdown). */
  onOpenWorkspace: (workspaceId: string, name: string) => void;
  /** Preselect a source (the request queue's deep-link). */
  initialSource?: ImportSourceId | undefined;
}

type ReportView =
  | { kind: "markdown-file"; report: MarkdownFileReport }
  | { kind: "logseq-folder"; report: LogseqFolderReport }
  | { kind: "logseq-db"; report: LogseqDbReport };

interface FolderState {
  parsed: LogseqFolderParsed;
  totalBlocks: number;
}

/** File → bytes, with a FileReader fallback for jsdom (whose Blob lacks arrayBuffer). */
async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function fileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Decode the picked .sqlite export in-browser (sql.js) into the model. */
export async function decodeLogseqDbFile(bytes: Uint8Array): Promise<LogseqDbModel> {
  // The wasm locateFile matters in the browser (a bare initSqlJs 404s the
  // wasm bundle outside vitest) — the sibling flows' exact pattern.
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  let db: InstanceType<typeof SQL.Database> | null = null;
  try {
    db = new SQL.Database(bytes);
    const result = db.exec("SELECT addr, content FROM kvs")[0];
    const rows = (result?.values ?? []).map(([addr, content]) => ({
      addr: Number(addr),
      content:
        typeof content === "string" ? content : new TextDecoder().decode(content as Uint8Array),
    }));
    return buildLogseqDbModel(decodeKvs(rows));
  } finally {
    db?.close();
  }
}

/** Ask for .md files through a hidden input (the markdown-workspace pick step). */
function pickMdFiles(input: HTMLInputElement | null): Promise<File[] | null> {
  if (input === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onChange = (): void => {
      cleanup();
      resolve(input.files !== null && input.files.length > 0 ? [...input.files] : null);
    };
    const onCancel = (): void => {
      cleanup();
      resolve(null);
    };
    const cleanup = (): void => {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    input.click();
  });
}

export function ImportOptionsModal({
  isOpen,
  onClose,
  client,
  serverUrl,
  credential,
  onOpenWorkspace,
  initialSource,
}: ImportOptionsModalProps) {
  const [source, setSource] = useState<ImportSourceId>("json");
  const [name, setName] = useState("");
  const [workspaces, setWorkspaces] = useState<Array<{ name: string | null }> | null>(null);
  const [dumpFile, setDumpFile] = useState<File | null>(null);
  const [mdFile, setMdFile] = useState<File | null>(null);
  const [sqliteFile, setSqliteFile] = useState<File | null>(null);
  const [folder, setFolder] = useState<FolderState | null>(null);
  const [dbModel, setDbModel] = useState<LogseqDbModel | null>(null);
  const [dbPlan, setDbPlan] = useState<LogseqDbPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [dbProgress, setDbProgress] = useState<{ completed: number; total: number } | null>(null);
  const [report, setReport] = useState<ReportView | null>(null);
  const [workspaceResult, setWorkspaceResult] = useState<NoteesDumpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState(0);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const mdPickerRef = useRef<HTMLInputElement | null>(null);

  const resetForm = useCallback(() => {
    setName("");
    setDumpFile(null);
    setMdFile(null);
    setSqliteFile(null);
    setFolder(null);
    setDbModel(null);
    setDbPlan(null);
    setBusy(false);
    setProgressLabel("");
    setDbProgress(null);
    setReport(null);
    setWorkspaceResult(null);
    setError(null);
    if (folderInputRef.current) folderInputRef.current.value = "";
  }, []);

  // Full state reset each open (v1 behavior) + the availability list.
  useEffect(() => {
    if (!isOpen) return;
    resetForm();
    setSource(initialSource ?? "json");
    setOpenCount((count) => count + 1);
  }, [isOpen, initialSource, resetForm]);

  useEffect(() => {
    if (!isOpen || serverUrl === null) return;
    let cancelled = false;
    listWorkspaces(serverUrl, credential)
      .then(({ workspaces: list }) => {
        if (!cancelled) setWorkspaces(list);
      })
      .catch(() => {
        // The server didn't answer — the availability check stays unknown
        // and the import itself will surface the server's error.
        if (!cancelled) setWorkspaces(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, openCount, serverUrl, credential]);

  // Source change resets the parsed/selected state (v1 behavior).
  useEffect(() => {
    setDumpFile(null);
    setMdFile(null);
    setSqliteFile(null);
    setFolder(null);
    setDbModel(null);
    setDbPlan(null);
    setReport(null);
    setError(null);
    if (folderInputRef.current) folderInputRef.current.value = "";
  }, [source]);

  useEffect(() => {
    if (!isOpen) return;
    if (source === "json" || source === "markdown") nameInputRef.current?.focus();
  }, [isOpen, source]);

  const nameTrimmed = name.trim();
  const nameTaken =
    workspaces !== null &&
    nameTrimmed.length >= 2 &&
    workspaces.some((ws) => (ws.name ?? "").trim().toLowerCase() === nameTrimmed.toLowerCase());
  const nameValid = nameTrimmed.length >= 2 && !nameTaken;

  const requiresServer = source === "json" || source === "markdown";
  const serverMissing = requiresServer && serverUrl === null;

  const submitEnabled = (() => {
    if (busy) return false;
    if (serverMissing) return false;
    if (source === "json") return nameValid && dumpFile !== null;
    if (source === "markdown") return nameValid;
    if (source === "markdown-file") return mdFile !== null;
    if (source === "logseq-folder") return folder !== null;
    if (source === "logseq-db") return dbPlan !== null;
    return false;
  })();

  // --- the per-source runs ---------------------------------------------------

  const runJson = async (): Promise<void> => {
    if (serverUrl === null || dumpFile === null) return;
    setProgressLabel("Importing workspace");
    setBusy(true);
    try {
      const bytes = await fileBytes(dumpFile);
      const result = await importNoteesDump({
        serverUrl,
        credential,
        name: nameTrimmed,
        fileName: dumpFile.name,
        bytes,
      });
      setWorkspaceResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runMarkdown = async (): Promise<void> => {
    if (serverUrl === null) return;
    setProgressLabel("Creating workspace");
    setBusy(true);
    try {
      // v1: the workspace is created first, then the .md panel picks files.
      // The pick rides the same hidden-input idiom; cancel still lands the
      // user in the fresh (empty) workspace — the v1 panel equivalent.
      const { id: workspaceId } = await createWorkspace(serverUrl, credential, nameTrimmed);
      setProgressLabel("Importing file");
      const files = await pickMdFiles(mdPickerRef.current);
      if (files !== null) {
        const contents = await Promise.all(
          files.map(async (file) => ({ name: file.name, content: await fileText(file) })),
        );
        const result = await importMarkdownWorkspace({
          serverUrl,
          credential,
          name: nameTrimmed,
          workspaceId,
          files: contents,
          onStatus: setProgressLabel,
        });
        if (result.failures.length > 0) {
          console.warn("[import] markdown workspace failures:", result.failures);
        }
      }
      onOpenWorkspace(workspaceId, nameTrimmed);
      handleClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runMarkdownFile = async (): Promise<void> => {
    if (mdFile === null) return;
    setProgressLabel("Importing file");
    setBusy(true);
    try {
      const content = await fileText(mdFile);
      const result = await importMarkdownFile(client, { content });
      setReport({ kind: "markdown-file", report: result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runLogseqFolder = async (): Promise<void> => {
    if (folder === null) return;
    setProgressLabel("Importing folder");
    setBusy(true);
    try {
      const result = await importLogseqFolder(client, folder.parsed, {
        onProgress: (p) => setProgressLabel(p.message),
      });
      setReport({ kind: "logseq-folder", report: result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runLogseqDb = async (): Promise<void> => {
    if (dbModel === null) return;
    setProgressLabel("Importing Logseq DB");
    setBusy(true);
    setDbProgress({ completed: 0, total: dbModel.nodes.length });
    try {
      const result = await runLogseqDbImport(dbModel, client, {
        onProgress: (completed, total) => setDbProgress({ completed, total }),
      });
      setReport({ kind: "logseq-db", report: result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setDbProgress(null);
    }
  };

  const handleSubmit = useCallback((): void => {
    if (!submitEnabled) return;
    setError(null);
    if (source === "json") void runJson();
    else if (source === "markdown") void runMarkdown();
    else if (source === "markdown-file") void runMarkdownFile();
    else if (source === "logseq-folder") void runLogseqFolder();
    else if (source === "logseq-db") void runLogseqDb();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submitEnabled gates the snapshot.
  }, [submitEnabled, source, nameTrimmed, dumpFile, mdFile, folder, dbModel, dbPlan, client, serverUrl, credential]);

  // Enter anywhere inside the modal = submit (capture phase; v1 semantics).
  useEffect(() => {
    if (!isOpen || report !== null || workspaceResult !== null) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const tag = (event.target as HTMLElement).tagName;
      if (tag === "TEXTAREA") return;
      const target = event.target as HTMLElement;
      if (!target.closest(".import-unified")) return;
      event.preventDefault();
      event.stopPropagation();
      handleSubmit();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [isOpen, report, workspaceResult, handleSubmit]);

  const handleClose = (): void => {
    resetForm();
    onClose();
  };

  const openImportedWorkspace = useCallback(
    (result: NoteesDumpResult): void => {
      onOpenWorkspace(result.workspaceId, result.name);
      handleClose();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose only resets form state.
    [onOpenWorkspace],
  );

  // The json flow ends by SWITCHING to the imported workspace (v1 onSuccess).
  // When the restore has something to surface (bundled assets not restored,
  // values that failed validation), a summary phase shows the counts first;
  // a clean restore switches straight away.
  const dumpHasNotes =
    workspaceResult !== null &&
    (workspaceResult.assetCount > 0 || workspaceResult.skippedValues.length > 0);
  useEffect(() => {
    if (workspaceResult !== null && !dumpHasNotes) {
      openImportedWorkspace(workspaceResult);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per result.
  }, [workspaceResult]);

  const handleDumpFile = (picked: File): void => {
    setDumpFile(picked);
    setError(null);
  };

  const handleMdFile = (picked: File): void => {
    setMdFile(picked);
    setError(null);
  };

  const handleSqliteFile = async (picked: File): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const bytes = await fileBytes(picked);
      const model = await decodeLogseqDbFile(bytes);
      setSqliteFile(picked);
      setDbModel(model);
      setDbPlan(planLogseqDbImport(model, client));
    } catch (cause) {
      setSqliteFile(null);
      setDbModel(null);
      setDbPlan(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleFolderChange = async (list: FileList | null): Promise<void> => {
    setError(null);
    setFolder(null);
    if (list === null || list.length === 0) return;
    setBusy(true);
    try {
      const parsed = await parseLogseqFolderFiles([...list]);
      const allPages = [...parsed.pages, ...parsed.journals];
      setFolder({
        parsed,
        totalBlocks: allPages.reduce((sum, p) => sum + countMdBlocks(p.blocks), 0),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const importLabel =
    source === "logseq-db" && dbPlan !== null
      ? `Import ${dbPlan.counts.create + dbPlan.counts.fill} changes`
      : "Import";

  // --- report phase ------------------------------------------------------------

  if (report !== null) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={handleClose}
        title="Import Complete"
        size="md"
        className="import-unified"
        footer={
          <Button variant="primary" onClick={handleClose}>
            Done
          </Button>
        }
      >
        <ReportBody view={report} />
      </Modal>
    );
  }

  // --- dump restore summary (assets not restored / values skipped) ----------

  if (workspaceResult !== null && dumpHasNotes) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={() => openImportedWorkspace(workspaceResult)}
        title="Import Complete"
        size="md"
        className="import-unified"
        footer={
          <Button variant="primary" onClick={() => openImportedWorkspace(workspaceResult)}>
            Open workspace
          </Button>
        }
      >
        <div className="import-unified__report">
          <p className="import-unified__report-success">
            Restored <strong>{workspaceResult.nodeCount}</strong> nodes into &ldquo;
            {workspaceResult.name}&rdquo;.
          </p>
          <ul className="import-unified__report-list">
            {workspaceResult.assetCount > 0 && (
              <li>
                <span>Assets bundled (not restored)</span>
                <span>{workspaceResult.assetCount}</span>
              </li>
            )}
            {workspaceResult.skippedValues.length > 0 && (
              <li>
                <span>Values skipped</span>
                <span>{workspaceResult.skippedValues.length}</span>
              </li>
            )}
          </ul>
          {workspaceResult.assetCount > 0 && (
            <p className="import-unified__hint">
              The dump bundles asset files, but a snapshot restore carries the node projection
              only — re-upload assets into the restored workspace if you need them.
            </p>
          )}
          {workspaceResult.skippedValues.length > 0 && (
            <details className="import-unified__details">
              <summary className="import-unified__details-summary">
                Skipped values ({workspaceResult.skippedValues.length})
              </summary>
              <ul className="import-unified__details-list">
                {workspaceResult.skippedValues.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Modal>
    );
  }

  // --- progress overlay ----------------------------------------------------------

  if (busy) {
    return (
      <Modal isOpen={isOpen} onClose={() => {}} title="Import Workspace" size="md" className="import-unified">
        <div className="import-unified__progress">
          <Spinner size="lg" />
          {dbProgress !== null ? (
            <div className="import-unified__progress-bar">
              <Progress
                value={dbProgress.completed}
                max={Math.max(dbProgress.total, 1)}
                label={progressLabel}
              />
            </div>
          ) : (
            <p className="import-unified__progress-label">{progressLabel}</p>
          )}
        </div>
      </Modal>
    );
  }

  // --- form phase ------------------------------------------------------------------

  const allFolderPages = folder !== null ? [...folder.parsed.pages, ...folder.parsed.journals] : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import Workspace"
      size="md"
      className="import-unified"
      footer={
        <div className="import-unified__footer">
          {(source === "json" || source === "markdown") && (
            <div className="import-unified__footer-name">
              <TextField
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-notes"
                disabled={busy}
                error={nameTaken}
                {...(nameTaken ? { errorMessage: "This name is already taken" } : {})}
                aria-label="Workspace name"
              />
            </div>
          )}
          <div className="import-unified__footer-actions">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit} disabled={!submitEnabled}>
              {importLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className="import-unified__body">
        <div className="import-unified__field-group">
          <span className="import-unified__section-label">Source</span>
          <RadioGroup
            value={source}
            onValueChange={(value) => setSource(value as ImportSourceId)}
            className="import-unified__radios"
            aria-label="Import source"
          >
            {SOURCE_OPTIONS.map((option) => (
              <Radio
                key={option.value}
                value={option.value}
                disabled={busy}
                label={
                  <span className="import-unified__radio-text">
                    <span className="import-unified__radio-title">{option.label}</span>
                    <span className="import-unified__radio-desc">{option.description}</span>
                  </span>
                }
              />
            ))}
          </RadioGroup>
        </div>

        {source === "json" && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Notees export file</span>
            <FileDropZone
              file={dumpFile}
              accept=".json,.zip"
              onSelect={handleDumpFile}
              onClear={() => setDumpFile(null)}
              placeholder="Drop the export here (.json or .zip)"
              disabled={busy}
            />
          </div>
        )}

        {source === "markdown" && (
          <div className="import-unified__field-group">
            <p className="import-unified__hint">
              A workspace will be created and an import panel will open where you can select your
              Markdown files.
            </p>
            {/* The post-create multi-file pick rides this hidden input (v1's
                import panel, collapsed into the flow). */}
            <input
              ref={mdPickerRef}
              type="file"
              accept=".md"
              multiple
              className="import-unified__file-input"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        )}

        {source === "markdown-file" && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Markdown file</span>
            <FileDropZone
              file={mdFile}
              accept=".md"
              onSelect={handleMdFile}
              onClear={() => setMdFile(null)}
              placeholder="Drop your .md file here"
              disabled={busy}
            />
          </div>
        )}

        {source === "logseq-folder" && (
          <div className="import-unified__field-group">
            <p className="import-unified__hint">
              Opens a folder picker for the Logseq graph containing <code>pages/</code>,{" "}
              <code>journals/</code>, and <code>assets/</code>. Import runs directly into the
              current workspace.
            </p>
            <input
              ref={folderInputRef}
              type="file"
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              className="import-unified__file-input"
              onChange={(event) => void handleFolderChange(event.target.files)}
              disabled={busy}
              data-testid="import-folder-input"
            />
            {folder !== null && (
              <div className="import-unified__summary">
                <div className="import-unified__badges">
                  <span className="import-unified__badge">
                    {allFolderPages.length} page{allFolderPages.length !== 1 ? "s" : ""}
                  </span>
                  <span className="import-unified__badge">
                    {folder.totalBlocks} block{folder.totalBlocks !== 1 ? "s" : ""}
                  </span>
                  {folder.parsed.assetFiles.size > 0 && (
                    <span className="import-unified__badge">
                      {folder.parsed.assetFiles.size} asset
                      {folder.parsed.assetFiles.size !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <ul className="import-unified__page-list">
                  {allFolderPages.slice(0, 12).map((page, index) => (
                    <li key={index} className="import-unified__page-item">
                      {page.title}
                      <span className="import-unified__page-blocks">
                        {countMdBlocks(page.blocks)} blocks
                      </span>
                    </li>
                  ))}
                  {allFolderPages.length > 12 && (
                    <li className="import-unified__page-item import-unified__page-item--more">
                      …and {allFolderPages.length - 12} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}

        {source === "logseq-db" && (
          <div className="import-unified__field-group">
            <span className="import-unified__section-label">Logseq database</span>
            <FileDropZone
              file={sqliteFile}
              accept=".sqlite"
              onSelect={(picked) => void handleSqliteFile(picked)}
              onClear={() => {
                setSqliteFile(null);
                setDbModel(null);
                setDbPlan(null);
              }}
              placeholder="Drop the .sqlite export here"
              disabled={busy}
            />
            {dbPlan !== null && dbModel !== null && (
              <LogseqDbPreview model={dbModel} plan={dbPlan} />
            )}
          </div>
        )}

        {serverMissing && (
          <p className="import-unified__error" role="alert">
            This source needs the sync server — connect a server before importing.
          </p>
        )}
        {error !== null && (
          <p className="import-unified__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The Logseq DB dry-run preview (default state — writes need the confirm). */
function LogseqDbPreview({ model, plan }: { model: LogseqDbModel; plan: LogseqDbPlan }) {
  const changes = plan.counts.create + plan.counts.fill;
  return (
    <div className="import-unified__db-preview" data-testid="import-db-preview">
      <p className="import-unified__hint">
        <strong>{changes}</strong> change{changes === 1 ? "" : "s"} to write:{" "}
        <strong>{plan.counts.create}</strong> new node{plan.counts.create === 1 ? "" : "s"},{" "}
        <strong>{plan.counts.fill}</strong> existing node{plan.counts.fill === 1 ? "" : "s"} filled
        (missing values only), <strong>{plan.counts.skip}</strong> unchanged.
      </p>
      <p className="import-unified__hint">
        Skipped entities: {model.skipped.views} view{model.skipped.views === 1 ? "" : "s"},{" "}
        {model.skipped.system} system, {model.skipped.assets} asset
        {model.skipped.assets === 1 ? "" : "s"} (metadata only — not imported),{" "}
        {model.skipped.closedValues} closed value
        {model.skipped.closedValues === 1 ? "" : "s"} (select-option vocabulary).
      </p>
      {plan.unmappedClasses.length > 0 && (
        <p className="import-unified__hint">
          Unmapped classes (members import unclassed): {plan.unmappedClasses.join(", ")}.
        </p>
      )}
      {plan.unmappedProperties.length > 0 && (
        <p className="import-unified__hint">
          Unmapped properties (values not written): {plan.unmappedProperties.join(", ")}.
        </p>
      )}
      {(plan.samples.create.length > 0 || plan.samples.fill.length > 0) && (
        <details className="import-unified__details">
          <summary className="import-unified__details-summary">Samples</summary>
          <ul className="import-unified__details-list">
            {plan.samples.create.map((title) => (
              <li key={`c:${title}`}>Create: {title}</li>
            ))}
            {plan.samples.fill.map((title) => (
              <li key={`f:${title}`}>Fill: {title}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The per-source report body (rows + collapsible failure/warning lists). */
function ReportBody({ view }: { view: ReportView }) {
  if (view.kind === "markdown-file") {
    const { created, existing, warnings } = view.report;
    const total = created.length + existing.length;
    return (
      <div className="import-unified__report">
        <p className="import-unified__report-success">
          Imported {total} item{total !== 1 ? "s" : ""}.
        </p>
        <ul className="import-unified__report-list">
          <li>
            <span>Created</span>
            <span>{created.length}</span>
          </li>
          {existing.length > 0 && (
            <li>
              <span>Existing</span>
              <span>{existing.length}</span>
            </li>
          )}
        </ul>
        {created.length > 0 && (
          <details className="import-unified__details">
            <summary className="import-unified__details-summary">Imported nodes</summary>
            <ul className="import-unified__details-list">
              {created.map((entry) => (
                <li key={entry.id}>{entry.title}</li>
              ))}
            </ul>
          </details>
        )}
        {warnings.length > 0 && (
          <details className="import-unified__details">
            <summary className="import-unified__details-summary">Warnings ({warnings.length})</summary>
            <ul className="import-unified__details-list">
              {warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  if (view.kind === "logseq-folder") {
    const report = view.report;
    return (
      <div className="import-unified__report">
        <p className="import-unified__report-success">
          Imported {report.pagesCreated} page{report.pagesCreated !== 1 ? "s" : ""} and{" "}
          {report.blocksCreated} block{report.blocksCreated !== 1 ? "s" : ""}.
        </p>
        <ul className="import-unified__report-list">
          <li>
            <span>Pages</span>
            <span>{report.pagesCreated}</span>
          </li>
          <li>
            <span>Blocks</span>
            <span>{report.blocksCreated}</span>
          </li>
          <li>
            <span>Wiki-links</span>
            <span>{report.linksCreated}</span>
          </li>
          <li>
            <span>Assets uploaded</span>
            <span>{report.assetsUploaded}</span>
          </li>
        </ul>
        {report.errors.length > 0 && (
          <details className="import-unified__details" open={report.errors.length > 0}>
            <summary className="import-unified__details-summary">Warnings ({report.errors.length})</summary>
            <ul className="import-unified__details-list">
              {report.errors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  const report = view.report;
  return (
    <div className="import-unified__report">
      <ul className="import-unified__report-list">
        <li>
          <span>Created</span>
          <span>{report.created}</span>
        </li>
        <li>
          <span>Filled</span>
          <span>{report.filled}</span>
        </li>
        <li>
          <span>Skipped</span>
          <span>{report.skipped}</span>
        </li>
        {report.failed > 0 && (
          <li>
            <span>Failed</span>
            <span>{report.failed}</span>
          </li>
        )}
      </ul>
      <p className="import-unified__hint">
        Skipped entities: {report.skippedEntities.views} views, {report.skippedEntities.system}{" "}
        system, {report.skippedEntities.assets} assets, {report.skippedEntities.closedValues} closed
        values.
      </p>
      {(report.unmappedClasses.length > 0 || report.unmappedProperties.length > 0) && (
        <details className="import-unified__details">
          <summary className="import-unified__details-summary">Unmapped</summary>
          <ul className="import-unified__details-list">
            {report.unmappedClasses.map((entry) => (
              <li key={`c:${entry}`}>Class: {entry}</li>
            ))}
            {report.unmappedProperties.map((entry) => (
              <li key={`p:${entry}`}>Property: {entry}</li>
            ))}
          </ul>
        </details>
      )}
      {(report.missingParents.length > 0 || report.missingRefs.length > 0) && (
        <details className="import-unified__details">
          <summary className="import-unified__details-summary">Unresolved references</summary>
          <ul className="import-unified__details-list">
            {report.missingParents.map((entry) => (
              <li key={`mp:${entry}`}>Parent missing — created at root: {entry}</li>
            ))}
            {report.missingRefs.map((entry) => (
              <li key={`mr:${entry}`}>Ref target missing: {entry}</li>
            ))}
          </ul>
        </details>
      )}
      {report.failures.length > 0 && (
        <details className="import-unified__details" open>
          <summary className="import-unified__details-summary">Failures ({report.failures.length})</summary>
          <ul className="import-unified__details-list">
            {report.failures.map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
