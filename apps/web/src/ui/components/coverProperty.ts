/**
 * The cover read/write seam — the `coverAssetId` WIRE NODE FIELD
 * (SCHEMA.md "Node structure", the icon/color precedent): the cover is a
 * platform-fixed node fundamental, NOT a property. The retired image-typed
 * `cover` property assertions were superseded by the wire-fields slice
 * (object.update carries the field; present-null clears; row LWW like
 * icon/color) and the migrate-cover-banner-alias log rewrite moves every
 * stored value onto the field. Every read below goes through the node
 * column, so a cover set by ANY client (the web card, the CLI, the API,
 * the migration) shows in the header card — the banner's exact precedent
 * (PageBanner.tsx bannerAssetIdOf/setNodeBanner).
 *
 * A cover IS an ordinary ASSET-classed node; the property value used to be
 * the authority, the wire field is now. The card-view "Cover" badge derives
 * from the field (isCoverAsset below — no class to keep in sync).
 *
 * The upload gesture: the empty card's "Add cover" opens the
 * AssetUploadModal directly — image-only (accept="image/*"), validated,
 * with preview + progress — and the uploaded asset node becomes the cover
 * (uploadCoverAsset: CAS upload → asset node → attach → the field + the
 * asset class). The Change path keeps the CoverPicker (search existing
 * assets, or "Upload new cover…" which routes to the same modal).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * The asset node id a node's `coverAssetId` wire field carries
 * (null = unset). The node-column read, the bannerAssetIdOf precedent.
 */
export function coverAssetIdOf(
  client: Pick<AnyClient, "getNode">,
  nodeId: string,
): string | null {
  return client.getNode(nodeId)?.coverAssetId ?? null;
}

/**
 * Upload a file and set it as the node's cover: CAS upload → asset node →
 * attach → the wire field + the asset class. Shared by the picker's upload
 * row and drag-drop.
 */
export async function uploadCoverAsset(
  client: AnyClient,
  pageId: string,
  file: File,
): Promise<void> {
  const uploaded = await client.uploadAsset(file, file.name);
  const assetNodeId = await client.createObject({
    presentAsMain: true,
    name: uploaded.originalName,
    classIds: [SYSTEM_CLASS_UUIDS.asset],
  });
  await client.attachAsset(assetNodeId, uploaded);
  await setNodeCover(client, pageId, assetNodeId);
}

/**
 * Set a node's cover: the `coverAssetId` object.update field + the asset's
 * asset class — explicit ops, so every client converges on the classIds
 * projection (the wire field is the authority, the setNodeBanner shape).
 */
export async function setNodeCover(
  client: AnyClient,
  pageId: string,
  assetId: string,
): Promise<void> {
  await client.updateObject(pageId, { coverAssetId: assetId });
  const node = client.getNode(assetId);
  const classIds = node?.classIds ?? [];
  if (!classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
    await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
  }
}

/** Remove a node's cover (present-null clears the field). The asset stays. */
export async function clearNodeCover(client: AnyClient, pageId: string): Promise<void> {
  await client.updateObject(pageId, { coverAssetId: null });
}

/**
 * The card-view "Cover" badge, DERIVED (the retired cover class used to
 * carry this identity): an asset wears the badge while any live node's
 * cover field points at it. The wire field is the authority; the badge
 * follows it with no class to keep in sync. The node-column probe
 * (getCoverReferences), not getLinkedReferences — the wire node fields are
 * not mined into the edge index yet (the backlinks follow-on owns that).
 */
export function isCoverAsset(
  client: Pick<AnyClient, "getCoverReferences">,
  assetId: string,
): boolean {
  return client.getCoverReferences(assetId).length > 0;
}
