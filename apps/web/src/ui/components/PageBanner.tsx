/**
 * PageBanner.tsx — the page's imagery chrome:
 *
 * CoverCard — the cover element (owner directive 2026-10-04: "the
 * collapsible cover element, that showed even when empty — cover as a card
 * in the right side"). Sits in the header row's right column
 * (the .page-header-section grid); ALWAYS renders when the page can carry
 * a cover — collapsed to the slim chevron strip by default, expanding to
 * the card: the cover image, a dashed placeholder naming a byte-less
 * asset, or the dashed "Add cover" affordance when empty. The assetId
 * prop is the node's `coverAssetId` wire field (coverProperty.ts — the
 * retired cover property is superseded; the node column is the one read).
 *
 * BannerCard — the full-width banner ABOVE the header (the wire
 * `bannerAssetId` node field, written through object.update; the
 * ClientNode read, the icon/color precedent). Collapsed to a slim
 * full-width strip by default (per-page device-local pref), expanding to
 * the fixed-height cover-fit image; empty expands to the dashed Add
 * affordance, which opens the AssetUploadModal (images only). Banner and
 * cover coexist: the banner spans the content width above the header, the
 * cover card stays in the header row.
 *
 * The collapse state derives from whether a cover is set (no per-node
 * persistence; the toggle is session-local). The card accepts a dropped
 * image file (the AddCoverButton gesture); hover reveals Change/Remove.
 * Selection writes through coverProperty: the coverAssetId wire field +
 * the cover/asset classes (explicit ops — every client converges).
 *
 * The upload gesture: clicking the empty "Add cover" element opens
 * the AssetUploadModal directly — image-only (accept="image/*"), validated,
 * with preview + progress — and the uploaded asset node becomes the cover.
 * The Change path keeps the CoverPicker (search existing assets, or "Upload
 * new cover…" which routes to the same modal).
 */

import { useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { useBannerCollapsed } from "../viewPrefs.js";
import { assetImageUrl } from "../views/assetThumbs.js";
import { Icon } from "../Icon.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { AssetUploadModal } from "./modals/AssetUploadModal.js";
import { Button, ImageModal } from "./ui/index.js";
import { clearNodeCover, setNodeCover, uploadCoverAsset } from "./coverProperty.js";
import "./PageBanner.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The shared cover-picker surface: pick an existing asset, or hand the
 * upload to the AssetUploadModal (the validated upload gesture — preview,
 * progress). `onUploadRequest` swaps the picker's raw hidden-input upload
 * for the modal; the picker closes so the modal owns the interaction.
 */
export function CoverPicker({
  client,
  pageId,
  anchor,
  onClose,
  onUploadRequest,
}: {
  client: AnyClient;
  pageId: string;
  anchor: HTMLElement;
  onClose: () => void;
  onUploadRequest: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const pickCover = async (assetNodeId: string) => {
    onClose();
    setError(null);
    try {
      await setNodeCover(client, pageId, assetNodeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="nt-cover-picker">
      <NodeSelector
        client={client}
        searchMode="pages"
        classFilters={[SYSTEM_CLASS_UUIDS.asset]}
        anchorEl={anchor}
        onClose={onClose}
        searchPlaceholder="Search assets…"
        onAdd={(node) => void pickCover(node.id)}
      />
      <button
        type="button"
        className="nt-cover-picker__upload"
        onClick={() => {
          onClose();
          onUploadRequest();
        }}
      >
        Upload new cover…
      </button>
      {error !== null && (
        <p role="alert" className="nt-cover-picker__error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Drag-and-drop surface shared by the empty affordance and the card. */
function useCoverDrop(client: AnyClient, pageId: string) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    setDragging(true);
  };
  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file === undefined) return;
    setError(null);
    void uploadCoverAsset(client, pageId, file).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return { dragging, error, onDragOver, onDragLeave, onDrop };
}

export function CoverCard({
  client,
  pageId,
  assetId,
}: {
  client: AnyClient;
  pageId: string;
  /** The cover's asset node id, null when the cover is unset. */
  assetId: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  /** The collapse derives from whether a cover is set; session-local. */
  const [collapsed, setCollapsed] = useState(assetId === null);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The upload modal — opened by the empty Add state and the picker's
   *  "Upload new cover…" row. */
  const [uploadOpen, setUploadOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drop = useCoverDrop(client, pageId);

  // The uploaded asset node becomes the cover (value + asset class through
  // the shared coverProperty write).
  const applyUploadedCover = (assetNodeId: string) => {
    setUploadOpen(false);
    setError(null);
    setNodeCover(client, pageId, assetNodeId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  // New cover set while collapsed? Expand (the original feel: the card appears).
  useEffect(() => {
    if (assetId !== null) setCollapsed(false);
  }, [assetId]);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setResolved(false);
    if (assetId === null) return;
    void assetImageUrl(client, assetId).then((resolved_) => {
      if (alive) {
        setUrl(resolved_);
        setResolved(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [client, assetId]);

  const removeCover = async () => {
    setError(null);
    try {
      await clearNodeCover(client, pageId);
      setCollapsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const assetName =
    assetId !== null && client.getNode(assetId) !== undefined
      ? (client.getDisplayName(assetId) ?? assetId)
      : assetId;

  const hasImage = assetId !== null && resolved && url !== null;

  return (
    <div
      className={`nt-covercard${drop.dragging ? " nt-covercard--dropping" : ""}`}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <button
        type="button"
        className="nt-covercard__collapse"
        title={collapsed ? "Expand cover" : "Collapse cover"}
        aria-label={collapsed ? "Expand cover" : "Collapse cover"}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <Icon path={collapsed ? "mdi-chevron-left" : "mdi-chevron-right"} size={0.7} />
      </button>
      {!collapsed && (
        <div className="nt-covercard__card">
          {assetId === null ? (
            <button
              type="button"
              className="nt-covercard__empty"
              aria-label="Add cover image"
              title="Add cover image"
              onClick={() => setUploadOpen(true)}
            >
              <Icon path="mdi-image-plus" size={0.9} />
              <span>Add cover</span>
            </button>
          ) : hasImage ? (
            <>
              <button
                type="button"
                className="nt-covercard__zoom"
                title={`${assetName ?? "Cover"} (click to view full size)`}
                aria-label={`View ${assetName ?? "cover"} full size`}
                onClick={(event) => {
                  event.stopPropagation();
                  setZoomOpen(true);
                }}
              >
                <img className="nt-covercard__img" src={url} alt="" draggable="false" />
              </button>
              {zoomOpen && (
                <ImageModal
                  isOpen
                  onClose={() => setZoomOpen(false)}
                  src={url}
                  filename={assetName ?? undefined}
                  alt={assetName ?? ""}
                />
              )}
            </>
          ) : (
            <div className="nt-covercard__placeholder" role="status">
              <Icon path="mdi-image-outline" size={0.8} />
              <span className="nt-covercard__placeholder-name">{assetName}</span>
              <span className="nt-covercard__placeholder-hint">
                {resolved ? "No image bytes — drop or change" : "Loading…"}
              </span>
            </div>
          )}
          {assetId !== null && (
            <div className="nt-covercard__toolbar">
              <Button
                variant="ghost"
                size="xs"
                icon="mdi-image-sync"
                aria-label="Change cover"
                title="Change cover…"
                onClick={(event) => {
                  event.stopPropagation();
                  setPickerAnchor(event.currentTarget);
                  setPickerOpen((open) => !open);
                }}
              />
              <Button
                variant="ghost"
                size="xs"
                icon="mdi-close"
                aria-label="Remove cover"
                title="Remove cover"
                onClick={(event) => {
                  event.stopPropagation();
                  void removeCover();
                }}
              />
            </div>
          )}
        </div>
      )}
      {pickerOpen && pickerAnchor !== null && (
        <CoverPicker
          client={client}
          pageId={pageId}
          anchor={pickerAnchor}
          onClose={() => setPickerOpen(false)}
          onUploadRequest={() => setUploadOpen(true)}
        />
      )}
      {uploadOpen && (
        <AssetUploadModal
          isOpen
          client={client}
          assetClassId={SYSTEM_CLASS_UUIDS.asset}
          accept="image/jpeg,image/png,image/webp"
          onClose={() => setUploadOpen(false)}
          onUploaded={applyUploadedCover}
        />
      )}
      {(error !== null || drop.error !== null) && (
        <p role="alert" className="nt-page-banner__error">
          {error ?? drop.error}
        </p>
      )}
    </div>
  );
}

// --- the banner (the bannerAssetId wire field) ------------------------------

/** The asset node id a node's `bannerAssetId` wire field carries (null = unset). */
export function bannerAssetIdOf(
  client: Pick<AnyClient, "getNode">,
  nodeId: string,
): string | null {
  return client.getNode(nodeId)?.bannerAssetId ?? null;
}

/**
 * Set a node's banner: the `bannerAssetId` object.update field + the
 * asset's asset class — explicit ops, so every client converges on the
 * classIds projection (the wire field is the authority).
 */
export async function setNodeBanner(
  client: AnyClient,
  pageId: string,
  assetId: string,
): Promise<void> {
  await client.updateObject(pageId, { bannerAssetId: assetId });
  const node = client.getNode(assetId);
  if (node !== undefined && !node.classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
    await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
  }
}

/** Remove a node's banner (present-null clears the field). The asset stays. */
export async function clearNodeBanner(client: AnyClient, pageId: string): Promise<void> {
  await client.updateObject(pageId, { bannerAssetId: null });
}

/**
 * BannerCard — the full-width banner above the page header, spanning the
 * content width inside the page card. Collapsed to a slim full-width strip
 * by default (the per-page device-local pref — display state, never an
 * op); expanding shows the fixed-height cover-fit image, the dashed
 * placeholder naming a byte-less asset, or the dashed Add affordance when
 * no banner is set. The Add/Change affordances open the AssetUploadModal
 * through the host's `onUploadRequest` (image-only accept) so the page
 * context menu's Add banner rides the exact same modal; the upload lands
 * via setNodeBanner. Whiteboard pages and embedded renders host no banner
 * (the cover gating precedent).
 */
export function BannerCard({
  client,
  pageId,
  assetId,
  onUploadRequest,
}: {
  client: AnyClient;
  pageId: string;
  /** The banner's asset node id (the wire field), null when unset. */
  assetId: string | null;
  /** Opens the image-only upload modal (owned by the host). */
  onUploadRequest: () => void;
}) {
  const [collapsed, setCollapsed] = useBannerCollapsed(pageId);
  const [url, setUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A banner landing while the card is mounted (upload, the context menu)
  // expands the strip — the new image is the feedback (the CoverCard
  // precedent). The mount is excluded: the pref governs the first view, so
  // a page whose banner was set elsewhere still starts collapsed.
  const initialAssetId = useRef(assetId);
  useEffect(() => {
    if (assetId !== null && assetId !== initialAssetId.current) setCollapsed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the setter is stable per pageId; react to the field only.
  }, [assetId]);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setResolved(false);
    if (assetId === null) return;
    void assetImageUrl(client, assetId).then((resolved_) => {
      if (alive) {
        setUrl(resolved_);
        setResolved(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [client, assetId]);

  const assetName =
    assetId !== null && client.getNode(assetId) !== undefined
      ? (client.getDisplayName(assetId) ?? assetId)
      : assetId;
  const hasImage = assetId !== null && resolved && url !== null;

  return (
    <div className="nt-bannercard">
      {collapsed ? (
        <button
          type="button"
          className="nt-bannercard__strip"
          aria-label="Expand banner"
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <span className="nt-bannercard__strip-handle" aria-hidden="true">
            <Icon path="mdi-chevron-down" size={0.7} />
          </span>
        </button>
      ) : (
        <div className="nt-bannercard__card">
          {assetId === null ? (
            <button
              type="button"
              className="nt-bannercard__empty"
              aria-label="Add banner"
              title="Add banner"
              onClick={onUploadRequest}
            >
              <Icon path="mdi-panorama" size={0.9} />
              <span>Add banner</span>
            </button>
          ) : hasImage ? (
            <>
              <button
                type="button"
                className="nt-bannercard__zoom"
                title={`${assetName ?? "Banner"} (click to view full size)`}
                aria-label={`View ${assetName ?? "banner"} full size`}
                onClick={() => setZoomOpen(true)}
              >
                <img className="nt-bannercard__img" src={url} alt="" draggable="false" />
              </button>
              {zoomOpen && (
                <ImageModal
                  isOpen
                  onClose={() => setZoomOpen(false)}
                  src={url}
                  filename={assetName ?? undefined}
                  alt={assetName ?? ""}
                />
              )}
            </>
          ) : (
            <div className="nt-bannercard__placeholder" role="status">
              <Icon path="mdi-image-outline" size={0.8} />
              <span className="nt-bannercard__placeholder-name">{assetName}</span>
              <span className="nt-bannercard__placeholder-hint">
                {resolved ? "No image bytes — change or remove" : "Loading…"}
              </span>
            </div>
          )}
          <div className="nt-bannercard__toolbar">
            <Button
              variant="ghost"
              size="xs"
              icon="mdi-chevron-up"
              aria-label="Collapse banner"
              aria-expanded={true}
              title="Collapse banner"
              onClick={() => setCollapsed(true)}
            />
            {assetId !== null && (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  icon="mdi-image-sync"
                  aria-label="Change banner"
                  title="Change banner…"
                  onClick={onUploadRequest}
                />
                <Button
                  variant="ghost"
                  size="xs"
                  icon="mdi-close"
                  aria-label="Remove banner"
                  title="Remove banner"
                  onClick={() => {
                    setError(null);
                    clearNodeBanner(client, pageId).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : String(err));
                    });
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="nt-page-banner__error">
          {error}
        </p>
      )}
    </div>
  );
}
