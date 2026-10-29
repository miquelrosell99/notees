/**
 * displayTemplate seed convergence migration (scripts/migrate-display-template.mts).
 *
 * End-to-end harness in the migrate-seed-pins shape: the test builds a
 * scratch relay whose workspace predates the displayTemplate declaration
 * (system classes whose `class.display_template` column is NULL — plus the
 * two user-set cases the NULL-only ruling protects: `film` carrying a USER
 * opt-out ("" — never overwritten even though the seed value is also "",
 * the plan must not even re-plan it) and `book` carrying a USER template
 * (never overwritten by the "" opt-out seed), plus `podcast` with NO class
 * row at all — the missing skip), then:
 *
 *  1. spawns the script WITHOUT --apply — the dry run must print the plan
 *     and write nothing;
 *  2. exercises the exported plan functions in-process against the sync
 *     server's hydration shape (scratch store = snapshot + tail): the plan
 *     covers exactly the NULL-column targets with their manifest values
 *     (the "" opt-outs included — an authored "" is meaningful state), the
 *     user-set rows are not re-planned, the class-less target reports as
 *     skipped;
 *  3. spawns the script WITH --apply — the appended envelopes replay clean
 *     through a fresh hydration, every planned row equals its manifest
 *     value, and the user-set rows are untouched;
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
  SYSTEM_CLASS_DISPLAY_TEMPLATES,
  SYSTEM_CLASS_UUIDS,
  type SystemClassName,
} from "@notees/domain";
import { getClassDisplayTemplate, Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../src/relay-storage.js";

import {
  buildDisplayTemplateEnvelopes,
  deriveDisplayTemplateTargets,
  planDisplayTemplateAppends,
} from "../../../scripts/migrate-display-template.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const MIGRATION_SCRIPT = "../../scripts/migrate-display-template.mts";

const WORKSPACE = "4b7d1a00-3333-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-0000000000a1";
const DEVICE = "display-template-test-device";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const FILM_ID = SYSTEM_CLASS_UUIDS.film;
const BOOK_ID = SYSTEM_CLASS_UUIDS.book;
const PODCAST_ID = SYSTEM_CLASS_UUIDS.podcast;

/**
 * The pre-declaration fixture: the manifest classes as authored BEFORE the
 * declaration — five with no displayTemplate anywhere (NULL column:
 * source, tv_broadcast, audio_recording, radio_broadcast, video_recording),
 * two user-set rows (film's USER opt-out "", book's USER template), and
 * podcast with no class row at all (the missing skip).
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

  const neverSet = [
    "source",
    "film",
    "tv_broadcast",
    "audio_recording",
    "radio_broadcast",
    "video_recording",
    "book",
  ] as const;
  for (const name of neverSet) {
    push("class.create", {
      classId: SYSTEM_CLASS_UUIDS[name],
      contentAst: text(SYSTEM_CLASS_DISPLAY_NAMES[name]),
    });
  }
  // User-set rows — the NULL-only ruling must never touch these: a USER
  // opt-out on film (the seed value is also "" — a plan that compares
  // against the manifest, or treats "" as unset, would re-plan it) and a
  // USER template on book (the "" opt-out seed must not clobber it).
  push("class.update", { classId: FILM_ID, displayTemplate: "" });
  push("class.update", { classId: BOOK_ID, displayTemplate: "📚 {{title}}" });
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

const templateOf = (store: Store, classId: string): string | null =>
  getClassDisplayTemplate(store.database, classId);

describe("migrate-display-template.mts", () => {
  let dataDir: string;
  let relay: RelayStorage;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-display-template-test-"));
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

  it("derives the target set from the manifest: 8 classes, no duplicates", () => {
    const targets = deriveDisplayTemplateTargets();
    expect(targets).toHaveLength(8);
    expect(new Set(targets.map((t) => t.classId)).size).toBe(8);
    const byName = Object.fromEntries(targets.map((t) => [t.className, t.template]));
    expect(byName.source).toBe("@{{citekey}}");
    // The seven opt-outs carry "" — an authored empty string, not absence.
    for (const name of [
      "film",
      "tv_broadcast",
      "audio_recording",
      "radio_broadcast",
      "podcast",
      "video_recording",
      "book",
    ] as SystemClassName[]) {
      expect(byName[name], name).toBe("");
    }
  });

  it("plans exactly the NULL-column targets with the manifest value; user-set rows are never re-planned; the class-less target is skipped", () => {
    const plan = planDisplayTemplateAppends(store);
    const planned = Object.fromEntries(plan.appends.map((t) => [t.className, t.template]));
    // The five never-set classes plan: source with the citekey template,
    // the four present opt-outs with their authored "".
    expect(planned.source).toBe("@{{citekey}}");
    for (const name of [
      "tv_broadcast",
      "audio_recording",
      "radio_broadcast",
      "video_recording",
    ] as SystemClassName[]) {
      expect(planned[name], name).toBe("");
    }
    expect(plan.appends).toHaveLength(5);
    // The user-set rows are NOT re-planned — film's "" user opt-out must
    // not be "converged" even though the seed value equals it, and book's
    // user template must survive the "" opt-out seed (Review Focus 1).
    expect(planned).not.toHaveProperty("film");
    expect(planned).not.toHaveProperty("book");
    // podcast has no class row at all — skipped, reported, never written.
    expect(plan.missing.map((t) => t.className)).toEqual(["podcast"]);

    // The built envelopes are protocol-valid and carry the manifest value…
    const envelopes = buildDisplayTemplateEnvelopes(WORKSPACE, plan.appends);
    for (const envelope of envelopes) {
      expect(envelopeSchema.safeParse(envelope).success).toBe(true);
      expect(payloadSchemaFor(envelope.opType)!.safeParse(envelope.payload).success).toBe(true);
    }
    const payloads = Object.fromEntries(
      envelopes.map((e) => {
        const payload = e.payload as { classId: string; displayTemplate: string };
        return [payload.classId, payload.displayTemplate];
      }),
    );
    expect(payloads[SOURCE_ID]).toBe("@{{citekey}}");
    expect(payloads[SYSTEM_CLASS_UUIDS.tv_broadcast]).toBe("");
    // …and applying them makes the plan empty (idempotency at the store level).
    for (const envelope of envelopes) store.apply(envelope);
    expect(planDisplayTemplateAppends(store).appends).toHaveLength(0);
  });

  it("dry run prints the plan and writes nothing", () => {
    const seqBefore = relay.latestSeq(WORKSPACE);
    const result = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("planned display-template appends:");
    expect(result.stdout).toContain("dry run");
    expect(result.stdout).toContain("podcast");
    expect(relay.latestSeq(WORKSPACE)).toBe(seqBefore);
  });

  it("--apply appends the templates, replays clean, user-set rows survive, and a second run plans nothing", () => {
    const apply = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("ingested 5 envelope(s)");

    // Fresh hydration (the shape every replica replays): the planned rows
    // converged to the manifest values, the user-set rows are untouched.
    const fresh = Store.open(betterSqlite3Backend(":memory:"));
    try {
      hydrate(relay, fresh);
      expect(templateOf(fresh, SOURCE_ID)).toBe("@{{citekey}}");
      for (const name of [
        "tv_broadcast",
        "audio_recording",
        "radio_broadcast",
        "video_recording",
      ] as SystemClassName[]) {
        expect(templateOf(fresh, SYSTEM_CLASS_UUIDS[name]), name).toBe("");
      }
      // The user's own choices survive — film's opt-out and book's
      // template were never NULL, so the seed never replaces them.
      expect(templateOf(fresh, FILM_ID)).toBe("");
      expect(templateOf(fresh, BOOK_ID)).toBe("📚 {{title}}");
      // The class-less target stays class-less — no row authored for it.
      expect(
        fresh.database.prepare("SELECT id FROM class WHERE id = ?").get(PODCAST_ID),
      ).toBeUndefined();
    } finally {
      fresh.close();
    }

    // Idempotent: the second run plans nothing.
    const second = runScript(["--data-dir", dataDir, "--workspace", WORKSPACE, "--apply"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
  });

  it("the manifest is the target authority: a non-manifest class is never a target", () => {
    // web_page carries no manifest entry — derive must not see it.
    const targets = deriveDisplayTemplateTargets();
    expect(targets.some((t) => t.className === "web_page")).toBe(false);
    expect(SYSTEM_CLASS_DISPLAY_TEMPLATES.web_page).toBeUndefined();
  });
});
