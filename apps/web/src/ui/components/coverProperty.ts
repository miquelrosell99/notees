/**
 * Cover property self-heal (§34.27 L2) — the `cover` system property exists
 * in the seed manifest (SYSTEM_PROPERTY_UUIDS.cover + the source-class
 * binding row in SYSTEM_EXTRA_CLASS_BINDINGS) but nothing authors it: the
 * server seed emits SYSTEM_PROPERTY_SPECS only, and the v1 migration is the
 * only other writer. A fresh workspace therefore has no cover schema and no
 * surface could ever set one — the page banner would be dead chrome.
 *
 * Following the ensureTaskFamily precedent (§34.28 #2): author the schema
 * idempotently at the reserved id (type `image`, the v1 mapping) plus the
 * source-class binding when missing; a complete no-op once present. Safe
 * under both WorkspaceClient and WorkerClient — it composes only the shared
 * write surface (createPropertySchema / setClassProperty) and sync reads.
 *
 * The value shape is the shared node-reference record `{ nodeId }` (the same
 * shape object/date property values carry); for a cover the target is an
 * asset-classed node whose bytes render through `assetImageUrl`
 * (views/assetThumbs.ts). This is the first real renderer of the `image`
 * property type (§34.32 PG14's zombie row).
 */

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The cover class id (§34.56 — cover extends asset). */
export const COVER_CLASS_ID: string = SYSTEM_CLASS_UUIDS.cover;

/** True when the cover schema exists and the source class binds it. */
export function coverPropertyPresent(
  client: Pick<AnyClient, "listPropertySchemas" | "getClassBindings">,
): boolean {
  const have = client.listPropertySchemas().some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.cover);
  const bound = client
    .getClassBindings(SYSTEM_CLASS_UUIDS.source)
    .some((binding) => binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover);
  return have && bound;
}

/**
 * Author the cover family when missing (idempotent): the `cover` class at
 * its reserved id extending `asset` (§34.56), the image-typed cover schema,
 * and the source binding. The class gives cover assets identity — the
 * "Cover" badge in card views, the asset class's classed-nodes listing,
 * and the future cover-specific logic.
 */
export async function ensureCoverFamily(client: AnyClient): Promise<void> {
  // Fresh workspaces carry no system-class ROWS (the server seed emits
  // property specs only) — author the class roots first (the meetingFamily
  // ensure does the same for event): the cover family extends asset, and
  // the schema binds to source.
  for (const [name, id, icon] of [
    ["asset", SYSTEM_CLASS_UUIDS.asset, "mdiPaperclip"],
    ["source", SYSTEM_CLASS_UUIDS.source, "mdiBookshelf"],
    ["cover", COVER_CLASS_ID, "mdiImageArea"],
  ] as const) {
    if (client.getNode(id) === undefined) {
      await client.createClass(name, { id, icon });
    }
  }
  const parents = client.getClassParents(COVER_CLASS_ID);
  if (!parents.includes(SYSTEM_CLASS_UUIDS.asset)) {
    await client.setClassExtends(COVER_CLASS_ID, [SYSTEM_CLASS_UUIDS.asset]);
  }
  if (!client.listPropertySchemas().some((schema) => schema.id === SYSTEM_PROPERTY_UUIDS.cover)) {
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.cover,
      name: "cover",
      type: "image",
      scope: "class",
    });
  }
  // Binding sequence 7 lands the row after the seeded source specs (the seed
  // manifest's SYSTEM_EXTRA_CLASS_BINDINGS sequence); the read model sorts
  // by (sequence, schema id) so any tie still orders deterministically.
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.source, SYSTEM_PROPERTY_UUIDS.cover, {
    sequence: 7,
  });
}

/** @deprecated Renamed — ensureCoverFamily authors the class too. */
export const ensureCoverProperty = ensureCoverFamily;

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
 * True when the node COULD carry a cover. v1's cover was a GLOBAL property
 * (any page) — §34.59-era read it as the source binding only, hiding the
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
 * cover value + classes. Shared by the picker's upload row and drag-drop.
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
 * the asset's cover+asset classes — explicit ops, so every client converges
 * on the classIds projection (the property value stays the authority; the
 * class is identity/chrome, derived by the client's cover flows).
 */
export async function setNodeCover(
  client: AnyClient,
  pageId: string,
  assetId: string,
): Promise<void> {
  await ensureCoverFamily(client);
  await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, { nodeId: assetId }, 0);
  const node = client.getNode(assetId);
  const classIds = node?.classIds ?? [];
  for (const classId of [COVER_CLASS_ID, SYSTEM_CLASS_UUIDS.asset]) {
    if (!classIds.includes(classId)) await client.assignClass(assetId, classId);
  }
}

/**
 * Remove a node's cover: unset the value; the asset's cover class follows
 * only when no OTHER node still covers with it (the asset class always
 * stays — the node remains an asset).
 */
export async function clearNodeCover(client: AnyClient, pageId: string): Promise<void> {
  const assetId = coverAssetIdOf(client, pageId);
  await client.unsetProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, 0);
  if (assetId === null) return;
  const stillUsed = client
    .getLinkedReferences(assetId)
    .some(
      (entry) =>
        entry.source.id !== pageId &&
        (coverAssetIdOf(client, entry.source.id) === assetId ||
          coverAssetIdOf(client, entry.containingPageId) === assetId),
    );
  if (!stillUsed) await client.unassignClass(assetId, COVER_CLASS_ID);
}
