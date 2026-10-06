/**
 * CoverCard — the v1 cover element (owner directive 2026-10-04: "the v1
 * collapsible cover element, that showed even when empty — cover as a card
 * in the right side like in v1"). Sits in the header row's right column
 * (the .page-header-section grid); ALWAYS renders when the page can carry
 * a cover — collapsed to the slim chevron strip by default, expanding to
 * the card: the cover image, a dashed placeholder naming a byte-less
 * asset, or the dashed "Add cover" affordance when empty.
 *
 * The collapse state derives from whether a cover is set (v1: no per-node
 * persistence; the toggle is session-local). The card accepts a dropped
 * image file (the v1 AddCoverButton gesture); hover reveals Change/Remove.
 * Selection writes through coverProperty: value + the cover/asset classes
 * (explicit ops — every client converges).
 *
 * The v1 upload gesture (M33): clicking the empty "Add cover" element opens
 * the AssetUploadModal directly — image-only (acceptedTypes), validated,
 * with preview + progress — and the uploaded asset node becomes the cover.
 * The Change path keeps the CoverPicker (search existing assets, or "Upload
 * new cover…" which routes to the same modal).
 */

import { useEffect, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

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
 * upload to the AssetUploadModal (the M33 v1 gesture — validated, preview,
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
  /** v1: the collapse derives from whether a cover is set; session-local. */
  const [collapsed, setCollapsed] = useState(assetId === null);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The M33 upload modal — opened by the empty Add state and the picker's
   *  "Upload new cover…" row (the v1 gestures). */
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

  // New cover set while collapsed? Expand (the v1 feel: the card appears).
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
          acceptedTypes={["image"]}
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
