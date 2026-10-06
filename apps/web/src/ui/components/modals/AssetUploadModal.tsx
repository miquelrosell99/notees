/**
 * AssetUploadModal — the upload surface (drag-drop,
 * preview, explicit progress state). The earlier baseline uploaded through the
 * property picker's hidden file input with a bare busy flag: no drop zone,
 * no preview, no visible progress. This modal closes the gap over the
 * FileDropZone primitive: pick or drop ONE file, see a category chip +
 * preview (image thumbnail / audio player / document icon), then upload
 * with an explicit status line (uploading → done/error). The upload itself
 * is the existing CAS path (uploadAsset → asset node → attachAsset); the
 * caller links the returned asset node to its property.
 *
 * The server sniffs magic bytes (jpeg/png/webp/pdf/epub/audio) and enforces
 * the media/document size caps, so client-side validation stays
 * presentational: the accept list mirrors the sniffed set and the status
 * line surfaces the server's rejection verbatim.
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { AssetUploadResult, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { FileDropZone } from "../ui/FileDropZone.js";
import "./AssetUploadModal.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Upload lifecycle — the explicit progress state the register row asks for. */
type UploadPhase = "idle" | "uploading" | "error";

type AssetCategory = "image" | "audio" | "document";

const ACCEPT =
  "image/jpeg,image/png,image/webp,audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/opus,audio/webm," +
  ".pdf,.epub";

function categoryOf(file: File): AssetCategory {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  return "document";
}

const CATEGORY_LABELS: Record<AssetCategory, string> = {
  image: "Image",
  audio: "Audio",
  document: "Document",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AssetUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the upload composes through. */
  client: AnyClient;
  /** The asset class the new node carries (the picker's resolved target). */
  assetClassId: string;
  /** Called with the created asset NODE id once the upload fully lands. */
  onUploaded: (assetNodeId: string) => void;
  /** Optional file to prefill the drop zone (e.g. a paste capture). */
  initialFile?: File | null;
}

export function AssetUploadModal({
  isOpen,
  onClose,
  client,
  assetClassId,
  onUploaded,
  initialFile = null,
}: AssetUploadModalProps) {
  const [file, setFile] = useState<File | null>(initialFile);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Object URL for the image/audio preview; revoked on swap/close/unmount. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Reset each open; adopt the prefilled file (paste flow).
  useEffect(() => {
    if (!isOpen) return;
    setFile(initialFile);
    setPhase("idle");
    setError(null);
  }, [isOpen, initialFile]);

  // Revoke the stale object URL when the preview swaps or the modal unmounts
  // (the cleanup captures the previous value), so repeated uploads do not
  // leak blobs for the session. The typeof guard keeps jsdom (no
  // URL.revokeObjectURL) from crashing the unmount cleanup.
  useEffect(() => {
    return () => {
      if (previewUrl !== null && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const selectFile = (next: File | null) => {
    setFile(next);
    setPhase("idle");
    setError(null);
    const previewable =
      next !== null && (next.type.startsWith("image/") || next.type.startsWith("audio/"));
    setPreviewUrl(previewable && next !== null ? URL.createObjectURL(next) : null);
  };

  const upload = async () => {
    if (file === null || phase === "uploading") return;
    setPhase("uploading");
    setError(null);
    let uploaded: AssetUploadResult;
    try {
      uploaded = await client.uploadAsset(file, file.name);
      // The Zotero-style asset node: a node carrying the asset class, named
      // by the uploaded file; node_asset ties it to the content-addressed
      // bytes (the property picker's exact pre-modal semantics).
      const assetNodeId = await client.createObject({
        presentAsMain: true,
        name: uploaded.originalName,
        classIds: [assetClassId],
      });
      await client.attachAsset(assetNodeId, uploaded);
      onUploaded(assetNodeId);
      selectFile(null);
      onClose();
    } catch (err) {
      // Keep the file selected so the failure is retryable in one click.
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  const category = file !== null ? categoryOf(file) : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Upload file"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={phase === "uploading"}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void upload()}
            disabled={file === null || phase === "uploading"}
            loading={phase === "uploading"}
            icon="mdi-upload"
          >
            Upload
          </Button>
        </>
      }
    >
      <div className="asset-upload-modal">
        <FileDropZone
          file={file}
          accept={ACCEPT}
          onSelect={(next) => selectFile(next)}
          onClear={() => selectFile(null)}
          placeholder="Drop a file here"
          hint="or click to browse"
          icon={<Icon path="mdi-cloud-upload-outline" size={1.6} />}
          disabled={phase === "uploading"}
        />
        {file !== null && category !== null && (
          <div className="asset-upload-modal__preview">
            {category === "image" && previewUrl !== null ? (
              <img className="asset-upload-modal__thumb" src={previewUrl} alt={file.name} />
            ) : (
              <span className="asset-upload-modal__doc-icon" aria-hidden="true">
                <Icon
                  path={
                    category === "image"
                      ? "mdi-image-outline"
                      : category === "audio"
                        ? "mdi-music-note-outline"
                        : "mdi-file-outline"
                  }
                  size={1.6}
                />
              </span>
            )}
            <span className="asset-upload-modal__meta">
              <span className="asset-upload-modal__name">{file.name}</span>
              <span className="asset-upload-modal__sub">
                <span className="asset-upload-modal__chip">{CATEGORY_LABELS[category]}</span>
                {formatSize(file.size)}
              </span>
            </span>
          </div>
        )}
        {category === "audio" && file !== null && previewUrl !== null && (
          // A real audio preview (the row's "preview" ask); jsdom renders the
          // element without playback.
          <audio className="asset-upload-modal__audio" controls preload="metadata" src={previewUrl} data-filename={file.name} />
        )}
        {phase === "uploading" && (
          <p className="asset-upload-modal__status" role="status">
            Uploading {file?.name ?? "file"}…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="asset-upload-modal__error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
