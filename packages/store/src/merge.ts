/**
 * Node merge planner (SCHEMA.md "Node merge"): merge a source node into a
 * target node as ONE deterministic plan of EXISTING op types — no new wire
 * op. The plan is computed once from the planner's read-time state, then
 * applied op-by-op (web: one undo-journal batch through the local store;
 * server: one ingested batch; the CLI calls the server route). Every op is
 * an ordinary convergent op, so GTK/Flutter clients converge on a merge by
 * replay without any applier change (the fixture-gate law for new op types
 * does not apply — the wire is untouched).
 *
 * Semantics (the v1 mergePages port, extended to the v2 model):
 *  1. children — the source's ACTIVE children move to the target, relative
 *     order preserved (sequential object.move with afterId chaining).
 *  2. class/tag bindings — re-issued object.create add carriers for the
 *     target + class.unassign/tag.unassign on the source (OR-Set remap).
 *  3. properties — authored values copy source → target: single-value slots
 *     only when the target has none (target wins), multi-value slots append
 *     value-distinct elements under fresh PG5 element ids. Node references
 *     to the source inside copied values/metadata rewrite to the target.
 *  4. content links — every active node's contentAst gets its mention
 *     tokens pointing at the source retargeted to the target
 *     (object.update contentAst; the edge index re-derives).
 *  5. aliases — nodes aliasing the source repoint to the target.
 *  6. property references — node-typed property values (object/asset refs,
 *     datetime anchors, date-qualified metadata) on any active node that
 *     point at the source rewrite to the target (property.set re-addressing
 *     the same element id — LWW overwrite, convergent).
 *  7. collections — memberships of the source remap to the target.
 *  8. wire fields — cover/banner/description copy only when the target has
 *     none.
 *  9. the source trashes (object.delete permanent:false, LAST — every other
 *     leg reads source state at plan time, and the delete must not race its
 *     own plan's application).
 *
 * Guards fail loud (MergeGuardError) before ANY op is emitted: either node
 * missing/inactive, either node a class, source === target, the target
 * inside the source's subtree (trashing the source would trash the
 * target), or the source being a non-empty collection (membership remap
 * into an arbitrary node is out of scope — loud, never silent).
 */

import { uuidv7 } from "uuidv7";

import type { OpType } from "@notees/protocol";

import { parseContentAst } from "./content.js";
import { visiblePropertyValueRows, type VisiblePropertyValueRow } from "./property-values.js";
import type { StoreDatabase } from "./types.js";

export interface MergePlanOp {
  opType: OpType;
  payload: Record<string, unknown>;
}

export interface MergePlanSummary {
  childrenMoved: number;
  classesRemapped: number;
  tagsRemapped: number;
  /** Authored property values copied source → target. */
  propertiesCopied: number;
  /** Single-value slots skipped because the target already has a value. */
  propertiesSkipped: number;
  /** Content updates rewriting mention tokens that pointed at the source. */
  contentLinksRewritten: number;
  /** property.set rewrites of node-typed values referencing the source. */
  propertyValuesRewritten: number;
  /** Alias nodes repointed from the source to the target. */
  aliasesRepointed: number;
  /** Collection memberships remapped source → target. */
  collectionsRemapped: number;
  /** Wire fields (cover/banner/description) copied to an empty target. */
  fieldsCopied: number;
}

export interface MergePlan {
  sourceId: string;
  targetId: string;
  /** The ops, in application order — the source trash is always last. */
  ops: MergePlanOp[];
  summary: MergePlanSummary;
}

export class MergeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeGuardError";
  }
}

interface NodeLite {
  id: string;
  workspace_id: string;
  is_class: number;
  parent_id: string | null;
  class_ids: string;
  tag_ids: string;
  cover_asset_id: string | null;
  banner_asset_id: string | null;
  description: string | null;
  is_active: number;
}

function mustGet(db: StoreDatabase, id: string, role: "source" | "target"): NodeLite {
  const row = db.prepare("SELECT * FROM node WHERE id = ?").get(id) as NodeLite | undefined;
  if (!row) throw new MergeGuardError(`merge ${role} node ${id} does not exist`);
  if (row.is_active !== 1) throw new MergeGuardError(`merge ${role} node ${id} is trashed`);
  if (row.is_class === 1) throw new MergeGuardError(`merge ${role} node ${id} is a class`);
  return row;
}

/** JSON with recursively sorted keys — value-equality for dedup decisions. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Deep rewrite of `{ nodeId: <from> }` references — property values
 * (object/asset refs), datetime slots ({nodeId, time?} nesting included)
 * and date-qualified metadata ({startDate/endDate: {nodeId}}). Anywhere the
 * key appears in a JSON object, at any depth.
 */
export function rewriteNodeRefs(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteNodeRefs(v, from, to));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "nodeId" && v === from ? to : rewriteNodeRefs(v, from, to);
    }
    return out;
  }
  return value;
}

/** True when rewriteNodeRefs would change anything (skip no-op updates). */
function referencesNode(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => referencesNode(v, id));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => (k === "nodeId" && v === id) || referencesNode(v, id),
    );
  }
  return false;
}

/** Deep-rewrite mention tokens (`{type:"mention", targetNodeId}`) in a
 * contentAst; returns the rewritten AST plus whether anything changed. */
export function rewriteMentionTargets(
  ast: readonly unknown[],
  from: string,
  to: string,
): { ast: unknown[]; changed: boolean } {
  let changed = false;
  const walk = (tokens: readonly unknown[]): unknown[] =>
    tokens.map((token) => {
      if (Array.isArray(token)) return walk(token);
      if (typeof token !== "object" || token === null) return token;
      const t = token as Record<string, unknown>;
      const rewritten: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) {
        if (k === "children" && Array.isArray(v)) {
          rewritten[k] = walk(v);
        } else if (k === "targetNodeId" && t.type === "mention" && v === from) {
          rewritten[k] = to;
          changed = true;
        } else {
          rewritten[k] = v;
        }
      }
      return rewritten;
    });
  const result = walk(ast);
  return { ast: result, changed };
}

/** Subtree containment check (parent chain walk — the tree is shallow). */
function isInSubtree(db: StoreDatabase, ancestorId: string, nodeId: string): boolean {
  let cur = db.prepare("SELECT parent_id FROM node WHERE id = ?").get(nodeId) as
    | { parent_id: string | null }
    | undefined;
  let guard = 0;
  while (cur?.parent_id != null && guard < 10_000) {
    if (cur.parent_id === ancestorId) return true;
    cur = db.prepare("SELECT parent_id FROM node WHERE id = ?").get(cur.parent_id) as
      | { parent_id: string | null }
      | undefined;
    guard += 1;
  }
  return false;
}

interface SchemaLite {
  id: string;
  multi: number;
}

/**
 * Compute the merge plan. `db` is a derived-store handle (web local store,
 * server projection — both the TS implementation, the only merge planner
 * that exists; GTK/Flutter converge by replaying the resulting ops). Pure
 * read + pure op list: same inputs → same plan (multi-value element ids are
 * minted here, so a plan is a one-shot artifact — do not re-plan expecting
 * identical ids).
 */
export function planMerge(db: StoreDatabase, sourceId: string, targetId: string): MergePlan {
  const source = mustGet(db, sourceId, "source");
  const target = mustGet(db, targetId, "target");

  if (sourceId === targetId) {
    throw new MergeGuardError("merge source and target must be different nodes");
  }
  if (isInSubtree(db, sourceId, targetId)) {
    throw new MergeGuardError(
      "merge target is inside the source's subtree — trashing the source would trash the target",
    );
  }
  const collectionMember = db
    .prepare("SELECT 1 FROM collection_member WHERE collection_id = ? AND present = 1 LIMIT 1")
    .get(sourceId);
  if (collectionMember !== undefined) {
    throw new MergeGuardError(
      "merge source is a non-empty collection — collection merges are not supported",
    );
  }

  const ops: MergePlanOp[] = [];
  const summary: MergePlanSummary = {
    childrenMoved: 0,
    classesRemapped: 0,
    tagsRemapped: 0,
    propertiesCopied: 0,
    propertiesSkipped: 0,
    contentLinksRewritten: 0,
    propertyValuesRewritten: 0,
    aliasesRepointed: 0,
    collectionsRemapped: 0,
    fieldsCopied: 0,
  };

  // 1. children — active children move, relative order preserved.
  const childRows = db
    .prepare(
      `SELECT n.id AS id, n.is_active AS is_active
       FROM node n JOIN node_child_order o ON o.child_id = n.id
       WHERE o.parent_id = ? ORDER BY o.position`,
    )
    .all(sourceId) as { id: string; is_active: number }[];
  const activeChildren = childRows.filter((r) => r.is_active === 1).map((r) => r.id);
  let prevChild: string | undefined;
  for (const childId of activeChildren) {
    const payload: Record<string, unknown> = { objectId: childId, parentId: targetId };
    if (prevChild !== undefined) payload.afterId = prevChild;
    ops.push({ opType: "object.move", payload });
    prevChild = childId;
  }
  summary.childrenMoved = activeChildren.length;

  // 2. class/tag bindings — add carriers for the target, tombstones for the
  //    source (the OR-Set remap).
  const sourceClassIds = JSON.parse(source.class_ids || "[]") as string[];
  const sourceTagIds = JSON.parse(source.tag_ids || "[]") as string[];
  for (const classId of sourceClassIds) {
    ops.push({ opType: "object.create", payload: { objectId: targetId, classIds: [classId] } });
    ops.push({ opType: "class.unassign", payload: { objectId: sourceId, classId } });
  }
  for (const tagId of sourceTagIds) {
    ops.push({ opType: "object.create", payload: { objectId: targetId, tagIds: [tagId] } });
    ops.push({ opType: "tag.unassign", payload: { objectId: sourceId, tagId } });
  }
  summary.classesRemapped = sourceClassIds.length;
  summary.tagsRemapped = sourceTagIds.length;

  // 3. authored properties — single-value slots fill only empty target slots
  //    (target wins); multi-value slots append value-distinct elements under
  //    fresh element ids. Self-references rewrite to the target.
  const schemas = new Map(
    (
      db
        .prepare("SELECT id, multi FROM property_schema WHERE workspace_id = ?")
        .all(source.workspace_id) as SchemaLite[]
    ).map((s) => [s.id, s]),
  );
  const sourceRows = visiblePropertyValueRows(db, sourceId);
  const targetRows = visiblePropertyValueRows(db, targetId);
  const targetValuesBySchema = new Map<string, Set<string>>();
  for (const row of targetRows) {
    const set = targetValuesBySchema.get(row.property_schema_id) ?? new Set<string>();
    set.add(canonicalJson(JSON.parse(row.value)));
    targetValuesBySchema.set(row.property_schema_id, set);
  }
  for (const row of sourceRows) {
    const schema = schemas.get(row.property_schema_id);
    const multi = schema?.multi === 1;
    const existing = targetValuesBySchema.get(row.property_schema_id);
    if (!multi && existing !== undefined && existing.size > 0) {
      summary.propertiesSkipped += 1;
      continue;
    }
    const value = rewriteNodeRefs(JSON.parse(row.value), sourceId, targetId);
    const metadata =
      row.metadata !== null
        ? rewriteNodeRefs(JSON.parse(row.metadata), sourceId, targetId)
        : undefined;
    const payload: Record<string, unknown> = {
      objectId: targetId,
      propertySchemaId: row.property_schema_id,
      value,
      idx: row.idx,
    };
    if (multi) payload.elementId = uuidv7();
    if (metadata !== undefined) payload.metadata = metadata;
    ops.push({ opType: "property.set", payload });
    const set = existing ?? new Set<string>();
    set.add(canonicalJson(value));
    targetValuesBySchema.set(row.property_schema_id, set);
    summary.propertiesCopied += 1;
  }

  // 4. content links — retarget mention tokens pointing at the source, in
  //    every active referencing node (the edge index re-derives on apply).
  const mentionSources = db
    .prepare("SELECT DISTINCT source_id FROM edge WHERE type = 'mention' AND target_id = ?")
    .all(sourceId) as { source_id: string }[];
  for (const { source_id: referrerId } of mentionSources) {
    if (referrerId === sourceId) continue;
    const row = db
      .prepare("SELECT content, is_active FROM node WHERE id = ?")
      .get(referrerId) as { content: string; is_active: number } | undefined;
    if (!row || row.is_active !== 1) continue;
    const { ast, changed } = rewriteMentionTargets(parseContentAst(row.content), sourceId, targetId);
    if (!changed) continue;
    ops.push({
      opType: "object.update",
      payload: { objectId: referrerId, contentAst: ast },
    });
    summary.contentLinksRewritten += 1;
  }

  // 5. aliases — nodes aliasing the source repoint to the target.
  const aliasRows = db
    .prepare("SELECT id FROM node WHERE aliased_node_id = ? AND is_active = 1")
    .all(sourceId) as { id: string }[];
  for (const { id } of aliasRows) {
    ops.push({ opType: "object.update", payload: { objectId: id, aliasedNodeId: targetId } });
  }
  summary.aliasesRepointed = aliasRows.length;

  // 6. property references — node-typed values/metadata on any active node
  //    referencing the source rewrite to the target. The LIKE prefilter
  //    (exact quoted uuid) keeps the scan cheap; JS verifies + rewrites.
  const needle = `%"nodeId":"${sourceId}"%`;
  const refRows = db
    .prepare(
      `SELECT pv.id AS id, pv.node_id AS node_id, pv.property_schema_id AS property_schema_id,
              pv.value AS value, pv.idx AS idx, pv.metadata AS metadata
       FROM property_value pv JOIN node n ON n.id = pv.node_id
       WHERE n.is_active = 1 AND pv.node_id != ?
         AND (pv.value LIKE ? OR (pv.metadata IS NOT NULL AND pv.metadata LIKE ?))`,
    )
    .all(sourceId, needle, needle) as VisiblePropertyValueRow[];
  for (const row of refRows) {
    const parsedValue: unknown = JSON.parse(row.value);
    const parsedMetadata: unknown = row.metadata !== null ? JSON.parse(row.metadata) : null;
    const valueChanged = referencesNode(parsedValue, sourceId);
    const metadataChanged =
      parsedMetadata !== null && referencesNode(parsedMetadata, sourceId);
    if (!valueChanged && !metadataChanged) continue;
    const payload: Record<string, unknown> = {
      objectId: row.node_id,
      propertySchemaId: row.property_schema_id,
      value: valueChanged
        ? rewriteNodeRefs(parsedValue, sourceId, targetId)
        : parsedValue,
      idx: row.idx,
      elementId: row.id,
    };
    if (metadataChanged) payload.metadata = rewriteNodeRefs(parsedMetadata, sourceId, targetId);
    else if (row.metadata !== null) payload.metadata = parsedMetadata;
    ops.push({ opType: "property.set", payload });
    summary.propertyValuesRewritten += 1;
  }

  // 7. collections — the source's memberships remap to the target.
  const membershipRows = db
    .prepare("SELECT collection_id FROM collection_member WHERE object_id = ? AND present = 1")
    .all(sourceId) as { collection_id: string }[];
  for (const { collection_id } of membershipRows) {
    ops.push({
      opType: "collection.member.add",
      payload: { collectionId: collection_id, objectId: targetId },
    });
    ops.push({
      opType: "collection.member.remove",
      payload: { collectionId: collection_id, objectId: sourceId },
    });
  }
  summary.collectionsRemapped = membershipRows.length;

  // 8. wire fields — copy only into empty target fields.
  const fieldPayload: Record<string, unknown> = { objectId: targetId };
  if (target.cover_asset_id === null && source.cover_asset_id !== null) {
    fieldPayload.coverAssetId = source.cover_asset_id;
  }
  if (target.banner_asset_id === null && source.banner_asset_id !== null) {
    fieldPayload.bannerAssetId = source.banner_asset_id;
  }
  if (target.description === null && source.description !== null) {
    fieldPayload.description = source.description;
  }
  if (Object.keys(fieldPayload).length > 1) {
    ops.push({ opType: "object.update", payload: fieldPayload });
    summary.fieldsCopied = Object.keys(fieldPayload).length - 1;
  }

  // 9. trash the source — ALWAYS last.
  ops.push({
    opType: "object.delete",
    payload: { objectId: sourceId, permanent: false },
  });

  return { sourceId, targetId, ops, summary };
}
