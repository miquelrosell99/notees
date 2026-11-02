/**
 * The Zotero full-alignment migration (scripts/migrate-zotero-full-alignment.mts)
 * — the 2026-11-02 slice that added the 31 source pool properties (UUID tails
 * …057–…075; `pmcid` pinned onto the base family like `pmid`) and the full
 * per-class binding table (SYSTEM_SOURCE_CLASS_BINDINGS, 39 classes).
 *
 * End-to-end harness in the migrate-pmid-property shape: the test builds a
 * scratch relay whose workspace predates the alignment (the `source` class +
 * every bound source type-class with its extends edges, NO new schemas), then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run prints the plan and
 *     writes nothing;
 *  2. exercises the exported plan functions in-process against the sync
 *     server's hydration shape (scratch store = snapshot + tail): the plan is
 *     exactly 31 propertySchema.create envelopes + the full derived binding
 *     count (one class.property.set per missing binding row, pmcid's base
 *     binding pinned on `source`);
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration and the rows land;
 *  4. re-runs --apply — idempotent: the second run plans nothing;
 *  5. the idempotency arms in-process: an existing-but-unpinned pmcid binding
 *     converges with a pin patch, and a stored class-local scope that excludes
 *     a bound class converges scope-FIRST (propertySchema.update ordered
 *     before the binding, same ingest).
 *
 * Every count is DERIVED from the domain manifests (SYSTEM_PROPERTY_UUIDS /
 * SYSTEM_SOURCE_CLASS_BINDINGS), never hand-copied — manifest drift fails here.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, payloadSchemaFor, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  sourceBindingPropertyOf,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildEnvelopes,
  planAlignment,
} from "../../../scripts/migrate-zotero-full-alignment.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-zotero-full-alignment.mts";

const WORKSPACE = "4b7d1a00-2222-4000-8000-000000000002";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "zotero-alignment-test-device";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const PMCID_ID = SYSTEM_PROPERTY_UUIDS.pmcid;
const CASE_NAME_ID = SYSTEM_PROPERTY_UUIDS.caseName;

/** Payload field access (the wire payload is a closed zod union). */
const payloadOf = (envelope: Envelope): Record<string, unknown> =>
  envelope.payload as Record<string, unknown>;

/** The 31-property alignment batch, derived from the UUID pool (…057–…075). */
const BATCH_NAMES = (
  Object.entries(SYSTEM_PROPERTY_UUIDS) as Array<[SystemPropertyName, string]>
)
  .filter(([, id]) => {
    const tail = parseInt(id.slice(-2), 16);
    return tail >= 0x57 && tail <= 0x75;
  })
  .map(([name]) => name);

/** Per-class binding rows the manifests derive for the 30 bind:false pool fields. */
function derivedBindingRows(): number {
  let rows = 0;
  for (const name of BATCH_NAMES) {
    if (name === "pmcid") continue;
    for (const refs of Object.values(SYSTEM_SOURCE_CLASS_BINDINGS)) {
      rows += refs.filter((ref) => sourceBindingPropertyOf(ref) === name).length;
    }
  }
  return rows;
}

const EXPECTED_CREATES = BATCH_NAMES.length; // 31 propertySchema.create
const EXPECTED_BINDING_OPS = 1 + derivedBindingRows(); // pmcid's pinned base row + the pool rows
const EXPECTED_ENVELOPES = EXPECTED_CREATES + EXPECTED_BINDING_OPS;

/** Every class named in the binding table (39 source type-classes). */
function boundClassNames(): SystemClassName[] {
  return Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS) as SystemClassName[];
}

/**
 * The pre-alignment fixture: the `source` class + every bound source
 * type-class with its seeded extends edges — no new schemas anywhere.
 */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>, affected: string[] = []) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );

  const createClass = (name: SystemClassName) =>
    push("class.create", {
      classId: SYSTEM_CLASS_UUIDS[name],
      contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]),
    });

  createClass("source");
  for (const name of boundClassNames()) {
    if (name === "source") continue;
    createClass(name);
  }
  // Ancestors first (all source subclasses); the extends edges build the
  // class_hierarchy closure the R5 dead-config check reads.
  for (const name of boundClassNames()) {
    const parents = SYSTEM_CLASS_EXTENDS[name] ?? [];
    if (parents.length === 0) continue;
    push(
      "class.setExtends",
      {
        classId: SYSTEM_CLASS_UUIDS[name],
        parentClassIds: parents.map((parent) => SYSTEM_CLASS_UUIDS[parent]),
      },
      [SYSTEM_CLASS_UUIDS[name]],
    );
  }
  return envelopes;
}

interface CliResult {
  stdout: string;
  status: number;
}

/** Spawn the migration script exactly as the runbook documents. */
function runScript(args: string[]): CliResult {
  try {
    const stdout = execFileSync(TSX, [MIGRATION_SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      status: failed.status ?? 1,
    };
  }
}

/** The sync server's hydration shape: snapshot (none here) + full tail. */
function hydrate(relay: RelayStorage, store: Store): void {
  let cursor = 0;
  for (;;) {
    const page = relay.catchUp(WORKSPACE, cursor, 10_000);
    for (const envelope of page.envelopes) store.apply(envelope);
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
}

describe("migrate-zotero-full-alignment.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-zotero-alignment-test-"));
    relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    relay.ingest(fixtureEnvelopes());
    store = Store.open(betterSqlite3Backend(":memory:"));
    hydrate(relay, store);
  });

  afterEach(() => {
    store.close();
    relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("derives a 31-property batch from the manifests", () => {
    expect(BATCH_NAMES).toHaveLength(31);
    expect(BATCH_NAMES[0]).toBe("pmcid");
    expect(BATCH_NAMES).toContain("dateDecided");
  });

  it("dry run prints the plan and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned Zotero full alignment:");
    expect(result.stdout).toContain("propertySchema.create");
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain(`${EXPECTED_ENVELOPES} envelope(s)`);
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("plans exactly 31 schema creates + the full derived binding count", () => {
    const plan = planAlignment(store);
    expect(plan.sourceClassMissing).toBe(false);
    expect(plan.properties).toHaveLength(31);
    for (const property of plan.properties) {
      expect(property.schemaMissing).toBe(true);
      expect(property.attributeDrift).toEqual([]);
      expect(property.scopeConverge).toBe(false);
    }

    const envelopes = buildEnvelopes(WORKSPACE, plan);
    expect(envelopes).toHaveLength(EXPECTED_ENVELOPES);
    const creates = envelopes.filter((e) => e.opType === "propertySchema.create");
    const bindingOps = envelopes.filter((e) => e.opType === "class.property.set");
    expect(creates).toHaveLength(EXPECTED_CREATES);
    expect(bindingOps).toHaveLength(EXPECTED_BINDING_OPS);

    // pmcid leads: base-family schema + the PINNED source binding row.
    const pmcid = plan.properties.find((p) => p.name === "pmcid")!;
    expect(pmcid.base).not.toBeNull();
    expect(pmcid.base!.planSet).toBe(true);
    expect(pmcid.base!.pinPatch).toBe(false);
    expect(pmcid.classBindings).toHaveLength(0);
    const pmcidBinding = bindingOps.find(
      (e) => payloadOf(e).propertySchemaId === PMCID_ID,
    )!;
    expect(pmcidBinding.payload).toEqual({
      classId: SOURCE_ID,
      propertySchemaId: PMCID_ID,
      pinned: true,
    });

    // Every pool property: the seed shape at the reserved UUID, scope [source].
    for (const name of BATCH_NAMES) {
      const create = creates.find(
        (e) => payloadOf(e).propertySchemaId === SYSTEM_PROPERTY_UUIDS[name],
      )!;
      expect(create.payload).toEqual({
        propertySchemaId: SYSTEM_PROPERTY_UUIDS[name],
        name: SYSTEM_PROPERTY_DISPLAY_NAMES[name],
        type: "text",
        scopeClassIds: [SOURCE_ID],
      });
    }

    // Ordering: each property's schema op precedes every one of its binding
    // ops (same-ingest convergence; the scope-drift update leads too).
    for (const name of BATCH_NAMES) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[name];
      const schemaIndex = envelopes.findIndex(
        (e) =>
          (e.opType === "propertySchema.create" || e.opType === "propertySchema.update") &&
          payloadOf(e).propertySchemaId === schemaId,
      );
      expect(schemaIndex).toBeGreaterThanOrEqual(0);
      for (const [index, envelope] of envelopes.entries()) {
        if (envelope.opType === "class.property.set" && payloadOf(envelope).propertySchemaId === schemaId) {
          expect(index).toBeGreaterThan(schemaIndex);
        }
      }
    }

    // The protocol gate: every envelope satisfies its per-op payload schema.
    for (const envelope of envelopes) {
      const schema = payloadSchemaFor(envelope.opType);
      expect(schema).toBeDefined();
      expect(schema!.safeParse(envelope.payload).success).toBe(true);
    }
  });

  it("--apply appends the rows, replays clean, and a second run plans nothing", () => {
    const apply = runScript([
      "--data-dir",
      dataDir,
      "--workspace",
      WORKSPACE,
      "--apply",
    ]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain(`ingested ${EXPECTED_ENVELOPES} envelope(s)`);

    // Fresh hydration (the shape every replica replays): clean + the rows.
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);
      const schemas = fresh.database
        .prepare("SELECT id, name, type, scope_class_ids FROM property_schema")
        .all() as Array<{ id: string; name: string; type: string; scope_class_ids: string | null }>;
      for (const name of BATCH_NAMES) {
        const row = schemas.find((s) => s.id === SYSTEM_PROPERTY_UUIDS[name]);
        expect(row, `schema ${name}`).toBeDefined();
        expect(row!.type).toBe("text");
        expect(JSON.parse(row!.scope_class_ids!)).toEqual([SOURCE_ID]);
      }
      const bindings = fresh.database
        .prepare(
          "SELECT class_id, property_schema_id, pinned FROM class_property WHERE property_schema_id IN (SELECT value FROM json_each(?))",
        )
        .all(JSON.stringify(BATCH_NAMES.map((n) => SYSTEM_PROPERTY_UUIDS[n]))) as Array<{
        class_id: string;
        property_schema_id: string;
        pinned: number;
      }>;
      expect(bindings).toHaveLength(EXPECTED_BINDING_OPS);
      const pmcidRow = bindings.find((b) => b.property_schema_id === PMCID_ID)!;
      expect(pmcidRow.class_id).toBe(SOURCE_ID);
      expect(pmcidRow.pinned).toBe(1);
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript([
      "--data-dir",
      dataDir,
      "--workspace",
      WORKSPACE,
      "--apply",
    ]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already converged");
  });

  it("pin-patch and scope-drift arms converge without touching drifted attributes", () => {
    // A workspace that already carries the pmcid schema + an UNPINNED source
    // binding, and the caseName schema at a drifted class-local scope that
    // excludes document (caseName's only bound class).
    const arm = Store.open(betterSqlite3Backend(":memory:"));
    try {
      let t = 1727300000000;
      const step = () => (t += 1000);
      const text = (s: string) => [{ type: "text", text: s }];
      const push = (opType: string, payload: Record<string, unknown>, affected: string[] = []) =>
        arm.apply(
          newEnvelope({
            workspaceId: WORKSPACE,
            actorId: ACTOR,
            deviceId: DEVICE,
            hlc: { physical: step(), logical: 0 },
            affectedNodeIds: affected,
            opType,
            payload,
          }),
        );

      push("class.create", { classId: SOURCE_ID, contentAst: text("Source") });
      push("class.create", {
        classId: SYSTEM_CLASS_UUIDS.document,
        contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES.document),
      });
      push(
        "class.setExtends",
        { classId: SYSTEM_CLASS_UUIDS.document, parentClassIds: [SOURCE_ID] },
        [SYSTEM_CLASS_UUIDS.document],
      );
      push("propertySchema.create", {
        propertySchemaId: PMCID_ID,
        name: "PMCID",
        type: "text",
        scopeClassIds: [SOURCE_ID],
      });
      push("class.property.set", { classId: SOURCE_ID, propertySchemaId: PMCID_ID }, [SOURCE_ID]);
      push("propertySchema.create", {
        propertySchemaId: CASE_NAME_ID,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES.caseName,
        type: "text",
        scopeClassIds: [SYSTEM_CLASS_UUIDS.journal_article],
      });

      const plan = planAlignment(arm);
      const pmcid = plan.properties.find((p) => p.name === "pmcid")!;
      expect(pmcid.schemaMissing).toBe(false);
      expect(pmcid.attributeDrift).toEqual([]);
      expect(pmcid.base!.bound).toBe(true);
      expect(pmcid.base!.boundPinned).toBe(false);
      expect(pmcid.base!.planSet).toBe(true);
      expect(pmcid.base!.pinPatch).toBe(true);

      const caseName = plan.properties.find((p) => p.name === "caseName")!;
      expect(caseName.schemaMissing).toBe(false);
      expect(caseName.scopeConverge).toBe(true);
      expect(caseName.classBindings).toHaveLength(1);
      expect(caseName.classBindings[0]!.className).toBe("document");
      expect(caseName.classBindings[0]!.planSet).toBe(true);

      const envelopes = buildEnvelopes(WORKSPACE, plan);
      // The arms: the pmcid pin patch, the scope-first converge pair — and,
      // this workspace predating the whole batch, the 30 missing schema
      // creates (gated to classes whose closure reaches [source] — only
      // document exists here besides source).
      const pinPatch = envelopes.find(
        (e) => e.opType === "class.property.set" && payloadOf(e).propertySchemaId === PMCID_ID,
      )!;
      expect(pinPatch.payload).toEqual({
        classId: SOURCE_ID,
        propertySchemaId: PMCID_ID,
        pinned: true,
      });
      expect(
        envelopes.filter((e) => e.opType === "propertySchema.create" && payloadOf(e).propertySchemaId === PMCID_ID),
      ).toHaveLength(0);
      const updateIndex = envelopes.findIndex(
        (e) => e.opType === "propertySchema.update" && payloadOf(e).propertySchemaId === CASE_NAME_ID,
      );
      const bindIndex = envelopes.findIndex(
        (e) =>
          e.opType === "class.property.set" && payloadOf(e).propertySchemaId === CASE_NAME_ID,
      );
      expect(updateIndex).toBeGreaterThanOrEqual(0);
      expect(bindIndex).toBeGreaterThan(updateIndex);
      expect(envelopes[updateIndex]!.payload).toEqual({
        propertySchemaId: CASE_NAME_ID,
        scopeClassIds: [SOURCE_ID],
      });
      // No binding is ever planned for a class whose closure cannot reach
      // the schema scope (R5) — the 38 never-deployed classes contribute zero
      // binding rows despite the 30 missing schemas. This fixture deploys
      // only source + document, so those are the only binding targets.
      const DOCUMENT_ID = SYSTEM_CLASS_UUIDS.document;
      for (const envelope of envelopes) {
        if (envelope.opType !== "class.property.set") continue;
        expect([SOURCE_ID, DOCUMENT_ID]).toContain(payloadOf(envelope).classId);
      }
    } finally {
      arm.close();
    }
  });
});
