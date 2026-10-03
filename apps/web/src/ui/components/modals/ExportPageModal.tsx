/**
 * ExportPageModal — export one node or a batch of nodes (§34.24 E3,
 * modelling decision 3: the Capacities structure, composed from kit
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
 * The preview and the export run through the local export engine
 * (exportSubtree): a single node downloads one concatenated Markdown file; a
 * batch collects every node's subtree bundle into ONE zip (slug filenames
 * + `notees-manifest.json`, the E5 server-zip conventions). The markdown
 * registry's "Include asset files" option (E7) scans the exported subtrees
 * for asset_ref tokens, fetches the bytes concurrency-limited, and switches
 * delivery to the same zip shape — single node included — with the refs
 * rewritten to relative `assets/` paths.
 */
import { useState, useCallback, useEffect, useMemo } from "react";
import type { ExportFormatId } from "@notees/export";

import { useCopiedState } from "./overlayHooks";
import { Modal } from "../ui/Modal.js";
import { copyToClipboard } from "./clipboard";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Checkbox } from "../ui/Checkbox.js";
import { Spinner } from "../ui/Spinner.js";
import { Icon } from "../../Icon";
import { downloadBlob } from "./download";
import {
  exportSubtreeMarkdown,
  exportSubtreeBundle,
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
  type WebExportFormatDefinition,
} from "./registerExportFormats";
import "./ExportPageModal.css";

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
  const [formatId, setFormatId] = useState<ExportFormatId>(() => firstAvailableFormat().id);
  const [optionValues, setOptionValues] = useState<Record<string, boolean>>(() =>
    defaultOptionValues(firstAvailableFormat()),
  );
  const [optionsOpen, setOptionsOpen] = useState(true);

  const [previewContent, setPreviewContent] = useState<string>("");
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
  const includeOutline = optionValues["includeOutline"] ?? true;
  const hideEmptyProperties = optionValues["hideEmptyProperties"] ?? true;
  const showTypeLabels = optionValues["showTypeLabels"] ?? false;

  /** Engine options the checkbox rows reach (single-node and batch paths). */
  const engineOptions = useMemo(
    () => ({ includeChildPages, includeEmbedded, includeOutline, hideEmptyProperties, showTypeLabels }),
    [includeChildPages, includeEmbedded, includeOutline, hideEmptyProperties, showTypeLabels],
  );

  // Recompute the preview whenever the options change. The export engine is
  // synchronous and local; the debounce keeps rapid setting changes from
  // re-rendering the world per keystroke.
  useEffect(() => {
    if (!isOpen || effectiveNodeUuids.length === 0) {
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
  }, [isOpen, effectiveNodeUuids, engineOptions, client]);

  const handleSelectFormat = useCallback((id: ExportFormatId) => {
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
      const includeAssets = optionValues["includeAssets"] ?? false;
      // Zip delivery for batches (E3) and whenever asset bytes are included
      // (E7 — a single node with assets becomes a zip too); otherwise one
      // concatenated .md per the single-file convention.
      if (isBatch || includeAssets) {
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
        const exported = exportSubtreeMarkdown(client, effectiveNodeUuids[0]!, engineOptions);
        const blob = new Blob([exported.markdown], { type: format.mimeType });
        downloadBlob(blob, exported.filename);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [format, isBatch, client, effectiveNodeUuids, engineOptions, optionValues, includeChildPages]);

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

        {/* Markdown live preview (read-only). */}
        <div className="export-modal__preview-wrap">
          {error && (
            <div className="export-modal__error" role="alert">
              {error}
            </div>
          )}
          <textarea
            className={`export-modal__preview${loading ? " export-modal__preview--loading" : ""}`}
            readOnly
            value={previewContent}
            spellCheck={false}
            aria-label={`${format.id} preview`}
          />
        </div>
      </div>
    </Modal>
  );
}
