/**
 * Cover-class retirement (owner directive 2026-10-04) — one-shot
 * migration converting the withdrawn `cover` system class's members onto
 * the plain `asset` class:
 *
 *   - the `cover` class (…0001-000000000042) was minted and withdrawn the
 *     same day: it duplicated the cover PROPERTY's
 *     meaning. A cover is an ordinary asset-classed node; the property
 *     value is the only authority.
 *   - per member of the cover class: assign the system `asset` class when
 *     missing, then unassign the cover class. Class membership is OR-Set
 *     add-wins, so these are ordinary convergent ops through the objects
 *     API (PUT/DELETE /api/objects/:id/classes/:classId — the CLI class
 *     verbs' path); every write is recoverable (unassign survives authored
 *     values; the trash covers the rest).
 *   - when (and only when) EVERY member converted, the empty cover class
 *     node rides to the trash (DELETE /api/objects/:id — recoverable). A
 *     partial pass leaves the class node live so the remainder is visible;
 *     re-running is idempotent (asset assign is checked first, the cover
 *     unassign tolerates a missing row).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (members, their asset-class state) and writes nothing.
 *
 * Usage (the tsx binary lives in apps/server; run from the repo root):
 *   pnpm --dir apps/server exec tsx ../../scripts/migrate-cover-to-asset.mts \
 *     --server http://127.0.0.1:8377 --data-dir ../../config/notees/sync \
 *     --workspace <workspace-uuid> [--apply]
 *
 * The module is import-safe (main runs only when executed directly) and its
 * plan/apply core is surface-driven, so tests can drive it against the
 * in-process client harness (apps/web/test/migrate-cover-to-asset.test.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The withdrawn cover class id — hardcoded on purpose: the constant was
 * removed from the seed manifest (…0042 never reused), but live workspaces
 * still carry the class node this id names.
 */
export const COVER_CLASS_ID = "00000000-0000-0000-0001-000000000042";
export const ASSET_CLASS_ID = "00000000-0000-0000-0001-000000000009";

/** The script's surface: class membership reads + the membership/trash writes. */
export interface MigrateScriptSurface {
  /** True when the cover class NODE exists in this workspace (members or not). */
  coverClassExists(): Promise<boolean>;
  /** Members of the cover class (live nodes). */
  listCoverMembers(): Promise<Array<{ id: string; name: string | null }>>;
  /** The member's current class ids (asset assign is checked, never assumed). */
  getObjectClasses(id: string): Promise<string[]>;
  assignClass(objectId: string, classId: string): Promise<void>;
  unassignClass(objectId: string, classId: string): Promise<void>;
  /** Trash a node (the cover class node, once empty). */
  trashObject(id: string): Promise<void>;
}

export interface MigratePlanMember {
  id: string;
  name: string;
  /** True when the member already carries the asset class. */
  hasAsset: boolean;
}

export interface MigratePlan {
  /** False when no cover class node exists in this workspace. */
  coverClassPresent: boolean;
  members: MigratePlanMember[];
}

/** Collect the migration plan: the class node's presence and every member's asset state. */
export async function buildMigratePlan(surface: MigrateScriptSurface): Promise<MigratePlan> {
  if (!(await surface.coverClassExists())) return { coverClassPresent: false, members: [] };
  const members = await surface.listCoverMembers();
  const planned: MigratePlanMember[] = [];
  for (const member of members.sort((a, b) => a.id.localeCompare(b.id))) {
    const classIds = await surface.getObjectClasses(member.id);
    planned.push({
      id: member.id,
      name: member.name ?? "",
      hasAsset: classIds.includes(ASSET_CLASS_ID),
    });
  }
  return { coverClassPresent: true, members: planned };
}

export interface MigrateResult {
  dryRun: boolean;
  converted: number;
  failures: Array<{ id: string; name: string; error: string }>;
  /** True when the (previously membered) cover class node was trashed. */
  classTrashed: boolean;
}

/**
 * Execute the plan. `apply: false` (the default at the CLI) prints the blast
 * radius and writes nothing; `apply: true` converts each member (asset
 * assign when missing → cover unassign) and trashes the cover class node
 * only when every member converted. Per-member failures are collected
 * without aborting the run.
 */
export async function runMigration(
  surface: MigrateScriptSurface,
  plan: MigratePlan,
  options: { apply: boolean; log?: (line: string) => void },
): Promise<MigrateResult> {
  const log = options.log ?? ((): void => undefined);
  if (!plan.coverClassPresent) {
    log("no cover class node in this workspace — nothing to migrate.");
    return { dryRun: true, converted: 0, failures: [], classTrashed: false };
  }
  if (!options.apply) {
    const needAsset = plan.members.filter((member) => !member.hasAsset).length;
    log(
      `dry run: the cover class node exists with ${plan.members.length} member(s) — all would be converted to plain assets (${needAsset} need the asset class assigned, ${plan.members.length - needAsset} already carry it), then the class node would ride to the trash`,
    );
    for (const member of plan.members) {
      log(`  ${member.id}  ${member.name}${member.hasAsset ? "  (asset class already present)" : ""}`);
    }
    return { dryRun: true, converted: 0, failures: [], classTrashed: false };
  }
  const failures: Array<{ id: string; name: string; error: string }> = [];
  let converted = 0;
  for (const member of plan.members) {
    try {
      if (!member.hasAsset) await surface.assignClass(member.id, ASSET_CLASS_ID);
      await surface.unassignClass(member.id, COVER_CLASS_ID);
      converted += 1;
      log(`converted ${member.id}  ${member.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: member.id, name: member.name, error: message });
      log(`FAILED ${member.id}  ${member.name}: ${message}`);
    }
  }
  // The class node goes to the trash only on a FULL pass — a partial pass
  // leaves it live so the remaining members are still visible (and the
  // unconverted stay cover-classed, exactly as before).
  let classTrashed = false;
  if (failures.length === 0) {
    try {
      await surface.trashObject(COVER_CLASS_ID);
      classTrashed = true;
      log(`cover class node ${COVER_CLASS_ID} trashed (recoverable via object restore)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ id: COVER_CLASS_ID, name: "cover class node", error: message });
      log(`FAILED trashing the cover class node: ${message}`);
    }
  } else {
    log(`${failures.length} failure(s) — the cover class node stays live; re-run after fixing.`);
  }
  log(`done: ${converted}/${plan.members.length} member(s) converted, ${failures.length} failure(s)`);
  return { dryRun: false, converted, failures, classTrashed };
}

// --- CLI ----------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CliOptions {
  server: string;
  dataDir: string;
  workspace: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const server = (value("--server") ?? "http://127.0.0.1:8377").replace(/\/+$/, "");
  const dataDir = value("--data-dir") ?? "config/notees/sync";
  const workspace = value("--workspace") ?? "";
  if (!UUID_PATTERN.test(workspace)) {
    throw new Error(
      "a --workspace <uuid> is required (name resolution is the CLI's job; the operator key resolves ids server-side only)",
    );
  }
  return { server, dataDir, workspace, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", apiKey);
    headers.set("x-workspace-id", options.workspace);
    const response = await fetch(`${options.server}${path}`, { ...init, headers });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body.error?.message !== undefined) detail = body.error.message;
      } catch {
        // Non-JSON error body; keep the status-based message.
      }
      throw new Error(`${path} failed: ${detail}`);
    }
    return response;
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await request(path)).json() as Promise<T>;
  }

  const surface: MigrateScriptSurface = {
    async coverClassExists() {
      const response = await fetch(
        `${options.server}/api/classes/${encodeURIComponent(COVER_CLASS_ID)}`,
        { headers: { "x-api-key": apiKey, "x-workspace-id": options.workspace } },
      );
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`cover class read failed: HTTP ${response.status}`);
      return true;
    },
    async listCoverMembers() {
      const response = await fetch(
        `${options.server}/api/classes/${encodeURIComponent(COVER_CLASS_ID)}`,
        { headers: { "x-api-key": apiKey, "x-workspace-id": options.workspace } },
      );
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`cover class read failed: HTTP ${response.status}`);
      const body = (await response.json()) as {
        members: Array<{ id: string; name: string | null }>;
      };
      return body.members;
    },
    async getObjectClasses(id) {
      const body = await getJson<{ object: { classIds?: string[] } }>(
        `/api/objects/${encodeURIComponent(id)}`,
      );
      return body.object.classIds ?? [];
    },
    async assignClass(objectId, classId) {
      await request(`/api/objects/${encodeURIComponent(objectId)}/classes/${encodeURIComponent(classId)}`, {
        method: "PUT",
      });
    },
    async unassignClass(objectId, classId) {
      await request(`/api/objects/${encodeURIComponent(objectId)}/classes/${encodeURIComponent(classId)}`, {
        method: "DELETE",
      });
    },
    async trashObject(id) {
      await request(`/api/objects/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };

  const log = (line: string): void => console.log(line);
  const plan = await buildMigratePlan(surface);
  const result = await runMigration(surface, plan, { apply: options.apply, log });
  if (!options.apply && plan.coverClassPresent) {
    log("re-run with --apply to execute (this was a dry run — nothing was written)");
  } else if (result.failures.length > 0) {
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
