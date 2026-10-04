/**
 * PageBanner — the page cover above the title (§34.27 L2, decision D2;
 * §34.56 covers-v2; §34.59 the dedicated header element — the cover is
 * HEADER CHROME, never a property row): the node's `cover` property (an
 * image property — value shape `{ nodeId }` pointing at an asset-classed
 * node, itself classed `cover` extending `asset`) rendered as header chrome
 * over the `--page-cover-height` budget. Click collapses/expands; the
 * collapse flag is device-local per page (device state, never an op).
 *
 * Hover reveals the cover toolbar (§34.56, v1-parity+): Change cover…
 * (pick an existing asset or upload a new one — the picked/uploaded asset
 * gains the cover+asset classes through explicit ops) and Remove cover
 * (the asset's cover class survives only while another node still covers
 * with it). Pages that CAN carry a cover (a class binds the schema) but
 * don't yet render AddCover instead — the v1/Capacities affordance.
 *
 * Absence is the fallback: no cover value, unresolvable asset bytes, an
 * embedded feed entry, or a whiteboard page → nothing renders (date pages
 * carry no cover binding by construction — the schema binds to `source`
 * only — so they naturally land here too).
 */

import { useEffect, useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { assetImageUrl } from "../views/assetThumbs.js";
import { useCoverCollapsed } from "../viewPrefs.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { Button } from "./ui/Button.js";
import { setNodeCover, clearNodeCover } from "./coverProperty.js";
import "./PageBanner.css";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The shared cover-picker surface (§34.59): pick an existing asset-classed
 * node or upload a new one, then setNodeCover. Rendered anchored to whoever
 * opened it (the banner's Change button or the AddCover strip).
 */
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
      const uploaded = await client.uploadAsset(file, file.name);
      const assetNodeId = await client.createObject({
        presentAsMain: true,
        name: uploaded.originalName,
        classIds: [SYSTEM_CLASS_UUIDS.asset],
      });
      await client.attachAsset(assetNodeId, uploaded);
      await setNodeCover(client, pageId, assetNodeId);
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
  const [collapsed, setCollapsed] = useCoverCollapsed(pageId);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    void assetImageUrl(client, assetId).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [client, assetId]);

  // Bytes unresolved or unreadable → the honest fallback is no banner.
  if (url === null) return null;

  const removeCover = async () => {
    setError(null);
    try {
      await clearNodeCover(client, pageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={collapsed ? "nt-page-banner nt-page-banner--collapsed" : "nt-page-banner"}>
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
      {error !== null && (
        <p role="alert" className="nt-page-banner__error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * AddCover — the v1/Capacities affordance for a page that CAN carry a cover
 * (a class binds the cover schema) but doesn't yet: a slim dashed strip in
 * the banner slot, revealed on page hover, opening the shared picker.
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

  return (
    <div className="nt-add-cover">
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
    </div>
  );
}
