/**
 * exportWorkspace — the client-side, connected-workspace zip export (plan 07
 * retired the server `export.zip` route). The bundle is built entirely from
 * the local derived store through the same machinery as the subtree export
 * (`exportSubtreeBundle` + `zipExportBundle` + `fetchSubtreeAssets`), over
 * the workspace's exportable roots — the same zip-roots exclusions the server
 * bundle applied: the system-seed pages and the date chain are journal
 * scaffolding, not exportable content.
 *
 * Capability note: the server route could bundle ANY workspace by id; the
 * local build needs the workspace's store, so export is offered for the
 * CONNECTED workspace (open it from the manager first). Ruled in plan 07.
 */

import { SYSTEM_PAGE_UUIDS, parseDateNodeId } from "@notees/domain";

import type { AnyClient } from "../../ui/app/clients.js";
import {
  collectSubtreeAssetRefIds,
  exportSubtreeBundle,
  fetchSubtreeAssets,
  zipExportBundle,
} from "./exportSubtree.js";

export interface WorkspaceExportOptions {
  includeAssets?: boolean | undefined;
  /** The display name — the zip filename source. */
  workspaceName: string;
}

export interface WorkspaceExport {
  blob: Blob;
  filename: string;
}

/** Build the full-workspace Markdown zip from the local store. */
export async function exportConnectedWorkspace(
  client: AnyClient,
  options: WorkspaceExportOptions,
): Promise<WorkspaceExport> {
  const systemPages = new Set<string>(Object.values(SYSTEM_PAGE_UUIDS));
  const includeChildPages = true;
  const rootIds = client
    .roots()
    .filter((node) => !systemPages.has(node.id) && parseDateNodeId(node.id) === null)
    .map((node) => node.id);
  const assetFiles =
    options.includeAssets === true
      ? await fetchSubtreeAssets(client, collectSubtreeAssetRefIds(client, rootIds, includeChildPages))
      : undefined;
  const bundle = exportSubtreeBundle(client, rootIds, {
    includeChildPages,
    filenamePolicy: "slug",
    whiteboardMode: "sidecar",
    ...(assetFiles !== undefined ? { assetPath: (assetId: string) => assetFiles.get(assetId)?.path } : {}),
  });
  const blob = new Blob([zipExportBundle(bundle, assetFiles)], { type: "application/zip" });
  const slug =
    options.workspaceName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "workspace";
  const day = new Date().toISOString().slice(0, 10);
  return { blob, filename: `${slug}-${day}.zip` };
}
