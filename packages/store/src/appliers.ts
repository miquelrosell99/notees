/**
 * Envelope appliers: derive semantic state from the op registry
 * (`@notees/protocol` op-types.ts). Semantics ported from
 * `app/core/derived/{node,edge,property,class,class_hierarchy,child_order,asset}.py`,
 * adapted to the current model: the Revision-12 embedding model (is_class /
 * is_embedded) instead of kind/node_type, no relation.* ops (associations
 * are typed-link marks and node-typed property values projecting into the
 * edge index), OR-Set class membership, m2m class extends (replace
 * semantics).
 *
 * Convergence rules (SCHEMA.md):
 *  - row-level LWW by (hlc_physical, hlc_logical, actor_id) — higher HLC
 *    wins; equal HLC breaks the tie on actor_id (deterministic);
 *  - property values: single-value slots stay LWW per (node, schema, idx);
 *    multi-value slots are an OR-Set of elements (PG5 — per-element id,
 *    add-wins removes with tombstones; the membership comparator is HLC-only
 *    so on equal HLC the add wins regardless of actor);
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
  type WorkspaceFeature,
} from "@notees/protocol";
import {
  familyClassNames,
  featureForManagedClass,
  gatingFeaturesForClass,
  dateChainClassId,
  dateChainParentId,
  isFamilyFeature,
  isLockedSystemClassId,
  managedClassIds,
  parseDateNodeId,
  plainTextExcerpt,
  stringifyContentAst,
  systemClassNameForId,
  SYSTEM_CLASS_EXTENDS_IDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_FAMILY_SEED,
  type FamilyFeature,
} from "@notees/domain";

import { reindexNode, removeSearchIndexEntry } from "./search.js";
import { rebuildEdges, reresolveEdgeTargets } from "./edges.js";
import { rebuildNodeStats } from "./stats.js";
import {
  assertValueForSchema,
  isValidDefaultForType,
  nodeRefOfValue,
  normalizeQualifierMetadata,
  type PropertySchemaValidationRow,
  visiblePropertyValueRows,
} from "./property-values.js";
import {
  CycleError,
  EnvelopeValidationError,
  isSqliteError,
  LockedSystemClassError,
  MoveGuardError,
  NotFoundError,
  PropertyValueShapeError,
  StoreError,
  SystemExtendsLockError,
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
  /**
   * Replay-only: the envelope failed to apply inside a remote batch and was
   * quarantined (recorded in `quarantined_envelope`) so the batch keeps
   * converging. Local authoring (Store.apply) never produces this — it
   * throws instead.
   */
  quarantined?: boolean;
  /** The apply error, set for quarantined summaries. */
  error?: string;
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
      "encrypted payload slot ($e) is reserved for E2EE and cannot be applied yet",
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

/** The render facts isPageRow needs off a node row. */
type RenderRow = { is_class: unknown; parent_id: unknown; is_embedded: unknown };

/** True when the row renders with document chrome under the recursive
 *  parent-page rule (owner ruling 2026-10-15): a class never does
 *  (ClassView), a parentless non-class row always does (the flag is unread),
 *  and a parented row does exactly when is_embedded = 0 (the standalone
 *  claim) AND its parent renders with document chrome. Walks the parent
 *  chain — cycles are impossible (subtree moves are guarded); a missing
 *  parent row is a defensive "not a page". */
function isPageRow(db: StoreDatabase, row: RenderRow): boolean {
  if (row.is_class === 1) return false;
  if (row.parent_id === null || row.parent_id === undefined) return true;
  if (row.is_embedded !== 0) return false;
  const parent = getNodeRow(db, row.parent_id as string);
  if (!parent) return false;
  return isPageRow(db, parent as unknown as RenderRow);
}

/** The property schema's type, null when the schema row is unknown
 *  (property.set has no schema FK — arbitrary ids store unchecked). */
function propertySchemaTypeOf(db: StoreDatabase, propertySchemaId: string): string | null {
  const row = db.prepare("SELECT type FROM property_schema WHERE id = ?").get(propertySchemaId) as
    | { type: string }
    | undefined;
  return row?.type ?? null;
}

/** The full schema row for value validation (PG6), null when unknown. */
function propertySchemaRowOf(
  db: StoreDatabase,
  propertySchemaId: string,
): PropertySchemaValidationRow | null {
  const row = db
    .prepare(
      `SELECT id, type, multi, options, target_class_filter AS targetClassFilter,
              date_precision AS datePrecision, date_qualified AS dateQualified,
              scope_class_ids AS scopeClassIds, validation_rules AS validationRules
       FROM property_schema WHERE id = ?`,
    )
    .get(propertySchemaId) as PropertySchemaValidationRow | undefined;
  return row ?? null;
}

/**
 * R3/R5 eligibility (owner ruling 2026-10-20): the scope list vs a candidate
 * class set's EXTENDS-AWARE closure — carried classes plus their
 * class_hierarchy ancestors (the same closure walk assertRefTargetForSchema
 * uses for targetClassFilter, and effective.ts's reachOf for bindings).
 * An empty scope list never occurs (the wire rejects it); NULL means global.
 */
function classClosureIntersectsScope(
  db: StoreDatabase,
  carriedClassIds: string[],
  scopeClassIds: string[] | null,
): boolean {
  if (scopeClassIds === null) return true; // global — anyone may carry it.
  if (scopeClassIds.length === 0) return true; // defensive: no stored empty list.
  const allowed = new Set<string>(carriedClassIds);
  if (carriedClassIds.length > 0) {
    const ancestors = db
      .prepare(
        "SELECT ancestor_id FROM class_hierarchy WHERE class_id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(carriedClassIds)) as Array<{ ancestor_id: string }>;
    for (const row of ancestors) allowed.add(row.ancestor_id);
  }
  return scopeClassIds.some((id) => allowed.has(id));
}

/** The stored scope list of a schema row (NULL = global). */
function scopeClassIdsOfRow(row: { scopeClassIds?: string | null } | null): string[] | null {
  if (row === null || row.scopeClassIds === null || row.scopeClassIds === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(row.scopeClassIds);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

/**
 * R3 (owner ruling 2026-10-20): a node is eligible for a schema when the
 * schema is global or the node's class closure (its classes + extends
 * ancestors) intersects the scope list. The node's classes come from the
 * derived class_ids projection (already assignment-order; eligibility is a
 * pure set test).
 */
function nodeEligibleForSchema(
  db: StoreDatabase,
  nodeClassIdsJson: string | null,
  scopeClassIds: string[] | null,
): boolean {
  if (scopeClassIds === null) return true;
  let carried: string[] = [];
  try {
    const parsed: unknown = JSON.parse(nodeClassIdsJson ?? "[]");
    if (Array.isArray(parsed)) carried = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    carried = [];
  }
  return classClosureIntersectsScope(db, carried, scopeClassIds);
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

/**
 * Content-asserted class membership (the no-divergence law, owner ruling
 * 2026-10-15): every `class_link` token in a stored content stream IS a
 * classing of its node. The object appliers apply the OR-set add for these
 * ids, so ANY writer (web gesture, CLI, GTK, Flutter, imports) converges —
 * a live reference can never outlive its membership. The inverse lock lives
 * in applyClassUnassign: it refuses while the content still references the
 * class (the removal gesture strips the links first, strip-then-unassign).
 */
function contentClassLinkIds(ast: unknown): string[] {
  const found = new Set<string>();
  const walk = (tokens: unknown): void => {
    if (!Array.isArray(tokens)) return;
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as Record<string, unknown>;
      if (t.type === "class_link" && typeof t.classId === "string") found.add(t.classId);
      if (Array.isArray(t.children)) walk(t.children);
    }
  };
  walk(ast);
  return [...found];
}

/** The class_member_set OR-set upsert shared by the membership carriers
 *  (object.create seed, the content assertion, class.unassign's remove). */
const CLASS_MEMBER_UPSERT_SQL = `INSERT INTO class_member_set (node_id, class_id, present, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, class_id) DO UPDATE SET
       present = excluded.present, hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`;

function applyObjectCreate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.create";
  const p = env.payload as OpPayload<"object.create">;
  const parentId = p.parentId ?? null;
  // Embedding flag (Revision 12): the payload may carry isEmbedded; the
  // applier defaults it by context — embedded is the default for a parented
  // node (its content belongs to the parent's body, block chrome), a
  // parentless one is standalone (document chrome by the second cascade
  // branch; the flag is stored but unread). Demotion/promotion is the
  // 1→0 / 0→1 toggle.
  const isEmbedded = p.isEmbedded === undefined ? (parentId === null ? 0 : 1) : p.isEmbedded ? 1 : 0;
  // Content-asserted membership (the no-divergence law, owner ruling
  // 2026-10-15): an embedded block keeps the rich stream, so its class_link
  // tokens class the node; a document-chrome node's content flattens to
  // text-only below (by construction — nothing to assert there).
  const linkClassIds = isEmbedded === 0 ? [] : contentClassLinkIds(p.contentAst);
  // Date-chain class lock (SCHEMA.md "Datetime"): a date node's class set is
  // FIXED to its precision's system class. The re-issued object.create is
  // the OR-Set add carrier (class.assign rides it, also on an existing id),
  // so the guard runs BEFORE the membership seeding and the re-create early
  // return below — and over the content-asserted ids too.
  const lockedDateClass = dateChainClassId(p.objectId);
  if (lockedDateClass !== null) {
    for (const classId of [...p.classIds, ...linkClassIds]) {
      if (classId !== lockedDateClass) {
        throw new MoveGuardError(
          `${opType}: node ${p.objectId} is a date-chain node; it can only carry the ${lockedDateClass} system class`,
          opType,
        );
      }
    }
  }
  const ts = env.timestamp;
  // Content flatten invariant (SCHEMA.md): document-chrome nodes (is_class
  // or is_embedded = 0) carry text-only content; an embedded block keeps the
  // full rich token stream.
  const content = JSON.stringify(
    isEmbedded === 0 ? stringifyContentAst(p.contentAst as never) : (p.contentAst ?? []),
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

  // First create wins for duplicate node ids (INSERT OR IGNORE): re-issuing
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
    for (const classId of [...p.classIds, ...linkClassIds]) {
      memberUpsert.run(p.objectId, classId, env.hlc.physical, env.hlc.logical, env.actorId);
    }
    if (p.classIds.length > 0 || linkClassIds.length > 0) recomputeClassIds(db, p.objectId);
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
    // Classes are containers (spec I4): a class parent is legal for
    // non-class children — which is all object.create can make (is_class
    // stays 0; class declaration remains the class.create op).
    // Parent-page condition (owner ruling 2026-10-15): the standalone role
    // is only effective under a page parent — claiming it under a class or
    // a block parent establishes an illegal parented state and fails loud.
    // (A parented default is embedded = 1, so isEmbedded === 0 here is
    // always an explicit claim.)
    if (isEmbedded === 0 && !isPageRow(db, parent as unknown as RenderRow)) {
      throw new MoveGuardError(
        `${opType}: is_embedded = 0 (standalone) requires the parent to render with document chrome ` +
          `(parent ${parentId} is a class or an embedded block)`,
        opType,
      );
    }
  }
  // Date-chain parenting lock (SCHEMA.md "Datetime", same rule as
  // object.move, with one birth-time exception): a date id may only be
  // created AT its deterministic chain parent (year → root, month → year,
  // day → month). Claiming any other parent is establishing an illegal
  // parented state and fails loud; a parentless create is the standalone
  // shape the client chain self-heal adopts, so it stays legal.
  if (
    parentId !== null &&
    parseDateNodeId(p.objectId) !== null &&
    parentId !== dateChainParentId(p.objectId)
  ) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} is a date-chain node; it can only be created at its deterministic chain parent`,
      opType,
    );
  }

  try {
    db.prepare(
      `INSERT INTO node (
         id, workspace_id, is_class, is_embedded, parent_id, class_ids, name, content, icon, color,
         list_style, is_active, created_at, updated_at, created_by, updated_by,
         hlc_physical, hlc_logical, actor_id
       ) VALUES (?, ?, 0, ?, ?, '[]', NULL, ?, NULL, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.objectId,
      env.workspaceId,
      isEmbedded,
      parentId,
      content,
      p.listStyle ?? null,
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

  for (const classId of [...p.classIds, ...linkClassIds]) {
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
  const createdEdges = rebuildEdges(db, p.objectId, ts);
  rebuildNodeStats(db, [p.objectId]);
  // The summary carries the edge targets too: a mention/link/class chip on
  // the new content changes those nodes' backlink/reference reads (the
  // scope-classed invalidation depends on target inclusion).
  return summary(opType, [p.objectId, ...createdEdges.affectedNodeIds]);
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

/**
 * M12 write-time alias-cycle validation (the extends-DAG precedent):
 * `object.update {aliasedNodeId: T}` on node N must not close an alias
 * cycle. The would-be chain is N → T → T's target → … — walk it from T; a
 * revisit of any visited node (including N itself — the 1-edge self-alias)
 * means the write would create a cycle, so it fails loud and is NEVER
 * applied. Clearing (null) cannot create a cycle and skips the check.
 * Chains without a cycle terminate (finite graph); the visited set makes
 * the walk exact.
 */
function assertAliasAcyclic(
  db: StoreDatabase,
  nodeId: string,
  targetId: string,
  opType: string,
): void {
  const visited = new Set<string>([nodeId]);
  let current = targetId;
  for (;;) {
    if (visited.has(current)) {
      throw new CycleError(
        `${opType}: aliasing ${nodeId} → ${targetId} would close an alias cycle at ${current}`,
        opType,
      );
    }
    visited.add(current);
    const row = db
      .prepare("SELECT aliased_node_id FROM node WHERE id = ?")
      .get(current) as { aliased_node_id: string | null } | undefined;
    if (row === undefined || row.aliased_node_id === null) return;
    current = row.aliased_node_id;
  }
}

function applyObjectUpdate(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.update";
  const p = env.payload as OpPayload<"object.update">;
  const row = requireNode(db, p.objectId, opType) as unknown as Parameters<typeof rowWinner>[0] & {
    is_class: number;
    is_embedded: number;
    parent_id: string | null;
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
  // Promotion/demotion (Revision 12) is the isEmbedded toggle: the flag
  // joins the row-level LWW set; a 1 -> 0 flip (promotion to standalone /
  // the Page role) stringifies the rich token stream to text-only in the
  // same op (the lossy boundary the UI warns about), while a 0 -> 1
  // demotion leaves the content untouched — demotion never un-flattens.
  // On a class row the flag is inert (classes render ClassView regardless);
  // applying it harmlessly keeps the op uniform.
  // Parent-page condition (owner ruling 2026-10-15): the standalone role is
  // only effective under a page parent. Promotion (isEmbedded: false) fails
  // loud when the parent is a class or an embedded block; demotion of a
  // parented page fails loud while it still carries is_embedded = 0
  // children (they would dangle under a non-page parent — demote or move
  // them first).
  if (p.isEmbedded !== undefined) {
    if (p.isEmbedded === false && row.parent_id !== null) {
      const parent = getNodeRow(db, row.parent_id);
      if (!parent || !isPageRow(db, parent as unknown as RenderRow)) {
        throw new MoveGuardError(
          `${opType}: is_embedded = 0 (standalone) requires the parent to render with document chrome ` +
            `(parent ${row.parent_id} is a class or an embedded block)`,
          opType,
        );
      }
    }
    if (p.isEmbedded === true && row.is_embedded === 0 && row.parent_id !== null) {
      const standaloneChild = db
        .prepare("SELECT 1 AS x FROM node WHERE parent_id = ? AND is_embedded = 0 LIMIT 1")
        .get(p.objectId);
      if (standaloneChild !== undefined) {
        throw new MoveGuardError(
          `${opType}: cannot demote node ${p.objectId} while it carries standalone (is_embedded = 0) children ` +
            "(demote or move them first)",
          opType,
        );
      }
    }
    sets.push("is_embedded = ?");
    values.push(p.isEmbedded ? 1 : 0);
    if (p.isEmbedded === false && row.is_embedded === 1) {
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
  // Wire node fields (the icon/color precedent): presence writes, present-
  // null clears (SQL NULL) — the schema's nullish fields make absence and
  // clear distinguishable, exactly like `color`. They ride the row-level
  // LWW with the rest of the update. Cover/banner map without validating
  // (asset existence is a read/client-layer concern); the alias target DOES
  // validate — see assertAliasAcyclic below (M12, the extends-DAG
  // precedent: structural invariants are write-time impossible).
  if (p.coverAssetId !== undefined) {
    sets.push("cover_asset_id = ?");
    values.push(p.coverAssetId);
  }
  if (p.bannerAssetId !== undefined) {
    sets.push("banner_asset_id = ?");
    values.push(p.bannerAssetId);
  }
  if (p.aliasedNodeId !== undefined) {
    if (p.aliasedNodeId !== null) {
      assertAliasAcyclic(db, p.objectId, p.aliasedNodeId, opType);
    }
    sets.push("aliased_node_id = ?");
    values.push(p.aliasedNodeId);
  }
  if (p.description !== undefined) {
    sets.push("description = ?");
    values.push(p.description);
  }
  // Per-block list style (store schema v23): presence writes, present-null
  // clears back to the bullet default — the same keep/clear contract as
  // `color`.
  if (p.listStyle !== undefined) {
    sets.push("list_style = ?");
    values.push(p.listStyle);
  }
  // Archival bit (owner ruling 2026-10-22, the classes-gallery batch):
  // presence writes — `false` archives, `true` unarchives. A reversible
  // STATE, distinct from the trash table (deletion). Archival REFUSALS:
  // the locked system classes can never be archived, and family bases are
  // toggle-managed (the Features setting is their single archive path) —
  // both fail loud below; unarchiving is harmless and stays legal. Class
  // rows mirror the bit to the registry projection below (the
  // feature-derivation pattern).
  if (p.active !== undefined) {
    if (p.active === false && row.is_class === 1) {
      // Locked system classes can never be archived (the delete routing's
      // locked arm applies to the archival write path too).
      if (isLockedSystemClassId(p.objectId)) {
        throw new LockedSystemClassError(
          `${opType}: ${systemClassNameForId(p.objectId)} is a locked system class — it can never be archived ` +
            "(archival is gallery-toggleable for every OTHER system class)",
          opType,
        );
      }
      // Family bases are toggle-managed: the Features setting is the single
      // archive path for the families (the delete routing's arm 2). A direct
      // archival write would diverge the class bit from the toggle until the
      // next re-derivation — refused, fail loud. (Unarchiving stays legal:
      // it heals, never diverges harmfully.)
      const managedFeature = featureForManagedClass(p.objectId);
      if (managedFeature !== null) {
        throw new MoveGuardError(
          `${opType}: ${systemClassNameForId(p.objectId)} is a family base class — archival is toggle-managed ` +
            `(workspace.feature.set {feature: "${managedFeature}", enabled: false}); direct archival writes are refused`,
          opType,
        );
      }
    }
    sets.push("is_active = ?");
    values.push(p.active ? 1 : 0);
  }
  let assertedClassIds: string[] = [];
  if (p.contentAst !== undefined) {
    // Class content stays text-only; every other node keeps the rich token
    // stream it was sent. A page's own content may carry inline tokens
    // (mentions, external links) — the header title edits it with the full
    // block editor — while display-name derivation still flattens to text
    // for labels (SCHEMA.md title-is-content). Create-as-main and the
    // promotion stringify above remain the lossy boundaries.
    const flatten = row.is_class === 1;
    sets.push("content = ?");
    values.push(
      JSON.stringify(flatten ? stringifyContentAst(p.contentAst as never) : p.contentAst),
    );
    // Content-asserted membership (the no-divergence law): the class_link
    // tokens about to be stored class the node. Class rows flatten (never
    // carry links); date-chain nodes' class set is fixed — a foreign link
    // there is the same illegal state as a foreign classId on create.
    assertedClassIds = flatten ? [] : contentClassLinkIds(p.contentAst);
    const lockedDateClass = dateChainClassId(p.objectId);
    if (lockedDateClass !== null && assertedClassIds.some((id) => id !== lockedDateClass)) {
      throw new MoveGuardError(
        `${opType}: node ${p.objectId} is a date-chain node; it can only carry the ${lockedDateClass} system class`,
        opType,
      );
    }
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
  // The rebuild's affected set (previous + desired edge targets) rides the
  // summary: scope-classed invalidation keys on those nodes' backlink and
  // reference reads changing.
  let contentEdgeAffected: string[] = [];
  if (p.contentAst !== undefined) {
    reindexNode(db, p.objectId);
    contentEdgeAffected = rebuildEdges(db, p.objectId, env.timestamp).affectedNodeIds;
  }
  // The content assertion lands with the write: every stored class_link
  // token is an OR-set membership add, so any writer converges (the inline
  // reference can never outlive the membership).
  if (assertedClassIds.length > 0) {
    const memberUpsert = db.prepare(CLASS_MEMBER_UPSERT_SQL);
    for (const classId of assertedClassIds) {
      memberUpsert.run(p.objectId, classId, 1, env.hlc.physical, env.hlc.logical, env.actorId);
    }
    recomputeClassIds(db, p.objectId);
  }
  // An alias write re-points every alias chain through this node: re-resolve
  // the resolved_target_id of all edge rows whose target chain touches it
  // (this node's own edges re-derive on the next content rebuild; the
  // closure covers every OTHER source's rows). Liveness-neutral: the
  // reverse closure is pointer-based, invariant under this write.
  if (p.aliasedNodeId !== undefined) {
    reresolveEdgeTargets(db, [p.objectId]);
  }
  // An archival flip changes node liveness, which gates alias-chain
  // resolution (the walk is live-aware) — re-materialize the edge rows whose
  // chains touch the node. On a class row the bit ALSO mirrors to the
  // registry projection (`class.active`, the pickers/class-hubs read — the
  // feature-derivation pattern): the class node's bit is the authority, the
  // registry column its direct projection. No HLC/timestamp writes on the
  // registry row — the op's HLC already landed on the node row above.
  if (p.active !== undefined) {
    if (row.is_class === 1) {
      db.prepare("UPDATE class SET active = ? WHERE id = ?").run(p.active ? 1 : 0, p.objectId);
    }
    reresolveEdgeTargets(db, [p.objectId]);
  }
  return summary(opType, [p.objectId, ...contentEdgeAffected]);
}

function applyObjectDelete(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.delete";
  const p = env.payload as OpPayload<"object.delete">;
  requireNode(db, p.objectId, opType);
  const ts = env.timestamp;
  const affected = new Set<string>([p.objectId, ...ancestorIds(db, p.objectId)]);
  // Class-node delete routing (owner ruling 2026-10-22 — the retired
  // class.delete op's routing, moved here; SCHEMA.md "Workspace features").
  // Classes are nodes: one delete op, four applier-decided outcomes, all a
  // pure function of the class id so every replica takes the same branch.
  // MEMBERSHIP RIDES in every arm — `class_member_set` rows are never
  // touched by class removal (archive or trash); stripping a class from
  // nodes stays the explicit per-node `class.unassign`.
  const nodeRow = db
    .prepare("SELECT is_class FROM node WHERE id = ?")
    .get(p.objectId) as { is_class: number } | undefined;
  const deletedIsClass = nodeRow?.is_class === 1;

  if (deletedIsClass) {
    // Arm 1 — LOCKED system classes (the date chain + table, asset, query,
    // code, template, comment): platform structure, never archivable or
    // deletable. Fails loud, never applied — regardless of `permanent`.
    if (isLockedSystemClassId(p.objectId)) {
      throw new LockedSystemClassError(
        `${opType}: ${systemClassNameForId(p.objectId)} is a locked system class — it can never be deleted`,
        opType,
      );
    }
    // Arm 2 — a family BASE class (task, event, meeting, source, person):
    // routed to the toggle, applied as a feature-disable (the LWW row + the
    // family re-derivation — the Features setting stays the single archive
    // path for the families, and the whole extends family archives with the
    // base). The route decision rides the envelope's HLC, so a racing
    // toggle converges under either delivery order (the row gate).
    const managedFeature = featureForManagedClass(p.objectId);
    if (managedFeature !== null) {
      const wrote = lwwWriteFeatureRow(db, env, managedFeature, false);
      if (wrote) {
        deriveFamilyClassBits(db, env.workspaceId, managedFeature);
      }
      return summary(
        opType,
        wrote ? managedClassIds(managedFeature) : [p.objectId],
        !wrote,
      );
    }
    // Arm 3 — any OTHER non-locked system class: re-wired to ARCHIVAL
    // (`active = false`), NOT trash (the gallery's disable gesture; the
    // system picks the most reversible interpretation — disable = delete).
    // No trash row: the node is restorable with `object.update
    // {active: true}`, not `object.restore` (archive is not deletion).
    // `permanent` is ignored on this arm — archival is the only delete a
    // system class admits.
    if (systemClassNameForId(p.objectId) !== null) {
      db.prepare("UPDATE node SET is_active = 0, updated_at = ? WHERE id = ?").run(
        ts,
        p.objectId,
      );
      db.prepare("UPDATE class SET active = 0, updated_at = ? WHERE id = ?").run(ts, p.objectId);
      // The archival flip gates alias-chain resolution (the walk is
      // live-aware) — re-materialize the edge rows touching the class node.
      reresolveEdgeTargets(db, [p.objectId]);
      rebuildNodeStats(db, [...affected]);
      return summary(opType, [...affected]);
    }
    // Arm 4 — a USER class: falls through to the plain trash path below
    // (soft delete with a trash row, restorable from the Trash hub — the
    // whole subtree rides, exactly like any node). The registry projection
    // mirrors the node's liveness in BOTH directions on this arm (trash →
    // active = 0, restore → active = 1, purge → row gone) — the class node's
    // bit is the authority on every arm, never only the archival ones.
  }

  if (!p.permanent) {
    // Soft delete: trash the subtree (SCHEMA.md deletion
    // semantics — restore is whole-tree), keep the tree for restore.
    const ids = subtreeIds(db, p.objectId);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE node SET is_active = 0 WHERE id IN (${placeholders})`).run(...ids);
    if (deletedIsClass) {
      // The registry projection follows the node into the trash (the picker
      // read filters on it — an active registry row under a trashed node is
      // the ghost-row state the withdrawn-system-class cleanup hit).
      db.prepare("UPDATE class SET active = 0, updated_at = ? WHERE id = ?").run(ts, p.objectId);
    }
    db.prepare(
      "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 0)",
    ).run(p.objectId, ts);
    // Trashed nodes never resolve through (the edge resolution walk is
    // live-aware): re-materialize the rows whose alias chains touch the
    // subtree — a trashed alias's edges stay on the alias (inert), chains
    // THROUGH a trashed node collapse to their last live link.
    reresolveEdgeTargets(db, ids);
    rebuildNodeStats(db, [...affected]);
    return summary(opType, [...affected]);
  }

  permanentlyDeleteSubtree(db, p.objectId, ts);
  return summary(opType, [...affected]);
}

/**
 * Hard-delete a subtree and record the root's permanent retention row —
 * the shared body of `object.delete {permanent: true}` and `trash.empty`
 * (SCHEMA.md deletion semantics). Every descendant table owned by the
 * subtree is purged; incoming references from SURVIVING nodes keep their
 * rows (PB1 — see the object.delete applier's comment) and the alias/edge
 * projections are re-materialized for the deleted id set. The purge also
 * rebuilds node_stats for everything that lost a count: the subtree's edge
 * targets (backlinks) and its ancestors (descendant counts).
 */
function permanentlyDeleteSubtree(db: StoreDatabase, objectId: string, ts: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 1)",
  ).run(objectId, ts);

  const ids = subtreeIds(db, objectId);
  const placeholders = ids.map(() => "?").join(",");
  // Everything that loses a materialized count in this purge, collected
  // BEFORE the rows die: the subtree's edge targets lose backlinks and the
  // subtree's ancestors lose descendants — without the rebuild their
  // node_stats rows keep counting the dead rows (the badge reads a stored
  // number, so the divergence never heals on its own).
  const lostBacklinkTargets = (
    db
      .prepare(
        `SELECT DISTINCT target_id FROM edge WHERE source_id IN (${placeholders}) AND target_id IS NOT NULL`,
      )
      .all(...ids) as { target_id: string }[]
  ).map((r) => r.target_id);
  const ancestors = ancestorIds(db, objectId);
  db.prepare(`DELETE FROM node WHERE id IN (${placeholders})`).run(...ids);
  // The registry row is a projection of the class node's liveness: a
  // permanently purged class takes it along (otherwise the row ghosts in
  // registry reads forever — the withdrawn-system-class lesson: node gone,
  // `class.active = 1` left behind by the pre-mirror purge).
  db.prepare(`DELETE FROM class WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(
    `DELETE FROM node_child_order WHERE parent_id IN (${placeholders}) OR child_id IN (${placeholders})`,
  ).run(...ids, ...ids);
  db.prepare(`DELETE FROM property_value WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM property_value_tombstone WHERE node_id IN (${placeholders})`).run(...ids);
  // PG5: the subtree's element tombstones die with it (owned rows only —
  // tombstones of elements on SURVIVING nodes are keyed by globally-unique
  // element ids and never reference these rows).
  db.prepare(`DELETE FROM property_value_element_tombstone WHERE node_id IN (${placeholders})`).run(
    ...ids,
  );
  db.prepare(`DELETE FROM class_member_set WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM node_asset WHERE node_id IN (${placeholders})`).run(...ids);
  // PB1 (keep-value + render-broken, SCHEMA.md "Broken references"): rows
  // OWNED by the subtree die with it (sources, memberships, attachments).
  // Incoming references from SURVIVING nodes keep their rows — the other's
  // property_value / mention content survives deletion by design, so its
  // edge projection must survive too; deleting here only to have the
  // source's next rebuildEdges re-derive the identical row (shape-based,
  // target-existence-blind) was a transient resurrection.
  // Ghost-target edge rows are inert: every backlink/reference query is
  // keyed by a live node id, and a target restored from trash heals the
  // set only when its rows survived.
  db.prepare(`DELETE FROM node_link WHERE source_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM edge WHERE source_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM node_stats WHERE node_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM trash WHERE node_id IN (${placeholders}) AND node_id != ?`).run(...ids, objectId);
  for (const id of ids) removeSearchIndexEntry(db, id);
  // Deleted rows are ghosts that never resolve through: re-materialize the
  // rows whose alias chains touched the subtree (incoming edges keep their
  // rows by design — PB1 — with the resolution their chain now yields).
  reresolveEdgeTargets(db, ids);
  rebuildNodeStats(db, [...ancestors, ...lostBacklinkTargets]);
}

/**
 * Empty the trash (the trash.empty op): permanently delete every node
 * carrying a non-permanent trash row. The root set is snapshotted at apply
 * time and each root goes through the same subtree purge as `object.delete
 * {permanent: true}` — a root consumed by an earlier iteration (its own
 * subtree contained another independently-trashed root) has no node row
 * left and is skipped. A stale non-permanent trash row with no node row
 * (legacy dangling state) is swept as cleanup instead of failing replay.
 * Replay is idempotent: an empty trash table no-ops.
 */
function applyTrashEmpty(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "trash.empty";
  const ts = env.timestamp;
  const roots = db
    .prepare("SELECT node_id FROM trash WHERE is_permanent = 0 ORDER BY node_id")
    .all() as { node_id: string }[];
  const affected = new Set<string>();
  for (const { node_id } of roots) {
    const row = getNodeRow(db, node_id);
    if (row === undefined) {
      db.prepare("DELETE FROM trash WHERE node_id = ?").run(node_id);
      continue;
    }
    affected.add(node_id);
    for (const id of ancestorIds(db, node_id)) affected.add(id);
    permanentlyDeleteSubtree(db, node_id, ts);
    // A class emptied from the trash keeps its memberships (owner ruling
    // 2026-10-22 — membership rides): the surviving pairs become the
    // dangling-reference render state (SCHEMA.md "Content grammar", Fork 3).
  }
  rebuildNodeStats(db, [...affected]);
  return summary(opType, [...affected]);
}

/**
 * Restore from the trash (the object.restore op). Whole-tree, per SCHEMA.md's
 * deletion/restore semantics: every descendant trashed WITH the root
 * reactivates; a descendant carrying its OWN trash row was trashed
 * independently (its subtree rode with that delete, not with this restore)
 * and stays trashed — so the reactivation set is "subtree minus the
 * independently-trashed branches", computed by walking up from each id to
 * the root and bailing at the first own-trash-row ancestor. The root's own
 * trash row is consumed. With NO trash row on the root there is nothing to
 * restore: a safe no-op (archive is not trash — an archived node's
 * unarchive path is `object.update {active: true}`, never object.restore;
 * restoring a live node stays the promote-gesture no-op). Corner: parent
 * row missing (permanently deleted —
 * the chain above is unknowable from the derived store) → reparent to the
 * workspace root; a present-but-inactive parent is left alone (transient
 * state that restoring the parent heals — never data loss). LWW against
 * object.delete is plain log order: the single global relay log applies
 * each op to every replica once, so the pair converges.
 */
function applyObjectRestore(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "object.restore";
  const p = env.payload as OpPayload<"object.restore">;
  const root = requireNode(db, p.objectId, opType);

  // Corner: dangling parent_id (parent permanently deleted, legacy rows) —
  // reparent to the workspace root; the child_order rows of a hard-deleted
  // parent were purged with it, so no order row needs repair.
  if (typeof root.parent_id === "string") {
    const parent = getNodeRow(db, root.parent_id);
    if (parent === undefined) {
      db.prepare("UPDATE node SET parent_id = NULL WHERE id = ?").run(p.objectId);
      root.parent_id = null;
    }
  }

  // Archive is not trash (owner ruling 2026-10-22): without a trash row on
  // the root there is no trash event to restore from — the op is a safe
  // no-op (the promote-gesture precedent: restoring a live carrier no-ops).
  // An ARCHIVED node (is_active = 0, no trash row) is therefore NOT
  // reactivated here: unarchive rides `object.update {active: true}`.
  if (db.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(p.objectId) === undefined) {
    return summary(opType, [p.objectId]);
  }

  const ids = subtreeIds(db, p.objectId);
  const hasOwnTrashRow = (id: string) =>
    db.prepare("SELECT 1 FROM trash WHERE node_id = ?").get(id) !== undefined;
  const parentOf = (id: string): string | null =>
    (db.prepare("SELECT parent_id AS pid FROM node WHERE id = ?").get(id) as { pid: string | null } | undefined)
      ?.pid ?? null;

  const toReactivate: string[] = [];
  for (const id of ids) {
    if (id === p.objectId) {
      toReactivate.push(id);
      continue;
    }
    // The id itself carries a trash row → trashed independently, full stop.
    if (hasOwnTrashRow(id)) continue;
    // Otherwise walk up: an own-trash-row ancestor below the root means this
    // id rode THAT delete (the ancestor's subtree), not the root's.
    let cursor: string | null = parentOf(id);
    let ridesThisDelete = true;
    while (cursor !== null) {
      if (cursor === p.objectId) break;
      if (hasOwnTrashRow(cursor)) {
        ridesThisDelete = false;
        break;
      }
      cursor = parentOf(cursor);
    }
    if (ridesThisDelete) toReactivate.push(id);
  }

  const placeholders = toReactivate.map(() => "?").join(",");
  db.prepare(`UPDATE node SET is_active = 1 WHERE id IN (${placeholders})`).run(...toReactivate);
  // The registry projection mirrors back with the node (the trash arm
  // mirrored it off — a restored class re-enters the pickers).
  db.prepare(`UPDATE class SET active = 1, updated_at = ? WHERE id IN (${placeholders})`).run(
    env.timestamp,
    ...toReactivate,
  );
  db.prepare("DELETE FROM trash WHERE node_id = ?").run(p.objectId);
  // Restored rows re-enter alias chains (the resolution walk is live-aware):
  // re-materialize every edge row whose chain touches the reactivated set.
  reresolveEdgeTargets(db, toReactivate);

  const affected = new Set<string>([p.objectId, ...ancestorIds(db, p.objectId)]);
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
 * a node may never move under itself or its own descendant (parent_id cycle),
 * a CLASS node may never move under any parent (classes are always roots
 * — spec I4 makes class nodes containers of non-class children, but the
 * class-under-class / class-with-parent shape stays illegal; the DB CHECK
 * would fire anyway, so the guard surfaces it friendly), and a DATE-CHAIN
 * node may only move under its deterministic chain parent (SCHEMA.md
 * "Datetime" — the parenting lock), and a STANDALONE (is_embedded = 0) node
 * may only move under a parent that renders with document chrome (the
 * parent-page condition, owner ruling 2026-10-15). Moves never write
 * the embedding flag: a parentless non-class node renders with document
 * chrome by the second cascade branch regardless of is_embedded.
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
    if (subtreeIds(db, p.objectId).includes(p.parentId)) {
      throw new MoveGuardError(
        `${opType}: cannot move node ${p.objectId} under ${p.parentId}, which is in its own subtree`,
        opType,
      );
    }
  }
  if (p.parentId !== null && (row as { is_class?: number }).is_class === 1) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} is a class; classes are always roots and cannot have a parent`,
      opType,
    );
  }
  // Parent-page condition (owner ruling 2026-10-15): a standalone node
  // (is_embedded = 0) renders with document chrome only under a page parent,
  // so moving one under a class or an embedded block establishes an illegal
  // parented state and fails loud (moves never write the flag — the
  // alternative, silently clearing it, would rewrite render state behind
  // the user's back).
  if (
    p.parentId !== null &&
    (row as { is_embedded?: number }).is_embedded === 0 &&
    !isPageRow(db, getNodeRow(db, p.parentId) as unknown as RenderRow)
  ) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} is standalone (is_embedded = 0); it can only move under a parent that renders with document chrome`,
      opType,
    );
  }
  // Date-chain parenting lock (SCHEMA.md "Datetime"): a date node may ONLY
  // live under its deterministic chain parent (year → root, month → year,
  // day → month). The chain self-heal re-issues exactly this move, so the
  // chain-correct parent stays legal; any other target is a reparenting
  // attempt and fails loud.
  if (parseDateNodeId(p.objectId) !== null && p.parentId !== dateChainParentId(p.objectId)) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} is a date-chain node; its parent is locked to the deterministic chain parent`,
      opType,
    );
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
  fields: { contentAst?: unknown; icon?: string | undefined; color?: string | null | undefined },
): void {
  // The class node (is_class = 1) is the structural authority for the
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
  // Create-time icon/color ride along for the same reason: without them the
  // class node row stays iconless while the registry row carries the glyph,
  // and every effective-icon read (which reads node rows) misses it.
  db.prepare(
    `INSERT OR IGNORE INTO node (
       id, workspace_id, is_class, is_embedded, parent_id, class_ids, name, content,
       icon, color,
       is_active, created_at, updated_at, created_by, updated_by,
       hlc_physical, hlc_logical, actor_id
     ) VALUES (?, ?, 1, 0, NULL, '[]', NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    classId,
    env.workspaceId,
    content ?? "[]",
    fields.icon ?? null,
    fields.color ?? null,
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
  // Date-chain class lock (SCHEMA.md "Datetime"): a date node is a journal
  // entry, never a class — declaring it one (fresh or the conversion flip)
  // would sever its identity.
  if (parseDateNodeId(p.classId) !== null) {
    throw new MoveGuardError(
      `${opType}: node ${p.classId} is a date-chain node; it can never be declared a class`,
      opType,
    );
  }
  // Registry `name` is a denormalized cache of the class node's title text
  // (NOT NULL — the empty string is the absent sentinel). A conversion
  // (class.create on an existing node) carries no contentAst: absent fields
  // PRESERVE the stored registry values on re-declaration (COALESCE around a
  // NULLIF sentinel), they never wipe. The fresh INSERT's empty-name case is
  // backfilled from the node's existing title below (title-is-content: the
  // node row is the authority).
  const titleText = p.contentAst !== undefined ? (plainTextExcerpt(p.contentAst as never) ?? "") : null;
  db.prepare(
    `INSERT INTO class (id, workspace_id, name, icon, color, description, active, created_at, updated_at)
     VALUES (?, ?, COALESCE(?, ''), ?, ?, NULL, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(NULLIF(excluded.name, ''), class.name),
       icon = COALESCE(excluded.icon, class.icon),
       color = COALESCE(excluded.color, class.color),
       description = class.description, active = 1, updated_at = excluded.updated_at`,
  ).run(p.classId, env.workspaceId, titleText, p.icon ?? null, p.color ?? null, env.timestamp, env.timestamp);
  if (titleText === null) {
    // Title-less declaration (the conversion path — a bare classId payload):
    // adopt the node's current title into the fresh registry cache.
    const nodeRow = db.prepare("SELECT content FROM node WHERE id = ?").get(p.classId) as
      | { content: string }
      | undefined;
    let derived = "";
    try {
      derived = plainTextExcerpt(JSON.parse(nodeRow?.content ?? "[]") as never) ?? "";
    } catch {
      derived = "";
    }
    db.prepare("UPDATE class SET name = ? WHERE id = ? AND name = ''").run(derived, p.classId);
  }
  upsertClassNode(db, env, p.classId, { contentAst: p.contentAst, icon: p.icon, color: p.color });
  // Conversion (owner ruling retiring the seeded `class` class, 2026-10-07):
  // class.create on an EXISTING node DECLARES that node a class — the node
  // row was INSERT OR IGNOREed above, which never flips the identity bit.
  // The flip is the whole capability: is_class = 1, classes-are-roots (the
  // parent edge + its child-order row drop), the embedding flag cleared. The
  // node's title/icon/color stay LWW-gated above (an absent payload field
  // preserves them — conversion carries no content unless sent). Membership
  // and the node's own children are untouched (classes are containers).
  // Applied unconditionally: declaration is structural, not a row-field race
  // (the extends-DAG precedent, object.delete's bit flips).
  const converted = db
    .prepare("UPDATE node SET is_class = 1, is_embedded = 0, parent_id = NULL WHERE id = ? AND is_class = 0")
    .run(p.classId);
  if (converted.changes > 0) {
    db.prepare("DELETE FROM node_child_order WHERE child_id = ?").run(p.classId);
  }
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
  // Date-chain class lock (SCHEMA.md "Datetime"): the precision's system
  // class IS the date node's identity — removing it is illegal. Unassigning
  // a FOREIGN class stays legal: it cleans up a legacy violation rather
  // than freezing one.
  const lockedDateClass = dateChainClassId(p.objectId);
  if (lockedDateClass !== null && p.classId === lockedDateClass) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} is a date-chain node; its ${lockedDateClass} system class cannot be removed`,
      opType,
    );
  }
  // Content-reference lock (the no-divergence law, owner ruling 2026-10-15):
  // the stored content still carries an inline class_link to this class —
  // unassigning would strand a live reference. The removal gesture strips
  // the links FIRST (strip-then-unassign, envelope order); a raw
  // class.unassign refuses rather than silently diverging — loud failure,
  // never applied, the write-time-impossible law.
  const contentRow = db.prepare("SELECT content FROM node WHERE id = ?").get(p.objectId) as
    | { content: string }
    | undefined;
  if (contentRow !== undefined && contentClassLinkIds(JSON.parse(contentRow.content)).includes(p.classId)) {
    throw new MoveGuardError(
      `${opType}: node ${p.objectId} content references class ${p.classId} inline — remove the inline links first`,
      opType,
    );
  }
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
 * model). Recompute-from-scratch for the whole
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

  // System-extends lock (SCHEMA.md "Class properties"): a system class's
  // extends mapping is seeded platform structure — the feature-toggle cascade
  // (systemClassAncestors) and binding inheritance (the class_extends walk)
  // both derive from it. The payload's parent set must EQUAL the seeded set
  // (compared as sets — the seed/ensure re-issue convergence path); any
  // deviation fails loud and is never applied. System classes without seeded
  // parents are frozen to the empty set. User classes stay freely extensible,
  // including onto system bases.
  const seededParents = SYSTEM_CLASS_EXTENDS_IDS[p.classId];
  if (seededParents !== undefined) {
    const next = new Set(p.parentClassIds);
    const seeded = new Set(seededParents);
    const same = next.size === seeded.size && [...next].every((id) => seeded.has(id));
    if (!same) {
      const fmt = (ids: Set<string>) => [...ids].sort().join(", ");
      throw new SystemExtendsLockError(
        `${opType}: system class ${p.classId} has a frozen extends mapping; ` +
          `payload parents [${fmt(next)}] deviate from the seeded set [${fmt(seeded)}]`,
        opType,
      );
    }
  }

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
// Binding rows on `class_property` (SCHEMA.md "Class properties"): the
// genuinely per-class mechanics ONLY — today just `active`, the soft-unbind
// flag (owner rulings 2026-10-20/21): the render contracts
// (readonly/hideWhenEmpty/display) moved to the property schema
// (owner review 2026-10-05), `required`/`defaultValue` left the binding
// entirely (2026-10-20 — `required` retired outright, `defaultValue` moved
// to the schema, one global default per property), and `sequence` retired
// outright (2026-10-21 — class panels render alphabetically by property
// name, a pure read-time derivation in effective.ts). Row-level LWW by
// envelope HLC; on update the payload PATCHES the row — omitted fields keep
// their existing values. Defaults are never materialized into
// property_value; the effective-values read model (effective.ts) derives the
// schema's default at query time — and skips INACTIVE rows entirely (PC4:
// soft-unbind, the row survives).

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

  // R5 (owner ruling 2026-10-20): dead config is rejected — a binding on a
  // schema whose scope EXCLUDES the class is provably inert (the effective
  // read suppresses its default under R4), so the write fails loud. The
  // class's own extends closure counts: a class scoped to an ANCESTOR of the
  // binding class still binds (subclass instances are eligible via the
  // ancestor). Schema-less writes (unknown schema id) stay unchecked.
  {
    const schema = propertySchemaRowOf(db, p.propertySchemaId);
    if (schema !== null) {
      const scope = scopeClassIdsOfRow(schema);
      if (!classClosureIntersectsScope(db, [p.classId], scope)) {
        throw new MoveGuardError(
          `${opType}: schema ${p.propertySchemaId} is scoped to classes that exclude ${p.classId} — ` +
            "the binding would be inert (scope is the sole locality authority)",
          opType,
        );
      }
    }
  }

  const active = p.active === undefined ? null : p.active ? 1 : 0;

  if (!existing) {
    db.prepare(
      `INSERT INTO class_property
         (class_id, property_schema_id, active,
          hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      p.classId,
      p.propertySchemaId,
      active ?? 1,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
  } else {
    // Partial update: COALESCE keeps the stored value for omitted fields
    // (present fields update, including explicit false).
    db.prepare(
      `UPDATE class_property SET
         active = COALESCE(?, active),
         hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE class_id = ? AND property_schema_id = ?`,
    ).run(
      active,
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
  // PC2 (moved from the binding, owner ruling 2026-10-20): the default is
  // typed per the schema's (payload) type — a wrong-typed default fails loud
  // here instead of deriving silently on every read. Node-typed schemas
  // (datetime/object/asset) accept only JSON null — a default that links a
  // node is meaningless. Absent = no default (NULL column).
  if (p.defaultValue !== undefined && p.defaultValue !== null && !isValidDefaultForType(p.type, p.defaultValue)) {
    throw new PropertyValueShapeError(
      `${opType}: defaultValue for ${p.type} schema ` +
        (p.type === "datetime" || p.type === "object" || p.type === "asset"
          ? "must be null — node-typed defaults are not supported"
          : `must be typed ${p.type}`) +
        ` — got ${JSON.stringify(p.defaultValue)}`,
      opType,
    );
  }
  db.prepare(
    `INSERT INTO property_schema
       (id, workspace_id, name, type, multi, icon, scope_class_ids, options, target_class_filter,
        date_precision, date_qualified, number_pad, number_decimals, number_rounding,
        display, hide_when_empty, default_value,
        active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, type = excluded.type, multi = excluded.multi, icon = excluded.icon,
       scope_class_ids = excluded.scope_class_ids,
       options = excluded.options, target_class_filter = excluded.target_class_filter,
       date_precision = excluded.date_precision, date_qualified = excluded.date_qualified,
       number_pad = excluded.number_pad, number_decimals = excluded.number_decimals,
       number_rounding = excluded.number_rounding,
       display = excluded.display,
       hide_when_empty = excluded.hide_when_empty,
       default_value = excluded.default_value,
       active = 1, updated_at = excluded.updated_at`,
  ).run(
    p.propertySchemaId,
    env.workspaceId,
    p.name,
    p.type,
    p.multi ? 1 : 0,
    p.icon ?? null,
    p.scopeClassIds !== undefined ? JSON.stringify(p.scopeClassIds) : null,
    JSON.stringify(p.options ?? []),
    p.targetClassFilter !== undefined ? JSON.stringify(p.targetClassFilter) : null,
    p.datePrecision ?? null,
    p.dateQualified !== undefined ? (p.dateQualified ? 1 : 0) : null,
    p.numberPad ?? null,
    p.numberDecimals ?? null,
    p.numberRounding ?? null,
    p.display ?? null,
    p.hideWhenEmpty !== undefined ? (p.hideWhenEmpty ? 1 : 0) : null,
    p.defaultValue !== undefined && p.defaultValue !== null ? JSON.stringify(p.defaultValue) : null,
    env.timestamp,
    env.timestamp,
  );
  return summary(opType, []);
}

/**
 * R2 applicability (owner ruling 2026-10-20): the update payload is a patch
 * carrying no type, so validationRules applicability is enforced HERE against
 * the schema's STORED type — min/max only on `number` schemas, pattern only
 * on `text`/`url`/`email`. (min <= max is a parse-time rule.) Fail loud —
 * the rules would be provably inert or wrong-typed.
 */
function assertValidationRulesApplicable(
  schemaType: string,
  rules: { min?: number | undefined; max?: number | undefined; pattern?: string | undefined },
  opType: string,
): void {
  if (rules.min !== undefined || rules.max !== undefined) {
    if (schemaType !== "number") {
      throw new PropertyValueShapeError(
        `${opType}: validationRules min/max apply to number schemas only — schema type is ${schemaType}`,
        opType,
      );
    }
  }
  if (rules.pattern !== undefined) {
    if (schemaType !== "text" && schemaType !== "url" && schemaType !== "email") {
      throw new PropertyValueShapeError(
        `${opType}: validationRules pattern applies to text/url/email schemas only — schema type is ${schemaType}`,
        opType,
      );
    }
  }
}

/**
 * A pattern that does not compile would throw at value-check time (an applier
 * crash is never acceptable) — the rule write itself fails loud instead. The
 * pattern is stored as authored (no anchoring rewrite: the value check adds
 * the full-string anchors around the source).
 */
function assertValidationPatternCompilable(
  rules: { pattern?: string | undefined },
  opType: string,
): void {
  if (rules.pattern === undefined) return;
  try {
    new RegExp(rules.pattern);
  } catch {
    throw new PropertyValueShapeError(
      `${opType}: validationRules pattern is not a compilable regex — got ${JSON.stringify(rules.pattern)}`,
      opType,
    );
  }
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
  // icon / scope / validation rules: the keep/clear contract (absent keeps
  // the stored value, present-null clears back to NULL/global/none) — the
  // same shape as the number formats below.
  if (p.icon !== undefined) {
    sets.push("icon = ?");
    values.push(p.icon);
  }
  if (p.scopeClassIds !== undefined) {
    sets.push("scope_class_ids = ?");
    values.push(p.scopeClassIds === null ? null : JSON.stringify(p.scopeClassIds));
  }
  if (p.targetClassFilter !== undefined) {
    sets.push("target_class_filter = ?");
    values.push(p.targetClassFilter === null ? null : JSON.stringify(p.targetClassFilter));
  }
  if (p.multi !== undefined) {
    // The column is NOT NULL — "clear" is the single-value default (0), not SQL NULL.
    sets.push("multi = ?");
    values.push(p.multi === null ? 0 : p.multi ? 1 : 0);
  }
  if (p.validationRules !== undefined) {
    if (p.validationRules !== null) {
      const schemaType = propertySchemaTypeOf(db, p.propertySchemaId);
      // A schema-less update (unknown id — no schema FK here either) stores
      // unchecked, exactly like property.set; a known schema enforces.
      if (schemaType !== null) {
        assertValidationRulesApplicable(schemaType, p.validationRules, opType);
      }
      // Applicable to every write carrying a pattern: a stored pattern that
      // throws at value-check time would be an applier crash.
      assertValidationPatternCompilable(p.validationRules, opType);
    }
    sets.push("validation_rules = ?");
    values.push(p.validationRules === null ? null : JSON.stringify(p.validationRules));
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
  // Number display formatting: absent keeps the stored value, null clears it
  // (the keep-vs-clear contract — a plain `?? undefined` cannot express
  // "clear" for nullable fields).
  if (p.numberPad !== undefined) {
    sets.push("number_pad = ?");
    values.push(p.numberPad);
  }
  if (p.numberDecimals !== undefined) {
    sets.push("number_decimals = ?");
    values.push(p.numberDecimals);
  }
  if (p.numberRounding !== undefined) {
    sets.push("number_rounding = ?");
    values.push(p.numberRounding);
  }
  // The default value (owner ruling 2026-10-20 — schema-level): absent keeps,
  // present-null clears. PC2 runs against the schema's STORED type, exactly
  // like validationRules applicability (a schema-less update stores
  // unchecked).
  if (p.defaultValue !== undefined) {
    if (p.defaultValue !== null) {
      const schemaType = propertySchemaTypeOf(db, p.propertySchemaId);
      if (schemaType !== null && !isValidDefaultForType(schemaType, p.defaultValue)) {
        throw new PropertyValueShapeError(
          `${opType}: defaultValue for ${schemaType} schema ` +
            (schemaType === "datetime" || schemaType === "object" || schemaType === "asset"
              ? "must be null — node-typed defaults are not supported"
              : `must be typed ${schemaType}`) +
            ` — got ${JSON.stringify(p.defaultValue)}`,
          opType,
        );
      }
    }
    sets.push("default_value = ?");
    values.push(p.defaultValue === null ? null : JSON.stringify(p.defaultValue));
  }
  // Render contracts (PROPERTY-level): absent keeps the stored value,
  // present-null clears (the same keep-vs-clear contract as the number
  // formats — `required`/`defaultValue` left the binding entirely under the
  // owner ruling 2026-10-20; the default lives here). `readonly` retired
  // outright under the owner ruling 2026-10-21 — derived from the system
  // property list instead, nothing to store.
  if (p.display !== undefined) {
    sets.push("display = ?");
    values.push(p.display);
  }
  if (p.hideWhenEmpty !== undefined) {
    sets.push("hide_when_empty = ?");
    values.push(p.hideWhenEmpty === null ? null : p.hideWhenEmpty ? 1 : 0);
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

/**
 * Deterministic positional-element id (PG5): the property_value row id for
 * single-value slots and legacy positional writes. Element adds instead use
 * the writer-minted elementId AS the row id — the row id IS the element id.
 */
function positionalPropertyValueId(nodeId: string, schemaId: string, idx: number): string {
  return `${nodeId}:${schemaId}:${idx}`;
}

function applyPropertySet(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.set";
  const p = env.payload as OpPayload<"property.set">;
  const incoming = winnerFromEnvelope(env);

  // PB2/PG6: one-shape-per-type + schema-linked integrity at the
  // write path. The schema row (when known — property.set has no schema FK)
  // types the slot: shape/scalar mismatch, a date ref finer than the
  // schema's precision, a target outside the class filter, and a ref to a
  // nonexistent node all fail loud; a legacy bare-uuid reference or numeric
  // string normalizes to the canonical encoding.
  // R3 (owner ruling 2026-10-20): the write fails loud when the target node
  // is INELIGIBLE for the schema — scopeClassIds set and the node's class
  // closure (its classes + extends ancestors) misses the list. Schema-less
  // writes (unknown schema id) stay unchecked, exactly like the shape checks
  // below. Narrowing a scope later never orphans history: pre-existing
  // authored rows survive in the log and the effective read returns them
  // tagged eligible=false — enforcement is never retroactive. A schema
  // carrying validationRules validates the value before the write too (R2
  // value enforcement — min/max on numbers, pattern full-string on
  // text/url/email scalars, each multi element at its own add).
  const schema = propertySchemaRowOf(db, p.propertySchemaId);
  if (schema !== null) {
    const scope = scopeClassIdsOfRow(schema);
    if (scope !== null) {
      const nodeRow = db.prepare("SELECT class_ids FROM node WHERE id = ?").get(p.objectId) as
        | { class_ids: string | null }
        | undefined;
      const carried = nodeRow === undefined ? null : (nodeRow.class_ids ?? null);
      if (!nodeEligibleForSchema(db, carried, scope)) {
        throw new MoveGuardError(
          `${opType}: node ${p.objectId} is not eligible for schema ${p.propertySchemaId} ` +
            "(its classes — extends-aware — do not intersect the schema's scopeClassIds)",
          opType,
        );
      }
    }
  }
  const value =
    schema !== null
      ? assertValueForSchema(db, schema, p.value ?? null, opType)
      : (p.value ?? null);
  // PC6: dateQualified schemas canonicalize the reserved qualifier keys to
  // date-node refs; everything else rides through untouched.
  const metadata = normalizeQualifierMetadata(schema, p.metadata);
  // PG6 cardinality: a single-value schema takes idx 0 only. Higher slots
  // would write rows no reader derives (the read model reads slot 0 for a
  // single-value schema's editor), so the write is rejected, not parked.
  if (schema !== null && schema.multi === 0 && p.idx > 0) {
    throw new PropertyValueShapeError(
      `${opType}: schema ${p.propertySchemaId} is single-value — idx must be 0, got ${p.idx}`,
      opType,
    );
  }

  let dropped = false;
  if (p.elementId !== undefined) {
    dropped = applyElementAdd(db, env, p, value, metadata);
  } else {
    dropped = applyPositionalSet(db, env, p, value, metadata);
  }

  // The FTS row carries the node's text-ish property values too, so
  // property writes reindex the owner exactly like content writes. The
  // edge rebuild's affected set (typed-link values reference other nodes)
  // rides the summary for the same scope-invalidation reason as content.
  reindexNode(db, p.objectId);
  const setEdges = rebuildEdges(db, p.objectId, env.timestamp);
  return summary(opType, [p.objectId, ...setEdges.affectedNodeIds], dropped);
}

/**
 * PG5 OR-Set element ADD (a payload `elementId`): the property_value row id
 * IS the element id, so adds of distinct elements never conflict and a
 * re-issued add revives the element unless a strictly-newer (HLC) tombstone
 * stands — add-wins: on equal HLC the add proceeds regardless of actor (the
 * classIds `>=` convention generalized to the two-table projection; the
 * stored tombstone's full (hlc, actor) tuple is otherwise only used for its
 * own LWW upsert). The value/metadata/idx overwrite per element uses the
 * full (hlc, actor) tuple, exactly like the pre-PG5 slot LWW.
 */
function applyElementAdd(
  db: StoreDatabase,
  env: Envelope,
  p: OpPayload<"property.set">,
  value: unknown,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const incoming = winnerFromEnvelope(env);
  const tombstone = db
    .prepare(
      "SELECT hlc_physical, hlc_logical FROM property_value_element_tombstone WHERE element_id = ?",
    )
    .get(p.elementId!) as { hlc_physical: number; hlc_logical: number } | undefined;
  if (
    tombstone !== undefined &&
    (tombstone.hlc_physical > incoming.physical ||
      (tombstone.hlc_physical === incoming.physical && tombstone.hlc_logical > incoming.logical))
  ) {
    return true; // a strictly-newer remove wins — the add is dropped.
  }

  const existing = db
    .prepare("SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE id = ?")
    .get(p.elementId!) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  const encoded = JSON.stringify(value ?? null);
  const encodedMetadata = metadata !== undefined ? JSON.stringify(metadata) : null;
  if (!existing) {
    db.prepare(
      `INSERT INTO property_value
         (id, node_id, property_schema_id, value, idx, metadata, hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.elementId!,
      p.objectId,
      p.propertySchemaId,
      encoded,
      p.idx,
      encodedMetadata,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
    return false;
  }
  if (compareLww(incoming, rowWinner(existing)) > 0) {
    db.prepare(
      `UPDATE property_value SET value = ?, metadata = ?, idx = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE id = ?`,
    ).run(
      encoded,
      encodedMetadata,
      p.idx,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
      p.elementId!,
    );
    return false;
  }
  // A stale re-add (full tuple <= the live row) leaves the row untouched.
  return true;
}

/**
 * The pre-PG5 positional path (payload WITHOUT elementId): unchanged slot
 * LWW, keyed by the deterministic positional row id — concurrent element adds
 * may share the idx, but a positional write addresses ONLY its own
 * deterministic element, so the address is unambiguous without the retired
 * UNIQUE(node, schema, idx).
 */
function applyPositionalSet(
  db: StoreDatabase,
  env: Envelope,
  p: OpPayload<"property.set">,
  value: unknown,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const incoming = winnerFromEnvelope(env);
  const rowId = positionalPropertyValueId(p.objectId, p.propertySchemaId, p.idx);

  // A tombstone with a winning (>=) (hlc, actor) blocks the write.
  const tombstone = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM property_value_tombstone WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
    )
    .get(p.objectId, p.propertySchemaId, p.idx) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  if (tombstone && compareLww(incoming, rowWinner(tombstone)) <= 0) {
    return true;
  }

  const existing = db
    .prepare("SELECT hlc_physical, hlc_logical, actor_id FROM property_value WHERE id = ?")
    .get(rowId) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;

  const encoded = JSON.stringify(value ?? null);
  const encodedMetadata = metadata !== undefined ? JSON.stringify(metadata) : null;
  if (!existing) {
    db.prepare(
      `INSERT INTO property_value
         (id, node_id, property_schema_id, value, idx, metadata, hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rowId,
      p.objectId,
      p.propertySchemaId,
      encoded,
      p.idx,
      encodedMetadata,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
    return false;
  }
  if (compareLww(incoming, rowWinner(existing)) > 0) {
    db.prepare(
      `UPDATE property_value SET value = ?, metadata = ?, hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE id = ?`,
    ).run(
      encoded,
      encodedMetadata,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
      rowId,
    );
    return false;
  }
  // A stale write (full tuple <= the live row) leaves the row untouched.
  return true;
}

function applyPropertyUnset(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.unset";
  const p = env.payload as OpPayload<"property.unset">;
  const incoming = winnerFromEnvelope(env);

  if (p.elementId !== undefined) {
    applyElementRemove(db, env, p);
  } else {
    applyPositionalUnset(db, env, p);
  }

  // The owner's indexed text includes its property values — reindex. The
  // edge rebuild's affected set rides the summary (the property.set
  // precedent above).
  reindexNode(db, p.objectId);
  const unsetEdges = rebuildEdges(db, p.objectId, env.timestamp);
  return summary(opType, [p.objectId, ...unsetEdges.affectedNodeIds]);
}

/**
 * PG5 OR-Set element REMOVE (a payload `elementId`): records the remove's
 * causality on the element tombstone (strictly-greater full (hlc, actor)
 * upsert — on an exact tie the earlier add sticks, add-wins) and deletes the
 * live row when the remove's HLC is strictly newer than the row's (equal HLC
 * keeps the row — the add wins ties). An unset addressed at an element that
 * exists under a DIFFERENT (node, schema) is malformed: ignored, like a
 * stale write (deterministic on every replica).
 */
function applyElementRemove(
  db: StoreDatabase,
  env: Envelope,
  p: OpPayload<"property.unset">,
): void {
  const incoming = winnerFromEnvelope(env);
  const existing = db
    .prepare(
      "SELECT node_id, property_schema_id, value, hlc_physical, hlc_logical, actor_id FROM property_value WHERE id = ?",
    )
    .get(p.elementId!) as
    | {
        node_id: string;
        property_schema_id: string;
        value: string;
        hlc_physical: number;
        hlc_logical: number;
        actor_id: string | null;
      }
    | undefined;
  if (
    existing !== undefined &&
    (existing.node_id !== p.objectId || existing.property_schema_id !== p.propertySchemaId)
  ) {
    return; // malformed addressing — deterministic no-op.
  }

  db.prepare(
    `INSERT INTO property_value_element_tombstone
       (element_id, node_id, property_schema_id, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(element_id) DO UPDATE SET
       node_id = excluded.node_id, property_schema_id = excluded.property_schema_id,
       hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  ).run(
    p.elementId!,
    p.objectId,
    p.propertySchemaId,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
  );

  if (existing === undefined) return;
  const removeWinsByHlc =
    incoming.physical > existing.hlc_physical ||
    (incoming.physical === existing.hlc_physical && incoming.logical > existing.hlc_logical);
  if (!removeWinsByHlc) return; // add-wins ties: the live row stays.
  db.prepare("DELETE FROM property_value WHERE id = ?").run(p.elementId!);
  // PB2 (SCHEMA.md "Node-backed text properties"): unsetting a node-backed
  // text value deletes the carrier block under the same guards as the
  // positional path (child-of-owner, active, non-class, unreferenced).
  trashTextCarrierIfOrphaned(db, p.objectId, p.propertySchemaId, existing.value, env.timestamp);
}

/** The pre-PG5 positional remove (payload WITHOUT elementId) — unchanged. */
function applyPositionalUnset(
  db: StoreDatabase,
  env: Envelope,
  p: OpPayload<"property.unset">,
): void {
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

  const rowId = positionalPropertyValueId(p.objectId, p.propertySchemaId, p.idx);
  const existing = db
    .prepare(
      "SELECT value, hlc_physical, hlc_logical, actor_id FROM property_value WHERE id = ?",
    )
    .get(rowId) as
    | { value: string; hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  if (existing && compareLww(incoming, rowWinner(existing)) > 0) {
    db.prepare("DELETE FROM property_value WHERE id = ?").run(rowId);
    // PB2 (SCHEMA.md "Node-backed text properties"): unsetting a node-backed
    // text value deletes the carrier block — trash + retention, consistent
    // with node deletion. Guards: the removed value references a node, the
    // target is an active non-class CHILD of the owner, and no other
    // property_value row (any owner/slot, both stored shapes) still
    // references it. Scalar text values (citekey-style) carry no carrier.
    trashTextCarrierIfOrphaned(db, p.objectId, p.propertySchemaId, existing.value, env.timestamp);
  }
}

/**
 * The carrier-deletion half of property.unset (PB2). The value row is
 * already deleted; `removedValueRaw` is its stored JSON. Trashes the
 * now-unreferenced carrier inside the same transaction.
 */
function trashTextCarrierIfOrphaned(
  db: StoreDatabase,
  objectId: string,
  propertySchemaId: string,
  removedValueRaw: string,
  timestamp: string,
): void {
  if (propertySchemaTypeOf(db, propertySchemaId) !== "text") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(removedValueRaw);
  } catch {
    return;
  }
  const target = nodeRefOfValue(parsed);
  if (target === null) return;
  // Exclusive reference: no other live property_value row (any owner or
  // slot) points at the carrier — both the {nodeId} and the legacy
  // bare-uuid stored shapes.
  const stillReferenced =
    db
      .prepare(
        `SELECT 1 FROM property_value
          WHERE value = ? OR value = ? LIMIT 1`,
      )
      .get(JSON.stringify({ nodeId: target }), JSON.stringify(target)) !== undefined;
  if (stillReferenced) return;
  const carrier = getNodeRow(db, target) as
    | { parent_id: string | null; is_class: number; is_active: number }
    | undefined;
  if (
    !carrier ||
    carrier.parent_id !== objectId ||
    carrier.is_class !== 0 ||
    carrier.is_active !== 1
  ) {
    return;
  }
  const ids = subtreeIds(db, target);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE node SET is_active = 0 WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(
    "INSERT OR REPLACE INTO trash (node_id, deleted_at, is_permanent) VALUES (?, ?, 0)",
  ).run(target, timestamp);
  // Liveness flip — the trashed carrier never resolves through an alias
  // chain while inactive; re-materialize the touching edge rows.
  reresolveEdgeTargets(db, ids);
  rebuildNodeStats(db, [target, ...ancestorIds(db, target)]);
}

// --- property.assign / property.unassign ----------------------------------------

/**
 * Node-level property ASSIGNMENT (owner ruling 2026-10-23 — the v1
 * `node_property` lineage): the (node, property) pair declaration WITHOUT a
 * value. Presence row, LWW by the full (hlc, actor) tuple (the
 * class_property row precedent — an older or equal causal stamp is dropped,
 * so concurrent assigns converge on one row). Assignment carries zero
 * availability semantics, but scope stays the sole locality authority: the
 * R3 eligibility check from applyPropertySet runs here too — a scoped schema
 * rejects a node whose class closure misses the list, fail loud. Schema-less
 * writes (unknown schema id) stay unchecked, exactly like property.set.
 */
function applyPropertyAssign(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.assign";
  const p = env.payload as OpPayload<"property.assign">;
  const incoming = winnerFromEnvelope(env);

  const existing = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM node_property WHERE node_id = ? AND property_schema_id = ?",
    )
    .get(p.objectId, p.propertySchemaId) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;

  if (existing && compareLww(incoming, rowWinner(existing)) <= 0) {
    return summary(opType, [p.objectId], true);
  }

  const schema = propertySchemaRowOf(db, p.propertySchemaId);
  if (schema !== null) {
    const scope = scopeClassIdsOfRow(schema);
    if (scope !== null) {
      const nodeRow = db.prepare("SELECT class_ids FROM node WHERE id = ?").get(p.objectId) as
        | { class_ids: string | null }
        | undefined;
      const carried = nodeRow === undefined ? null : (nodeRow.class_ids ?? null);
      if (!nodeEligibleForSchema(db, carried, scope)) {
        throw new MoveGuardError(
          `${opType}: node ${p.objectId} is not eligible for schema ${p.propertySchemaId} ` +
            "(its classes — extends-aware — do not intersect the schema's scopeClassIds)",
          opType,
        );
      }
    }
  }

  if (!existing) {
    db.prepare(
      `INSERT INTO node_property
         (node_id, property_schema_id, hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(p.objectId, p.propertySchemaId, env.hlc.physical, env.hlc.logical, env.actorId);
  } else {
    db.prepare(
      `UPDATE node_property SET
         hlc_physical = ?, hlc_logical = ?, actor_id = ?
       WHERE node_id = ? AND property_schema_id = ?`,
    ).run(env.hlc.physical, env.hlc.logical, env.actorId, p.objectId, p.propertySchemaId);
  }
  return summary(opType, [p.objectId]);
}

/**
 * Assignment removal: plain DELETE — a presence declaration, last write wins,
 * no tombstone (the class.property.unset precedent). Authored property_value
 * rows are untouched by design: enforcement is never retroactive, an
 * unassigned node's values render as ordinary unbound authored rows.
 */
function applyPropertyUnassign(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.unassign";
  const p = env.payload as OpPayload<"property.unassign">;
  db.prepare("DELETE FROM node_property WHERE node_id = ? AND property_schema_id = ?").run(
    p.objectId,
    p.propertySchemaId,
  );
  return summary(opType, [p.objectId]);
}

/**
 * CLEAR every authored value of one property on a node while KEEPING the
 * assignment (owner ruling 2026-10-23 — the property.assign companion; the
 * context menu's "Empty property" gesture). Addressed at (node, schema) —
 * ALL values, every idx and every PG5 element.
 *
 * Causality mirrors the per-value removes, applied to each live row: BOTH
 * tombstone families upsert at the empty's (hlc, actor) — the PG5 element
 * tombstone (element-addressed adds stay dead) and the legacy slot
 * tombstone (positional adds stay dead) — and the live row is deleted only
 * when the empty is the strictly newer writer (a concurrent newer set
 * survives). Add-wins on exact HLC ties, exactly like property.unset.
 * Orphaned exclusive text carriers ride the unset's trash contract.
 */
function applyPropertyEmpty(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "property.empty";
  const p = env.payload as OpPayload<"property.empty">;
  const incoming = winnerFromEnvelope(env);

  const rows = visiblePropertyValueRows(db, p.objectId).filter(
    (row) => row.property_schema_id === p.propertySchemaId,
  );

  const elementTombstone = db.prepare(
    `INSERT INTO property_value_element_tombstone
       (element_id, node_id, property_schema_id, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(element_id) DO UPDATE SET
       node_id = excluded.node_id, property_schema_id = excluded.property_schema_id,
       hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  );
  const slotTombstone = db.prepare(
    `INSERT INTO property_value_tombstone (node_id, property_schema_id, idx, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_id, property_schema_id, idx) DO UPDATE SET
       hlc_physical = excluded.hlc_physical, hlc_logical = excluded.hlc_logical,
       actor_id = excluded.actor_id
     WHERE excluded.hlc_physical > hlc_physical
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical > hlc_logical)
        OR (excluded.hlc_physical = hlc_physical AND excluded.hlc_logical = hlc_logical
            AND excluded.actor_id > COALESCE(actor_id, ''))`,
  );

  for (const row of rows) {
    elementTombstone.run(
      row.id,
      p.objectId,
      p.propertySchemaId,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
    slotTombstone.run(
      p.objectId,
      p.propertySchemaId,
      row.idx,
      env.hlc.physical,
      env.hlc.logical,
      env.actorId,
    );
    if (compareLww(incoming, rowWinner(row)) > 0) {
      db.prepare("DELETE FROM property_value WHERE id = ?").run(row.id);
      trashTextCarrierIfOrphaned(
        db,
        p.objectId,
        p.propertySchemaId,
        row.value,
        env.timestamp,
      );
    }
  }

  // The owner's indexed text includes its property values — reindex. Edge
  // rebuild rides along for node-typed values (the property.unset precedent).
  reindexNode(db, p.objectId);
  const emptyEdges = rebuildEdges(db, p.objectId, env.timestamp);
  return summary(opType, [p.objectId, ...emptyEdges.affectedNodeIds]);
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

// --- workspace.feature.* ---------------------------------------------------------
//
// Per-workspace feature toggles: LWW by (workspaceId, feature) on
// the envelope (hlc, actor) — the winning row lands in `workspace_feature`
// and the applier derives the membership-preserving archival of the
// feature's managed system classes from it. Toggle-off is hide-surfaces-
// keep-data (F3): `class.active` + the class node's `is_active` flip,
// `class_member_set` rows NEVER touched (membership rides, owner ruling
// 2026-10-22 — class removal, archive or trash, never tombstones a pair).
// An absent row means ENABLED (F2): the empty table is the all-ON default,
// so pre-toggle workspaces converge with zero migration. An object.delete
// addressed at a family base class is ROUTED here (the retired class.delete
// op's F4 rule, moved into the object.delete applier): applied as a
// feature-disable so the Features setting is the single archive path for
// the families. The `journal` toggle gates SURFACES only (the journal nav
// view, Today-page management) — the date classes stay always-on and it
// derives no class bits (isFamilyFeature is the guard).

/**
 * LWW-write one feature row. Returns true when the incoming envelope won
 * (the row was written); false when a newer (hlc, actor) row already stood
 * (the toggle is dropped, exactly like a stale property.set).
 */
function lwwWriteFeatureRow(
  db: StoreDatabase,
  env: Envelope,
  feature: WorkspaceFeature,
  enabled: boolean,
): boolean {
  const existing = db
    .prepare(
      "SELECT hlc_physical, hlc_logical, actor_id FROM workspace_feature WHERE workspace_id = ? AND feature = ?",
    )
    .get(env.workspaceId, feature) as
    | { hlc_physical: number; hlc_logical: number; actor_id: string | null }
    | undefined;
  if (existing && compareLww(winnerFromEnvelope(env), rowWinner(existing)) <= 0) {
    return false;
  }
  db.prepare(
    `INSERT INTO workspace_feature (workspace_id, feature, enabled, hlc_physical, hlc_logical, actor_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, feature) DO UPDATE SET
       enabled = excluded.enabled, hlc_physical = excluded.hlc_physical,
       hlc_logical = excluded.hlc_logical, actor_id = excluded.actor_id`,
  ).run(env.workspaceId, feature, enabled ? 1 : 0, env.hlc.physical, env.hlc.logical, env.actorId);
  return true;
}

/**
 * Re-derive the archival bits for one family's full class set (base +
 * extends-children) from the CURRENT feature rows. Each class's bit is the
 * AND of its gating features (own feature when it is a family base, plus
 * every managed ancestor's — gatingFeaturesForClass): re-enabling EVENTS
 * must not un-archive a MEETINGS-off meeting, so a blind family-wide flip
 * is wrong under the cascade; per-class re-derivation is idempotent,
 * membership-preserving, and convergent (pure active-bit projection —
 * updated_at is deliberately NOT bumped: the toggles' HLCs live on the
 * workspace_feature rows, and a wall-of-envelope timestamp here would
 * diverge under reversed delivery of racing toggles).
 */
function deriveFamilyClassBits(db: StoreDatabase, workspaceId: string, feature: FamilyFeature): void {
  for (const name of familyClassNames(feature)) {
    const enabled = gatingFeaturesForClass(name).every((f) =>
      featureEnabledNow(db, workspaceId, f),
    );
    const classId = SYSTEM_CLASS_UUIDS[name];
    db.prepare("UPDATE class SET active = ? WHERE id = ?").run(enabled ? 1 : 0, classId);
    // The class NODE flip is what pickers/search/class hubs filter on
    // (node.is_active = 1). Node-row HLC columns stay untouched — the flip
    // is a derived projection of the toggles, not a content write.
    db.prepare("UPDATE node SET is_active = ? WHERE id = ? AND is_class = 1").run(
      enabled ? 1 : 0,
      classId,
    );
    // The flip gates alias-chain resolution (the walk is live-aware) —
    // re-materialize the edge rows whose chains touch the class node.
    reresolveEdgeTargets(db, [classId]);
  }
}

/**
 * The `tasks` enable path (constraint 5 — closes the "task property
 * schemas never authored" gap): author the task class + the six
 * property schemas + their bindings at the fixed seed ids. Purely additive
 * (INSERT OR IGNORE everywhere) so a client-authored family (the web
 * ensureTaskFamily, random option ids) or a server-seeded one is never
 * clobbered — first writer wins, convergent on the single global log. The
 * authored rows are a deterministic function of the enable op, so wipe ->
 * replay stays byte-identical. The rows are inserted ACTIVE; the caller
 * normalizes the archival bit afterwards (see applyWorkspaceFeatureSet).
 */
function ensureTaskFamilyRows(db: StoreDatabase, env: Envelope): void {
  const classId = SYSTEM_CLASS_UUIDS.task;
  const title = JSON.stringify([{ type: "text", text: "Task" }]);
  db.prepare(
    `INSERT OR IGNORE INTO node (
       id, workspace_id, is_class, is_embedded, parent_id, class_ids, name, content,
       icon, color, is_active, created_at, updated_at, created_by, updated_by,
       hlc_physical, hlc_logical, actor_id
     ) VALUES (?, ?, 1, 0, NULL, '[]', NULL, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    classId,
    env.workspaceId,
    title,
    SYSTEM_CLASS_ICONS.task,
    env.timestamp,
    env.timestamp,
    env.actorId,
    env.actorId,
    env.hlc.physical,
    env.hlc.logical,
    env.actorId,
  );
  db.prepare(
    `INSERT OR IGNORE INTO class (id, workspace_id, name, icon, color, description, active, created_at, updated_at)
     VALUES (?, ?, 'Task', ?, NULL, NULL, 1, ?, ?)`,
  ).run(classId, env.workspaceId, SYSTEM_CLASS_ICONS.task, env.timestamp, env.timestamp);
  db.prepare("INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)").run(
    classId,
    classId,
  );
  for (const entry of TASK_FAMILY_SEED) {
    const schemaId = SYSTEM_PROPERTY_UUIDS[entry.property];
    db.prepare(
      `INSERT OR IGNORE INTO property_schema
         (id, workspace_id, name, type, multi, icon, scope_class_ids, options, target_class_filter,
          date_precision, date_qualified, display, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL, ?, 1, ?, ?)`,
    ).run(
      schemaId,
      env.workspaceId,
      entry.name,
      entry.type,
      // Global scope (owner ruling 2026-10-20, the seed-scope audit — the
      // whole task family is reusable, Status explicitly so): NULL
      // scope_class_ids; the family binds the task class below (bindings
      // are per-class config, zero availability semantics).
      null,
      JSON.stringify([...(entry.options ?? [])]),
      entry.display ?? null,
      env.timestamp,
      env.timestamp,
    );
    db.prepare(
      `INSERT OR IGNORE INTO class_property
         (class_id, property_schema_id,
          hlc_physical, hlc_logical, actor_id)
       VALUES (?, ?, 0, 0, NULL)`,
    ).run(classId, schemaId);
  }
  reindexNode(db, classId);
}

/** Read the current (winning) feature row's enabled bit — absent = enabled (F2). */
function featureEnabledNow(db: StoreDatabase, workspaceId: string, feature: WorkspaceFeature): boolean {
  const row = db
    .prepare("SELECT enabled FROM workspace_feature WHERE workspace_id = ? AND feature = ?")
    .get(workspaceId, feature) as { enabled: number } | undefined;
  return row === undefined || row.enabled === 1;
}

function applyWorkspaceFeatureSet(db: StoreDatabase, env: Envelope): ChangeSummary {
  const opType = "workspace.feature.set";
  const p = env.payload as OpPayload<"workspace.feature.set">;
  // Family toggles derive class archival bits; the journal toggle gates
  // SURFACES only (the date classes stay always-on) — no family, no
  // derivation, just the LWW row.
  const family = isFamilyFeature(p.feature) ? p.feature : null;
  const wrote = lwwWriteFeatureRow(db, env, p.feature, p.enabled);
  if (wrote && family !== null) {
    deriveFamilyClassBits(db, env.workspaceId, family);
  }
  // The ensure rides every enable PAYLOAD (not only the LWW winner): both
  // delivery orders of a racing toggle pair must author the identical row
  // set — the family re-derivation below normalizes the archival bits to
  // the CURRENT row state on every path.
  if (p.enabled && p.feature === "tasks") {
    ensureTaskFamilyRows(db, env);
    deriveFamilyClassBits(db, env.workspaceId, "tasks");
  }
  return summary(opType, wrote && family !== null ? managedClassIds(family) : [], !wrote);
}

// --- dispatch ------------------------------------------------------------------------

const APPLIERS: Record<
  OpType,
  (db: StoreDatabase, env: Envelope) => ChangeSummary
> = {
  "object.create": applyObjectCreate,
  "object.update": applyObjectUpdate,
  "object.delete": applyObjectDelete,
  "object.restore": applyObjectRestore,
  "object.move": applyObjectMove,
  "trash.empty": applyTrashEmpty,
  "class.create": applyClassCreate,
  "class.update": applyClassUpdate,
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
  "property.assign": applyPropertyAssign,
  "property.unassign": applyPropertyUnassign,
  "property.empty": applyPropertyEmpty,
  "asset.attach": applyAssetAttach,
  "asset.detach": applyAssetDetach,
  "collection.member.add": (db, env) => applyCollectionMember(db, env, 1),
  "collection.member.remove": (db, env) => applyCollectionMember(db, env, 0),
  "workspace.feature.set": applyWorkspaceFeatureSet,
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
