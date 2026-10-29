/**
 * displayTemplate seed convergence (2026-10-29): the domain seed manifest
 * DECLARES class-level display templates now — `source` ships the
 * citekey-centric header template "@{{citekey}}" and the seven media-type
 * classes (film, tv_broadcast, audio_recording, radio_broadcast, podcast,
 * video_recording, book) opt OUT explicitly ("" — their designed chrome
 * shows cover art instead). New workspaces receive the templates from the
 * server seed / the deploy ensure; EXISTING workspaces carry class rows
 * authored BEFORE the declaration (a NULL `display_template` column) —
 * this script converges them.
 *
 * The convergence is strictly NULL-ONLY (the binding ruling, Review Focus
 * 1): the script appends a `class.update {classId, displayTemplate}` ONLY
 * for a manifest target whose converged `class.display_template` column IS
 * NULL — never set — and it writes the manifest value INCLUDING "" for
 * the opt-outs. A non-NULL column is NEVER overwritten: a user-set
 * template AND a user-set "" opt-out are both first-class authored state,
 * and the plan compares against NULL, never against the manifest value
 * (a user "" on film is not "drift from the seed """, it is a decision).
 * A target with NO class row in the converged store is SKIPPED (reported,
 * not written): the applier ensure / web self-heal authors missing rows
 * from the manifests, and a bare class.update against a missing row could
 * not write the registry column anyway.
 *
 * The envelopes are ADDITIVE state at the log tail: fresh
 * `class.update {classId, displayTemplate}` envelopes appended via
 * RelayStorage.ingest (the migrate-seed-pins / migrate-system-names Path A
 * shape) — no history rewrite, so NO EPOCH BUMP (applied_envelope tracks
 * envelope ids; the new ids apply everywhere). SNAPSHOT STALENESS: a
 * snapshot built before the append embeds template-less class rows; every
 * hydration path restores the snapshot then catches up the tail (the
 * appended envelopes land above the snapshot's up_to_seq and apply on
 * top), so no snapshot patch is needed — the next server snapshot rebuild
 * derives from the converged store and carries the templates. The server's
 * RUNNING derived store does not see ingested envelopes until rehydration,
 * so restart the sync server after --apply (the migrations.md Path A note).
 *
 * LOCKSTEP GATE (the strict-payload additive law, migrations.md §0): the
 * appended envelopes carry the `displayTemplate` key on `class.update` —
 * a pre-batch client REJECTS them and its sync stalls. SCHEMA.md still
 * carries the LOCKSTEP-PENDING marker for the displayTemplate payload
 * (cleared when the GTK/Flutter ports ship `class-display-template.json`
 * acceptance), so run --apply ONLY after the ports accept the key and the
 * CLI bumps its vendor pin. Until then: dry-run is always safe.
 *
 * The target set is DERIVED from the same domain manifest the seeds
 * consume (SYSTEM_CLASS_DISPLAY_TEMPLATES — no second hardcoded list), so
 * the migration can never drift from the declaration (the domain test
 * pins the manifest verbatim). Idempotent: a second run plans nothing
 * (every converged row reads non-NULL).
 *
 * DRY RUN BY DEFAULT. --apply ingests through RelayStorage.ingest, then
 * verifies: the new envelopes read back from the log and
 * protocol-validate, and a FRESH scratch store (snapshot + full tail)
 * replays clean with every planned target row equal to its manifest value.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-display-template.mts \
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
  SYSTEM_CLASS_DISPLAY_TEMPLATES,
  SYSTEM_CLASS_UUIDS,
  type SystemClassName,
} from "../packages/domain/src/index.ts";
import { Store } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

const ACTOR = "01920000-0000-7000-8000-0000000000b1";
const DEVICE = "migrate-display-template";
const CLIENT = "migrate-display-template";
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

// --- the display-template target set (derived from the domain manifest) --------

export interface DisplayTemplateTarget {
  classId: string;
  className: SystemClassName;
  /** The manifest value: the template, or "" for the explicit opt-outs. */
  template: string;
}

/**
 * Every class the seed manifest declares a display template for — the same
 * manifest the server seed, the deploy ensure, and the web self-heal
 * consume, so the migration can never drift from the declaration.
 */
export function deriveDisplayTemplateTargets(): DisplayTemplateTarget[] {
  const targets: DisplayTemplateTarget[] = [];
  for (const [name, template] of Object.entries(SYSTEM_CLASS_DISPLAY_TEMPLATES)) {
    if (template === undefined) continue;
    targets.push({
      classId: SYSTEM_CLASS_UUIDS[name as SystemClassName],
      className: name as SystemClassName,
      template,
    });
  }
  return targets;
}

// --- planning -------------------------------------------------------------------

export interface DisplayTemplatePlan {
  /** Rows whose column IS NULL — one append each, with the manifest value. */
  appends: DisplayTemplateTarget[];
  /** Rows already carrying a value (user-set template or user-set "") — never touched. */
  set: DisplayTemplateTarget[];
  /** Targets with NO class row in the converged store — skipped, reported. */
  missing: DisplayTemplateTarget[];
}

/**
 * Plan from the converged scratch store, NULL-ONLY: the append decision
 * reads the raw `display_template` column and plans ONLY when it IS NULL —
 * a user-set template AND a user-set "" opt-out both read non-NULL and are
 * never overwritten (the NULL-only ruling, Review Focus 1; the comparison
 * is against NULL, never against the manifest value).
 */
export function planDisplayTemplateAppends(
  store: Store,
  targets: DisplayTemplateTarget[] = deriveDisplayTemplateTargets(),
): DisplayTemplatePlan {
  const appends: DisplayTemplateTarget[] = [];
  const set: DisplayTemplateTarget[] = [];
  const missing: DisplayTemplateTarget[] = [];
  const row = store.database.prepare("SELECT display_template FROM class WHERE id = ?");
  for (const target of targets) {
    const existing = row.get(target.classId) as { display_template: string | null } | undefined;
    if (existing === undefined) {
      missing.push(target);
    } else if (existing.display_template === null) {
      appends.push(target);
    } else {
      set.push(target);
    }
  }
  return { appends, set, missing };
}

// --- envelopes ------------------------------------------------------------------

export function buildDisplayTemplateEnvelopes(
  workspaceId: string,
  appends: DisplayTemplateTarget[],
): Envelope[] {
  const physical = Date.now();
  return appends.map((target, index) =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: index },
      affectedNodeIds: [target.classId],
      opType: "class.update",
      payload: {
        classId: target.classId,
        displayTemplate: target.template,
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
 * with every planned target row equal to its manifest value ("" for the
 * opt-outs — an authored empty string, not absence).
 */
function verify(relay: RelayStorage, workspaceId: string, appends: DisplayTemplateTarget[]): void {
  const rows = relay
    .allEnvelopes(workspaceId)
    .filter((envelope) => envelope.deviceId === DEVICE);
  if (rows.length !== appends.length) {
    throw new Error(`read-back mismatch: expected ${appends.length} new envelopes, found ${rows.length}`);
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
    const check = store.database.prepare("SELECT display_template FROM class WHERE id = ?");
    for (const target of appends) {
      const row = check.get(target.classId) as { display_template: string | null } | undefined;
      if (row === undefined || row.display_template !== target.template) {
        throw new Error(
          `verification failed: ${target.className} (${target.classId}) reads ` +
            `${row === undefined ? "(no row)" : JSON.stringify(row.display_template)} after replay, ` +
            `expected ${JSON.stringify(target.template)}`,
        );
      }
    }
    // Idempotency at the converged-store level: a re-plan on the fresh
    // replay must plan nothing.
    const replan = planDisplayTemplateAppends(store);
    if (replan.appends.length > 0) {
      throw new Error(
        `verification failed: ${replan.appends.length} target(s) still NULL after replay: ` +
          replan.appends.map((t) => t.className).join(", "),
      );
    }
  } finally {
    store.close();
  }
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; fresh scratch replay clean, every planned target row equals its manifest value.`,
  );
}

// --- main -------------------------------------------------------------------------

function describeTemplate(template: string): string {
  return template === "" ? '(opt-out "")' : JSON.stringify(template);
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
    const plan = planDisplayTemplateAppends(store);
    store.close();

    console.log("\nplanned display-template appends:");
    if (plan.appends.length === 0) {
      console.log("  (none — every target row already carries a value)");
    }
    for (const target of plan.appends) {
      console.log(`  set  ${target.className} → ${describeTemplate(target.template)}`);
    }
    if (plan.set.length > 0) {
      console.log("  untouched (user-set value — the NULL-only ruling never overwrites):");
      for (const target of plan.set) {
        console.log(`       ${target.className} already ${describeTemplate(target.template)}`);
      }
    }
    if (plan.missing.length > 0) {
      console.log(
        "  skipped (no class row — the applier ensure / web self-heal authors it with the template):",
      );
      for (const target of plan.missing) {
        console.log(`       ${target.className}`);
      }
    }

    if (plan.appends.length === 0) {
      console.log("\nnothing to migrate — every manifest target already carries a value.");
      return;
    }

    const envelopes = buildDisplayTemplateEnvelopes(options.workspace, plan.appends);
    validateEnvelopes(envelopes);
    console.log(`\n${envelopes.length} envelope(s) built and protocol-validated.`);

    if (!options.apply) {
      console.log(
        "\ndry run — re-run with --apply to append these envelopes (LOCKSTEP GATE: the GTK/Flutter ports + the CLI vendor pin must accept `displayTemplate` first — SCHEMA.md LOCKSTEP-PENDING).",
      );
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(options.dataDir, "relay.db"), `/tmp/relay.db.bak-display-template-${stamp}`);
    console.log(`\nbackup: /tmp/relay.db.bak-display-template-${stamp}`);

    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    console.log("no epoch bump (Path A append) — restart the sync server to rehydrate its derived store.");

    verify(relay, options.workspace, plan.appends);
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
