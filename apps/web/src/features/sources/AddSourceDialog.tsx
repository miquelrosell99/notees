/**
 * AddSourceDialog — the add-source flow's small dialog (* source-library slice 3 task 6): ONE input accepting a DOI, ISBN, arXiv
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
 * The dialog composes the fleet Modal's footer + the fleet FileDropZone
 * exactly as the other first-class dialogs (QuickCreateModal,
 * AssetUploadModal): the actions ride the Modal footer slot, the PDF pick
 * rides the drop zone with the AssetUploadModal selected-file row (the
 * document icon + name + category chip + size). The bare native file input
 * ("Examinar") retired with this composition pass.
 *
 * The dialog's second step IS the QuickCreateModal (sourcePrefill), so the
 * duplicate-DOI warning, the archived-class auto-enable (un-archive + create
 * in ONE undo batch), and the auto-citekey all live in the one place.
 */

import { useEffect, useId, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { AnyClient } from "../modals/quickCreate.js";
import { readSourceSettings } from "../modals/quickCreate.js";
import { QuickCreateModal, type SourcePrefill } from "../modals/QuickCreateModal.js";
import { CATEGORY_LABELS, categoryOf, formatSize } from "../modals/AssetUploadModal.js";
import { Modal } from "../../components/ui/fleet/Modal.js";
import { Button } from "../../components/ui/fleet/Button.js";
import { TextField } from "../../components/ui/fleet/TextField.js";
import { FileDropZone } from "../../components/ui/fleet/FileDropZone.js";
import { Icon } from "../../ui/Icon.js";
import {
  ResolverRequestError,
  resolvePdfFile,
  classifySourceInput,
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
  // The record's own type picks the prefill class (the resolver knows the
  // work's type better than any caller guess).
  const classId =
    SYSTEM_CLASS_UUIDS[record.classKey as keyof typeof SYSTEM_CLASS_UUIDS] ??
    SYSTEM_CLASS_UUIDS.book;
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
  /** The "PDF file" section label's id — the drop zone's aria-labelledby. */
  const pdfLabelId = useId();

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
    // The local short-circuit: no fetch when the resolver is off — the
    // honest error + the manual path (the Add button stays enabled).
    if (!resolverEnabled) {
      setError(
        "The metadata resolver is turned off. Enable it in Workspace settings → Features → Sources, or add the source manually.",
      );
      setBusy(false);
      return;
    }
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

  // The manual path: a failed (or resolver-off) Add never dead-ends — the
  // error region offers "Add manually", landing in the same citation form
  // with a best-effort prefill from what was typed or picked.
  const manualPrefillOf = (raw: string, picked: File | null): SourcePrefill => {
    const base: SourcePrefill = {
      classId: SYSTEM_CLASS_UUIDS.book,
      title: "",
      authorsText: "",
      fields: {},
      ...(picked !== null ? { pdf: { file: picked, filename: picked.name } } : {}),
    };
    const classified = classifySourceInput(raw);
    if (classified === null) {
      return { ...base, title: raw.trim() };
    }
    switch (classified.kind) {
      case "doi":
        return { ...base, doi: classified.value };
      case "isbn":
        return { ...base, isbn: classified.value };
      case "arxiv":
        return { ...base, url: `https://arxiv.org/abs/${classified.value}` };
      case "url":
        // The weblink convention: the URL is the title.
        return { ...base, classId: SYSTEM_CLASS_UUIDS.web_page, title: raw.trim(), url: classified.url };
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add source"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void resolve()}
            disabled={busy || (input.trim() === "" && file === null)}
            loading={busy}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="add-source-dialog">
        <p className="add-source-dialog__hint">
          Paste a DOI, ISBN, arXiv id or URL, a PDF link, or drop a PDF file — the
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
          <span id={pdfLabelId} className="add-source-dialog__section-label">PDF file</span>
          <FileDropZone
            file={file}
            accept="application/pdf,.pdf"
            labelledBy={pdfLabelId}
            onSelect={(picked) => {
              setFile(picked);
              setError(null);
              // The file wins over the text input for one resolve gesture.
              setInput("");
            }}
            onClear={() => setFile(null)}
            placeholder="Drop a PDF here"
            hint="or click to browse"
            icon={<Icon path="mdi-cloud-upload-outline" size={1.6} />}
            disabled={busy}
          />
          {file !== null && (
            <div className="add-source-dialog__preview">
              <span className="add-source-dialog__doc-icon" aria-hidden="true">
                <Icon path="mdi-file-outline" size={1.6} />
              </span>
              <span className="add-source-dialog__meta">
                <span className="add-source-dialog__name">{file.name}</span>
                <span className="add-source-dialog__sub">
                  <span className="add-source-dialog__chip">
                    {CATEGORY_LABELS[categoryOf(file)]}
                  </span>
                  {formatSize(file.size)}
                </span>
              </span>
            </div>
          )}
        </div>
        {!resolverEnabled && (
          <p className="add-source-dialog__note" role="status">
            The metadata resolver is turned off in Workspace settings → Features → Sources —
            Add still works, offering the manual form.
          </p>
        )}
        {error !== null && (
          <div className="add-source-dialog__error-row">
            <p role="alert" className="add-source-dialog__error">
              {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (input.trim() === "" && file === null)}
              onClick={() => setPrefilled({ prefill: manualPrefillOf(input, file) })}
            >
              Add manually
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
