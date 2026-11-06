/**
 * The authors-to-text migration's node-free planning core — the client-side
 * executor pattern (F3 fleet extraction, 2026-11-06), the Stage-1 proving
 * pattern repeated: everything a keyed client needs to RUN this content-
 * class migration against its local UNSEALED derived store. NODE-DEP-FREE
 * by contract: no better-sqlite3, no RelayStorage, no fs, no node builtins
 * (the element-id mint rides Web Crypto's getRandomValues — a crypto-random
 * source under Node 22 and every browser alike). The store import is the
 * browser-safe workspace package (it ships in the web client), not a node
 * dep.
 *
 * The CLI (scripts/migrate-authors-to-text.mts) delegates its planning and
 * envelope-building here unchanged; its rehearsal suite
 * (apps/server/test/migrate-authors-to-text.test.ts) stays green as the pin.
 *
 * Semantics (unchanged by the extraction — the script header is the
 * normative story): the object-typed authors schema flips to text-multi
 * (the propertySchema.create upsert), every {nodeId} author value rewrites
 * to its agent's "Family, Given" name (else the flattened title), a
 * linkedAuthors copy preserves the people-graph backlink, and saved views
 * carrying the schema are reported (the meaning flip), never written.
 * Kept values (broken refs, empty titles) are reported, never dropped.
 */

import {
  envelopeSchema,
  newEnvelope,
  parseQueryAst,
  payloadSchemaFor,
  type Envelope,
} from "../../../packages/protocol/src/index.ts";
import { fullTitleOf, SYSTEM_PROPERTY_UUIDS } from "../../../packages/domain/src/index.ts";
import {
  nodeRefOfValue,
  visiblePropertyValueRows,
  type Store,
  type VisiblePropertyValueRow,
} from "../../../packages/store/src/index.ts";

/**
 * The migration's actor/device/client constants — the identity the CLI path
 * has always ridden. A client-side executor passes ITS session constants
 * instead (the envelopes then carry the client's actor/device, sealed and
 * pushed by the sync engine like any write).
 */
export interface MigrationIdentity {
  actorId: string;
  deviceId: string;
  client?: string;
}

export const MIGRATION_IDENTITY: MigrationIdentity = {
  actorId: "01920000-0000-7000-8000-0000000000a8",
  deviceId: "migrate-authors-to-text",
  client: "migrate-authors-to-text",
};

/** One migration write in its wire-neutral triple form — the shape a
 *  client-side executor stamps with its session constants through the
 *  normal write path (no new crypto, no wire change). */
export interface MigrationOp {
  opType: string;
  payload: Record<string, unknown>;
  affected: string[];
}

export const AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.authors;
export const LINKED_AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const GIVEN_NAME_ID = SYSTEM_PROPERTY_UUIDS.givenName;
const FAMILY_NAME_ID = SYSTEM_PROPERTY_UUIDS.familyName;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


/**
 * A locally minted UUIDv7 (the PG5 writer-minted element id law) — 48-bit ms
 * timestamp, version 7, variant bits, 74 crypto-random bits. Local because
 * the scripts/ dir resolves no runtime deps beyond the workspace packages.
 */
function mintElementId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const time = BigInt(now) & 0xffffffffffffn;
  bytes[0] = Number((time >> 40n) & 0xffn);
  bytes[1] = Number((time >> 32n) & 0xffn);
  bytes[2] = Number((time >> 24n) & 0xffn);
  bytes[3] = Number((time >> 16n) & 0xffn);
  bytes[4] = Number((time >> 8n) & 0xffn);
  bytes[5] = Number(time & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- plan shape ---------------------------------------------------------------


export interface SchemaRow {
  id: string;
  name: string;
  type: string;
  multi: number;
  icon: string | null;
  scope_class_ids: string | null;
  options: string | null;
  target_class_filter: string | null;
  date_precision: string | null;
  date_qualified: number | null;
  number_pad: number | null;
  number_decimals: number | null;
  number_rounding: string | null;
  display: string | null;
  hide_when_empty: number | null;
  default_value: string | null;
  active: number;
}

export interface PlannedRewrite {
  sourceId: string;
  /** PG5 element id when the row id is uuid-shaped; else the positional carrier. */
  elementId: string | undefined;
  idx: number;
  oldValue: unknown;
  newValue: string;
  /** names | title — where the string came from. */
  derivedFrom: "names" | "title";
  targetId: string;
  targetTitle: string;
  metadata: string | null;
}

export interface PlannedAdd {
  sourceId: string;
  refId: string;
  idx: number;
}

export interface KeptRef {
  sourceId: string;
  elementId: string | undefined;
  idx: number;
  oldValue: unknown;
  reason: "broken-ref" | "empty-title";
  targetId: string;
}

export interface SavedViewHit {
  hostId: string;
  hostTitle: string;
  /** The condition descriptors that reference …0012 (e.g. "property:contains"). */
  conditions: string[];
}

export interface UnparseableView {
  hostId: string;
  hostTitle: string;
}

export interface WorkspacePlan {
  /** The …0012 row as stored (null = schema never authored in this workspace). */
  schemaRow: SchemaRow | null;
  /** The flip envelope is needed (row exists, stored type is not "text"). */
  flip: boolean;
  rewrites: PlannedRewrite[];
  adds: PlannedAdd[];
  kept: KeptRef[];
  alreadyText: number;
  savedViews: SavedViewHit[];
  /**
   * Legacy saved views whose stored AST fails the current strict query-ast
   * schema (live discovery 2026-10-24: a pre-strict view aborted the whole
   * dry run). Listed as skipped, never aborting — planning, apply, verify.
   */
  unparseableViews: UnparseableView[];
  /** linkedAuthors schema row absent — the copy is skipped (task-7 seeds it). */
  linkedSchemaMissing: boolean;
}

function authorsSchemaRow(store: Store): SchemaRow | undefined {
  return store.database
    .prepare(
      `SELECT id, name, type, multi, icon, scope_class_ids, options, target_class_filter,
              date_precision, date_qualified, number_pad, number_decimals, number_rounding,
              display, hide_when_empty, default_value, active
       FROM property_schema WHERE id = ?`,
    )
    .get(AUTHORS_ID) as SchemaRow | undefined;
}

function nodeRow(store: Store, nodeId: string): { content: string; class_ids: string | null; is_active: number } | undefined {
  return store.database
    .prepare("SELECT content, class_ids, is_active FROM node WHERE id = ?")
    .get(nodeId) as { content: string; class_ids: string | null; is_active: number } | undefined;
}

/** The effective idx-0 string value of a single-value text property on a node. */
function textValueAtIdx0(store: Store, nodeId: string, schemaId: string): string | null {
  const row = visiblePropertyValueRows(store.database, nodeId).find(
    (candidate) => candidate.property_schema_id === schemaId && candidate.idx === 0,
  );
  if (row === undefined) return null;
  const parsed: unknown = JSON.parse(row.value);
  return typeof parsed === "string" ? parsed : null;
}

/** "Family, Given" from the name properties; null when neither is authored. */
function formatAuthorName(store: Store, agentNodeId: string): string | null {
  const family = textValueAtIdx0(store, agentNodeId, FAMILY_NAME_ID);
  const given = textValueAtIdx0(store, agentNodeId, GIVEN_NAME_ID);
  const parts = [family, given].filter((part): part is string => part !== null && part.trim() !== "");
  if (parts.length === 0) return null;
  return parts.map((part) => part.trim()).join(", ");
}

/** The flattened title (title-is-content) — "" when the content carries no prose. */
function flattenedTitle(store: Store, nodeId: string): string {
  const row = nodeRow(store, nodeId);
  if (row === undefined) return "";
  let contentAst: unknown = null;
  try {
    contentAst = JSON.parse(row.content);
  } catch {
    return "";
  }
  let classIds: string[] = [];
  if (row.class_ids !== null) {
    try {
      classIds = JSON.parse(row.class_ids) as string[];
    } catch {
      classIds = [];
    }
  }
  return fullTitleOf({ id: nodeId, contentAst: contentAst as never, classIds });
}

/**
 * The saved views / content query tokens carrying a property condition on
 * …0012 — the meaning-flip report. They keep matching by UUID (the schema
 * id is unchanged) but read name-strings after the flip. Reported only;
 * the migration never writes them.
 *
 * A stored view whose AST fails the current strict query-ast schema (a
 * legacy pre-strict token) is LISTED as unparseable-and-skipped, never an
 * abort — live discovery 2026-10-24: one such view in the personal workspace
 * killed the whole --all dry run before any planning output.
 */
function enumerateSavedViews(store: Store): {
  hits: SavedViewHit[];
  unparseable: UnparseableView[];
} {
  const hits: SavedViewHit[] = [];
  const unparseable = new Map<string, UnparseableView>();
  const hosts = store.database
    .prepare("SELECT id, content FROM node WHERE content LIKE '%\"type\":\"query\"%'")
    .all() as Array<{ id: string; content: string }>;
  const walk = (value: unknown, nearestType: string | null, out: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, nearestType, out);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : nearestType;
    if ((record.schemaId === AUTHORS_ID || record.id === AUTHORS_ID) && type !== null) {
      const op = typeof record.op === "string" ? `:${record.op}` : "";
      out.add(`${type}${op}`);
    }
    for (const item of Object.values(record)) walk(item, type, out);
  };
  for (const host of hosts) {
    let tokens: unknown[] = [];
    try {
      tokens = JSON.parse(host.content) as unknown[];
    } catch {
      continue;
    }
    for (const token of tokens) {
      if (
        typeof token !== "object" ||
        token === null ||
        (token as { type?: unknown }).type !== "query"
      ) {
        continue;
      }
      let ast: ReturnType<typeof parseQueryAst>;
      try {
        ast = parseQueryAst((token as { queryAst: unknown }).queryAst);
      } catch {
        // A legacy pre-strict AST — report and keep enumerating the rest.
        if (!unparseable.has(host.id)) {
          unparseable.set(host.id, { hostId: host.id, hostTitle: flattenedTitle(store, host.id) });
        }
        continue;
      }
      const conditions = new Set<string>();
      walk(ast.root, null, conditions);
      if (conditions.size === 0) continue;
      hits.push({ hostId: host.id, hostTitle: flattenedTitle(store, host.id), conditions: [...conditions] });
    }
  }
  return { hits, unparseable: [...unparseable.values()] };
}

export function planWorkspace(store: Store): WorkspacePlan {
  const schema = authorsSchemaRow(store);
  const linkedSchemaPresent =
    store.database
      .prepare("SELECT 1 FROM property_schema WHERE id = ?")
      .get(LINKED_AUTHORS_ID) !== undefined;
  const plan: WorkspacePlan = {
    schemaRow: schema ?? null,
    flip: false,
    rewrites: [],
    adds: [],
    kept: [],
    alreadyText: 0,
    savedViews: [],
    unparseableViews: [],
    linkedSchemaMissing: !linkedSchemaPresent,
  };
  const enumerated = enumerateSavedViews(store);
  plan.savedViews = enumerated.hits;
  plan.unparseableViews = enumerated.unparseable;

  if (schema !== undefined) {
    if (schema.active !== 1) {
      throw new Error(
        `plan: the authors schema (…0012) row is soft-deleted (active = 0) — the retype upsert ` +
          "would resurrect it; restore or delete it by hand first (refusing to decide for you)",
      );
    }
    if (schema.type !== "text" && schema.type !== "object") {
      throw new Error(
        `plan: the authors schema (…0012) has an unexpected stored type ${JSON.stringify(schema.type)} ` +
          "— the known drift is object; anything else may be user config (refusing to clobber it)",
      );
    }
    plan.flip = schema.type === "object";
  }

  // Every visible …0012 element (schema-wide — the workspace may hold
  // schema-less rows too; nodeRefOfValue reads both the canonical {nodeId}
  // and a legacy bare-uuid encoding).
  const valueRows = visiblePropertyValueRows(store.database).filter(
    (row) => row.property_schema_id === AUTHORS_ID,
  );
  const existingLinkedRefs = new Map<string, Set<string>>();
  const maxLinkedIdx = new Map<string, number>();
  if (linkedSchemaPresent) {
    for (const row of visiblePropertyValueRows(store.database)) {
      if (row.property_schema_id !== LINKED_AUTHORS_ID) continue;
      const ref = nodeRefOfValue(JSON.parse(row.value));
      if (ref === null) continue;
      if (!existingLinkedRefs.has(row.node_id)) existingLinkedRefs.set(row.node_id, new Set());
      existingLinkedRefs.get(row.node_id)!.add(ref);
      maxLinkedIdx.set(row.node_id, Math.max(maxLinkedIdx.get(row.node_id) ?? -1, row.idx));
    }
  }

  for (const row of valueRows) {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed === "string") {
      plan.alreadyText += 1;
      continue;
    }
    const ref = nodeRefOfValue(parsed);
    if (ref === null) {
      // Neither text nor a node ref — an unknown shape; keep it, report loudly.
      plan.kept.push({
        sourceId: row.node_id,
        elementId: UUID_RE.test(row.id) ? row.id : undefined,
        idx: row.idx,
        oldValue: parsed,
        reason: "broken-ref",
        targetId: "",
      });
      continue;
    }
    const target = nodeRow(store, ref);
    if (target === undefined) {
      // Broken ref: the target was deleted after the value was authored.
      // A text schema still accepts a {nodeId} shape, so the value rides
      // untouched — reported, never silently dropped.
      plan.kept.push({
        sourceId: row.node_id,
        elementId: UUID_RE.test(row.id) ? row.id : undefined,
        idx: row.idx,
        oldValue: parsed,
        reason: "broken-ref",
        targetId: ref,
      });
      continue;
    }
    const fromNames = formatAuthorName(store, ref);
    const title = flattenedTitle(store, ref);
    const newValue = fromNames ?? (title !== "" ? title : null);
    if (newValue === null) {
      plan.kept.push({
        sourceId: row.node_id,
        elementId: UUID_RE.test(row.id) ? row.id : undefined,
        idx: row.idx,
        oldValue: parsed,
        reason: "empty-title",
        targetId: ref,
      });
      continue;
    }
    plan.rewrites.push({
      sourceId: row.node_id,
      elementId: UUID_RE.test(row.id) ? row.id : undefined,
      idx: row.idx,
      oldValue: parsed,
      newValue,
      derivedFrom: fromNames !== null ? "names" : "title",
      targetId: ref,
      targetTitle: title,
      metadata: row.metadata,
    });

    // The linkedAuthors copy — same {nodeId} ref, so the people-graph
    // backlink survives the string rewrite. Existence-checked per row.
    if (linkedSchemaPresent) {
      const linked = existingLinkedRefs.get(row.node_id) ?? new Set<string>();
      if (!linked.has(ref)) {
        linked.add(ref);
        existingLinkedRefs.set(row.node_id, linked);
        const idx = (maxLinkedIdx.get(row.node_id) ?? -1) + 1;
        maxLinkedIdx.set(row.node_id, idx);
        plan.adds.push({ sourceId: row.node_id, refId: ref, idx });
      }
    }
  }

  return plan;
}

export function planIsEmpty(plan: WorkspacePlan): boolean {
  // `kept` refs produce no envelopes (report-only) — they don't block the
  // empty plan.
  return !plan.flip && plan.rewrites.length === 0 && plan.adds.length === 0;
}

/**
 * The pending probe the client-side surface lists by: the migration needs
 * a run exactly when the planner finds work (a converged store plans
 * nothing — idempotent by construction).
 */
export function isPending(store: Store): boolean {
  return !planIsEmpty(planWorkspace(store));
}

// --- ops ------------------------------------------------------------------------

export function buildOps(plan: WorkspacePlan, stamp: number): MigrationOp[] {
  const physical = stamp;
  const ops: MigrationOp[] = [];
  const push = (
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
    ops.push({ opType, payload, affected });
  };

  // (1) linkedAuthors adds FIRST — object values under the untouched object
  // linkedAuthors schema, validated exactly like the original writes.
  for (const add of plan.adds) {
    push(
      "property.set",
      {
        objectId: add.sourceId,
        propertySchemaId: LINKED_AUTHORS_ID,
        elementId: mintElementId(physical),
        idx: add.idx,
        value: { nodeId: add.refId },
      },
      [add.sourceId],
    );
  }

  // (2) the flip — propertySchema.create UPSERT (the ONLY wire path that can
  // change a schema's type). Every stored column rides verbatim; type moves
  // object→text, multi lands on the spec's true. options is always emitted
  // (the upsert replaces the column unconditionally).
  if (plan.flip && plan.schemaRow !== null) {
    const row = plan.schemaRow;
    const scope = row.scope_class_ids !== null ? (JSON.parse(row.scope_class_ids) as string[]) : null;
    push(
      "propertySchema.create",
      {
        propertySchemaId: AUTHORS_ID,
        name: row.name,
        type: "text",
        multi: true,
        ...(row.icon !== null ? { icon: row.icon } : {}),
        ...(scope !== null ? { scopeClassIds: scope } : {}),
        options: row.options !== null ? (JSON.parse(row.options) as unknown[]) : [],
        ...(row.target_class_filter !== null
          ? { targetClassFilter: JSON.parse(row.target_class_filter) as string[] }
          : {}),
        ...(row.date_precision !== null ? { datePrecision: row.date_precision } : {}),
        ...(row.date_qualified !== null ? { dateQualified: row.date_qualified === 1 } : {}),
        ...(row.number_pad !== null ? { numberPad: row.number_pad } : {}),
        ...(row.number_decimals !== null ? { numberDecimals: row.number_decimals } : {}),
        ...(row.number_rounding !== null ? { numberRounding: row.number_rounding } : {}),
        ...(row.display !== null ? { display: row.display } : {}),
        ...(row.hide_when_empty !== null ? { hideWhenEmpty: row.hide_when_empty === 1 } : {}),
        ...(row.default_value !== null ? { defaultValue: JSON.parse(row.default_value) } : {}),
      },
      [],
    );
  }

  // (3) the value rewrites — each reuses its element identity (in-place LWW
  // swap) or its positional idx; metadata rides verbatim.
  for (const rewrite of plan.rewrites) {
    push(
      "property.set",
      {
        objectId: rewrite.sourceId,
        propertySchemaId: AUTHORS_ID,
        value: rewrite.newValue,
        idx: rewrite.idx,
        ...(rewrite.elementId !== undefined ? { elementId: rewrite.elementId } : {}),
        ...(rewrite.metadata !== null ? { metadata: JSON.parse(rewrite.metadata) } : {}),
      },
      [rewrite.sourceId],
    );
  }

  return ops;
}

/**
 * The CLI envelope builder: the plan's ops as fully-stamped protocol
 * envelopes. `stamp` is the HLC physical clock (the CLI passes
 * `Date.now()`); `identity` defaults to {@link MIGRATION_IDENTITY} — with
 * the default and the same stamp the output matches what the
 * pre-extraction script built (the minted element ids and envelope
 * ids/timestamps are per-call mints in both paths).
 */
export function buildEnvelopes(
  workspaceId: string,
  plan: WorkspacePlan,
  stamp: number,
  identity: MigrationIdentity = MIGRATION_IDENTITY,
): Envelope[] {
  const ops = buildOps(plan, stamp);
  return ops.map((op, logical) =>
    newEnvelope({
      workspaceId,
      actorId: identity.actorId,
      deviceId: identity.deviceId,
      ...(identity.client !== undefined ? { client: identity.client } : {}),
      hlc: { physical: stamp, logical },
      affectedNodeIds: op.affected,
      opType: op.opType,
      payload: op.payload,
    }),
  );
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
export function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    const envResult = envelopeSchema.safeParse(envelope);
    if (!envResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid — ${envResult.error.message}`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined) {
      failures.push(`${envelope.opType} ${envelope.id}: no payload schema registered`);
      continue;
    }
    const payloadResult = schema.safeParse(envelope.payload);
    if (!payloadResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid — ${payloadResult.error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`,
    );
  }
}

/**
 * The replay gate (pre-ingest): test-apply every built envelope, IN ORDER,
 * against the scratch store the plan was read from. The flip-first ordering
 * is proven here — a rewrite that a static plan cannot see failing (e.g. an
 * ineligible source node under a narrowed scope) throws BEFORE ingest, so
 * the abort lands with ZERO envelopes written. Runs in dry-run too.
 */
export function testApplyEnvelopes(store: Store, envelopes: Envelope[]): void {
  for (let index = 0; index < envelopes.length; index++) {
    const envelope = envelopes[index]!;
    try {
      store.apply(envelope);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `pre-ingest test-apply failed at envelope ${index + 1}/${envelopes.length} ` +
          `(${envelope.opType} ${JSON.stringify(envelope.payload)}): ${detail}\n` +
          "aborting with ZERO envelopes ingested — fix the workspace state and re-run.",
      );
    }
  }
}
