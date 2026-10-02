/**
 * Envelope appliers: derive semantic state from the M1 op registry
 * (`@notees/protocol` op-types.ts). Semantics ported from v1
 * `app/core/derived/{node,edge,property,class,class_hierarchy,child_order,asset}.py`,
 * adapted to v2: node_type instead of kind, no relation.* ops (associations
 * are typed-link marks and node-typed property values projecting into the
 * edge index), OR-Set class membership, m2m class extends (replace
 * semantics).
 *
 * Convergence rules (01-knowledge-model.md §12 / SCHEMA.md):
 *  - row-level LWW by (hlc_physical, hlc_logical, actor_id) — higher HLC
 *    wins; equal HLC breaks the tie on actor_id (deterministic);
 *  - property values: LWW per (node, schema, idx), tombstone wins over live;
 *  - OR-Sets (class membership, collection membership): add-wins per pair;
 *  - class extends closure is applier-maintained; cycles fail loud.
 *
 * Every applier writes deterministic derived rows: all timestamps come from
 * the applying envelope, all generated ids are content-addressed, so
 * wipe -> replay -> byte-identical state.
 */

import {
  envelopeSchema,
  payloadSchemaFor,
  type Envelope,
  type OpPayload,
  type OpType,
} from "@notees/protocol";
import { plainTextExcerpt, stringifyContentAst } from "@notees/domain";

import { reindexNode, removeSearchIndexEntry } from "./search.js";
import { rebuildEdges } from "./edges.js";
import { rebuildNodeStats } from "./stats.js";
import {
  CycleError,
  EnvelopeValidationError,
  isSqliteError,
  MoveGuardError,
  NotFoundError,
  StoreError,
  translateSqliteError,
  UnsupportedCarrierError,
} from "./errors.js";
import type { StoreDatabase } from "./types.js";

// --- LWW comparison ----------------------------------------------------------

/** Compare (hlc, actor) tuples; positive when ``a`` wins over ``b``. */
export function compareLww(
  a: { physical: number; logical: number; actor: string },
  b: { physical: number; logical: number; actor: string },
): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.logical !== b.logical) return a.logical - b.logical;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

function winnerFromEnvelope(env: Envelope) {
  return { physical: env.hlc.physical, logical: env.hlc.logical, actor: env.actorId };
}

function rowWinner(row: { hlc_physical: number; hlc_logical: number; actor_id: string | null }) {
  return {
    physical: row.hlc_physical,
    logical: row.hlc_logical,
    actor: row.actor_id ?? "",
  };
}

// --- summaries ---------------------------------------------------------------

export interface ChangeSummary {
  opType: string;
  affectedNodeIds: string[];
  /** True when a lower-HLC write was dropped by LWW (state unchanged). */
  ignored: boolean;
}

function summary(opType: string, affectedNodeIds: string[] = [], ignored = false): ChangeSummary {
  return { opType, affectedNodeIds: [...new Set(affectedNodeIds)], ignored };
}

// --- validation ----------------------------------------------------------------

/** Validate an envelope and its payload against the protocol schemas. */
export function validateEnvelope(input: unknown): Envelope {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new EnvelopeValidationError(`invalid envelope: ${parsed.error.message}`);
  }
  const env = parsed.data;
  if (typeof env.payload === "object" && env.payload !== null && "$e" in env.payload) {
    throw new EnvelopeValidationError(
      "encrypted payload slot ($e) is reserved for M3 E2EE and cannot be applied yet",
      env.opType,
    );
  }
  const schema = payloadSchemaFor(env.opType);
  if (!schema) {
    throw new EnvelopeValidationError(`unknown opType: ${env.opType}`, env.opType);
  }
  const payload = schema.safeParse(env.payload);
  if (!payload.success) {
    throw new EnvelopeValidationError(
      `invalid ${env.opType} payload: ${payload.error.message}`,
      env.opType,
    );
  }
  return { ...env, payload: payload.data as Envelope["payload"] };
}

// --- object.* -------------------------------------------------------------------

function getNodeRow(db: StoreDatabase, nodeId: string) {  return db.prepare("SELECT * FROM node WHERE id = ?").get(nodeId) as
    | Record<string, unknown>
    | undefined;
}

function requireNode(db: StoreDatabase, nodeId: string, opType: string) {
  const row = getNodeRow(db, nodeId);
  if (!row) throw new NotFoundError(`${opType}: node ${nodeId} does not exist`, opType);
  return row;
}

/** Subtree ids (inclusive) via a parent_id walk; deterministic order. */
function subtreeIds(db: StoreDatabase, nodeId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM node WHERE id = ?
         UNION ALL
         SELECT n.id FROM subtree s JOIN node n ON n.parent_id = s.id
       )
       SELECT id FROM subtree ORDER BY id`,
    )
    .all(nodeId) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Ancestor ids (exclusive) via a parent_id walk; deterministic order. */
function ancestorIds(db: StoreDatabase, nodeId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT parent_id FROM node WHERE id = ? AND parent_id IS NOT NULL
         UNION
         SELECT n.parent_id FROM ancestors a JOIN node n ON n.id = a.id
         WHERE n.parent_id IS NOT NULL
       )
       SELECT id FROM ancestors ORDER BY id`,
    )
    .all(nodeId) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Append position: lexicographic fractional string after the current last. */
function nextChildPosition(db: StoreDatabase, parentId: string): string {
  const last = db
    .prepare(
      "SELECT position FROM node_child_order WHERE parent_id = ? ORDER BY position DESC LIMIT 1",
    )
    .get(parentId) as { position: string } | undefined;
  return last ? `${last.position}a` : "a";
}

/**
 * Lexicographic midpoint of two fractional position strings: the shortest
 * string strictly greater than `lo` and strictly less than `hi` (precondition
 * lo < hi, ASCII). Boundary chars use '`' (one below 'a') as the floor and
 * '{' (one above 'z') as the ceil, so distinct positions always have room.
 * Deterministic — no random suffix — so wipe -> replay -> byte-identical.
 */
export function midpointBetween(lo: string, hi: string): string {
  let i = 0;
  while (i < lo.length && i < hi.length && lo.charCodeAt(i) === hi.charCodeAt(i)) i += 1;
  const prefix = lo.slice(0, i);
  const loRest = lo.slice(i);
  const hiRest = hi.slice(i);
  const loCode = loRest.length > 0 ? loRest.charCodeAt(0) : 0x60;
  const hiCode = hiRest.length > 0 ? hiRest.charCodeAt(0) : 0x7b;
  if (loCode + 1 < hiCode) {
    return prefix + String.fromCharCode(Math.floor((loCode + 1 + hiCode - 1) / 2));
  }
  if (loRest.length === 0) {
    // lo is a prefix of hi and hi continues at the lowest digit: squeeze one
    // char below hi's next digit.
    return prefix + String.fromCharCode(hiCode - 1);
  }
  // Adjacent boundary chars: keep lo's digit (which is < hi's) and descend.
  return prefix + loRest[0] + midpointBetween(loRest.slice(1), hiRest.slice(1));
}

/**
 * Fractional position for `childId` under `parentId`. Minimal deterministic
 * allocator (TreeCrdt remains designed, docs/ux.md "The outliner"), by anchor:
 * - `afterId`: sibling-midpoint between afterId's position and the next
 *   sibling's, append-at-end when afterId is the last sibling;
 * - `beforeId`: sibling-midpoint between the previous sibling's position and
 *   beforeId's — or, when beforeId is the first child, one slot below it
 *   (midpoint against the empty string: the only way to place BEFORE the
 *   current first sibling, which the afterId-only algebra cannot express);
 * - no usable anchor (absent, or not a current sibling): defensive plain
 *   append.
 * When both anchors are present `afterId` wins (the TS reference never sends
 * both).
 */
function allocateChildPosition(
  db: StoreDatabase,
  parentId: string,
  childId: string,
  afterId: string | undefined,
  beforeId?: string | undefined,
): string {
  if (afterId !== undefined) {
    const after = db
      .prepare(
        "SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?",
      )
      .get(parentId, afterId) as { position: string } | undefined;
    if (after !== undefined) {
      const next = db
        .prepare(
          `SELECT position FROM node_child_order
           WHERE parent_id = ? AND child_id != ? AND position > ?
           ORDER BY position ASC LIMIT 1`,
        )
        .get(parentId, childId, after.position) as { position: string } | undefined;
      return next !== undefined
        ? midpointBetween(after.position, next.position)
        : nextChildPosition(db, parentId);
    }
  }
  if (beforeId !== undefined) {
    const before = db
      .prepare(
        "SELECT position FROM node_child_order WHERE parent_id = ? AND child_id = ?",
      )
      .get(parentId, beforeId) as { position: string } | undefined;
    if (before !== undefined) {
      const prev = db
        .prepare(
          `SELECT position FROM node_child_order
           WHERE parent_id = ? AND child_id != ? AND position < ?
           ORDER BY position DESC LIMIT 1`,
        )
        .get(parentId, childId, before.position) as { position: string } | undefined;
      return prev !== undefined
        ? midpointBetween(prev.position, before.position)
        : midpointBetween("", before.position);
    }
  }
  return nextChildPosition(db, parentId);
}

function applyObjectCreate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.create";
  const p = env.payload as OpPayload<"object.create">;
  const parentId = p.parentId ?? null;
  const nodeType = p.nodeType ?? (parentId === null ? "page" : "block");
  const ts = env.timestamp;
  // Title-is-content constraint (SCHEMA.md): pages and classes carry
  // text-only content. A block created straight as page/class gets its
  // (possibly rich) content flattened; a block keeps the full token stream.
  const content = JSON.stringify(
    nodeType === "block" ? (p.contentAst ?? []) : stringifyContentAst(p.contentAst as never),
  );

  // Seed OR-Set membership from the payload's classIds (add-wins per pair,
  // HLC-gated; concurrent creates on the same id are the designed carrier
  // for class membership — see conflicts.ts class_conflict). The add's
  // comparator is >= on the actor tiebreak so an exact-HLC add beats a
  // class.unassign remove in either delivery order (the remove's is > — the
  // collection_member convention).
  const memberUpsert = db.prepare(
    `INSERT INTO class_member_set (node_id, class_id, present, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(node_id, class_id) DO UPDATE SET
       present = 1, hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id >= COALESCE(actor_id, ''))`,
  );
const tagMemberUpsert = db.prepare(
  `INSERT INTO tag_member_set (node_id, tag_id, present, hlc_physical, hlc_logical, actor_id)
   VALUES (?, ?, 1, ?, ?, ?)
   ON CONFLICT(node_id, tag_id) DO UPDATE SET
     present = 1, hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
     actor_id = excluded.actor_id
   WHERE excluded.hlc_physical > hlc_physical
      OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
      OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
          AND excluded.actor_id > COALESCE(actor_id, ''))`,
);

  // First create wins for duplicate node ids (v1 INSERT OR IGNORE): re-issuing
  // object.create on an existing id must not touch the TREE — the earlier
  // half-apply added a second node_child_order row under the new parent while
  // node.parent_id stayed stale, rendering the node under TWO parents. The
  // re-create returns before every tree side effect (child_order, search,
  // edges, stats); the one exception is the classIds OR-Set seed above, the
  // convergence carrier for concurrent creates (it cannot move the node).
  // A fresh insert must be a plain INSERT: OR IGNORE would also swallow the
  // placement CHECKs, and SCHEMA.md demands those surface as typed errors.
  const alreadyExists =
    db.prepare("SELECT 1 FROM node WHERE id = ?").get(p.objectId) !== undefined;
  if (alreadyExists) {
    for (const classId of p.classIds) {
      memberUpsert.run(p.objectId, classId, env.hlc.physical, env.hlc.logical, env.actorId);
    }
    if (p.classIds.length > 0) recomputeClassIds(db, p.objectId);
    for (const tagId of p.tagIds) {
      tagMemberUpsert.run(p.objectId, tagId, env.hlc.physical, env.hlc.logical, env.actorId);
    }
    if (p.tagIds.length > 0) recomputeTagIds(db, p.objectId);
    return summary(opType, [p.objectId], true);
  }

  if (parentId !== null) {
    const parent = getNodeRow(db, parentId);
    if (!parent) {
      throw new NotFoundError(`${opType}: parent ${parentId} does not exist`, opType);
    }
    // Cross-row tree guard (SCHEMA.md): a class may never be a parent.
    if (parent.node_type === "class") {
      throw new MoveGuardError(
        `${opType}: node ${parentId} is a class; classes are tree-external and cannot have children`,
        opType,
      );
    }
  }

  try {
    db.prepare(
      `INSERT INTO node (
         id, workspace_id, node_type, parent_id, class_ids, name, content, icon, color,
         is_active, created_at, updated_at, created_by, updated_by,
         hlc_physical, hlc_logical, actor_id
       ) VALUES (?, ?, ?, ?, '[]', NULL, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.objectId,
      env.workspaceId,
      nodeType,
      parentId,
      content,
      ts,
      ts,
      env.actorId,
      env.actorId,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
  } catch (error) {
    if (isSqliteError(error)) throw translateSqliteError(error, opType);
    throw error;
  }

  for (const classId of p.classIds) {
    memberUpsert.run(p.objectId, classId, env.hlc.physical, env.hlc.logical, env.actorId);
  }
  recomputeClassIds(db, p.objectId);
  for (const tagId of p.tagIds) {
    tagMemberUpsert.run(p.objectId, tagId, env.hlc.physical, env.hlc.logical, env.actorId);
  }
  recomputeTagIds(db, p.objectId);

  if (parentId !== null) {
    db.prepare(
      "INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)",
    ).run(
      parentId,
      p.objectId,
      allocateChildPosition(db, parentId, p.objectId, p.afterId, p.beforeId),
    );
  }

  reindexNode(db, p.objectId);
  rebuildEdges(db, p.objectId, ts);
  rebuildNodeStats(db, [p.objectId]);
  return summary(opType, [p.objectId]);
}

/** Recompute node.tag_ids from the tag OR-Set's present rows (sorted JSON). */
function recomputeTagIds(db: StoreDatabase, nodeId: string): void {
  const rows = db
    .prepare("SELECT tag_id FROM tag_member_set WHERE node_id = ? AND present = 1 ORDER BY tag_id")
    .all(nodeId) as { tag_id: string }[];
  db.prepare("UPDATE node SET tag_ids = ? WHERE id = ?").run(
    JSON.stringify(rows.map((r) => r.tag_id)),
    nodeId,
  );
}

/** Recompute node.class_ids from the OR-Set's present rows (sorted JSON).
 *  User order (node.class_order, written by class.reorder) wins: ordered
 *  members first, then any unlisted members sorted by id. */
function recomputeClassIds(db: StoreDatabase, nodeId: string): void {
  const rows = db
    .prepare("SELECT class_id FROM class_member_set WHERE node_id = ? AND present = 1 ORDER BY class_id")
    .all(nodeId) as { class_id: string }[];
  const present = rows.map((r) => r.class_id);
  const orderRow = db.prepare("SELECT class_order FROM node WHERE id = ?").get(nodeId) as
    | { class_order: string | null }
    | undefined;
  let ordered: string[] = [];
  try {
    const parsed: unknown = JSON.parse(orderRow?.class_order ?? "[]");
    if (Array.isArray(parsed)) {
      ordered = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    ordered = [];
  }
  const presentSet = new Set(present);
  const effective = [
    ...ordered.filter((id) => presentSet.has(id)),
    ...present.filter((id) => !ordered.includes(id)),
  ];
  db.prepare("UPDATE node SET class_ids = ? WHERE id = ?").run(
    JSON.stringify(effective),
    nodeId,
  );
}

function applyObjectUpdate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.update";
  const p = env.payload as OpPayload<"object.update">;
  const row = requireNode(db, p.objectId, opType) as unknown as Parameters<typeof rowWinner>[0] & {
    node_type: string;
    content: string;
  };

  if (p.contentDeltaB64 !== undefined && p.contentAst === undefined) {
    throw new UnsupportedCarrierError(
      `${opType}: contentDeltaB64 (canonical CRDT carrier) needs the Yjs port; ` +
        "reapply with the contentAst readable carrier",
      opType,
    );
  }

  // Row-level last-write-wins: lower or equal (hlc, actor) writes are dropped.
  if (compareLww(winnerFromEnvelope(env), rowWinner(row as never)) <= 0) {
    return summary(opType, [p.objectId], true);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  // Promotion/demotion (block↔page, page→class, …): pages and classes carry
  // text-only content (title-is-content), so promoting a BLOCK flattens its
  // rich token stream to plain text in the same op; demoting a page/class
  // leaves its (already text-only) content untouched.
  const resultingType = p.nodeType ?? row.node_type;
  if (p.nodeType !== undefined) {
    sets.push("node_type = ?");
    values.push(p.nodeType);
    if (p.nodeType !== "block" && row.node_type === "block") {
      const rowAst = JSON.parse(row.content) as unknown;
      sets.push("content = ?");
      values.push(JSON.stringify(stringifyContentAst(rowAst as never)));
    }
  }
  if (p.icon !== undefined) {
    sets.push("icon = ?");
    values.push(p.icon);
  }
  if (p.color !== undefined) {
    sets.push("color = ?");
    values.push(p.color);
  }
  if (p.contentAst !== undefined) {
    sets.push("content = ?");
    values.push(
      JSON.stringify(
        resultingType === "block" ? p.contentAst : stringifyContentAst(p.contentAst as never),
      ),
    );
  }
  sets.push(
    "updated_at = ?",
    "updated_by = ?",
    "hlc_physical = ?",
    "hlc_logical = ?",
    "actor_id = ?",
  );
  values.push(env.timestamp, env.actorId, env.hlc.physical, env.hlc.logical, env.actorId, p.objectId);

  try {
    db.prepare(`UPDATE node SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  } catch (error) {
    if (isSqliteError(error)) throw translateSqliteError(error, opType);
    throw error;
  }

  // Content writes reindex FTS (title search lives in the content now — a
  // page's title IS its content) and rebuild edges (derived from content).
  if (p.contentAst !== undefined) {
    reindexNode(db, p.objectId);
    rebuildEdges(db, p.objectId, env.timestamp);
  }
  return summary(opType, [p.objectId]);
}

function applyObjectDelete(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.delete";
  const p = env.payload as OpPayload<"object.delete">;
  requireNode(db, p.objectId, opType);
  const ts = env.timestamp;
  const affected = new Set<string>([p.objectId, ...ancestorIds(db, p.objectId)]);

  if (!p.permanent) {
    // Soft delete: trash the subtree (v1 precedent, SCHEMA.md deletion
    // semantics — restore is whole-tree), keep the tree for restore.
    const ids = subtreeIds(db, p.objectId);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE node SET is_active = 0 WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(
      "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 0)",
    ).run(p.objectId, ts);
    rebuildNodeStats(db, [...affected]);
    return summary(opType, [...affected]);
  }

  // Permanent delete: record retention metadata, then hard-delete the subtree.
  db.prepare(
    "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 1)",
  ).run(p.objectId, ts);

  const ids = subtreeIds(db, p.objectId);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM node WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(
    `DELETE FROM node_child_order WHERE parent_id IN (${placeholders}) OR child_id IN (${placeholders})`,
  ).run(...ids, ...ids);
  db.prepare(`DELETE FROM property_value WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM property_value_tombstone WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM class_member_set WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM node_asset WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM node_link WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM edge WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...ids, ...ids);
  db.prepare(`DELETE FROM node_stats WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM trash WHERE node_id IN (${placeholders}) AND node_id != ?`).run(...ids, p.objectId);
  for (const id of ids) removeSearchIndexEntry(db, id);
  rebuildNodeStats(db, [...affected]);
  return summary(opType, [...affected]);
}

/**
 * Reparent + reorder (object.move): the outliner's indent/outdent/Enter
 * placement. Parent/position are row-level LWW by envelope (hlc, actor) — the
 * same rule as object.update — and the winning HLC is stored on the node row,
 * so re-applying an older move after a newer one is dropped. (The schema has
 * no per-field HLC columns; node_child_order rows carry none, so the move is
 * published or dropped as a whole — a position write never outlives a newer
 * parent write and vice versa.)
 *
 * Placement guards fail loud, mirroring object.create: the parent must exist,
 * a class may never parent (cross-row move guard), and a node may never move
 * under itself or its own descendant (parent_id cycle). A block to workspace
 * root (parentId null) is rejected by the node's placement CHECK, surfacing
 * as a CheckConstraintError from the UPDATE below; null is legal only for
 * pages.
 */
function applyObjectMove(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.move";
  const p = env.payload as OpPayload<"object.move">;
  const row = requireNode(db, p.objectId, opType);
  const oldAncestors = ancestorIds(db, p.objectId);

  if (p.parentId !== null) {
    const parent = getNodeRow(db, p.parentId);
    if (!parent) {
      throw new NotFoundError(`${opType}: parent ${p.parentId} does not exist`, opType);
    }
    if (parent.node_type === "class") {
      throw new MoveGuardError(
        `${opType}: node ${p.parentId} is a class; classes are tree-external and cannot have children`,
        opType,
      );
    }
    if (subtreeIds(db, p.objectId).includes(p.parentId)) {
      throw new MoveGuardError(
        `${opType}: cannot move node ${p.objectId} under ${p.parentId}, which is in its own subtree`,
        opType,
      );
    }
  }

  if (compareLww(winnerFromEnvelope(env), rowWinner(row as never)) <= 0) {
    return summary(opType, [p.objectId], true);
  }

  db.prepare(
    `UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ?,
       hlc_physical = ?, hlc_logical = ?, actor_id = ?
     WHERE id = ?`,
  ).run(
    p.parentId,
    env.timestamp,
    env.actorId,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
    p.objectId,
  );

  // Carry the child_order row with the parent: delete the old one first —
  // without this the node renders under BOTH parents (the re-create
  // corruption class this op replaces) — then insert at the allocated slot.
  db.prepare("DELETE FROM node_child_order WHERE child_id = ?").run(p.objectId);
  if (p.parentId !== null) {
    db.prepare(
      "INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position) VALUES (?, ?, ?)",
    ).run(
      p.parentId,
      p.objectId,
      allocateChildPosition(db, p.parentId, p.objectId, p.afterId, p.beforeId),
    );
  }

  // Old ancestors lose the subtree, new ancestors gain it (child/descendant
  // counts); rebuildNodeStats also recomputes the node's own closure.
  const affected = [...new Set([p.objectId, ...oldAncestors])];
  rebuildNodeStats(db, affected);
  return summary(opType, affected);
}

// --- class.* ----------------------------------------------------------------

function upsertClassNode(
  db: StoreDatabase,
  env: Envelope,
  classId: string,
  fields: { contentAst?: unknown; icon?: string | undefined; color?: string | undefined },
): void {
  // The class node (node_type='class') is the structural authority for the
  // class_list read model; the registry row carries class-only config (its
  // `name` column is a denormalized cache of the node's title text — the
  // authority is node.content). Classes are nodes: their title IS their
  // (text-only) content. Node fields update only when the envelope wins the
  // row-level LWW.
  const hasContent = fields.contentAst !== undefined;
  const content = hasContent ? JSON.stringify(stringifyContentAst(fields.contentAst as never)) : null;
  // The INSERT carries the create-time content directly (the LWW-gated
  // UPDATE below can never beat this envelope's own HLC — equal on every
  // clause — so routing create fields through it would silently drop them).
  db.prepare(
    `INSERT OR IGNORE INTO node (
       id, workspace_id, node_type, parent_id, class_ids, name, content,
       is_active, created_at, updated_at, created_by, updated_by,
       hlc_physical, hlc_logical, actor_id
     ) VALUES (?, ?, 'class', NULL, '[]', NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    classId,
    env.workspaceId,
    content ?? "[]",
    env.timestamp,
    env.timestamp,
    env.actorId,
    env.actorId,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
  );
  const sets: string[] = [];
  const values: unknown[] = [];
  if (content !== null) {
    sets.push("content = ?");
    values.push(content);
  }
  if (fields.icon !== undefined) {
    sets.push("icon = ?");
    values.push(fields.icon);
  }
  if (fields.color !== undefined) {
    sets.push("color = ?");
    values.push(fields.color);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?", "updated_by = ?", "hlc_physical = ?", "hlc_logical = ?", "actor_id = ?");
  // Only overwrite node fields when this envelope wins the row LWW.
  db.prepare(
    `UPDATE node SET ${sets.join(", ")}
     WHERE id = ? AND (
       ? > hlc_physical
       OR (? = hlc_physical AND ? > hlc_logical)
       OR (? = hlc_physical AND ? = hlc_logical AND ? > COALESCE(actor_id, ''))
     )`,
  ).run(
    ...values,
    env.timestamp,
    env.actorId,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
    classId,
    env.hlc.physical,
    env.hlc.physical,
    env.hlc.logical,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
  );
}

function applyClassCreate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.create";
  const p = env.payload as OpPayload<"class.create">;
  // Registry `name` is a denormalized cache of the class node's title text.
  const titleText = plainTextExcerpt(p.contentAst as never) ?? "";
  db.prepare(
    `INSERT INTO class (id, workspace_id, name, icon, color, description, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, icon = excluded.icon, color = excluded.color,
       description = excluded.description, active = 1, updated_at = excluded.updated_at`,
  ).run(p.classId, env.workspaceId, titleText, p.icon ?? null, p.color ?? null, env.timestamp, env.timestamp);
  upsertClassNode(db, env, p.classId, { contentAst: p.contentAst, icon: p.icon, color: p.color });
  // Hierarchy self-row: the `class` query condition matches via the closure,
  // so every class needs (id, id) even before any setExtends runs.
  db.prepare(`INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)`).run(
    p.classId,
    p.classId,
  );
  // Classes are nodes: index the new class so full-text search finds it by
  // title (the picker and global search both rely on this).
  reindexNode(db, p.classId);
  return summary(opType, [p.classId]);
}

function applyClassUpdate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.update";
  const p = env.payload as OpPayload<"class.update">;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (p.contentAst !== undefined) {
    sets.push("name = ?");
    values.push(plainTextExcerpt(p.contentAst as never) ?? "");
  }
  if (p.icon !== undefined) {
    sets.push("icon = ?");
    values.push(p.icon);
  }
  if (p.color !== undefined) {
    sets.push("color = ?");
    values.push(p.color);
  }
  if (p.description !== undefined) {
    sets.push("description = ?");
    values.push(p.description);
  }
  if (sets.length === 0) return summary(opType, [p.classId], true);
  sets.push("updated_at = ?");
  values.push(env.timestamp, p.classId);
  db.prepare(`UPDATE class SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  upsertClassNode(db, env, p.classId, { contentAst: p.contentAst, icon: p.icon, color: p.color });
  // A title change re-renders the class unfindable under its old text —
  // reindex whenever the indexed fields may have changed.
  if (p.contentAst !== undefined) reindexNode(db, p.classId);
  return summary(opType, [p.classId]);
}

function applyClassDelete(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.delete";
  const p = env.payload as OpPayload<"class.delete">;
  db.prepare("UPDATE class SET active = 0, updated_at = ? WHERE id = ?").run(env.timestamp, p.classId);
  db.prepare("UPDATE node SET is_active = 0, updated_at = ? WHERE id = ?").run(env.timestamp, p.classId);
  // The class leaves every node's class_ids: tombstone the membership rows
  // and recompute the affected nodes (otherwise pills render dangling ids).
  const affected = db
    .prepare("SELECT node_id FROM class_member_set WHERE class_id = ? AND present = 1")
    .all(p.classId) as Array<{ node_id: string }>;
  db.prepare("UPDATE class_member_set SET present = 0 WHERE class_id = ?").run(p.classId);
  for (const row of affected) recomputeClassIds(db, row.node_id);
  return summary(opType, [p.classId]);
}

/**
 * Class membership removal (class.unassign — SCHEMA.md "Class properties"):
 * the OR-Set remove complement of the re-issued object.create add carrier.
 * The pair is tombstoned (present = 0) with the op's HLC under add-wins
 * gating (the remove's comparator is strictly-greater, the add carrier's
 * greater-or-equal, per the collection_member convention), and
 * `node.class_ids` is recomputed from the surviving present rows. Derived
 * defaults and node_stats need no applier attention: defaults live entirely
 * in the effective read model, and membership touches no stats row. A remove
 * that loses the HLC race to a newer add is written as nothing (the gated
 * upsert no-ops) and membership stands.
 */
function applyClassUnassign(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.unassign";
  const p = env.payload as OpPayload<"class.unassign">;
  requireNode(db, p.objectId, opType);
  db.prepare(
    `INSERT INTO class_member_set (node_id, class_id, present, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(node_id, class_id) DO UPDATE SET
       present = 0, hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  ).run(p.objectId, p.classId, env.hlc.physical, env.hlc.logical, env.actorId);
  recomputeClassIds(db, p.objectId);
  return summary(opType, [p.objectId]);
}

/**
 * Class ORDER (class.reorder): display-only user ordering, LWW-by-arrival —
 * the applier is deterministic per op order, so convergent replicas agree.
 * The class_ids projection merges: ordered members first, then unlisted
 * members sorted by id (recomputeClassIds).
 */
function applyClassReorder(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.reorder";
  const p = env.payload as OpPayload<"class.reorder">;
  requireNode(db, p.objectId, opType);
  db.prepare("UPDATE node SET class_order = ? WHERE id = ?").run(
    JSON.stringify(p.classIds),
    p.objectId,
  );
  recomputeClassIds(db, p.objectId);
  return summary(opType, [p.objectId]);
}

/**
 * Tag removal (tag.unassign): the OR-Set remove complement of the re-issued
 * object.create add carrier — identical gating to class.unassign, own table.
 */
function applyTagUnassign(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "tag.unassign";
  const p = env.payload as OpPayload<"tag.unassign">;
  requireNode(db, p.objectId, opType);
  db.prepare(
    `INSERT INTO tag_member_set (node_id, tag_id, present, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(node_id, tag_id) DO UPDATE SET
       present = 0, hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  ).run(p.objectId, p.tagId, env.hlc.physical, env.hlc.logical, env.actorId);
  recomputeTagIds(db, p.objectId);
  return summary(opType, [p.objectId]);
}

/**
 * Full, deterministic rebuild of the class_hierarchy closure from the
 * class_extends edge set (m2m: multiple parents per class, per the designed
 * model in 01-knowledge-model.md §6). Recompute-from-scratch for the whole
 * table on every setExtends — the class count is small (system seed ~30),
 * correctness and wipe -> replay -> byte-identity dominate any incremental
 * bookkeeping. Rows are inserted per class in sorted id order with sorted
 * ancestor order, so replay converges to identical bytes. The closure is a
 * pure set (no order, no depth) — diamond resolution happens at read time
 * in the bindings read model. Historical cycles terminate via the visited
 * set instead of looping.
 */
function rebuildClassHierarchy(db: StoreDatabase): void {
  const classes = db
    .prepare("SELECT id FROM class WHERE active = 1 ORDER BY id")
    .all() as { id: string }[];
  const parentsById = new Map<string, string[]>();
  const edges = db
    .prepare("SELECT class_id, parent_class_id FROM class_extends ORDER BY class_id, parent_class_id")
    .all() as { class_id: string; parent_class_id: string }[];
  for (const edge of edges) {
    const list = parentsById.get(edge.class_id);
    if (list) list.push(edge.parent_class_id);
    else parentsById.set(edge.class_id, [edge.parent_class_id]);
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
  );
  db.exec("DELETE FROM class_hierarchy");
  for (const c of classes) {
    const ancestors = new Set<string>();
    const visited = new Set([c.id]);
    // BFS over the parent sets; the visited set terminates historical cycles.
    const queue = [...(parentsById.get(c.id) ?? [])];
    while (queue.length > 0) {
      const cursor = queue.shift()!;
      if (visited.has(cursor)) continue;
      visited.add(cursor);
      ancestors.add(cursor);
      queue.push(...(parentsById.get(cursor) ?? []));
    }
    insert.run(c.id, c.id);
    for (const ancestorId of [...ancestors].sort()) insert.run(c.id, ancestorId);
  }
}

function applyClassSetExtends(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.setExtends";
  const p = env.payload as OpPayload<"class.setExtends">;
  requireNode(db, p.classId, opType);

  for (const parentClassId of p.parentClassIds) {
    requireNode(db, parentClassId, opType);
    if (parentClassId === p.classId) {
      throw new CycleError(`${opType}: class ${p.classId} cannot extend itself`, opType);
    }
    // A cycle forms when the class is already an ancestor of one of its new
    // parents. The check runs against the pre-write closure, so multi-hop
    // cycles across several parents are covered too.
    const cycle = db
      .prepare("SELECT 1 FROM class_hierarchy WHERE class_id = ? AND ancestor_id = ? LIMIT 1")
      .get(parentClassId, p.classId);
    if (cycle) {
      throw new CycleError(
        `${opType}: class ${p.classId} is already an ancestor of ${parentClassId}; extends would cycle`,
        opType,
      );
    }
  }

  // Replace semantics: the payload array IS the class's full parent set —
  // drop every previous edge, then insert the new ones (dedup via the PK).
  // An empty array detaches all parents.
  db.prepare("DELETE FROM class_extends WHERE class_id = ?").run(p.classId);
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO class_extends (class_id, parent_class_id) VALUES (?, ?)",
  );
  for (const parentClassId of p.parentClassIds) {
    insertEdge.run(p.classId, parentClassId);
  }
  db.prepare("UPDATE class SET updated_at = ? WHERE id = ?").run(env.timestamp, p.classId);
  rebuildClassHierarchy(db);
  return summary(opType, [p.classId]);
}

// --- class.property.* ---------------------------------------------------------
//
// Binding rows on `class_property` (SCHEMA.md "Class properties"): pure
// configuration (sequence, flags, defaultValue). Row-level LWW by envelope
// HLC; on update the payload PATCHES the row — omitted fields keep their
// existing values. Defaults are never materialized into property_value; the
// effective-values read model (effective.ts) derives them at query time.

function applyClassPropertySet(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.property.set";
  const p = env.payload as OpPayload<"class.property.set">;
  const incoming = winnerFromEnvelope(env);

  const existing = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM class_property WHERE class_id = ? AND property_schema_id = ?",
    )
    .get(p.classId, p.propertySchemaId) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;

  if (existing && compareLww(incoming, rowWinner(existing)) <= 0) {
    return summary(opType, [p.classId], true);
  }

  const required = p.required === undefined ? null : p.required ? 1 : 0;
  const readonlyFlag = p.readonly === undefined ? null : p.readonly ? 1 : 0;
  const hideWhenEmpty = p.hideWhenEmpty === undefined ? null : p.hideWhenEmpty ? 1 : 0;
  const defaultValue = p.defaultValue !== undefined ? JSON.stringify(p.defaultValue) : null;

  if (!existing) {
    db.prepare(
      `INSERT INTO class_property
         (class_id, property_schema_id, sequence, required, readonly, hide_when_empty,
          default_value, hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.classId,
      p.propertySchemaId,
      p.sequence ?? 0,
      required,
      readonlyFlag,
      hideWhenEmpty,
      defaultValue,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
  } else {
    // Partial update: COALESCE keeps the stored value for omitted fields
    // (present fields update, including explicit false / JSON null).
    db.prepare(
      `UPDATE class_property SET
         sequence = COALESCE(?, sequence),
         required = COALESCE(?, required),
         readonly = COALESCE(?, readonly),
         hide_when_empty = COALESCE(?, hide_when_empty),
         default_value = COALESCE(?, default_value),
         hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE class_id = ? AND property_schema_id = ?`,
    ).run(
      p.sequence ?? null,
      required,
      readonlyFlag,
      hideWhenEmpty,
      defaultValue,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
      p.classId,
      p.propertySchemaId,
    );
  }
  return summary(opType, [p.classId]);
}

/**
 * Binding removal: plain DELETE — a config row, last write wins, no tombstone
 * (SCHEMA.md). The read model stops deriving the schema's default for the
 * class's nodes; authored property_value rows are untouched by design.
 */
function applyClassPropertyUnset(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "class.property.unset";
  const p = env.payload as OpPayload<"class.property.unset">;
  db.prepare("DELETE FROM class_property WHERE class_id = ? AND property_schema_id = ?").run(
    p.classId,
    p.propertySchemaId,
  );
  return summary(opType, [p.classId]);
}

// --- propertySchema.* ---------------------------------------------------------

function applyPropertySchemaCreate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "propertySchema.create";
  const p = env.payload as OpPayload<"propertySchema.create">;
  db.prepare(
    `INSERT INTO property_schema
       (id, workspace_id, name, type, multi, scope, options, target_class_filter,
        date_precision, date_qualified, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, multi = excluded.multi, scope = excluded.scope,
       options = excluded.options, target_class_filter = excluded.target_class_filter,
       date_precision = excluded.date_precision, date_qualified = excluded.date_qualified,
       active = 1, updated_at = excluded.updated_at`,
  ).run(
    p.propertySchemaId,
    env.workspaceId,
    p.name,
    p.type,
    p.multi ? 1 : 0,
    p.scope,
    JSON.stringify(p.options ?? []),
    p.targetClassFilter !== undefined ? JSON.stringify(p.targetClassFilter) : null,
    p.datePrecision ?? null,
    p.dateQualified !== undefined ? (p.dateQualified ? 1 : 0) : null,
    env.timestamp,
    env.timestamp,
  );
  return summary(opType, []);
}

function applyPropertySchemaUpdate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "propertySchema.update";
  const p = env.payload as OpPayload<"propertySchema.update">;
  const sets: string[] = [];
  const values: unknown[] = [];
  if (p.name !== undefined) {
    sets.push("name = ?");
    values.push(p.name);
  }
  if (p.options !== undefined) {
    sets.push("options = ?");
    values.push(JSON.stringify(p.options));
  }
  if (p.datePrecision !== undefined) {
    sets.push("date_precision = ?");
    values.push(p.datePrecision);
  }
  if (p.dateQualified !== undefined) {
    sets.push("date_qualified = ?");
    values.push(p.dateQualified ? 1 : 0);
  }
  if (sets.length === 0) return summary(opType, [], true);
  sets.push("updated_at = ?");
  values.push(env.timestamp, p.propertySchemaId);
  db.prepare(`UPDATE property_schema SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return summary(opType, []);
}

function applyPropertySchemaDelete(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "propertySchema.delete";
  const p = env.payload as OpPayload<"propertySchema.delete">;
  db.prepare("UPDATE property_schema SET active = 0, updated_at = ? WHERE id = ?").run(
    env.timestamp,
    p.propertySchemaId,
  );
  return summary(opType, []);
}

// --- property.* -----------------------------------------------------------------

/** Deterministic property_value id (v2 payloads carry no propertyValueId). */
function propertyValueId(nodeId: string, schemaId: string, idx: number): string {
  return `${nodeId}:${schemaId}:${idx}`;
}

function applyPropertySet(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.set";
  const p = env.payload as OpPayload<"property.set">;
  const incoming = winnerFromEnvelope(env);

  // A tombstone with a winning (>=) (hlc, actor) blocks the write.
  const tombstone = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM property_value_tombstone WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
    )
    .get(p.objectId, p.propertySchemaId, p.idx) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  if (tombstone && compareLww(incoming, rowWinner(tombstone)) <= 0) {
    return summary(opType, [p.objectId], true);
  }

  const existing = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
    )
    .get(p.objectId, p.propertySchemaId, p.idx) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO property_value
         (id, node_id, property_schema_id, value, idx, metadata, hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      propertyValueId(p.objectId, p.propertySchemaId, p.idx),
      p.objectId,
      p.propertySchemaId,
      JSON.stringify(p.value ?? null),
      p.idx,
      p.metadata !== undefined ? JSON.stringify(p.metadata) : null,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
  } else if (compareLww(incoming, rowWinner(existing)) > 0) {
    db.prepare(
      `UPDATE property_value SET value = ?, metadata = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE node_id = ? AND property_schema_id = ? AND idx = ?`,
    ).run(
      JSON.stringify(p.value ?? null),
      p.metadata !== undefined ? JSON.stringify(p.metadata) : null,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
      p.objectId,
      p.propertySchemaId,
      p.idx,
    );
  } else {
    return summary(opType, [p.objectId], true);
  }

  rebuildEdges(db, p.objectId, env.timestamp);
  return summary(opType, [p.objectId]);
}

function applyPropertyUnset(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.unset";
  const p = env.payload as OpPayload<"property.unset">;
  const incoming = winnerFromEnvelope(env);

  // Upsert the tombstone only when the incoming write wins the slot.
  db.prepare(
    `INSERT INTO property_value_tombstone (node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
       hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  ).run(p.objectId, p.propertySchemaId, p.idx, env.hlc.physical, env.hlc.logical, env.actorId);

  const existing = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
    )
    .get(p.objectId, p.propertySchemaId, p.idx) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  if (existing && compareLww(incoming, rowWinner(existing)) > 0) {
    db.prepare(
      "DELETE FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
    ).run(p.objectId, p.propertySchemaId, p.idx);
  }

  rebuildEdges(db, p.objectId, env.timestamp);
  return summary(opType, [p.objectId]);
}

// --- asset.* ----------------------------------------------------------------------

function applyAssetAttach(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "asset.attach";
  const p = env.payload as OpPayload<"asset.attach">;
  db.prepare(
    `INSERT INTO node_asset (node_id, asset_id, hash, mime_type, size, original_name, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, asset_id) DO UPDATE SET
       hash = excluded.hash, mime_type = excluded.mime_type, size = excluded.size,
       original_name = excluded.original_name, uploaded_at = excluded.uploaded_at`,
  ).run(p.objectId, p.assetId, p.hash, p.mimeType, p.size, p.originalName, env.timestamp);
  return summary(opType, [p.objectId]);
}

function applyAssetDetach(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "asset.detach";
  const p = env.payload as OpPayload<"asset.detach">;
  db.prepare("DELETE FROM node_asset WHERE node_id = ? AND asset_id = ?").run(p.objectId, p.assetId);
  return summary(opType, [p.objectId]);
}

// --- collection.member.* -----------------------------------------------------------

function applyCollectionMember(
  db: StoreDatabase,
  env: Envelope,
  present: 0 | 1,
): ChangeSummary {
  const opType = present === 1 ? "collection.member.add" : "collection.member.remove";
  const p = env.payload as OpPayload<"collection.member.add">;
  // OR-Set add-wins: an add with an equal (hlc, actor) to a remove still
  // wins, so the remove's WHERE is strictly-greater while the add's is >=.
  const comparator =
    present === 1
      ? `excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id >= COALESCE(actor_id, ''))`
      : `excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`;
  db.prepare(
    `INSERT INTO collection_member (collection_id, object_id, present, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(collection_id, object_id) DO UPDATE SET
       present = excluded.present, hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical, actor_id = excluded.actor_id
     WHERE ${comparator}`,
  ).run(p.collectionId, p.objectId, present, env.hlc.physical, env.hlc.logical, env.actorId);
  return summary(opType, [p.collectionId, p.objectId]);
}

// --- dispatch ------------------------------------------------------------------------

const APPLIERS: Record<
  OpType,
  (db: StoreDatabase, env: Envelope) => ChangeSummary
> = {
  "object.create": applyObjectCreate,
  "object.update": applyObjectUpdate,
  "object.delete": applyObjectDelete,
  "object.move": applyObjectMove,
  "class.create": applyClassCreate,
  "class.update": applyClassUpdate,
  "class.delete": applyClassDelete,
  "class.unassign": applyClassUnassign,
  "class.reorder": applyClassReorder,
  "tag.unassign": applyTagUnassign,
  "class.setExtends": applyClassSetExtends,
  "class.property.set": applyClassPropertySet,
  "class.property.unset": applyClassPropertyUnset,
  "propertySchema.create": applyPropertySchemaCreate,
  "propertySchema.update": applyPropertySchemaUpdate,
  "propertySchema.delete": applyPropertySchemaDelete,
  "property.set": applyPropertySet,
  "property.unset": applyPropertyUnset,
  "asset.attach": applyAssetAttach,
  "asset.detach": applyAssetDetach,
  "collection.member.add": (db, env) => applyCollectionMember(db, env, 1),
  "collection.member.remove": (db, env) => applyCollectionMember(db, env, 0),
};

/**
 * Apply one validated envelope to the derived state. Callers are
 * responsible for idempotency (applied_envelope) and transaction wrapping;
 * this function assumes both.
 */
export function applyEnvelope(db: StoreDatabase, envelope: Envelope): ChangeSummary {
  const applier = APPLIERS[envelope.opType as OpType];
  if (!applier) {
    // Unreachable when validateEnvelope ran, but fail loud regardless.
    throw new EnvelopeValidationError(`unknown opType: ${envelope.opType}`, envelope.opType);
  }
  try {
    return applier(db, envelope);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (isSqliteError(error)) throw translateSqliteError(error, envelope.opType);
    throw error;
  }
}
