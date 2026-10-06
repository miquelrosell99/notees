/**
 * Cover property self-heal — the `cover` system property exists
 * in the seed manifest (SYSTEM_PROPERTY_UUIDS.cover) but nothing authors it:
 * the server seed emits SYSTEM_PROPERTY_SPECS only, and the migration import is
 * the only other writer. A fresh workspace therefore has no cover schema and
 * no surface could ever set one — the page banner would be dead chrome.
 *
 * Following the ensureTaskFamily precedent: author the schema
 * idempotently at the reserved id (type `image`, the designed mapping). A complete
 * no-op once present. Safe under both WorkspaceClient and WorkerClient —
 * it composes only the shared write surface (createPropertySchema) and sync
 * reads.
 *
 * The value shape is the shared node-reference record `{ nodeId }` (the same
 * shape object/date property values carry); for a cover the target is an
 * asset-classed node whose bytes render through `assetImageUrl`
 * (views/assetThumbs.ts). This is the first real renderer of the `image`
 * property type (the image type's long-empty schema row).
 *
 * (owner directive 2026-10-04): the dedicated `cover` system class
 * is DROPPED — it duplicated the property's meaning. A cover is an ordinary
 * ASSET-classed node; the property value is the only authority and the
 * card-view "Cover" badge derives from it (isCoverAsset below).
 *
 * 2026-10-05 (owner ruling): a cover makes no sense on SOURCES — the
 * cover→source binding row is removed from SYSTEM_EXTRA_CLASS_BINDINGS and
 * from live workspaces (scripts/migrate-system-names.mts), and this ensure
 * no longer re-authors it. The cover stays effectively global: once the
 * schema exists, ANY document-chrome node can carry the value (see
 * canHaveCoverOf).
 */

import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** True when the cover schema exists. */
export function coverPropertyPresent(
  client: Pick<AnyClient, "listPropertySchemas">,
): boolean {
  return client
    .listPropertySchemas()
    .some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.cover);
}

/**
 * Author the cover family when missing (idempotent): the image-typed cover
 * schema (plus the asset/source class roots on workspaces that do not carry
 * the seed rows yet — the meetingFamily ensure pattern). No cover CLASS
 * (withdrawn the day it shipped; covers are plain asset-classed
 * nodes, the property value is the authority) and NO source binding
 * (2026-10-05 owner ruling — a cover makes no sense on sources).
 */
export async function ensureCoverProperty(client: AnyClient): Promise<void> {
  // Fresh workspaces carry no system-class ROWS (the server seed emits
  // property specs only) — author the class roots first (the meetingFamily
  // ensure does the same for event); the cover value targets asset nodes.
  for (const [name, id, icon] of [
    ["asset", SYSTEM_CLASS_UUIDS.asset, "mdiPaperclip"],
    ["source", SYSTEM_CLASS_UUIDS.source, "mdiBookshelf"],
  ] as const) {
    if (client.getNode(id) === undefined) {
      await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id, icon });
    }
  }
  if (!client.listPropertySchemas().some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.cover)) {
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.cover,
      name: SYSTEM_PROPERTY_DISPLAY_NAMES.cover,
      type: "image",
      scope: "class",
    });
  }
}

/** The asset node id a node's cover property points at (null = no cover). */
export function coverAssetIdOf(
  client: Pick<AnyClient, "getEffectiveProperties">,
  nodeId: string,
): string | null {
  const cover = client
    .getEffectiveProperties(nodeId)
    .find((property) => property.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover);
  const target = cover?.value as { nodeId?: unknown } | undefined;
  return typeof target?.nodeId === "string" ? target.nodeId : null;
}

/**
 * True when the node COULD carry a cover. The original cover was a GLOBAL property
 * (any page) — the original read treated it as the source binding only, hiding the
 * cover from every other page (owner bug 2026-10-04: "I don't see the cover
 * element in page view"). The honest global rule: once the cover schema
 * exists, ANY document-chrome node can carry the value — authored values
 * surface in the effective read even without a binding (marked unbound),
 * the banner reads them directly, and setNodeCover writes them.
 */
export function canHaveCoverOf(
  client: Pick<AnyClient, "listPropertySchemas">,
  nodeId: string,
): boolean {
  void nodeId;
  return client.listPropertySchemas().some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.cover);
}

/**
 * Upload a file and set it as the node's cover: CAS upload → asset node →
 * cover value + the asset class. Shared by the picker's upload row and
 * drag-drop.
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
 * Set a node's cover: the cover property value ({nodeId} → the asset) plus
 * the asset's asset class — explicit ops, so every client converges on the
 * classIds projection (the property value stays the authority).
 */
export async function setNodeCover(
  client: AnyClient,
  pageId: string,
  assetId: string,
): Promise<void> {
  await ensureCoverProperty(client);
  await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, { nodeId: assetId }, 0);
  const node = client.getNode(assetId);
  const classIds = node?.classIds ?? [];
  if (!classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
    await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
  }
}

/** Remove a node's cover: unset the value. The asset node stays an asset. */
export async function clearNodeCover(client: AnyClient, pageId: string): Promise<void> {
  await client.unsetProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, 0);
}

/**
 * The card-view "Cover" badge, DERIVED (the retired cover class
 * used to carry this identity): an asset wears the badge when any live
 * node's cover property points at it. The property value is the authority;
 * the badge follows it with no class to keep in sync.
 */
export function isCoverAsset(
  client: Pick<AnyClient, "getLinkedReferences" | "getEffectiveProperties">,
  assetId: string,
): boolean {
  return client.getLinkedReferences(assetId).some(
    (entry) =>
      coverAssetIdOf(client, entry.source.id) === assetId ||
      coverAssetIdOf(client, entry.containingPageId) === assetId,
  );
}
