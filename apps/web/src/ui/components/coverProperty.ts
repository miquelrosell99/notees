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

/** Author the cover schema + source binding when missing (idempotent). */
export async function ensureCoverProperty(client: AnyClient): Promise<void> {
  if (coverPropertyPresent(client)) return;
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
