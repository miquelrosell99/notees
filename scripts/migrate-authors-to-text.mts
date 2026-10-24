/**
 * Authors object→text (owner 2026-10-23, source-library slice 1 task 8):
 * live workspaces converge to the task-8 seed change — the `authors`
 * property (…0000-000000000012) retyped in the SPEC from object-multi to
 * text-multi, its object {nodeId} values rewritten to "Family, Given"
 * strings, and the SAME {nodeId} refs copied to `linkedAuthors`
 * (…0006-000000000001, seeded object-multi→agent) so the people-graph
 * backlinks survive. Migrations.md Path A — the immutable relay log is never
 * edited; one ordered ingest of appended envelopes per workspace.
 *
 * THE ORDERING CONSTRAINT (review focus #1): a replica converging from a
 * pre-migration snapshot + migrated tail must NEVER validate an object
 * {nodeId} value against a text schema. The plan therefore CANNOT rewrite
 * values before the flip — `assertValueShapeForType` (packages/store
 * property-values.ts) rejects a plain string under an object schema, so a
 * replay would throw at the first rewrite. The sanctioned fallback ruling
 * applies, all inside ONE ingest whose replay order is the write order:
 *
 *  (1) `property.set` ADDS on linkedAuthors (…0006-…0001) copying every
 *      still-object {nodeId} ref whose target EXISTS (object values under
 *      the untouched object linkedAuthors schema — validated exactly like
 *      the original writes; a ref already linked is existence-skipped);
 *  (2) the `authors` schema flip — a `propertySchema.create` UPSERT, the
 *      ONLY wire path that changes a schema's type (`propertySchema.update`
 *      deliberately carries no type — op-types.ts; the
 *      migrate-attachments-asset-type.mts precedent). The stored row's
 *      name/icon/scope/options/filter/date/number/render/default columns
 *      ride VERBATIM — the retype changes type + multi only — so nothing
 *      the owner tuned is clobbered (scope included);
 *  (3) `property.set` REWRITES of every visible …0012 element to its text
 *      value, each REUSING the element's own identity: a PG5 row id IS the
 *      element id, so a rewrite with the same elementId is an in-place LWW
 *      value swap (applyElementAdd, appliers.ts — the old object value was
 *      validated when authored, under the object schema, and is never
 *      re-validated; the incoming string validates against the now-text
 *      schema). Legacy positional rows (deterministic `node:schema:idx`
 *      ids) rewrite through the positional carrier at their idx.
 *      Broken refs (target node row gone) KEEP their value — a text schema
 *      still accepts a {nodeId} shape (property-values.ts text branch), so
 *      convergence is not blocked; each is reported line by line.
 *
 * Replay safety: between (2) and (3) a replica's derived store momentarily
 * holds text-schema rows with {nodeId} values, but validation runs ONLY on
 * incoming writes (appliers.ts applyPropertySet) — no tail envelope re-touches
 * those rows with an object value, so no replay ever validates an object
 * value against the text schema. The pre-ingest testApplyEnvelopes gate
 * (task-7 pattern) proves the exact ingest applies throw-free IN ORDER, and
 * the post-ingest verification replays [latest snapshot + full tail] from a
 * FRESH store (zero StoreError) — the snapshot+tail convergence scenario.
 *
 * Value derivation per element: the target agent's familyName (…0022) +
 * givenName (…0021) property values (effective idx-0 read), formatted
 * "Family, Given" (single-part values keep the one part); when neither is
 * authored, the agent node's flattened title (fullTitleOf — title-is-
 * content); an EMPTY flatten keeps the value (reported). Metadata on the
 * old element rides verbatim.
 *
 * The plan is read from a SCRATCH derived store (latest snapshot + log tail
 * — the hydration shape the sync server uses), so every existence check
 * sees the converged log state and a second run plans NOTHING (values are
 * strings, refs are linked, the schema is text). Every envelope is
 * zod-validated BEFORE anything is inserted.
 *
 * DRY RUN BY DEFAULT: prints the full plan — per-element rewrites (old →
 * new), kept broken refs, linkedAuthors adds, the flip's before→after, and
 * the MEANING-FLIP REPORT: every saved view / content query token carrying
 * a property condition on …0012 keeps matching by UUID but reads
 * name-strings after the flip (listed + counted, never written). Runs the
 * same pre-ingest test-apply gate, writes nothing. --apply ingests through
 * RelayStorage.ingest (one transaction) and verifies from the persisted
 * log.
 *
 * NEVER point --data-dir at a real relay data dir during development: seed
 * a scratch dir (scripts/migrated-verify/seed-authors-scratch.mts points at
 * /tmp only) and pass it here.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-authors-to-text.mts \
 *     --data-dir /tmp/notees-authors-scratch [--workspace <uuid> | --all] [--apply]
 */

import { randomFillSync } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  parseQueryAst,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  fullTitleOf,
  SYSTEM_PROPERTY_UUIDS,
} from "../packages/domain/src/index.ts";
import {
  Store,
  nodeRefOfValue,
  visiblePropertyValueRows,
  type VisiblePropertyValueRow,
} from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";
import { runQuery } from "../packages/query/src/index.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000a8";
const DEVICE = "migrate-authors-to-text";
const CLIENT = "migrate-authors-to-text";
/** The task-8 scratch harness's happy-path workspace (real runs pass --workspace/--all). */
const DEFAULT_WORKSPACE = "4b7d1a00-1111-4000-8000-000000000001";

const AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.authors;
const LINKED_AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const GIVEN_NAME_ID = SYSTEM_PROPERTY_UUIDS.givenName;
const FAMILY_NAME_ID = SYSTEM_PROPERTY_UUIDS.familyName;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A locally minted UUIDv7 (the PG5 writer-minted element id law) — 48-bit ms
 * timestamp, version 7, variant bits, 74 crypto-random bits. Local because
 * the scripts/ dir resolves no runtime deps beyond the workspace packages.
 */
function mintElementId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
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

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? DEFAULT_WORKSPACE,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
  };
}

/** Every workspace id the relay log carries. */
function listWorkspaces(relay: RelayStorage): string[] {
  const rows = relay.db
    .prepare("SELECT DISTINCT workspace_id FROM envelope ORDER BY workspace_id")
    .all() as Array<{ workspace_id: string }>;
  return rows.map((row) => row.workspace_id);
}

// --- scratch derived store ----------------------------------------------------

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). Throws on any StoreError — a tail that cannot apply must block the
 * migration, not be planned against.
 */
export function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        store.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`tail apply failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- planning -----------------------------------------------------------------

interface SchemaRow {
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

interface PlannedRewrite {
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

interface PlannedAdd {
  sourceId: string;
  refId: string;
  idx: number;
}

interface KeptRef {
  sourceId: string;
  elementId: string | undefined;
  idx: number;
  oldValue: unknown;
  reason: "broken-ref" | "empty-title";
  targetId: string;
}

interface SavedViewHit {
  hostId: string;
  hostTitle: string;
  /** The condition descriptors that reference …0012 (e.g. "property:contains"). */
  conditions: string[];
}

interface UnparseableView {
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

// --- envelopes ----------------------------------------------------------------

export function buildEnvelopes(workspaceId: string, plan: WorkspacePlan): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );
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

  return envelopes;
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

// --- verification -------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log:
 *  1. read the new envelopes back (count + protocol validation),
 *  2. build a FRESH scratch store from the latest snapshot + the full tail
 *     INCLUDING the new envelopes — the [pre-migration snapshot + migrated
 *     tail] convergence replay: zero StoreError throws (review focus #1),
 *  3. assert the converged state: …0012 is text-multi with its stored scope
 *     preserved, every planned rewrite reads back as its text value (with
 *     metadata), kept broken refs still hold their value, every copied ref
 *     is present on linkedAuthors,
 *  4. the pre-migration saved views still run (the UUID-keyed property
 *     conditions match name-strings now — the meaning flip).
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  snapshotSeq: number,
  expectedCount: number,
  plan: WorkspacePlan,
): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== expectedCount) {
    throw new Error(`read-back mismatch: expected ${expectedCount} new envelopes, found ${rows.length}`);
  }
  for (const envelope of rows) {
    const stored = envelopeSchema.parse(envelope);
    const schema = payloadSchemaFor(stored.opType);
    if (schema === undefined || !schema.safeParse(stored.payload).success) {
      throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
    }
  }

  // Review focus #1: the fresh store replays the tail since the snapshot —
  // a replica converging from pre-migration state. Any StoreError throws.
  const store = buildScratchStore(relay, workspaceId);
  try {
    const db = store.database;

    if (plan.flip) {
      const row = db
        .prepare("SELECT type, multi, scope_class_ids FROM property_schema WHERE id = ?")
        .get(AUTHORS_ID) as { type: string; multi: number; scope_class_ids: string | null } | undefined;
      if (row === undefined) {
        throw new Error("verification failed: the authors schema (…0012) row is absent after the migration");
      }
      if (row.type !== "text" || row.multi !== 1) {
        throw new Error(
          `verification failed: authors schema converged to type=${row.type} multi=${row.multi}, expected text/1`,
        );
      }
      const beforeScope = plan.schemaRow?.scope_class_ids ?? null;
      if (row.scope_class_ids !== beforeScope) {
        throw new Error(
          `verification failed: the authors scope drifted in the flip — before ${JSON.stringify(beforeScope)}, after ${JSON.stringify(row.scope_class_ids)}`,
        );
      }
    }

    const visibleAuthors = visiblePropertyValueRows(db).filter(
      (row) => row.property_schema_id === AUTHORS_ID,
    );
    for (const rewrite of plan.rewrites) {
      const row = visibleAuthors.find(
        (candidate) =>
          candidate.node_id === rewrite.sourceId &&
          (rewrite.elementId !== undefined
            ? candidate.id === rewrite.elementId
            : candidate.idx === rewrite.idx && !UUID_RE.test(candidate.id)),
      );
      if (row === undefined) {
        throw new Error(
          `verification failed: the rewritten authors element on ${rewrite.sourceId} (idx ${rewrite.idx}) is gone`,
        );
      }
      const value: unknown = JSON.parse(row.value);
      if (value !== rewrite.newValue) {
        throw new Error(
          `verification failed: authors on ${rewrite.sourceId} converged to ${JSON.stringify(value)}, expected ${JSON.stringify(rewrite.newValue)}`,
        );
      }
      if (rewrite.metadata !== null && row.metadata !== rewrite.metadata) {
        throw new Error(
          `verification failed: the metadata on ${rewrite.sourceId} idx ${rewrite.idx} did not ride verbatim`,
        );
      }
    }
    for (const kept of plan.kept) {
      const row = visibleAuthors.find(
        (candidate) =>
          candidate.node_id === kept.sourceId &&
          (kept.elementId !== undefined
            ? candidate.id === kept.elementId
            : candidate.idx === kept.idx && !UUID_RE.test(candidate.id)),
      );
      if (row === undefined) {
        throw new Error(
          `verification failed: the kept authors element on ${kept.sourceId} (idx ${kept.idx}) is gone`,
        );
      }
      if (JSON.stringify(JSON.parse(row.value)) !== JSON.stringify(kept.oldValue)) {
        throw new Error(
          `verification failed: the kept ${kept.reason} element on ${kept.sourceId} idx ${kept.idx} changed value`,
        );
      }
    }

    const linkedRefs = new Map<string, Set<string>>();
    for (const row of visiblePropertyValueRows(db)) {
      if (row.property_schema_id !== LINKED_AUTHORS_ID) continue;
      const ref = nodeRefOfValue(JSON.parse(row.value));
      if (ref === null) continue;
      if (!linkedRefs.has(row.node_id)) linkedRefs.set(row.node_id, new Set());
      linkedRefs.get(row.node_id)!.add(ref);
    }
    for (const add of plan.adds) {
      if (!(linkedRefs.get(add.sourceId) ?? new Set()).has(add.refId)) {
        throw new Error(
          `verification failed: the linkedAuthors copy of ${add.refId} onto ${add.sourceId} is missing`,
        );
      }
    }

    // The meaning flip: the pre-migration saved views still run — the UUID
    // condition now matches name-strings.
    for (const view of plan.savedViews) {
      const host = db.prepare("SELECT content FROM node WHERE id = ?").get(view.hostId) as
        | { content: string }
        | undefined;
      if (host === undefined) continue;
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
        try {
          const ast = parseQueryAst((token as { queryAst: unknown }).queryAst);
          const result = runQuery(store, ast);
          console.log(
            `  meaning-flip view ${view.hostId} (${JSON.stringify(view.hostTitle)}): ` +
              `${view.conditions.join(", ")} — still runs, ${result.ids.length} node(s) match by UUID`,
          );
        } catch {
          // A legacy pre-strict AST sharing the host — never aborts verify.
          console.log(
            `  unparseable saved view (skipped): ${view.hostId} (${JSON.stringify(view.hostTitle)})`,
          );
        }
      }
    }
    for (const skipped of plan.unparseableViews) {
      console.log(
        `  unparseable saved view (skipped): ${skipped.hostId} (${JSON.stringify(skipped.hostTitle)})`,
      );
    }
  } finally {
    store.close();
  }

  const byOp = new Map<string, number>();
  for (const envelope of rows) {
    byOp.set(envelope.opType, (byOp.get(envelope.opType) ?? 0) + 1);
  }
  const ops = [...byOp.entries()].map(([op, n]) => `${op}×${n}`).join(", ");
  console.log(
    `verify: ${rows.length} new envelope(s) read back (${ops}); tail applied clean since seq ${snapshotSeq} ` +
      "from a fresh store (snapshot+tail replay — review focus #1); text-multi + scope preserved, " +
      "rewrites/metadata/linkedAuthors copies all read back clean.",
  );
}

// --- main ---------------------------------------------------------------------

export interface MigrationResult {
  plan: WorkspacePlan;
  envelopeCount: number;
  applied: boolean;
}

export function migrateWorkspace(
  relay: RelayStorage,
  workspaceId: string,
  apply: boolean,
): MigrationResult {
  const snapshot = relay.latestSnapshot(workspaceId);
  const snapshotSeq = snapshot?.up_to_seq ?? 0;
  const latestSeq = relay.latestSeq(workspaceId);
  console.log(
    `\nworkspace ${workspaceId}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshotSeq}`,
  );

  const store = buildScratchStore(relay, workspaceId);
  try {
    const plan = planWorkspace(store);

    console.log("planned authors→text convergence:");
    if (plan.schemaRow === null) {
      console.log("  authors schema (…0012): no row — the flip is task-7 materialization's job (it seeds the text spec); value rewrites below ride schema-less.");
    } else if (plan.flip) {
      console.log(
        `  (2) schema flip: propertySchema.create UPSERT …0012 ${plan.schemaRow.type}/multi=${plan.schemaRow.multi} → text/multi=true ` +
          "(every other stored column — name, icon, scope, options, filter, date/number/render flags — rides verbatim)",
      );
    } else {
      console.log(`  (2) schema flip: not needed — stored type is already "text".`);
    }
    console.log(`  (1) linkedAuthors adds: ${plan.adds.length}`);
    for (const add of plan.adds) {
      console.log(`      ${add.sourceId} += { nodeId: ${add.refId} } (idx ${add.idx})`);
    }
    if (plan.linkedSchemaMissing) {
      console.log(
        "  warning: the linkedAuthors schema (…0006-…0001) has no row here — the copy is SKIPPED " +
          "(run the task-7 roster migration first; it seeds the pool schemas). The value rewrites still land.",
      );
    }
    console.log(`  (3) value rewrites: ${plan.rewrites.length} (already-text elements: ${plan.alreadyText})`);
    for (const rewrite of plan.rewrites) {
      console.log(
        `      ${rewrite.sourceId} [${rewrite.elementId ?? `idx ${rewrite.idx}`}] ` +
          `${JSON.stringify(rewrite.oldValue)} → ${JSON.stringify(rewrite.newValue)} ` +
          `(${rewrite.derivedFrom === "names" ? "familyName/givenName" : "title fallback"}, target ${rewrite.targetId}` +
          `${rewrite.targetTitle !== "" ? ` "${rewrite.targetTitle}"` : ""})`,
      );
    }
    for (const kept of plan.kept) {
      console.log(
        `      KEPT ${kept.reason}: ${kept.sourceId} [${kept.elementId ?? `idx ${kept.idx}`}] ` +
          `${JSON.stringify(kept.oldValue)}${kept.targetId !== "" ? ` (target ${kept.targetId} gone)` : ""} — value untouched`,
      );
    }
    if (plan.savedViews.length === 0) {
      console.log("  meaning-flip report: no saved views carry a property condition on …0012.");
    } else {
      console.log(
        `  meaning-flip report: ${plan.savedViews.length} saved view(s) carry a property condition on …0012 ` +
          "— they keep matching by UUID but read NAME-STRINGS after the flip (owner decides per view; no writes):",
      );
      for (const view of plan.savedViews) {
        console.log(
          `      ${view.hostId} (${JSON.stringify(view.hostTitle)}): ${view.conditions.join(", ")}`,
        );
      }
    }
    for (const skipped of plan.unparseableViews) {
      console.log(
        `  unparseable saved view (skipped): ${skipped.hostId} (${JSON.stringify(skipped.hostTitle)})` +
          " — its stored AST predates the strict query-ast schema; left untouched",
      );
    }

    if (planIsEmpty(plan)) {
      console.log("\nnothing to migrate — this workspace already carries the authors text state.");
      return { plan, envelopeCount: 0, applied: false };
    }

    const envelopes = buildEnvelopes(workspaceId, plan);
    validateEnvelopes(envelopes);
    console.log(`${envelopes.length} envelope(s) built and protocol-validated.`);

    // The replay gate BEFORE anything is written (dry-run included).
    testApplyEnvelopes(store, envelopes);
    console.log(
      `pre-ingest test-apply: all ${envelopes.length} envelope(s) applied clean in order against the scratch store.`,
    );

    if (!apply) {
      console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
      return { plan, envelopeCount: envelopes.length, applied: false };
    }

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);

    verify(relay, workspaceId, snapshotSeq, envelopes.length, plan);
    return { plan, envelopeCount: envelopes.length, applied: true };
  } finally {
    store.close();
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaces = options.all ? listWorkspaces(relay) : [options.workspace];
    console.log(
      `authors→text migration: ${workspaces.length} workspace(s) ` +
        `(${options.apply ? "--apply" : "dry run"})`,
    );
    for (const workspaceId of workspaces) {
      migrateWorkspace(relay, workspaceId, options.apply);
    }
    if (options.apply) {
      console.log(
        "\ndone. The appended envelopes flow to every device through ordinary catch-up — " +
          "no restart or epoch bump needed (Path A append, not a log rewrite).",
      );
    }
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
