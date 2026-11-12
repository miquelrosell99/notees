/**
 * The asset REST transport helpers (shared by the in-process client and the
 * worker main-thread proxy): the POST /api/assets CAS upload, the
 * GET /api/assets/:id download, and the blob → data-URL convenience.
 * Pure fetch plumbing — no store, no client state.
 */

import { openAssetIfSealed, sealAssetIfKeyed } from "./asset-crypto.js";
import type { AssetUploadResult } from "./types.js";

/**
 * POST /api/assets (multipart, CAS upload). The web client's upload path:
 * the server sniffs magic bytes, stores the bytes content-addressed, records
 * the asset metadata and returns the new asset id + original name. Auth is
 * the workspace API key header, same as the relay transport.
 * Shared by WorkspaceClient (in-process) and WorkerClient (main-thread proxy
 * — the worker owns the store, but the REST call needs no store).
 */
export interface AssetSealFields {
  encrypted: string;
  mimeType: string;
  iv: string;
}

export async function postAssetUpload(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  file: Blob,
  filename: string,
  sealedFields?: AssetSealFields | undefined,
): Promise<AssetUploadResult> {
  const form = new FormData();
  if (sealedFields !== undefined) {
    // Declared-encrypted upload (plan 05): the server trusts the declared
    // mime and skips sniffing ONLY on this arm.
    form.append("encrypted", sealedFields.encrypted);
    form.append("mimeType", sealedFields.mimeType);
    form.append("iv", sealedFields.iv);
  }
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
export interface AssetBlob {
  blob: Blob;
  /** b64u 12-byte GCM nonce when the asset is sealed; null = plaintext. */
  iv: string | null;
}

export async function fetchAssetBlob(
  serverUrl: string,
  apiKey: string,
  assetId: string,
  workspaceId?: string,
): Promise<AssetBlob> {
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
  return { blob: await response.blob(), iv: response.headers.get("x-notees-asset-iv") };
}

/**
 * The shared upload recipe both clients ride: seal the bytes at the CAS
 * boundary when the workspace is keyed (plan 05; keyless stays plaintext),
 * then POST /api/assets. The REST channel never enters the worker — this
 * runs on the main thread in both modes.
 */
export async function sealAndUploadAsset(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  file: Blob,
  filename: string,
): Promise<AssetUploadResult> {
  const sealed = await sealAssetIfKeyed(
    serverUrl,
    apiKey,
    workspaceId,
    await blobBytes(file),
    file.type || "application/octet-stream",
  );
  return postAssetUpload(
    serverUrl,
    apiKey,
    workspaceId,
    new Blob([sealed.bytes as BlobPart]),
    filename,
    sealed.fields ?? undefined,
  );
}

/**
 * The shared download recipe both clients ride: GET /api/assets/:id
 * (workspace header load-bearing), open the bytes when sealed (plaintext
 * passes through), return a Blob of the opened bytes.
 */
export async function fetchAndOpenAsset(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  assetId: string,
): Promise<Blob> {
  const { blob, iv } = await fetchAssetBlob(serverUrl, apiKey, assetId, workspaceId);
  const opened = await openAssetIfSealed(workspaceId, iv, await blobBytes(blob));
  return new Blob([opened as BlobPart], { type: blob.type });
}

/**
 * The shared fetch → open → data-URL tail of the image-asset read (card
 * covers / thumbnails). Sealed-without-key and decrypt failures both land
 * in the null — the card renders the honest no-image fallback, never
 * corrupted bytes. Each caller keeps its own prologue (the info lookup).
 */
export async function fetchAssetDataUrl(
  serverUrl: string,
  apiKey: string,
  workspaceId: string,
  assetId: string,
): Promise<string | null> {
  try {
    const fetched = await fetchAssetBlob(serverUrl, apiKey, assetId, workspaceId);
    const opened = await openAssetIfSealed(
      workspaceId,
      fetched.iv,
      await blobBytes(fetched.blob),
    );
    return await readBlobAsDataUrl(new Blob([opened as BlobPart], { type: fetched.blob.type }));
  } catch {
    return null;
  }
}

/** Blob → bytes. `Blob.arrayBuffer` is absent in older DOM shims (jsdom) — FileReader fallback. */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
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
