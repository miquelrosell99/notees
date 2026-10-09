/**
 * ExportPageModal — export one node or a batch of nodes
 * (modelling decision 3: the Capacities structure, composed from kit
 * primitives only).
 *
 * Format cards come from the web-side registry (registerExportFormats),
 * which delegates to @notees/export's package catalog: available formats
 * render as selectable cards, unavailable ones as disabled cards carrying
 * the registry's reason — never stub-message tabs. The collapsible Options
 * section renders the selected format's registry option specs as checkbox
 * rows (defaults from the package catalog), including the modal's own
 * "Include child pages" subtree toggle for markdown.
 *
 * The preview and the markdown export run through the local export engine
 * (exportSubtree): a single node downloads one concatenated Markdown file; a
 * batch collects every node's subtree bundle into ONE zip (slug filenames +
 * `notees-manifest.json`, the E5 server-zip conventions). The markdown
 * registry's "Include asset files" option (E7) scans the exported subtrees
 * for asset_ref tokens, fetches the bytes concurrency-limited, and switches
 * delivery to the same zip shape — single node included — with the refs
 * rewritten to relative `assets/` paths.
 *
 * Format routing (task W): the other available cards (html/latex/docx) no
 * longer download markdown bytes under a foreign extension — the Export
 * button dispatches on the selected card and delivers that format's own
 * bytes (single node) or one zip of per-root rendered files (batch). The
 * live preview is the engine's markdown projection, so it stays markdown-
 * only; the other text formats show a short static note instead.
 *
 * JSON archive: the registry's sixth card — a node-set format
 * (verbatim contentAst/classIds/properties/child ids/edges in the
 * versioned notees-json-archive envelope), delivered as ONE document for
 * the whole selection (batch included — no per-root zip).
 *
 * PDF: the card is web-available with `delivery: "client-pdf"` —
 * the package serializer stays a throwing skeleton while the web client
 * renders PDFs through the lazily imported ui/export-pdf engine (react-pdf,
 * the OFL Gentium bundle, and the layout themes live in that async chunk;
 * the modal only ever `await import()`s it, on the first PDF export or
 * preview). Selecting PDF reveals the layout cards (Notes/Essay/Academic,
 * modelling decision 2) and the A4/Letter page-size SelectionButton, both
 * feeding the engine options; the preview pane renders the PDF into a blob
 * URL iframe, and Export downloads `<slug>-<YYYYMMDDHHmm>.pdf` (a batch zips
 * one PDF per root, the task-W convention; the local timestamp keeps repeated
 * exports from overwriting each other).
 */
import { useState, useCallback, useEffect, useMemo } from "react";
import type { ExportOptions } from "@notees/export";

import { useCopiedState } from "./useCopiedState";
import { Modal } from "../ui/Modal.js";
import { copyToClipboard } from "./clipboard";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Checkbox } from "../ui/Checkbox.js";
import { SelectionButton } from "../ui/SelectionButton.js";
import { Spinner } from "../ui/Spinner.js";
import { Icon } from "../../Icon";
import { downloadBlob } from "./download";
import {
  exportSubtreeMarkdown,
  exportSubtreeBundle,
  exportSubtreeFile,
  exportSubtreeBatchFile,
  exportSubtreeJsonArchive,
  exportZipFileName,
  zipExportBundle,
  collectSubtreeAssetRefIds,
  fetchSubtreeAssets,
  type ExportClient,
} from "./exportSubtree";
import {
  availableExportFormats,
  defaultOptionValues,
  getExportFormat,
  getRegisteredExportFormats,
  INCLUDE_CHILD_PAGES_KEY,
  webSelectOption,
  type WebExportFormatDefinition,
  type WebExportFormatId,
} from "./registerExportFormats";
import "./ExportPageModal.css";

type PdfLayout = NonNullable<ExportOptions["layout"]>;
type PdfPageFormat = NonNullable<ExportOptions["pageFormat"]>;

/** Layout card icons (MDI, keyed by the registry's layout option values). */
const LAYOUT_ICONS: Record<PdfLayout, string> = {
  notes: "notebook-outline",
  essay: "text-long",
  academic: "school-outline",
};

export interface ExportPageModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the export reads from. */
  client: ExportClient;
  /** Single node UUID */
  nodeUuid?: string;
  /** Multiple node UUIDs for batch export */
  nodeUuids?: string[];
  /** Optional node name for the modal title */
  nodeName?: string;
  /** Optional node names for batch export */
  nodeNames?: string[];
}

/** The first available format — markdown today; the registry decides. */
function firstAvailableFormat(): WebExportFormatDefinition {
  const first = availableExportFormats()[0];
  if (first === undefined) {
    throw new Error("ExportPageModal: the export registry has no available format");
  }
  return first;
}

export function ExportPageModal({ isOpen, onClose, client, nodeUuid, nodeUuids, nodeName }: ExportPageModalProps) {
  const formats = useMemo(() => getRegisteredExportFormats(), []);
  const [formatId, setFormatId] = useState<WebExportFormatId>(() => firstAvailableFormat().id);
  const [optionValues, setOptionValues] = useState<Record<string, boolean>>(() =>
    defaultOptionValues(firstAvailableFormat()),
  );
  const [optionsOpen, setOptionsOpen] = useState(true);

  // PDF-only selects (P1) — defaults from the package catalog's select
  // specs (layout is also gated to docx/html/latex, but only PDF renders
  // the dedicated cards today).
  const layoutSpec = useMemo(() => webSelectOption("pdf", "layout"), []);
  const pageFormatSpec = useMemo(() => webSelectOption("pdf", "pageFormat"), []);
  const [layout, setLayout] = useState<PdfLayout>(
    () => (layoutSpec?.defaultValue as PdfLayout | undefined) ?? "notes",
  );
  const [pageFormat, setPageFormat] = useState<PdfPageFormat>(
    () => (pageFormatSpec?.defaultValue as PdfPageFormat | undefined) ?? "a4",
  );

  const [previewContent, setPreviewContent] = useState<string>("");
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, triggerCopy] = useCopiedState();
  const [exporting, setExporting] = useState(false);

  const effectiveNodeUuids = useMemo(() => {
    if (nodeUuids && nodeUuids.length > 0) return nodeUuids;
    if (nodeUuid) return [nodeUuid];
    return [];
  }, [nodeUuid, nodeUuids]);

  const isBatch = effectiveNodeUuids.length > 1;

  // formatId only ever holds a registry id (initialized from the registry,
  // set from clickable cards), but the registry is the authority.
  const format = getExportFormat(formatId);

  const includeChildPages = optionValues[INCLUDE_CHILD_PAGES_KEY] ?? true;
  const includeEmbedded = optionValues["includeEmbedded"] ?? false;
  const hideEmptyProperties = optionValues["hideEmptyProperties"] ?? true;
  const showTypeLabels = optionValues["showTypeLabels"] ?? false;

  /**
   * Engine options the checkbox rows reach (single-node and batch paths).
   * The child outline is UNCONDITIONAL (owner 2026-10-09): child blocks are
   * part of the content — they ride recursively in every export, with main
   * nodes excluded from the block zone by the engine's childrenOf contract
   * (they are child pages: files / the PDF end list). The retired
   * "Include child outline" toggle only ever hid the content's own children
   * and made no sense.
   */
  const engineOptions = useMemo(
    () => ({ includeChildPages, includeEmbedded, includeOutline: true, hideEmptyProperties, showTypeLabels }),
    [includeChildPages, includeEmbedded, hideEmptyProperties, showTypeLabels],
  );

  /**
   * Bumps when the client's cached reads land. The worker client seeds its
   * cache empty and notifies on fill; without this the first preview ran
   * before the children cache populated, so child blocks were missing from
   * the preview until any option toggle forced a re-run.
   */
  const [dataVersion, setDataVersion] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    return client.subscribe(() => setDataVersion((version) => version + 1));
  }, [isOpen, client]);

  /** The PDF engine's bag — the checkbox options + the two PDF-only selects. */
  const pdfEngineOptions = useMemo(
    () => ({ ...engineOptions, layout, pageFormat }),
    [engineOptions, layout, pageFormat],
  );

  // Recompute the preview whenever the options change. The export engine is
  // synchronous and local; the debounce keeps rapid setting changes from
  // re-rendering the world per keystroke. `dataVersion` rides the deps so a
  // client notification (the worker's cached reads landing — the first open
  // can race the children cache) re-runs the preview instead of leaving it
  // stale until the next toggle. The preview is the engine's markdown
  // projection — it only runs for the markdown card; every other format
  // shows a static note instead of misleading markdown bytes.
  useEffect(() => {
    if (!isOpen || effectiveNodeUuids.length === 0) {
      return;
    }
    if (formatId !== "markdown") {
      setPreviewContent("");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const debounceTimer = window.setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const parts = effectiveNodeUuids.map((id) =>
          exportSubtreeMarkdown(client, id, engineOptions).markdown,
        );
        if (!cancelled) setPreviewContent(parts.join("\n\n---\n\n"));
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
    };
  }, [isOpen, effectiveNodeUuids, engineOptions, client, formatId, dataVersion]);

  // PDF preview (P1): render the selected subtree to a blob and show it in
  // an iframe. The engine module is lazily imported (the first import pays
  // the react-pdf + font cost — exactly the code-split boundary); failures
  // fall back to the static note instead of surfacing an error, since the
  // Export button itself reports real render errors. `dataVersion` re-runs
  // the render when the worker's cached reads land (same staleness contract
  // as the markdown preview).
  useEffect(() => {
    if (!isOpen || formatId !== "pdf" || effectiveNodeUuids.length !== 1) {
      setPdfPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    const debounceTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const pdfModule = await import("@/ui/export-pdf/renderPdf.js");
          const { blob } = await pdfModule.renderSubtreePdf(
            client,
            effectiveNodeUuids[0]!,
            pdfEngineOptions,
          );
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setPdfPreviewUrl(objectUrl);
        } catch {
          if (!cancelled) setPdfPreviewUrl(null);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      if (objectUrl !== null && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [isOpen, effectiveNodeUuids, client, formatId, pdfEngineOptions, dataVersion]);

  const handleSelectFormat = useCallback((id: WebExportFormatId) => {
    const def = getExportFormat(id);
    if (def === undefined || def.availability.status !== "available") return;
    setFormatId(id);
    setOptionValues(defaultOptionValues(def));
  }, []);

  const handleCopy = useCallback(() => {
    if (!previewContent) return;
    copyToClipboard(previewContent).then(() => {
      triggerCopy();
    });
  }, [previewContent, triggerCopy]);

  const handleExport = useCallback(async () => {
    if (format === undefined || effectiveNodeUuids.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      if (format.id === "pdf") {
        // Client-side PDF (P1): the lazy boundary — the pdf module,
        // react-pdf, and the font bundle load on this first import and
        // stay out of the main chunk.
        const pdfModule = await import("@/ui/export-pdf/renderPdf.js");
        const exported = isBatch
          ? await pdfModule.renderSubtreePdfBatch(client, effectiveNodeUuids, pdfEngineOptions)
          : await pdfModule.renderSubtreePdf(client, effectiveNodeUuids[0]!, pdfEngineOptions);
        downloadBlob(exported.blob, exported.filename);
        return;
      }
      if (format.id === "json") {
        // JSON archive: ONE notees-json-archive document over the
        // whole selection (batch included — no per-root zip), verbatim
        // node payloads with contentAst/classIds/properties/child ids/edges.
        const exported = exportSubtreeJsonArchive(client, effectiveNodeUuids, {
          includeChildPages,
        });
        downloadBlob(exported.blob, exported.filename);
        return;
      }
      // Include asset files is a markdown-bundle delivery toggle (E7): it
      // only renders on the markdown card, and only markdown's serializers
      // have an asset-bytes path — the other formats ignore it (assets stay
      // placeholder refs), so the guard is per format here.
      const includeAssets = format.id === "markdown" && (optionValues["includeAssets"] ?? false);
      if (isBatch && format.id !== "markdown") {
        // Batch delivery for html/latex/docx (task W): ONE zip carrying each
        // root's rendered file. Markdown's batch stays the E3/E7 bundle zip.
        const exported = await exportSubtreeBatchFile(client, effectiveNodeUuids, {
          format: format.id,
          ...engineOptions,
        });
        downloadBlob(exported.blob, exported.filename);
      } else if (isBatch || includeAssets) {
        // Zip delivery for batches (E3) and whenever asset bytes are included
        // (E7 — a single node with assets becomes a zip too); otherwise one
        // concatenated .md per the single-file convention.
        const assetFiles = includeAssets
          ? await fetchSubtreeAssets(
              client,
              collectSubtreeAssetRefIds(client, effectiveNodeUuids, includeChildPages),
            )
          : undefined;
        const bundle = exportSubtreeBundle(client, effectiveNodeUuids, {
          ...engineOptions,
          filenamePolicy: "slug",
          whiteboardMode: "sidecar",
          ...(assetFiles !== undefined
            ? { assetPath: (assetId: string) => assetFiles.get(assetId)?.path }
            : {}),
        });
        const blob = new Blob([zipExportBundle(bundle, assetFiles)], { type: "application/zip" });
        downloadBlob(blob, exportZipFileName(client, effectiveNodeUuids[0]!));
      } else {
        // Format-routed single-file delivery (task W): the selected card's
        // own bytes — markdown keeps the historical concatenated document.
        const exported = await exportSubtreeFile(client, effectiveNodeUuids[0]!, {
          format: format.id,
          ...engineOptions,
        });
        downloadBlob(exported.blob, exported.filename);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [format, isBatch, client, effectiveNodeUuids, engineOptions, pdfEngineOptions, optionValues, includeChildPages]);

  const title = useMemo(() => {
    if (isBatch) {
      return `Export ${effectiveNodeUuids.length} nodes`;
    }
    const plainName = nodeName ?? "";
    return plainName ? `Export: ${plainName}` : "Export";
  }, [isBatch, effectiveNodeUuids.length, nodeName]);

  if (format === undefined) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <div className="export-modal__footer">
          <Button variant="ghost" onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button
            variant="ghost"
            icon={copied ? "mdi mdi-check" : "mdi mdi-content-copy"}
            onClick={handleCopy}
            disabled={loading || !previewContent || exporting}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
          <Button
            variant="primary"
            icon="mdi mdi-download"
            onClick={handleExport}
            disabled={exporting || loading || effectiveNodeUuids.length === 0}
          >
            {exporting ? <Spinner size="sm" label="Exporting…" /> : "Export"}
          </Button>
        </div>
      }
    >
      <div className="export-modal__body">
        {/* Format cards — unavailable formats are disabled cards with the
            registry's reason, not stub-message tabs. */}
        <div className="export-modal__formats" role="radiogroup" aria-label="Export format">
          {formats.map((def) => {
            const availability = def.availability;
            const available = availability.status === "available";
            const selected = def.id === formatId;
            return (
              <Card
                key={def.id}
                role="radio"
                aria-checked={selected}
                aria-disabled={available ? undefined : true}
                tabIndex={available ? 0 : undefined}
                interactive={available}
                selected={available && selected}
                className="export-modal__format-card"
                onClick={available ? () => handleSelectFormat(def.id) : undefined}
                onKeyDown={
                  available
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleSelectFormat(def.id);
                        }
                      }
                    : undefined
                }
              >
                <Icon path={`mdi mdi-${def.icon}`} className="export-modal__format-card-icon" />
                <span className="export-modal__format-card-label">{def.label}</span>
                {available ? null : (
                  <span className="export-modal__format-card-reason">{availability.reason}</span>
                )}
              </Card>
            );
          })}
        </div>

        {/* PDF layout + page size (P1) — layout cards render only for the
            layout-aware PDF card; both feed the engine options. */}
        {format.id === "pdf" && layoutSpec !== undefined && pageFormatSpec !== undefined && (
          <div className="export-modal__pdf-options">
            <div className="export-modal__layouts" role="radiogroup" aria-label="Layout">
              {layoutSpec.choices.map((choice) => {
                const value = choice.value as PdfLayout;
                const selected = layout === value;
                return (
                  <Card
                    key={choice.value}
                    role="radio"
                    aria-checked={selected}
                    tabIndex={0}
                    interactive
                    selected={selected}
                    className="export-modal__layout-card"
                    onClick={() => setLayout(value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setLayout(value);
                      }
                    }}
                  >
                    <Icon path={`mdi mdi-${LAYOUT_ICONS[value] ?? "file-outline"}`} className="export-modal__layout-card-icon" />
                    <span className="export-modal__layout-card-label">{choice.label}</span>
                  </Card>
                );
              })}
            </div>
            <SelectionButton
              size="sm"
              label="Page size"
              options={pageFormatSpec.choices.map((choice) => ({
                value: choice.value,
                icon: "mdi mdi-file-outline",
                label: choice.label,
              }))}
              value={pageFormat}
              onChange={(value) => setPageFormat(value as PdfPageFormat)}
            />
          </div>
        )}

        {/* Options — the selected format's registry option specs. */}
        <div className="export-modal__options">
          <Button
            variant="ghost"
            size="sm"
            icon={`mdi mdi-chevron-${optionsOpen ? "up" : "down"}`}
            iconPosition="right"
            onClick={() => setOptionsOpen((open) => !open)}
            aria-expanded={optionsOpen}
            aria-controls="export-modal__options-rows"
          >
            Options
          </Button>
          {optionsOpen && (
            <div className="export-modal__options-rows" id="export-modal__options-rows">
              {format.options.map((spec) => (
                <Checkbox
                  key={spec.key}
                  size="sm"
                  label={spec.label}
                  checked={optionValues[spec.key] ?? spec.defaultValue}
                  onChange={(event) =>
                    setOptionValues((prev) => ({ ...prev, [spec.key]: event.target.checked }))
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* Live preview — the engine's markdown projection (read-only). Other
            formats download their own bytes (task W); showing markdown here
            would be misleading, so they get an honest static note. */}
        <div className="export-modal__preview-wrap">
          {error && (
            <div className="export-modal__error" role="alert">
              {error}
            </div>
          )}
          {format.id === "markdown" ? (
            <textarea
              className={`export-modal__preview${loading ? " export-modal__preview--loading" : ""}`}
              readOnly
              value={previewContent}
              spellCheck={false}
              aria-label="markdown preview"
            />
          ) : format.id === "pdf" && pdfPreviewUrl !== null ? (
            <iframe
              title="pdf preview"
              src={pdfPreviewUrl}
              className="export-modal__pdf-preview"
            />
          ) : (
            <p className="export-modal__preview-note">
              Preview is available for Markdown. The {format.label} export renders the whole
              subtree in the selected format.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
