/**
 * PageBanner — the page cover above the title (§34.27 L2, decision D2):
 * the node's `cover` property (an image property — value shape `{ nodeId }`
 * pointing at an asset-classed node) rendered as header chrome over the
 * `--page-cover-height` budget. Click collapses/expands; the collapse flag
 * is device-local per page (device state, never an op).
 *
 * Absence is the fallback: no cover value, unresolvable asset bytes, an
 * embedded feed entry, or a whiteboard page → nothing renders (date pages
 * carry no cover binding by construction — the schema binds to `source`
 * only — so they naturally land here too).
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { assetImageUrl } from "../views/assetThumbs.js";
import { useCoverCollapsed } from "../viewPrefs.js";
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

  return (
    <button
      type="button"
      className={collapsed ? "nt-page-banner nt-page-banner--collapsed" : "nt-page-banner"}
      aria-label={collapsed ? "Expand cover image" : "Collapse cover image"}
      aria-pressed={collapsed}
      title={collapsed ? "Expand cover" : "Collapse cover"}
      onClick={() => setCollapsed(!collapsed)}
    >
      {!collapsed && <img className="nt-page-banner__img" src={url} alt="" />}
    </button>
  );
}
