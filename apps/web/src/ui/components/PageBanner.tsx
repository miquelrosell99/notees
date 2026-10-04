/**
 * PageBanner — the page cover above the title (§34.27 L2, decision D2;
 * §34.56 covers-v2): the node's `cover` property (an image property — value
 * shape `{ nodeId }` pointing at an asset-classed node, itself classed
 * `cover` extending `asset`) rendered as header chrome over the
 * `--page-cover-height` budget. Click collapses/expands; the collapse flag
 * is device-local per page (device state, never an op).
 *
 * Hover reveals the cover toolbar (§34.56, v1-parity+): Change cover…
 * (pick an existing asset or upload a new one — the picked/uploaded asset
 * gains the cover+asset classes through explicit ops) and Remove cover
 * (the asset's cover class survives only while another node still covers
 * with it).
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
import { clearNodeCover, setNodeCover } from "./coverProperty.js";
import "./PageBanner.css";

type AnyClient = WorkspaceClient | WorkerClient;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const pickCover = async (assetNodeId: string) => {
    setPickerOpen(false);
    setError(null);
    try {
      await setNodeCover(client, pageId, assetNodeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const uploadCover = async (file: File) => {
    setPickerOpen(false);
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
          disabled={busy}
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
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            void removeCover();
          }}
        />
      </div>
      {pickerOpen && pickerAnchor !== null && (
        <div className="nt-page-banner__picker">
          <NodeSelector
            client={client}
            searchMode="pages"
            classFilters={[SYSTEM_CLASS_UUIDS.asset]}
            anchorEl={pickerAnchor}
            onClose={() => setPickerOpen(false)}
            searchPlaceholder="Search assets…"
            onAdd={(node) => void pickCover(node.id)}
          />
          <button
            type="button"
            className="nt-page-banner__upload"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload new cover…
          </button>
        </div>
      )}
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
        <p role="alert" className="nt-page-banner__error">
          {error}
        </p>
      )}
    </div>
  );
}
