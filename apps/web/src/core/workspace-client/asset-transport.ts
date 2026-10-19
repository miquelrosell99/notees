/**
 * The asset REST transport helpers (shared by the in-process client and the
 * worker main-thread proxy): the POST /api/assets CAS upload, the
 * GET /api/assets/:id download, and the blob → data-URL convenience.
 * Pure fetch plumbing — no store, no client state.
 */

import type { AssetUploadResult } from "./types.js";

/**
 * POST /api/assets (multipart, CAS upload). The web client's upload path:
 * the server sniffs magic bytes, stores the bytes content-addressed, records
 * the asset metadata and returns the new asset id + original name. Auth is
 * the workspace API key header, same as the relay transport.
 * Shared by WorkspaceClient (in-process) and WorkerClient (main-thread proxy
 * — the worker owns the store, but the REST call needs no store).
 */
export async function postAssetUpload(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  file: Blob,
  filename: string,
): Promise<AssetUploadResult> {
  const form = new FormData();
  form.append("file", file, filename);
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/assets`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "X-Workspace-Id": workspaceId },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`asset upload failed: HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as Partial<AssetUploadResult>;
  if (
    typeof body.assetId !== "string" ||
    typeof body.originalName !== "string" ||
    typeof body.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.hash)
  ) {
    throw new Error("asset upload failed: response missing assetId/originalName/hash");
  }
  return {
    assetId: body.assetId,
    hash: body.hash,
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream",
    size: typeof body.size === "number" ? body.size : file.size,
    originalName: body.originalName,
  };
}

/**
 * GET /api/assets/:id (auth; Range-capable). Fetched with the API key
 * header (a bare window.open cannot set headers), then opened as a blob URL
 * so the chip click lands in a new tab without leaking the key into a URL.
 */
export async function fetchAssetBlob(
  serverUrl: string,
  apiKey: string,
  assetId: string,
  workspaceId?: string,
): Promise<Blob> {
  const response = await fetch(
    `${serverUrl.replace(/\/$/, "")}/api/assets/${encodeURIComponent(assetId)}`,
    {
      // The workspace header is load-bearing: asset bytes live under the
      // workspace's own directory server-side, so without it the route
      // resolves the default workspace and 404s every non-default fetch
      // (2026-10-04: covers rendered "No image bytes" in worker AND
      // in-process modes for exactly this reason).
      headers: {
        "X-API-Key": apiKey,
        ...(workspaceId !== undefined ? { "X-Workspace-Id": workspaceId } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`asset download failed: HTTP ${response.status}`);
  }
  return response.blob();
}

/** Blob → data URL (image thumbnails/covers); null on read failure. */
export function readBlobAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
