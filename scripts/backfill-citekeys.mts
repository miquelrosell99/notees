/**
 * One-time citekey backfill (2026-10-29, the citekey-tracking slice): give
 * every EXISTING source node in every workspace a citekey, generated from
 * the workspace's own pattern — owner ruling: ALL workspaces, forced (the
 * Auto-citekey toggle does NOT gate this run; the backfilled keys land
 * UNPINNED, so a workspace with Auto-citekey on tracks metadata like any
 * generated key, and one with it off keeps a static key).
 *
 * For each workspace on the relay (or --workspace <uuid>): restore the
 * latest snapshot + full tail into a scratch derived store (the hydration
 * shape — the plan reads CONVERGED state), walk the store's own
 * `classMembers(source)` family read (extends-aware, active-only — the same
 * membership the web engine keys on), skip members already carrying a
 * non-empty citekey (scalar OR the manual-edit carrier shape — the
 * `citekeyTextOf` contract), render the pattern from the node's current
 * metadata (authors text literals first, the linkedAuthors agent
 * derivation's one-shot approximation when empty — familyName/givenName
 * properties else the target's display name; the publicationDate chain
 * year; the title via domain `deriveDisplayName`), collision-suffix against
 * the live library (deterministic a/b/c, case-insensitive), and append ONE
 * `property.set` envelope per missing key at the log tail — Path A (no
 * epoch bump; the payload keys predate every client, no lockstep gate).
 *
 * DRY RUN BY DEFAULT. --apply backs up relay.db to /tmp, ingests through
 * RelayStorage.ingest, then verifies from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch replay shows
 * every planned node carrying its citekey. The sync server's RUNNING
 * derived store does not see ingested envelopes until rehydration — restart
 * it after --apply (the migrations.md Path A note).
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/backfill-citekeys.mts \
 *     --data-dir ../../config/notees/sync [--workspace <uuid>] [--apply]
 */

import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  deriveDisplayName,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";
import { RelayStorage } from "../apps/server/src/relay-storage.ts";
import {
  compileCitekeyPattern,
  DEFAULT_CITEKEY_PATTERN,
  type CitekeyEntry,
} from "../apps/web/src/features/sources/citekey.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000b2";
const DEVICE = "backfill-citekeys";
const CLIENT = "backfill-citekeys";

const CITEKEY = SYSTEM_PROPERTY_UUIDS.citekey;
const AUTHORS = SYSTEM_PROPERTY_UUIDS.authors;
const LINKED_AUTHORS = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const PUBLICATION_DATE = SYSTEM_PROPERTY_UUIDS.publicationDate;
const FAMILY_NAME = SYSTEM_PROPERTY_UUIDS.familyName;
const GIVEN_NAME = SYSTEM_PROPERTY_UUIDS.givenName;

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string | null;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? null,
    apply: argv.includes("--apply"),
  };
}

// --- scratch derived store ----------------------------------------------------

/** Snapshot + full tail into a fresh in-memory store (the sync server's hydration shape). */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
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

// --- reads (the citekeyValue/citekeyEntryOf contract, one-shot form) ----------

interface ValueRow {
  /** The wire value (JSON-decoded). */
  value: unknown;
  idx: number;
}

function valueRows(store: Store, nodeId: string, schemaId: string): ValueRow[] {
  const rows = store.database
    .prepare(
      "SELECT value, idx FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx, id",
    )
    .all(nodeId, schemaId) as Array<{ value: string; idx: number }>;
  return rows.map((row) => ({ value: JSON.parse(row.value) as unknown, idx: row.idx }));
}

/** The citekey's text in either storage shape (scalar or carrier ref). */
function citekeyText(store: Store, raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  const ref =
    typeof raw === "object" && raw !== null && "nodeId" in (raw as Record<string, unknown>)
      ? String((raw as { nodeId: unknown }).nodeId ?? "")
      : null;
  if (ref === null) return "";
  const target = store.database
    .prepare("SELECT content FROM node WHERE id = ?")
    .get(ref) as { content: string } | undefined;
  if (target === undefined) return "";
  const ast = JSON.parse(target.content) as Parameters<typeof deriveDisplayName>[0]["contentAst"];
  return deriveDisplayName({ id: ref, contentAst: ast }).trim();
}

/** One text-literal property value (a scalar string; refs skipped). */
function textLiterals(store: Store, nodeId: string, schemaId: string): string[] {
  const out: string[] = [];
  for (const row of valueRows(store, nodeId, schemaId)) {
    if (typeof row.value === "string" && row.value.trim() !== "") out.push(row.value.trim());
  }
  return out;
}

/** A person/agent node name for the linkedAuthors fallback: family/given properties when present, else the display name. */
function agentName(store: Store, nodeId: string): string | null {
  const family = textLiterals(store, nodeId, FAMILY_NAME)[0];
  const given = textLiterals(store, nodeId, GIVEN_NAME)[0];
  if (family !== undefined && family !== "") {
    return given !== undefined && given !== "" ? `${family}, ${given}` : family;
  }
  const row = store.database.prepare("SELECT id, content FROM node WHERE id = ?").get(nodeId) as
    | { id: string; content: string }
    | undefined;
  if (row === undefined) return null;
  const name = deriveDisplayName({
    id: row.id,
    contentAst: JSON.parse(row.content) as Parameters<typeof deriveDisplayName>[0]["contentAst"],
  }).trim();
  return name === "" ? null : name;
}

// The date-chain id year prefix (sourcesQuery chainYearOf — never regenerated ids).
const CHAIN_ID_PREFIX = /^00000000-0000-0000-00(?:bb|aa|dd)-(\d{4})/;

function chainYearOf(id: string): number | null {
  const match = CHAIN_ID_PREFIX.exec(id);
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function publicationYear(store: Store, nodeId: string): number | null {
  for (const row of valueRows(store, nodeId, PUBLICATION_DATE)) {
    const value = row.value;
    if (typeof value === "string") {
      const match = /(\d{4})/.exec(value);
      if (match !== null) {
        const year = Number(match[1]);
        if (Number.isFinite(year) && year >= 1000) return year;
      }
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const point = (value as { nodeId?: unknown }).nodeId;
      if (typeof point === "string") {
        const fromPoint = chainYearOf(point);
        if (fromPoint !== null) return fromPoint;
      }
      const start = (value as { start?: { nodeId?: unknown } | null }).start;
      if (start !== null && typeof start === "object" && typeof start.nodeId === "string") {
        const fromStart = chainYearOf(start.nodeId);
        if (fromStart !== null) return fromStart;
      }
    }
  }
  return null;
}

/** The generation entry (the citekeyEntryOf read, one-shot form). */
function entryOf(store: Store, node: { id: string; content: string }): CitekeyEntry {
  const authors = textLiterals(store, node.id, AUTHORS);
  const resolved =
    authors.length > 0
      ? authors
      : valueRows(store, node.id, LINKED_AUTHORS)
          .map((row) => {
            const ref =
              typeof row.value === "object" && row.value !== null
                ? String((row.value as { nodeId?: unknown }).nodeId ?? "")
                : "";
            return ref === "" ? null : agentName(store, ref);
          })
          .filter((name): name is string => name !== null && name.length > 0);
  const title = deriveDisplayName({
    id: node.id,
    contentAst: JSON.parse(node.content) as Parameters<typeof deriveDisplayName>[0]["contentAst"],
  });
  return { authors: resolved, year: publicationYear(store, node.id), title };
}

// --- generation (the quickCreate generateCitekey contract) --------------------

/** The deterministic collision suffix: 0 → "a", 25 → "z", 26 → "aa", … */
function collisionSuffix(index: number): string {
  let n = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return suffix;
}

function generateCitekey(
  pattern: string | undefined,
  entry: CitekeyEntry,
  existing: readonly string[],
): string {
  const taken = new Set(existing.map((key) => key.trim().toLowerCase()).filter(Boolean));
  const stored = pattern !== undefined ? renderPattern(pattern, entry) : null;
  const base = stored ?? renderPattern(DEFAULT_CITEKEY_PATTERN, entry) ?? "";
  if (base === "" || !taken.has(base.toLowerCase())) return base;
  for (let index = 0; ; index++) {
    const candidate = `${base}${collisionSuffix(index)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function renderPattern(pattern: string, entry: CitekeyEntry): string | null {
  const compiled = compileCitekeyPattern(pattern);
  return compiled.ok ? compiled.render(entry) : null;
}

// --- planning -------------------------------------------------------------------

export interface BackfillPlanItem {
  nodeId: string;
  title: string;
  value: string;
}

export interface WorkspacePlan {
  workspaceId: string;
  /** Stored pattern (undefined = the default renders). */
  pattern: string | undefined;
  autoCitekey: boolean;
  members: number;
  alreadyKeyed: number;
  /** Nothing to generate from (no authors, no title, no date). */
  skippedEmpty: number;
  appends: BackfillPlanItem[];
}

function planWorkspace(relay: RelayStorage, workspaceId: string): WorkspacePlan {
  const store = buildScratchStore(relay, workspaceId);
  try {
    const featureRow = store.database
      .prepare("SELECT settings FROM workspace_feature WHERE workspace_id = ? AND feature = 'sources'")
      .get(workspaceId) as { settings: string } | undefined;
    const settings = featureRow === undefined ? {} : (JSON.parse(featureRow.settings) as Record<string, unknown>);
    const pattern = typeof settings.citekeyPattern === "string" ? settings.citekeyPattern : undefined;
    const autoCitekey = settings.autoCitekey === true;

    const members = store.classMembers(SYSTEM_CLASS_UUIDS.source).filter((row) => row.is_class === 0);
    const existing: string[] = [];
    const missing: Array<{ id: string; content: string }> = [];
    let alreadyKeyed = 0;
    for (const member of members) {
      const rows = valueRows(store, member.id, CITEKEY);
      const text = rows.map((row) => citekeyText(store, row.value)).find((value) => value !== "") ?? "";
      if (text !== "") {
        alreadyKeyed += 1;
        existing.push(text);
      } else {
        missing.push({ id: member.id, content: member.content });
      }
    }

    const appends: BackfillPlanItem[] = [];
    let skippedEmpty = 0;
    for (const node of missing) {
      const value = generateCitekey(pattern, entryOf(store, node), existing);
      if (value === "") {
        skippedEmpty += 1;
        continue;
      }
      existing.push(value);
      appends.push({ nodeId: node.id, title: entryTitle(store, node), value });
    }

    return {
      workspaceId,
      pattern,
      autoCitekey,
      members: members.length,
      alreadyKeyed,
      skippedEmpty,
      appends,
    };
  } finally {
    store.close();
  }
}

function entryTitle(store: Store, node: { id: string; content: string }): string {
  return deriveDisplayName({
    id: node.id,
    contentAst: JSON.parse(node.content) as Parameters<typeof deriveDisplayName>[0]["contentAst"],
  });
}

// --- envelopes ------------------------------------------------------------------

export function buildBackfillEnvelopes(workspaceId: string, appends: BackfillPlanItem[]): Envelope[] {
  const physical = Date.now();
  return appends.map((item, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: [item.nodeId],
      opType: "property.set",
      payload: {
        objectId: item.nodeId,
        propertySchemaId: CITEKEY,
        value: item.value,
        idx: 0,
      },
    }),
  );
}

function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    if (!envelopeSchema.safeParse(envelope).success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined || !schema.safeParse(envelope.payload).success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`);
  }
}

// --- verification ---------------------------------------------------------------

function verify(relay: RelayStorage, workspaceId: string, plan: WorkspacePlan): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== plan.appends.length) {
    throw new Error(
      `read-back mismatch: expected ${plan.appends.length} new envelopes, found ${rows.length}`,
    );
  }
  for (const envelope of rows) {
    const stored = envelopeSchema.parse(envelope);
    const schema = payloadSchemaFor(stored.opType);
    if (schema === undefined || !schema.safeParse(stored.payload).success) {
      throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
    }
  }

  const store = buildScratchStore(relay, workspaceId);
  try {
    for (const item of plan.appends) {
      const rowsNow = valueRows(store, item.nodeId, CITEKEY);
      const text = rowsNow.map((row) => citekeyText(store, row.value)).find((value) => value !== "") ?? "";
      if (text === "") {
        throw new Error(`verification failed: ${item.nodeId} still carries no citekey after replay`);
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} envelope(s) read back and protocol-valid; fresh scratch replay shows every planned node keyed.`,
  );
}

// --- main -------------------------------------------------------------------------

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const workspaceIds =
      options.workspace !== null ? [options.workspace] : relay.listWorkspaceIds();
    console.log(`relay: ${workspaceIds.length} workspace(s) at ${options.dataDir}`);

    const plans: WorkspacePlan[] = [];
    let totalAppends = 0;
    for (const workspaceId of workspaceIds) {
      const plan = planWorkspace(relay, workspaceId);
      plans.push(plan);
      totalAppends += plan.appends.length;
      console.log(
        `\nworkspace ${workspaceId}: ${plan.members} source member(s), ${plan.alreadyKeyed} already keyed, ` +
          `${plan.appends.length} to backfill, ${plan.skippedEmpty} skipped (nothing to generate from)` +
          ` — pattern ${plan.pattern ?? "(default)"}, auto-citekey ${plan.autoCitekey ? "on" : "off"}`,
      );
      for (const item of plan.appends.slice(0, 20)) {
        console.log(`  + ${item.value}  ←  ${item.title === "" ? "(untitled)" : item.title}`);
      }
      if (plan.appends.length > 20) {
        console.log(`  … and ${plan.appends.length - 20} more`);
      }
    }

    if (totalAppends === 0) {
      console.log("\nnothing to backfill — every source in every workspace already carries a citekey.");
      return;
    }

    const envelopes = plans.flatMap((plan) => buildBackfillEnvelopes(plan.workspaceId, plan.appends));
    validateEnvelopes(envelopes);
    console.log(`\n${envelopes.length} envelope(s) built and protocol-validated.`);

    if (!options.apply) {
      console.log("\ndry run — re-run with --apply to append these envelopes.");
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-backfill-citekeys-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-backfill-citekeys-${stamp}`);

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    for (const plan of plans) {
      if (plan.appends.length > 0) verify(relay, plan.workspaceId, plan);
    }
    console.log("done.");
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
