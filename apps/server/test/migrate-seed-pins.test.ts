/**
 * Seed pin sets migration (scripts/migrate-seed-pins.mts).
 *
 * End-to-end harness in the migrate-authors-to-text shape: the test builds a
 * scratch relay whose workspace predates the pin declaration (binding rows
 * WITHOUT the pinned flag — and one row already pinned, one binding row
 * missing entirely), then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run must print the plan
 *     and write nothing;
 *  2. exercises the exported plan functions in-process against the sync
 *     server's hydration shape (scratch store = snapshot + tail): the plan
 *     covers exactly the unpinned existing target rows, the already-pinned
 *     row is not re-planned, the missing row reports as skipped;
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration and the pinned flags land on exactly the
 *     declared rows (and on NO others);
 *  4. re-runs --apply — idempotent: the second run plans nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, payloadSchemaFor, envelopeSchema, type Envelope } from "@notees/protocol";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  TASK_FAMILY_SEED,
  type SystemPropertyName,
} from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildSeedPinEnvelopes,
  deriveSeedPinTargets,
  planSeedPinAppends,
} from "../../../scripts/migrate-seed-pins.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-seed-pins.mts";

const WORKSPACE = "4b7d1a00-2222-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-000000000099";
const DEVICE = "seed-pins-test-device";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const MEETING_ID = SYSTEM_CLASS_UUIDS.meeting;
const TASK_ID = SYSTEM_CLASS_UUIDS.task;
const WEB_PAGE_ID = SYSTEM_CLASS_UUIDS.web_page;

/** The pre-declaration fixture: the binding rows a live workspace carries. */
interface FixtureBinding {
  classId: string;
  property: SystemPropertyName;
  pinned?: boolean;
}

/**
 * The fixture workspace: the classes + schemas + binding rows of the
 * declared pin sets' neighborhoods, as authored BEFORE the declaration —
 * every binding row without the pinned flag, except location (already
 * converged by an earlier pass) and taskDeadline (no binding row at all —
 * the ensure authors it with the pin, so the script must skip it).
 */
function fixtureEnvelopes(): Envelope[] {
  const envelopes: Envelope[] = [];
  let t = 1727200000000;
  const step = () => (t += 1000);
  const text = (s: string) => [{ type: "text", text: s }];
  const push = (opType: string, payload: Record<string, unknown>) =>
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        hlc: { physical: step(), logical: 0 },
        opType,
        payload,
      }),
    );

  for (const name of ["source", "meeting", "task", "web_page"] as const) {
    push("class.create", {
      classId: SYSTEM_CLASS_UUIDS[name],
      contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]),
    });
  }

  const schemas: Array<{ property: SystemPropertyName; scope: string | null }> = [
    { property: "authors", scope: SOURCE_ID },
    { property: "citekey", scope: SOURCE_ID },
    { property: "doi", scope: SOURCE_ID },
    { property: "publicationDate", scope: SOURCE_ID },
    { property: "isbn", scope: SOURCE_ID },
    { property: "publisher", scope: SOURCE_ID },
    { property: "linkedAuthors", scope: SOURCE_ID },
    // url is a GLOBAL seed schema (the seed-scope audit) — reachability for
    // web_page's own row holds without an extends edge.
    { property: "url", scope: null },
    { property: "location", scope: MEETING_ID },
    { property: "agenda", scope: MEETING_ID },
    ...TASK_FAMILY_SEED.map((entry) => ({ property: entry.property, scope: null })),
  ];
  for (const { property, scope } of schemas) {
    const spec = SYSTEM_PROPERTY_SPECS[property];
    const seedEntry = TASK_FAMILY_SEED.find((entry) => entry.property === property);
    push("propertySchema.create", {
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[property],
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[property],
      type: seedEntry?.type ?? spec!.type,
      multi: spec?.multi ?? false,
      ...(scope !== null ? { scopeClassIds: [scope] } : {}),
      ...(seedEntry?.options !== undefined ? { options: [...seedEntry.options] } : {}),
    });
  }

  const bindings: FixtureBinding[] = [
    { classId: SOURCE_ID, property: "authors" },
    { classId: SOURCE_ID, property: "citekey" },
    { classId: SOURCE_ID, property: "doi" },
    { classId: SOURCE_ID, property: "publicationDate" },
    { classId: SOURCE_ID, property: "url" },
    { classId: SOURCE_ID, property: "linkedAuthors" },
    // The unpinned rest of the families — the declaration must not touch them.
    { classId: SOURCE_ID, property: "isbn" },
    { classId: SOURCE_ID, property: "publisher" },
    { classId: WEB_PAGE_ID, property: "url" },
    // location ALREADY carries the pin (a converged row — never re-planned).
    { classId: MEETING_ID, property: "location", pinned: true },
    { classId: MEETING_ID, property: "agenda" },
    { classId: TASK_ID, property: "taskStatus" },
    { classId: TASK_ID, property: "taskScheduled" },
    // taskPriority unpinned; taskDeadline has NO row at all (missing → skipped).
    { classId: TASK_ID, property: "taskPriority" },
  ];
  for (const binding of bindings) {
    push("class.property.set", {
      classId: binding.classId,
      propertySchemaId: SYSTEM_PROPERTY_UUIDS[binding.property],
      ...(binding.pinned !== undefined ? { pinned: binding.pinned } : {}),
    });
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

const pinnedOf = (store: Store, classId: string, property: SystemPropertyName): number | undefined =>
  (
    store.database
      .prepare("SELECT pinned FROM class_property WHERE class_id = ? AND property_schema_id = ?")
      .get(classId, SYSTEM_PROPERTY_UUIDS[property]) as { pinned: number } | undefined
  )?.pinned;

describe("migrate-seed-pins.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-seed-pins-test-"));
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

  it("derives the pin target set from the manifests: 10 rows, no duplicates", () => {
    const targets = deriveSeedPinTargets();
    expect(targets).toHaveLength(10);
    expect(new Set(targets.map((t) => `${t.classId}/${t.propertySchemaId}`)).size).toBe(10);
    // url→web_page is NOT a target (only the source base row pins).
    expect(
      targets.some((t) => t.classId === WEB_PAGE_ID && t.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url),
    ).toBe(false);
  });

  it("plans exactly the unpinned existing rows; the converged row is not re-planned; the missing row is skipped", () => {
    const plan = planSeedPinAppends(store);
    const pairs = plan.appends.map((t) => `${t.classId}/${t.propertySchemaId}`).sort();
    expect(pairs).toEqual(
      [
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.authors}`,
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.citekey}`,
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.doi}`,
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.linkedAuthors}`,
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.publicationDate}`,
        `${SOURCE_ID}/${SYSTEM_PROPERTY_UUIDS.url}`,
        `${TASK_ID}/${SYSTEM_PROPERTY_UUIDS.taskStatus}`,
        `${TASK_ID}/${SYSTEM_PROPERTY_UUIDS.taskScheduled}`,
      ].sort(),
    );
    // The already-pinned location row is NOT re-planned…
    expect(pairs).not.toContain(`${MEETING_ID}/${SYSTEM_PROPERTY_UUIDS.location}`);
    // …and the missing taskDeadline row reports as skipped, not written.
    expect(plan.missing.map((t) => t.propertySchemaId)).toEqual([
      SYSTEM_PROPERTY_UUIDS.taskDeadline,
    ]);

    // The built envelopes are protocol-valid…
    const envelopes = buildSeedPinEnvelopes(WORKSPACE, plan.appends);
    for (const envelope of envelopes) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
      expect(envelope.payload).toMatchObject({ pinned: true });
    }
    // …and applying them makes the plan empty (idempotency at the store level).
    for (const envelope of envelopes) store.apply(envelope);
    expect(planSeedPinAppends(store).appends).toHaveLength(0);
  });

  it("dry run prints the plan and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned seed-pin appends:");
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("taskDeadline");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("--apply appends the pins, replays clean, and a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 8 envelope(s)");

    // Fresh hydration (the shape every replica replays): clean + the flags
    // land on exactly the declared rows.
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);
      for (const property of [
        "authors",
        "citekey",
        "doi",
        "linkedAuthors",
        "publicationDate",
        "url",
      ] as SystemPropertyName[]) {
        expect(pinnedOf(fresh, SOURCE_ID, property), `source → ${property}`).toBe(1);
      }
      expect(pinnedOf(fresh, MEETING_ID, "location")).toBe(1);
      expect(pinnedOf(fresh, TASK_ID, "taskStatus")).toBe(1);
      expect(pinnedOf(fresh, TASK_ID, "taskScheduled")).toBe(1);
      // Unpinned everywhere else — the declaration never bleeds.
      for (const property of ["isbn", "publisher"] as SystemPropertyName[]) {
        expect(pinnedOf(fresh, SOURCE_ID, property), `source → ${property}`).toBe(0);
      }
      expect(pinnedOf(fresh, WEB_PAGE_ID, "url")).toBe(0);
      expect(pinnedOf(fresh, MEETING_ID, "agenda")).toBe(0);
      expect(pinnedOf(fresh, TASK_ID, "taskPriority")).toBe(0);
      // The missing row is still missing — the ensure authors it, not the script.
      expect(pinnedOf(fresh, TASK_ID, "taskDeadline")).toBeUndefined();
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
  });
});
