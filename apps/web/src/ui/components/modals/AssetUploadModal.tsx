/**
 * AssetUploadModal — the 1174 row's upload surface, at the v1
 * interaction's full parity: drag-drop OR click-to-browse, a clipboard
 * paste capture active while the modal is open (clipboardData.items — the
 * v1 modal-internal paste plumbing), type + size validation BEFORE the
 * upload starts (the v1 limits: 50 MB media / 100 MB documents, mirroring
 * the server caps in apps/server/src/config.ts), an `acceptedTypes` filter
 * that narrows both the picker's accept list and the validation message,
 * and an `initialFile` prop so external paste plumbing can hand a captured
 * file to a fresh modal. The upload itself is the existing CAS path
 * (uploadAsset → asset node → attachAsset) with the preview row (image
 * thumbnail / audio player / document icon) and the explicit progress
 * state (uploading → done/error).
 *
 * The server still sniffs magic bytes and enforces the same caps, so
 * client-side validation stays presentational: it rejects the obviously
 * wrong early with the v1 wording, and the status line surfaces the
 * server's rejection verbatim when bytes disagree.
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

/** The v1 size caps, mirroring NOTEES_MAX_MEDIA_BYTES / NOTEES_MAX_DOCUMENT_BYTES. */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/** MIME lists per category — the picker's accept list AND the supported-type
 *  check, mirroring the server's magic-byte sniff set (jpeg/png/webp,
 *  mpeg/wav/ogg/flac/mp4 audio, pdf/epub documents). */
const CATEGORY_TYPES: Record<AssetCategory, string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  audio: [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/flac",
    "audio/mp4",
  ],
  document: ["application/pdf", "application/epub+zip"],
};

/** Extension fallback for files whose type is empty (drag-drop from some
 *  sources gives no MIME); mirrors the dotted entries of the v1 accept list. */
const CATEGORY_EXTENSIONS: Record<AssetCategory, string[]> = {
  image: [".jpg", ".jpeg", ".png", ".webp"],
  audio: [".mp3", ".wav", ".ogg", ".opus", ".webm", ".flac", ".m4a", ".mp4"],
  document: [".pdf", ".epub"],
};

function categoryOf(file: File): AssetCategory {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  return "document";
}

/** The category a file is usable as, or null when its type (nor its name)
 *  is in the sniffed set — the v1 isSupportedAssetType gate. */
function supportedCategoryOf(file: File): AssetCategory | null {
  const byType = (Object.entries(CATEGORY_TYPES) as Array<[AssetCategory, string[]]>).find(
    ([, types]) => types.includes(file.type),
  );
  if (byType !== undefined) return byType[0];
  const name = file.name.toLowerCase();
  const byExtension = (
    Object.entries(CATEGORY_EXTENSIONS) as Array<[AssetCategory, string[]]>
  ).find(([, extensions]) => extensions.some((extension) => name.endsWith(extension)));
  return byExtension !== undefined ? byExtension[0] : null;
}

/** The picker's accept attribute, narrowed by acceptedTypes (v1
 *  getAcceptString): undefined accepts the full sniffed set. */
function acceptStringFor(acceptedTypes: AssetCategory[] | undefined): string {
  const categories: AssetCategory[] = acceptedTypes ?? ["image", "audio", "document"];
  return categories
    .flatMap((category) => [...CATEGORY_TYPES[category], ...CATEGORY_EXTENSIONS[category]])
    .join(",");
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
  /** Optional file to prefill the drop zone (external paste plumbing). */
  initialFile?: File | null;
  /**
   * Optional category filter (the v1 prop): narrows the accept list and the
   * validation — a file outside the list is rejected with "Only … files are
   * accepted." before the upload starts.
   */
  acceptedTypes?: AssetCategory[];
}

export function AssetUploadModal({
  isOpen,
  onClose,
  client,
  assetClassId,
  onUploaded,
  initialFile = null,
  acceptedTypes,
}: AssetUploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Object URL for the image/audio preview; revoked on swap/close/unmount. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  /**
   * The v1 validateFile gate, in the v1 order: supported type → accepted
   * category → size cap (media 50 MB, documents 100 MB). Returns the v1
   * wording; null means the file can be selected.
   */
  const validateFile = (candidate: File): string | null => {
    const supported = supportedCategoryOf(candidate);
    if (supported === null) return "Unsupported file type.";
    if (acceptedTypes !== undefined && !acceptedTypes.includes(supported)) {
      return `Only ${acceptedTypes.join(" and ")} files are accepted.`;
    }
    const maxBytes = supported === "document" ? MAX_DOCUMENT_BYTES : MAX_MEDIA_BYTES;
    if (candidate.size > maxBytes) {
      return `File too large. Maximum size is ${maxBytes / (1024 * 1024)}MB.`;
    }
    return null;
  };

  const selectFile = (next: File | null) => {
    if (next !== null) {
      const validationError = validateFile(next);
      if (validationError !== null) {
        // Rejected up front (v1): the error shows, the previous selection
        // is NOT replaced, no preview is minted.
        setError(validationError);
        return;
      }
    }
    setError(null);
    setFile(next);
    setPhase("idle");
    const previewable =
      next !== null && (next.type.startsWith("image/") || next.type.startsWith("audio/"));
    setPreviewUrl(previewable && next !== null ? URL.createObjectURL(next) : null);
  };

  // Reset each open; adopt the prefilled file through the same validation
  // gate (an externally pasted file can be oversize or the wrong category).
  useEffect(() => {
    if (!isOpen) return;
    setPhase("idle");
    setError(null);
    setFile(null);
    setPreviewUrl(null);
    if (initialFile !== null) selectFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectFile closes over the open-time acceptedTypes; a mid-open prop change must not re-validate the user's selection.
  }, [isOpen, initialFile]);

  // The v1 modal-internal paste capture: a document-level listener, active
  // ONLY while the modal is open; the first clipboard file item becomes the
  // selection (validation included). The workspace's other paste surfaces
  // are element-level (title/block editors), so a modal-open capture never
  // double-handles.
  useEffect(() => {
    if (!isOpen) return;
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (items === undefined) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const pasted = item.getAsFile();
        if (pasted !== null) {
          event.preventDefault();
          selectFile(pasted);
          break;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectFile closes over the open-time acceptedTypes; the listener re-registers on open/close, which is the lifecycle that matters.
  }, [isOpen]);

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
  const accept = acceptStringFor(acceptedTypes);
  const title =
    acceptedTypes?.length === 1
      ? acceptedTypes[0] === "image"
        ? "Upload image"
        : acceptedTypes[0] === "audio"
          ? "Upload audio"
          : "Upload file"
      : "Upload file";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
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
          accept={accept}
          onSelect={(next) => selectFile(next)}
          onClear={() => selectFile(null)}
          placeholder="Drop a file here"
          hint="or click to browse, or paste from clipboard"
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
