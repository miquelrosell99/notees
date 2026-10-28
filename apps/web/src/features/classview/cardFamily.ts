/**
 * Card family authoring — the ensureTaskFamily precedent, card-shaped
 * (memorization cards slice). The six SRS schedule schemas (reserved UUIDs
 * + canonical names/types in @notees/domain seeds as CARD_FAMILY_SEED /
 * CARD_PROPERTY_UUIDS) exist as constants + applier-side seed-ensure only:
 * nothing authored them, so a workspace missing them could never schedule a
 * card.
 *
 * ensureCardFamily authors the six schemas idempotently at their reserved
 * ids (the propertySchema.create upsert is a no-op when the row exists) plus
 * the card-class bindings when missing, and is a complete no-op once
 * present. Safe under both WorkspaceClient and WorkerClient — it composes
 * only the shared write surface (createPropertySchema / setClassProperty)
 * and sync reads (listPropertySchemas / getClassBindings / getNodeRaw), all
 * RPC-mirrored.
 *
 * All six schemas are scalar (one datetime, five numbers) — no select-option
 * pass, no restyle upgrade. All seed UNPINNED (the 2026-10-27 pinned roster
 * is frozen), so bindings land with an empty fields object. Schemas are
 * created with GLOBAL scope (no scopeClassIds) — exactly how
 * ensureTaskFamily does it; the bindings below stay per-class config with
 * zero availability semantics.
 *
 * Unlike ensureTaskFamily, the card class NODE is never self-healed here:
 * `card` is an always-on system class owned by the server seed/deploy
 * paths. When the node is genuinely absent (never seeded) the schemas still
 * self-heal, but the binding pass is skipped rather than fabricating a
 * class — getClassBindings could not see the rows anyway (binding rows
 * attach to a class that does not exist), and every open would re-author
 * them (op-log noise).
 */

import { CARD_FAMILY_SEED, CARD_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientPropertySchema, WorkspaceClient } from "@/core/workspace-client/index.js";

/** The composed write/read surface both full clients (and the outliner
 *  context's `OutlinerClient & OutlinerReader`, which the full client
 *  satisfies) implement — RPC-mirrored, so the structural pick is safe. */
export type CardFamilyClient = Pick<
  WorkspaceClient,
  | "listPropertySchemas"
  | "getClassBindings"
  | "getNodeRaw"
  | "createPropertySchema"
  | "setClassProperty"
>;

/** True when every card schema is present and bound to the card class. */
export function cardFamilyPresent(
  client: Pick<CardFamilyClient, "listPropertySchemas" | "getClassBindings">,
): boolean {
  const schemas = client.listPropertySchemas();
  const have = new Set<string>(schemas.map((schema: ClientPropertySchema) => schema.id));
  const bound = new Set(
    client.getClassBindings(SYSTEM_CLASS_UUIDS.card).map((binding) => binding.propertySchemaId),
  );
  return CARD_FAMILY_SEED.every((spec) => {
    const id = CARD_PROPERTY_UUIDS[spec.property];
    return have.has(id) && bound.has(id);
  });
}

/**
 * Author the six card property schemas + card-class bindings when missing;
 * a no-op when present (idempotent — safe to call on every open). The card
 * class node is expected from the server seed (always-on system class); a
 * workspace that never got one self-heals the schemas only — the binding
 * pass is skipped rather than fabricating the class node (see the module
 * comment).
 */
export async function ensureCardFamily(client: CardFamilyClient): Promise<void> {
  if (cardFamilyPresent(client)) return;
  const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
  for (const spec of CARD_FAMILY_SEED) {
    const id = CARD_PROPERTY_UUIDS[spec.property];
    if (!have.has(id)) {
      await client.createPropertySchema({
        id,
        name: spec.name,
        type: spec.type,
        // Global scope (exactly like the task family): absent scopeClassIds =
        // any node may carry it; the card-class bindings below are per-class
        // config with zero availability semantics.
      });
    }
  }
  // The card class is an always-on system seed — never fabricated here. When
  // the node is genuinely absent the bindings are skipped (they would attach
  // to nothing and re-author on every open).
  if (client.getNodeRaw(SYSTEM_CLASS_UUIDS.card) === undefined) return;
  const bound = new Set(
    client.getClassBindings(SYSTEM_CLASS_UUIDS.card).map((binding) => binding.propertySchemaId),
  );
  for (const spec of CARD_FAMILY_SEED) {
    const id = CARD_PROPERTY_UUIDS[spec.property];
    if (bound.has(id)) continue;
    // No pinning: the whole card family seeds unpinned (the 2026-10-27
    // pinned roster is frozen) — the empty fields object binds only.
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.card, id, {});
  }
}
