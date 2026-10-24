/**
 * AddSourceDialog — the add-source flow's small dialog (owner ruling,
 * source-library slice 3 task 6): ONE input accepting a DOI, ISBN, arXiv
 * id/URL, plain URL, or a PDF file. On resolve success the QuickCreateModal
 * opens PREFILLED from the unified record (class from classKey, title,
 * authors/editors as monoblock text, the class's venue fields, year, DOI,
 * ISBN, URL, publisher) — one create completes the gesture. On failure the
 * error is inline and honest: nothing half-creates (the create only ever
 * runs on a fully resolved record), a 403 resolver_disabled points at the
 * Sources settings, a 422 no_identifier_found says the PDF carried no DOI.
 *
 * Routing by input shape (features/sources/resolver.ts): doi/isbn/arxiv →
 * GET /api/resolve; a plain URL → POST /api/resolve/pdf?url= (the owner's
 * PDF flow — the bytes stay server-side; the record's pdf:{url} becomes the
 * source's URL, never a CAS upload); a picked file → POST /api/resolve/pdf
 * multipart, and THAT file uploads to CAS + links on the created source
 * (the caller holds the bytes — the attach is real).
 *
 * The dialog's second step IS the QuickCreateModal (sourcePrefill), so the
 * duplicate-DOI warning, the archived-class auto-enable (un-archive + create
 * in ONE undo batch), and the auto-citekey all live in the one place.
 */

import { useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../modals/quickCreate.js";
import { readSourceSettings } from "../modals/quickCreate.js";
import { QuickCreateModal, type SourcePrefill } from "../modals/QuickCreateModal.js";
import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import {
  ResolverRequestError,
  resolvePdfFile,
  resolveSourceInput,
  type ResolvedSourceRecord,
} from "./resolver.js";
import "./AddSourceDialog.css";

export interface AddSourceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the prefilled create composes through. */
  client: AnyClient;
  /** The sync server coordinates (the resolver routes' credential). */
  serverUrl: string;
  credential: string;
  /** A pasted identifier/link the caller already holds (the picker's
   *  paste-URL row opens the dialog with its query prefilled). */
  initialInput?: string | undefined;
  /** Called with the new source id once created (the app opens the page). */
  onCreated?: ((nodeId: string) => void) | undefined;
  /** Opens the duplicate warning's existing source (the app page-open). */
  onOpenNode?: ((nodeId: string) => void) | undefined;
}

interface PrefilledState {
  prefill: SourcePrefill;
}

/** Map the unified record onto the modal's prefill (the pdf intent halves). */
function prefillOf(record: ResolvedSourceRecord, pdfFile: File | null): SourcePrefill {
  const classId =
    SYSTEM_CLASS_UUIDS[record.classKey as keyof typeof SYSTEM_CLASS_UUIDS] ?? SYSTEM_CLASS_UUIDS.book;
  return {
    classId,
    title: record.title,
    authorsText: record.authors.join("; "),
    editorsText: record.editors.length > 0 ? record.editors.join("; ") : "",
    year: record.year !== undefined ? String(record.year) : "",
    doi: record.doi ?? "",
    isbn: record.isbn ?? "",
    // The URL-mode PDF's direct link is the honest full-text URL — it wins
    // over the provider's landing page (the user pasted the PDF link).
    url: record.pdf?.url ?? record.url ?? "",
    publisher: record.publisher ?? "",
    fields: record.fields,
    pdf: pdfFile !== null ? { file: pdfFile, filename: pdfFile.name } : null,
  };
}

export function AddSourceDialog({
  isOpen,
  onClose,
  client,
  serverUrl,
  credential,
  initialInput = "",
  onCreated = undefined,
  onOpenNode = undefined,
}: AddSourceDialogProps) {
  const [input, setInput] = useState(initialInput);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState<PrefilledState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset each open; the picker's paste carries its query in.
  useEffect(() => {
    if (!isOpen) return;
    setInput(initialInput);
    setFile(null);
    setBusy(false);
    setError(null);
    setPrefilled(null);
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, initialInput]);

  const resolverEnabled = readSourceSettings(client).resolverEnabled;

  const resolve = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (file !== null) {
        const record = await resolvePdfFile(serverUrl, credential, file, file.name);
        setPrefilled({ prefill: prefillOf(record, file) });
      } else {
        const record = await resolveSourceInput(serverUrl, credential, input);
        setPrefilled({ prefill: prefillOf(record, null) });
      }
    } catch (caught) {
      if (caught instanceof ResolverRequestError && caught.code === "resolver_disabled") {
        setError(
          "The metadata resolver is turned off. Enable it in Workspace settings → Features → Sources.",
        );
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  // The second step is the prefilled QuickCreateModal (same dialog stack:
  // close this shell first so the modal's overlay owns the surface).
  if (prefilled !== null) {
    return (
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={prefilled.prefill.classId}
        sourcePrefill={prefilled.prefill}
        onClose={onClose}
        onCreated={(nodeId) => {
          onClose();
          onCreated?.(nodeId);
        }}
        onOpenExisting={onOpenNode}
      />
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add source" size="sm">
      <div className="add-source-dialog">
        <p className="add-source-dialog__hint">
          Paste a DOI, ISBN, arXiv id or URL, a PDF link, or pick a PDF file — the
          metadata resolves and prefills the create form.
        </p>
        <div className="add-source-dialog__field">
          <TextField
            ref={inputRef}
            label="Identifier or link"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void resolve();
            }}
            placeholder="10.… / 978-… / arXiv:… / https://…"
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <div className="add-source-dialog__field">
          <label className="add-source-dialog__file">
            <span className="add-source-dialog__file-label">PDF file</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              aria-label="PDF file"
              disabled={busy}
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                setFile(picked);
                setError(null);
                // The file wins over the text input for one resolve gesture.
                if (picked !== null) setInput("");
              }}
            />
          </label>
          {file !== null && <span className="add-source-dialog__file-name">{file.name}</span>}
        </div>
        {!resolverEnabled && (
          <p className="add-source-dialog__note" role="status">
            The metadata resolver is turned off in Workspace settings → Features → Sources —
            resolving is disabled until you enable it.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="add-source-dialog__error">
            {error}
          </p>
        )}
        <div className="add-source-dialog__actions">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void resolve()}
            disabled={busy || (input.trim() === "" && file === null) || !resolverEnabled}
            loading={busy}
          >
            Resolve
          </Button>
        </div>
      </div>
    </Modal>
  );
}
