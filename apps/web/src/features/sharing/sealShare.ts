/**
 * Key-in-fragment share publishing (plan 08, spec §4).
 *
 * The publisher renders the shared subtree to self-contained HTML, seals it
 * with a FRESH random 256-bit share key, and the server stores ONLY the
 * ciphertext — the key never leaves this device except in the link's
 * `#fragment`. Sealed artifact format (the viewer in apps/server's
 * share-viewer.ts is the other half): random 12-byte IV, blob
 * iv(12) ‖ tag(16) ‖ ct, b64u when carried.
 *
 * Asset tokens render as placeholders in the artifact (the export
 * serializer never embeds bytes) — a sealed share is text-only by
 * construction, so nothing but the rendered subtree can leak.
 */

import { b64uEncode } from "@notees/protocol";

import { blobBytes } from "../../core/workspace-client/asset-transport.js";
import { exportSubtreeFile, type ExportClient } from "../export/exportSubtree.js";
import { createShare, putShareArtifact, type ShareEntry } from "./shareApi.js";

export interface SealedShare {
  entry: ShareEntry;
  /** The full link — server origin + urlPath + `#<b64u key>`. */
  url: string;
  /** The raw 32-byte key (for tests; the modal only needs the URL). */
  keyBytes: Uint8Array;
}

/** Seal one self-contained HTML document; returns the artifact (b64u iv‖tag‖ct) and the key. */
export async function sealShareHtml(
  html: Uint8Array,
  keyBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<{ artifact: string; keyBytes: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, html as BufferSource),
  );
  // WebCrypto's seal is ct ‖ tag; the artifact layout is iv ‖ tag ‖ ct.
  const ct = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const artifact = new Uint8Array(12 + 16 + ct.length);
  artifact.set(iv, 0);
  artifact.set(tag, 12);
  artifact.set(ct, 28);
  return { artifact: b64uEncode(artifact), keyBytes };
}

/**
 * The full publish flow: mint the share, render + seal + attach the
 * artifact, return the `#key` link. `render` is injectable for tests (the
 * default renders the subtree through the export serializer).
 */
export async function publishSealedShare(
  client: ExportClient,
  serverUrl: string,
  token: string,
  nodeUuid: string,
  render: (client: ExportClient, nodeUuid: string) => Promise<Uint8Array> = defaultRender,
): Promise<SealedShare> {
  const { share } = await createShare(serverUrl, token, nodeUuid);
  const html = await render(client, nodeUuid);
  const { artifact, keyBytes } = await sealShareHtml(html);
  await putShareArtifact(serverUrl, token, share.token, artifact);
  return {
    entry: share,
    url: `${serverUrl.replace(/\/$/, "")}${share.urlPath}#${b64uEncode(keyBytes)}`,
    keyBytes,
  };
}

async function defaultRender(client: ExportClient, nodeUuid: string): Promise<Uint8Array> {
  const exported = await exportSubtreeFile(client, nodeUuid, { format: "html" });
  return blobBytes(exported.blob);
}
