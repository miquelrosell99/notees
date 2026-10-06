/**
 * scripts/migrate-cover-to-asset.mts tests — the cover-class
 * retirement: the migration core (plan assembly, dry-run/apply) driven
 * against the in-process client harness (WorkspaceClient over a
 * MemoryRelay), through the same surface the script's HTTP adapter
 * implements. Safety properties under test: dry run writes NOTHING; --apply
 * assigns the asset class (only when missing) then unassigns the withdrawn
 * cover class per member; the cover class node rides to the trash ONLY on a
 * full pass; a member failure leaves the class node live; re-running after
 * a successful pass is a no-op (no cover class node → nothing to migrate).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  ASSET_CLASS_ID,
  buildMigratePlan,
  COVER_CLASS_ID,
  runMigration,
  type MigrateScriptSurface,
} from "../../../scripts/migrate-cover-to-asset.mts";

const WS = "0192a000-0000-7000-8000-0000000000d1";
const ACTOR = "0192a000-0000-7000-8000-0000000000d2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** The same surface the script's HTTP adapter builds, over the real client. */
function surfaceOf(client: WorkspaceClient): MigrateScriptSurface {
  return {
    coverClassExists: async () => client.getNode(COVER_CLASS_ID) !== undefined,
    listCoverMembers: async () =>
      client
        .getClassMembers(COVER_CLASS_ID)
        .map((node) => ({ id: node.id, name: deriveDisplayName(node) ?? "" })),
    getObjectClasses: async (id) => client.getNode(id)?.classIds ?? [],
    assignClass: async (objectId, classId) => client.assignClass(objectId, classId),
    unassignClass: async (objectId, classId) => client.unassignClass(objectId, classId),
    trashObject: async (id) => client.deleteObject(id),
  };
}

/** Authors the withdrawn cover class node + a member fixture set. */
async function seedCoverClassed(
  client: WorkspaceClient,
  members: Array<{ name: string; withAsset: boolean }>,
): Promise<string[]> {
  // The fixture authors the class roots first (the ensure pattern — fresh
  // workspaces carry no system-class rows).
  if (client.getNode(SYSTEM_CLASS_UUIDS.asset) === undefined) {
    await client.createClass("asset", { id: SYSTEM_CLASS_UUIDS.asset, icon: "mdiPaperclip" });
  }
  await client.createClass("cover", { id: COVER_CLASS_ID, icon: "mdiImageArea" });
  await client.setClassExtends(COVER_CLASS_ID, [SYSTEM_CLASS_UUIDS.asset]);
  const ids: string[] = [];
  for (const member of members) {
    const id = await client.createObject({ presentAsMain: true, name: member.name });
    await client.assignClass(id, COVER_CLASS_ID);
    if (member.withAsset) await client.assignClass(id, SYSTEM_CLASS_UUIDS.asset);
    ids.push(id);
  }
  return ids;
}

describe("migrate-cover-to-asset", () => {
  it("a workspace without the cover class plans nothing", async () => {
    const client = await seedClient();
    const surface = surfaceOf(client);
    const plan = await buildMigratePlan(surface);
    expect(plan.coverClassPresent).toBe(false);
    expect(plan.members).toEqual([]);

    const lines: string[] = [];
    const result = await runMigration(surface, plan, {
      apply: true,
      log: (line) => lines.push(line),
    });
    expect(result.converted).toBe(0);
    expect(result.classTrashed).toBe(false);
    expect(lines.join("\n")).toContain("nothing to migrate");
  });

  it("dry run prints the blast radius and writes nothing", async () => {
    const client = await seedClient();
    const surface = surfaceOf(client);
    await seedCoverClassed(client, [
      { name: "a.png", withAsset: false },
      { name: "b.png", withAsset: true },
    ]);

    const plan = await buildMigratePlan(surface);
    expect(plan.coverClassPresent).toBe(true);
    expect(plan.members).toHaveLength(2);
    expect(plan.members.find((m) => m.name === "a.png")?.hasAsset).toBe(false);
    expect(plan.members.find((m) => m.name === "b.png")?.hasAsset).toBe(true);

    const before = client.getClassMembers(COVER_CLASS_ID).map((m) => m.id);
    const lines: string[] = [];
    const result = await runMigration(surface, plan, {
      apply: false,
      log: (line) => lines.push(line),
    });
    expect(result.dryRun).toBe(true);
    expect(result.converted).toBe(0);
    // Nothing written: memberships untouched.
    expect(client.getClassMembers(COVER_CLASS_ID).map((m) => m.id)).toEqual(before);
    expect(client.getNode(COVER_CLASS_ID)).not.toBeUndefined();
    expect(lines.join("\n")).toContain("dry run");
  });

  it("--apply converts every member (asset assigned only when missing) and trashes the empty class", async () => {
    const client = await seedClient();
    const surface = surfaceOf(client);
    const ids = await seedCoverClassed(client, [
      { name: "a.png", withAsset: false },
      { name: "b.png", withAsset: true },
    ]);
    const a = ids[0]!;
    const b = ids[1]!;

    const plan = await buildMigratePlan(surface);
    const result = await runMigration(surface, plan, { apply: true });
    expect(result.failures).toEqual([]);
    expect(result.converted).toBe(2);
    expect(result.classTrashed).toBe(true);

    // Both are plain assets now, no cover membership anywhere.
    for (const id of [a, b]) {
      const classIds = client.getNode(id)?.classIds ?? [];
      expect(classIds).toContain(ASSET_CLASS_ID);
      expect(classIds).not.toContain(COVER_CLASS_ID);
    }
    // The class node is trashed (recoverable — the trash, not a purge).
    expect(client.getNode(COVER_CLASS_ID)).toBeUndefined();

    // Re-run is a clean no-op.
    const rerun = await buildMigratePlan(surface);
    expect(rerun.coverClassPresent).toBe(false);
  });

  it("an already-asset member converts without a duplicate assign (idempotent mid-pass)", async () => {
    const client = await seedClient();
    const surface = surfaceOf(client);
    const ids = await seedCoverClassed(client, [{ name: "b.png", withAsset: true }]);
    const b = ids[0]!;
    const assign = vi.spyOn(client, "assignClass");

    const result = await runMigration(surface, await buildMigratePlan(surface), { apply: true });
    expect(result.converted).toBe(1);
    expect(assign).not.toHaveBeenCalledWith(b, ASSET_CLASS_ID);
    expect(client.getNode(b)?.classIds).toContain(ASSET_CLASS_ID);
  });

  it("a member failure keeps the class node live; the failure is reported", async () => {
    const client = await seedClient();
    const surface = surfaceOf(client);
    const ids = await seedCoverClassed(client, [
      { name: "a.png", withAsset: false },
      { name: "b.png", withAsset: false },
    ]);
    const a = ids[0]!;
    const b = ids[1]!;
    // b's unassign blows up mid-pass.
    const original = client.unassignClass.bind(client);
    vi.spyOn(client, "unassignClass").mockImplementation(async (objectId, classId) => {
      if (objectId === b && classId === COVER_CLASS_ID) throw new Error("simulated relay fault");
      return original(objectId, classId);
    });

    const result = await runMigration(surface, await buildMigratePlan(surface), { apply: true });
    expect(result.converted).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe(b);
    expect(result.classTrashed).toBe(false);

    // a converted, b still cover-classed, the class node live.
    expect(client.getNode(a)?.classIds).toContain(ASSET_CLASS_ID);
    expect(client.getNode(b)?.classIds).toContain(COVER_CLASS_ID);
    expect(client.getNode(COVER_CLASS_ID)).not.toBeUndefined();
  });
});
