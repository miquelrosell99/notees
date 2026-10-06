/**
 * AssetView — the `asset_ref` token renderer (SCHEMA.md:61: renders inline
 * (chip/preview); alone in a stream = full-bleed). Injected into InlineTokens
 * by BlockRow; every other call site (read-only projections) keeps the
 * placeholder fallback.
 *
 * Variants:
 * - image-like bytes: a preview image; click opens the ImageModal lightbox
 *   (the primitive library's modal; the AssetImage pattern).
 * - anything else: a filename + size chip; click downloads the bytes.
 * - image whose bytes can't load (REST surface unconfigured, fetch failure):
 *   the chip remains as the honest fallback — it still names the file and
 *   offers the download.
 * - unknown asset (no node_asset row): the dashed placeholder box with the
 *   raw id visible (broken-mention philosophy).
 *
 * Bytes ride the client's REST read (CAS GET /api/assets/:id); the image
 * path is cached per asset for the session via the shared card-thumb cache.
 */

import { useEffect, useState } from "react";

import type { AssetInfo } from "@/core/workspace-client.js";

import { Icon } from "./Icon.js";
import { ImageModal } from "./components/ui/ImageModal.js";
import { notificationStore } from "./components/ui/notificationStore.js";
import { assetImageUrl } from "./views/assetThumbs.js";

/** The minimal client surface AssetView needs (both client classes satisfy it). */
export interface AssetViewClient {
  getAssetInfo(id: string): AssetInfo | undefined;
  getAssetDataUrl(assetNodeId: string): Promise<string | null>;
  fetchAssetBytes(assetId: string): Promise<Blob>;
}

/** Human byte sizes for the chip: 412 B / 1.9 KB / 3.1 MB. */
function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = size;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function AssetView({
  assetId,
  fullBleed = false,
  client,
}: {
  assetId: string;
  /** The lone token in its stream: render at block width instead of inline. */
  fullBleed?: boolean | undefined;
  client: AssetViewClient;
}) {
  const info = client.getAssetInfo(assetId);
  const isImage = info !== undefined && info.mimeType.startsWith("image/");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    void assetImageUrl(client, assetId).then((url) => {
      if (!cancelled) setImageUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [client, assetId, isImage]);

  if (info === undefined) {
    return (
      <span className="nt-placeholder" title={assetId}>
        asset
      </span>
    );
  }

  const download = async (): Promise<void> => {
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await client.fetchAssetBytes(info.assetId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = info.originalName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      notificationStore.error("Couldn't download asset", info.originalName);
    } finally {
      setDownloading(false);
    }
  };

  const fullBleedClass = fullBleed ? " nt-asset--fullbleed" : "";

  if (isImage && imageUrl !== null) {
    return (
      <>
        <button
          type="button"
          className={`nt-asset nt-asset--image${fullBleedClass}`}
          title={`${info.originalName} (click to view full size)`}
          onClick={(event) => {
            event.stopPropagation();
            setLightboxOpen(true);
          }}
        >
          <img src={imageUrl} alt={info.originalName} draggable="false" />
        </button>
        <ImageModal
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          src={imageUrl}
          filename={info.originalName}
          alt={info.originalName}
        />
      </>
    );
  }

  return (
    <button
      type="button"
      className={`nt-asset nt-asset--chip${fullBleedClass}`}
      title={`${info.originalName} — download`}
      onClick={(event) => {
        event.stopPropagation();
        void download();
      }}
    >
      <Icon path={isImage ? "mdi-image-outline" : "mdi-file-outline"} size={0.9} />
      <span className="nt-asset-name">{info.originalName}</span>
      {info.size > 0 && <span className="nt-asset-size">{formatBytes(info.size)}</span>}
    </button>
  );
}
