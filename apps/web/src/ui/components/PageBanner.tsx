/**
 * PageBanner — the page cover above the title (§34.27 L2, decision D2;
 * §34.56 covers-v2; §34.59 the dedicated header element; §34.72 v1-parity:
 * the banner is ALWAYS chrome when a cover value exists — even when the
 * bytes can't resolve, the shell renders as a dashed placeholder naming
 * the asset (never a silent void), and both the Add-cover strip and the
 * shell accept DRAG-AND-DROP of an image file — the v1 AddCoverButton
 * signature).
 *
 * Hover reveals the cover toolbar: Change cover… (pick an existing asset
 * or upload) and Remove cover. Click on the image collapses/expands; the
 * collapse flag is device-local per page. Absence (no value, embedded
 * feed, whiteboard page) renders nothing but the AddCover strip.
 */

import { useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { assetImageUrl } from "../views/assetThumbs.js";
import { useCoverCollapsed } from "../viewPrefs.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { Button } from "./ui/Button.js";
import { Icon } from "../Icon.js";
import { clearNodeCover, setNodeCover, uploadCoverAsset } from "./coverProperty.js";
import "./PageBanner.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The shared cover-picker surface (§34.59): pick an existing asset or
 *  upload a new one, then setNodeCover. */
export function CoverPicker({
  client,
  pageId,
  anchor,
  onClose,
}: {
  client: AnyClient;
  pageId: string;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
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

  const uploadCover = async (file: File) => {
    onClose();
    setBusy(true);
    setError(null);
    try {
      await uploadCoverAsset(client, pageId, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        Upload new cover…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        className="nt-file-input"
        aria-label="Upload cover image"
        accept="image/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void uploadCover(file);
          event.target.value = "";
        }}
      />
      {error !== null && (
        <p role="alert" className="nt-cover-picker__error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Drag-and-drop surface shared by the Add-cover strip and the shell. */
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

export function PageBanner({
  client,
  pageId,
  assetId,
}: {
  client: AnyClient;
  pageId: string;
  assetId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const [collapsed, setCollapsed] = useCoverCollapsed(pageId);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drop = useCoverDrop(client, pageId);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setResolved(false);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const assetName =
    client.getNode(assetId) !== undefined
      ? (client.getDisplayName(assetId) ?? assetId)
      : assetId;

  const shellClass = [
    "nt-page-banner",
    collapsed ? "nt-page-banner--collapsed" : "",
    drop.dragging ? "nt-page-banner--dropping" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // §34.72: a cover value EXISTS — the chrome always renders. Only the
  // IMAGE waits on bytes; without them the shell shows a dashed
  // placeholder naming the asset (never a silent void), still droppable.
  const image = resolved && url !== null;

  return (
    <div
      className={shellClass}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      {image ? (
        <button
          type="button"
          className="nt-page-banner__toggle"
          aria-label={collapsed ? "Expand cover image" : "Collapse cover image"}
          aria-pressed={collapsed}
          title={collapsed ? "Expand cover" : "Collapse cover"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {!collapsed && <img className="nt-page-banner__img" src={url} alt="" />}
        </button>
      ) : (
        <div className="nt-page-banner__placeholder" role="status">
          <Icon path="mdi-image-outline" size={0.9} />
          <span className="nt-page-banner__placeholder-name">{assetName}</span>
          <span className="nt-page-banner__placeholder-hint">
            {resolved ? "No image bytes on this asset — change the cover or drop an image" : "Loading cover…"}
          </span>
        </div>
      )}
      <div className="nt-page-banner__toolbar">
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
      {pickerOpen && pickerAnchor !== null && (
        <CoverPicker
          client={client}
          pageId={pageId}
          anchor={pickerAnchor}
          onClose={() => setPickerOpen(false)}
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

/**
 * AddCover — the v1/Capacities affordance for a page that CAN carry a cover
 * but doesn't yet: a slim dashed strip in the banner slot, revealed on page
 * hover, opening the shared picker — AND accepting a dropped image file
 * (the v1 AddCoverButton signature).
 */
export function AddCover({
  client,
  pageId,
}: {
  client: AnyClient;
  pageId: string;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const drop = useCoverDrop(client, pageId);

  return (
    <div
      className={`nt-add-cover${drop.dragging ? " nt-add-cover--dropping" : ""}`}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <button
        type="button"
        ref={setAnchor}
        className="nt-add-cover__button"
        aria-label="Add cover"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ＋ Add cover
      </button>
      {open && anchor !== null && (
        <CoverPicker client={client} pageId={pageId} anchor={anchor} onClose={() => setOpen(false)} />
      )}
      {drop.error !== null && (
        <p role="alert" className="nt-page-banner__error">
          {drop.error}
        </p>
      )}
    </div>
  );
}
