/**
 * property-drop — the S5 block-to-property drop (owner ruling
 * 2026-10-20): dragging a block from the owner's body onto a text-property
 * row makes the block the value's carrier. The carrier model already IS
 * "child block + {nodeId} value reference" — the gesture composes the
 * existing property.set (PG5 elementId for the multi append); the block
 * stays in the tree and its render zone switches body→panel by the
 * existing carrier rule. No wire change.
 *
 * The decision matrix (planPropertyDrop / propertyDropVerdict — pure, the
 * test surface):
 *
 *  - GARBAGE: the dragged block IS the owner or an ancestor of it can
 *    never be a child-of-owner carrier → noop.
 *  - SAME-OWNER ONLY: the block's parent must be the property's owner
 *    node (cross-node drags are not offered).
 *  - ELIGIBILITY (R3's applier guard is the backstop): the schema's
 *    scopeClassIds must include the owner (extends-aware) — an ineligible
 *    schema's drop target is never offered.
 *  - TEXT SLOTS ONLY: the row component registers the droppable, this is
 *    the backstop.
 *  - SINGLE slot: EMPTY → one property.set {value:{nodeId}} at idx 0 (the
 *    placeholder convention); OCCUPIED → noop — never an overwrite.
 *  - MULTI slot: APPEND — property.set at nextIdx with a fresh writer-
 *    minted UUIDv7 elementId (the PG5 OR-Set add; a block already serving
 *    another slot may be dropped again — shared carriers are legal).
 */

import { uuidv7 } from "uuidv7";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClientNode,
  WorkspaceClient,
} from "@/core/workspace-client/index.js";

import { isSchemaEligibleForNode } from "../features/metadata/schemaEligibility.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** The droppable id a text-property row registers under (its namespace —
 *  never a block id, so the host can tell a property drop from a move). */
export function workspacePropertyDropId(ownerNodeId: string, schemaId: string): string {
  return `workspace-prop-drop:${ownerNodeId}:${schemaId}`;
}

export interface PropertyDropArgs {
  /** The dragged block (the grip row; the lead of a selection stack). */
  blockId: string;
  /** The property's owner node (the panel's node). */
  ownerNodeId: string;
  propertySchemaId: string;
}

export type PropertyDropVerdict = "set" | "append" | "noop";

export type PropertyDropPlan =
  | { kind: "noop" }
  | { kind: "set"; idx: number }
  | { kind: "append"; idx: number; elementId: string };

/** The decision matrix without minting anything (the hover affordance
 *  runs this per render — uuidv7 minting stays in planPropertyDrop). */
export function propertyDropVerdict(client: AnyClient, args: PropertyDropArgs): PropertyDropVerdict {
  const owner = client.getNode(args.ownerNodeId);
  const block = client.getNode(args.blockId);
  if (owner === undefined || block === undefined) return "noop";
  // Garbage: dropping the owner onto itself, or a block that sits ABOVE
  // the owner in the tree, can never satisfy the child-of-owner carrier
  // invariant.
  let cursor: ClientNode | undefined = owner;
  for (let depth = 0; cursor !== undefined && depth < 128; depth++) {
    if (cursor.id === args.blockId) return "noop";
    cursor = cursor.parentId === null ? undefined : client.getNode(cursor.parentId);
  }
  // Same-owner only: the block stays a child of the owner; a foreign
  // block's drop is a no-op.
  if (block.parentId !== args.ownerNodeId) return "noop";
  const schema = client.listPropertySchemas().find((s) => s.id === args.propertySchemaId);
  if (schema === undefined || schema.type !== "text") return "noop";
  if (!isSchemaEligibleForNode(client, schema, owner)) return "noop";
  const authored = client
    .getEffectiveProperties(args.ownerNodeId)
    .filter((row) => row.propertySchemaId === args.propertySchemaId && row.source === "authored");
  if (!schema.multi) return authored.length === 0 ? "set" : "noop";
  return "append";
}

/** The drop decision as an executable plan (mints the PG5 elementId for
 *  the multi append). */
export function planPropertyDrop(client: AnyClient, args: PropertyDropArgs): PropertyDropPlan {
  const verdict = propertyDropVerdict(client, args);
  if (verdict === "noop") return { kind: "noop" };
  if (verdict === "set") return { kind: "set", idx: 0 };
  const authored = client
    .getEffectiveProperties(args.ownerNodeId)
    .filter((row) => row.propertySchemaId === args.propertySchemaId && row.source === "authored");
  const idx = authored.length > 0 ? Math.max(...authored.map((row) => row.idx)) + 1 : 0;
  return { kind: "append", idx, elementId: uuidv7() };
}

/** Run the plan: one property.set composing the {nodeId} carrier value. */
export async function executePropertyDrop(
  client: AnyClient,
  args: PropertyDropArgs,
  plan: PropertyDropPlan,
): Promise<void> {
  if (plan.kind === "noop") return;
  await client.setProperty(
    args.ownerNodeId,
    args.propertySchemaId,
    { nodeId: args.blockId },
    plan.idx,
    undefined,
    plan.kind === "append" ? plan.elementId : undefined,
  );
}
