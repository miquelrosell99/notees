/**
 * Seed pin sets convergence (2026-10-27): the domain seed manifests DECLARE
 * binding-row pins now — the source base family (authors/citekey/doi/
 * linkedAuthors/publicationDate/url), the meeting family's meetingDate/
 * location, and the task family's taskStatus/taskScheduled/taskDeadline.
 * Everything else seeds unpinned (eventDate/birthday, editors, isbn,
 * publisher, attachments, taskPriority/taskClosedDate/taskRecurrence, agenda,
 * the url→web_page extra row, every SYSTEM_SOURCE_CLASS_BINDINGS type-class
 * row). New workspaces receive the pins from the server seed / the applier
 * ensure / the web self-heal; EXISTING workspaces carry binding rows authored
 * BEFORE the declaration — this script converges them.
 *
 * The pins are ADDITIVE state on a config row: the script APPENDS fresh
 * `class.property.set {classId, propertySchemaId, pinned: true}` envelopes at
 * the log tail (fresh ids/HLC via RelayStorage.ingest, the
 * migrate-system-names / migrate-url-source-binding Path A shape) — no
 * history rewrite, so NO EPOCH BUMP (applied_envelope tracks envelope ids;
 * the new ids apply everywhere). SNAPSHOT STALENESS: a snapshot built before
 * the append embeds pin-less class_property rows; every hydration path
 * restores the snapshot then catches up the tail (the appended envelopes land
 * above the snapshot's up_to_seq and apply on top), so no snapshot patch is
 * needed — the next server snapshot rebuild derives from the converged store
 * and carries the pins. The server's RUNNING derived store does not see
 * ingested envelopes until rehydration, so restart the sync server after
 * --apply (the migrations.md Path A note).
 *
 * LOCKSTEP GATE (the strict-payload additive law, migrations.md §0): the
 * appended envelopes carry the `pinned` key on `class.property.set` — a
 * pre-batch client REJECTS them and its sync stalls. Check ran 2026-10-27:
 * the GTK port's ClassPropertySetPayload is extra="forbid" without the
 * field, the Flutter port's payload builder carries `active` only, and the
 * CLI's vendored notees predates the pinned machinery (strict zod) — so run
 * --apply ONLY after the GTK/Flutter ports accept `pinned` and the CLI bumps
 * its vendor pin. Until then: dry-run is always safe.
 *
 * The target set is DERIVED from the same domain manifests the seeds consume
 * (no second hardcoded list): SYSTEM_PROPERTY_SPECS entries with bindTo +
 * bind !== false + pinned, SYSTEM_EXTRA_CLASS_BINDINGS entries with pinned,
 * TASK_FAMILY_SEED entries with pinned (the task class), and any pinned
 * SYSTEM_SOURCE_CLASS_BINDINGS ref (none today). A target whose binding row
 * is MISSING from the converged store is SKIPPED (reported, not written):
 * the applier ensure / web self-heal authors missing rows with the manifest
 * pins, and appending a row the workspace deliberately never had would be a
 * semantics change. Idempotent: a second run plans nothing (existing rows
 * read pinned = 1).
 *
 * DRY RUN BY DEFAULT. --apply ingests through RelayStorage.ingest, then
 * verifies: the new envelopes read back from the log and protocol-validate,
 * and a FRESH scratch store (snapshot + full tail) replays clean with every
 * existing target row pinned.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-seed-pins.mts \
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
  sourceBindingPropertyOf,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  TASK_FAMILY_SEED,
  type SystemClassName,
  type SystemPropertyName,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000b1";
const DEVICE = "migrate-seed-pins";
const CLIENT = "migrate-seed-pins";
const DEFAULT_WORKSPACE = "3b30e070-039b-47bc-ad0d-2440a2f173c5";

// --- CLI ----------------------------------------------------------------------

interface CliOptions {
  dataDir: string;
  workspace: string;
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
    apply: argv.includes("--apply"),
  };
}

// --- scratch derived store ----------------------------------------------------

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). Throws on any tail apply failure — the plan reads the CONVERGED
 * state, never a possibly-stale replica.
 */
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

// --- the pin target set (derived from the domain manifests) --------------------

export interface SeedPinTarget {
  classId: string;
  propertySchemaId: string;
  /** The manifest the target derived from (plan output only). */
  origin: "spec" | "extra" | "task-family" | "source-class";
}

/**
 * Every (class, property) pair the seed manifests declare a pin for — the
 * same manifests the server seed, the applier ensure, and the web self-heal
 * consume, so the migration can never drift from the declaration (the
 * domain test pins the declared sets verbatim).
 */
export function deriveSeedPinTargets(): SeedPinTarget[] {
  const targets: SeedPinTarget[] = [];
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    if (spec.bindTo === undefined || spec.bind === false || spec.pinned !== true) continue;
    targets.push({
      classId: SYSTEM_CLASS_UUIDS[spec.bindTo],
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName],
      origin: "spec",
    });
  }
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    if (extra.pinned !== true) continue;
    targets.push({
      classId: SYSTEM_CLASS_UUIDS[extra.bindTo],
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[extra.property],
      origin: "extra",
    });
  }
  for (const entry of TASK_FAMILY_SEED) {
    if (entry.pinned !== true) continue;
    targets.push({
      classId: SYSTEM_CLASS_UUIDS.task,
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[entry.property],
      origin: "task-family",
    });
  }
  for (const [className, refs] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
    for (const ref of refs) {
      if (typeof ref === "string" || ref.pinned !== true) continue;
      targets.push({
        classId: SYSTEM_CLASS_UUIDS[className as SystemClassName],
        propertySchemaId: SYSTEM_PROPERTY_UUIDS[sourceBindingPropertyOf(ref)],
        origin: "source-class",
      });
    }
  }
  return targets;
}

// --- planning -------------------------------------------------------------------

export interface SeedPinPlan {
  /** Existing rows still unpinned — one append each. */
  appends: SeedPinTarget[];
  /** Targets with NO binding row in the converged store — skipped, reported. */
  missing: SeedPinTarget[];
}

/**
 * Plan from the converged scratch store: an existing row with pinned = 1 is
 * done; pinned = 0 plans an append; a MISSING row is skipped (the applier
 * ensure / web self-heal authors it from the manifests with the pin — e.g.
 * the task family in a tasks-feature-off workspace).
 */
export function planSeedPinAppends(store: Store, targets: SeedPinTarget[] = deriveSeedPinTargets()): SeedPinPlan {
  const appends: SeedPinTarget[] = [];
  const missing: SeedPinTarget[] = [];
  const row = store.database.prepare(
    "SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?",
  );
  for (const target of targets) {
    const existing = row.get(target.classId, target.propertySchemaId) as { pinned: number } | undefined;
    if (existing === undefined) {
      missing.push(target);
    } else if (existing.pinned !== 1) {
      appends.push(target);
    }
  }
  return { appends, missing };
}

// --- envelopes ------------------------------------------------------------------

export function buildSeedPinEnvelopes(workspaceId: string, appends: SeedPinTarget[]): Envelope[] {
  const physical = Date.now();
  return appends.map((target, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: [target.classId],
      opType: "class.property.set",
      payload: {
        classId: target.classId,
        propertySchemaId: target.propertySchemaId,
        pinned: true,
      },
    }),
  );
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema BEFORE anything is inserted.
 */
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

/**
 * Post-insert verification, straight from the persisted log: the new
 * envelopes read back + protocol-validate, and a FRESH scratch store
 * (snapshot + FULL tail, the appended envelopes included) replays clean
 * with every existing target row pinned.
 */
function verify(relay: RelayStorage, workspaceId: string, expectedCount: number): void {
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

  const store = buildScratchStore(relay, workspaceId);
  try {
    const check = store.database.prepare(
      "SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?",
    );
    for (const target of deriveSeedPinTargets()) {
      const existing = check.get(target.classId, target.propertySchemaId) as
        | { pinned: number }
        | undefined;
      // Missing rows stay missing (the ensures author them) — any row that
      // EXISTS must now be pinned.
      if (existing !== undefined && existing.pinned !== 1) {
        throw new Error(
          `verification failed: ${target.classId}/${target.propertySchemaId} still unpinned after replay`,
        );
      }
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; fresh scratch replay clean, every existing target row pinned.`,
  );
}

// --- main -------------------------------------------------------------------------

function describe(target: SeedPinTarget): string {
  const className =
    (Object.entries(SYSTEM_CLASS_UUIDS).find(([, id]) => id === target.classId)?.[0] as
      | SystemClassName
      | undefined) ?? target.classId;
  const propertyName =
    (Object.entries(SYSTEM_PROPERTY_UUIDS).find(([, id]) => id === target.propertySchemaId)?.[0] as
      | SystemPropertyName
      | undefined) ?? target.propertySchemaId;
  return `${className} → ${propertyName} (${target.origin})`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  try {
    const snapshot = relay.latestSnapshot(options.workspace);
    const latestSeq = relay.latestSeq(options.workspace);
    console.log(
      `workspace ${options.workspace}: log seq ${latestSeq}, snapshot ${snapshot?.id ?? "(none)"} at seq ${snapshot?.up_to_seq ?? 0}`,
    );

    const store = buildScratchStore(relay, options.workspace);
    const plan = planSeedPinAppends(store);
    store.close();

    console.log("\nplanned seed-pin appends:");
    if (plan.appends.length === 0) {
      console.log("  (none — every existing target row already carries the pin)");
    }
    for (const target of plan.appends) {
      console.log(`  pin  ${describe(target)}`);
    }
    if (plan.missing.length > 0) {
      console.log(
        `  skipped (no binding row — the applier ensure / web self-heal authors it with the pin):`,
      );
      for (const target of plan.missing) {
        console.log(`       ${describe(target)}`);
      }
    }

    if (plan.appends.length === 0) {
      console.log("\nnothing to migrate — the workspace already carries the declared seed pins.");
      return;
    }

    const envelopes = buildSeedPinEnvelopes(options.workspace, plan.appends);
    validateEnvelopes(envelopes);
    console.log(`\n${envelopes.length} envelope(s) built and protocol-validated.`);

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to append these envelopes (LOCKSTEP GATE: GTK/Flutter ports + the CLI vendor pin must accept `pinned` first).",
      );
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-seed-pins-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-seed-pins-${stamp}`);

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    verify(relay, options.workspace, envelopes.length);
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
