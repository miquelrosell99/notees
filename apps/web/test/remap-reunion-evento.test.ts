/**
 * scripts/remap-reunion-evento.mts tests (§34.36) — the remap core (title
 * matching, plan building, dry-run/apply) driven against the in-process
 * client harness (WorkspaceClient over a MemoryRelay), through the same
 * surface the script's HTTP adapter implements. Safety properties under
 * test: dry run writes NOTHING; --apply assigns the meeting class one op per
 * member while leaving the source classes AND their memberships untouched
 * (no deletions, no unassigns); re-apply is duplicate-free; the title match
 * is exact (case-insensitive, trimmed) — "Eventos"/"reunion" stay put.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ensureMeetingFamily, MEETING_CLASS_ID } from "../src/ui/components/meetingFamily.js";
import {
  buildRemapPlan,
  isRemapSourceTitle,
  runRemap,
  type RemapScriptSurface,
} from "../../../scripts/remap-reunion-evento.mts";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";
const DEVICE = "test-device";

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
function surfaceOf(client: WorkspaceClient): RemapScriptSurface {
  return {
    listClasses: async () =>
      client.listClasses().map((cls) => ({
        id: cls.id,
        name: deriveDisplayName(cls) ?? "",
        memberCount: client.getClassMembers(cls.id).length,
      })),
    listMembers: async (classId) =>
      client
        .getClassMembers(classId)
        .map((node) => ({ id: node.id, name: deriveDisplayName(node) ?? "" })),
    assignClass: async (objectId, classId) => client.assignClass(objectId, classId),
    getNodeRaw: async (id) => client.getNodeRaw(id),
    listPropertySchemas: async () => client.listPropertySchemas(),
    getClassBindings: async (classId) => client.getClassBindings(classId),
    createClass: (name, opts) => client.createClass(name, opts),
    createPropertySchema: (input) => client.createPropertySchema(input),
    setClassProperty: (classId, propertySchemaId, fields) =>
      client.setClassProperty(classId, propertySchemaId, fields),
  };
}

interface Fixture {
  client: WorkspaceClient;
  surface: RemapScriptSurface;
  reunionId: string;
  eventoId: string;
  eventosId: string;
  reunionMembers: string[];
  eventoMembers: string[];
  eventosMember: string;
}

/** Two exact-titled source classes (one capitalized), one plural decoy, one foreign class. */
async function fixture(): Promise<Fixture> {
  const client = await seedClient();
  const surface = surfaceOf(client);

  const reunionId = await client.createClass("reunión");
  const eventoId = await client.createClass("Evento");
  const eventosId = await client.createClass("Eventos");
  await client.createClass("fuente");

  async function memberOf(classId: string, name: string): Promise<string> {
    return client.createObject({ presentAsMain: true, name, classIds: [classId] });
  }
  const reunionMembers = [
    await memberOf(reunionId, "Weekly sync"),
    await memberOf(reunionId, "Sprint planning"),
  ];
  const eventoMembers = [await memberOf(eventoId, "Conference trip")];
  const eventosMember = await memberOf(eventosId, "Not a match");

  return {
    client,
    surface,
    reunionId,
    eventoId,
    eventosId,
    reunionMembers,
    eventoMembers,
    eventosMember,
  };
}

describe("isRemapSourceTitle (exact, case-insensitive, trimmed)", () => {
  it("matches the register's titles and their case variants only", () => {
    expect(isRemapSourceTitle("reunión")).toBe(true);
    expect(isRemapSourceTitle("REUNIÓN")).toBe(true);
    expect(isRemapSourceTitle("evento")).toBe(true);
    expect(isRemapSourceTitle(" Evento ")).toBe(true);
    expect(isRemapSourceTitle("Eventos")).toBe(false);
    expect(isRemapSourceTitle("reunion")).toBe(false); // no accent folding — exact title match
    expect(isRemapSourceTitle("reuniones")).toBe(false);
    expect(isRemapSourceTitle("eventos especiales")).toBe(false);
    expect(isRemapSourceTitle("")).toBe(false);
  });
});

describe("remap plan + dry run", () => {
  it("plans exactly the exact-titled classes with their members, and writes nothing", async () => {
    const fx = await fixture();
    const plan = await buildRemapPlan(fx.surface);

    expect(plan.targetClassId).toBe(MEETING_CLASS_ID);
    expect(plan.memberCount).toBe(3);
    expect(plan.entries.map((entry) => entry.classId).sort()).toEqual(
      [fx.reunionId, fx.eventoId].sort(),
    );
    expect(plan.entries.flatMap((entry) => entry.members.map((member) => member.id)).sort()).toEqual(
      [...fx.reunionMembers, ...fx.eventoMembers].sort(),
    );

    const lines: string[] = [];
    const result = await runRemap(fx.surface, plan, { apply: false, log: (line) => lines.push(line) });

    expect(result.dryRun).toBe(true);
    expect(result.assigned).toBe(0);
    expect(result.failures).toEqual([]);
    // The plan names the blast radius; the decoys are absent.
    expect(lines.join("\n")).toContain("Weekly sync");
    expect(lines.join("\n")).not.toContain("Not a match");

    // Nothing was written: no meeting class, no membership, decoys untouched.
    expect(fx.client.getNodeRaw(MEETING_CLASS_ID)).toBeUndefined();
    for (const id of [...fx.reunionMembers, ...fx.eventoMembers, fx.eventosMember]) {
      expect(fx.client.getNodeRaw(id)?.classIds).not.toContain(MEETING_CLASS_ID);
    }
    expect(fx.client.getClassMembers(fx.eventosId).map((node) => node.id)).toEqual([
      fx.eventosMember,
    ]);
  });

  it("plans nothing on a workspace without the source classes", async () => {
    const client = await seedClient();
    const plan = await buildRemapPlan(surfaceOf(client));
    expect(plan.entries).toEqual([]);
    expect(plan.memberCount).toBe(0);
    const result = await runRemap(surfaceOf(client), plan, { apply: false });
    expect(result).toMatchObject({ dryRun: true, assigned: 0, failures: [] });
  });
});

describe("remap apply (through the script's ensure + plan + apply flow)", () => {
  it("ensures the meeting family, assigns one op per member, and leaves the source classes intact", async () => {
    const fx = await fixture();

    // The script's exact flow: 1. ensure the target, 2. plan, 3. apply.
    await ensureMeetingFamily(fx.surface);
    const plan = await buildRemapPlan(fx.surface);
    const lines: string[] = [];
    const result = await runRemap(fx.surface, plan, { apply: true, log: (line) => lines.push(line) });

    expect(result).toMatchObject({ dryRun: false, assigned: 3, failures: [] });

    // Every member now carries the meeting class…
    for (const id of [...fx.reunionMembers, ...fx.eventoMembers]) {
      const node = fx.client.getNodeRaw(id);
      expect(node?.classIds).toContain(MEETING_CLASS_ID);
      expect(node?.classIds.filter((classId) => classId === MEETING_CLASS_ID)).toHaveLength(1);
    }
    // …AND keeps its source membership (assignment only — no unassigns).
    for (const id of fx.reunionMembers) {
      expect(fx.client.getNodeRaw(id)?.classIds).toContain(fx.reunionId);
    }
    for (const id of fx.eventoMembers) {
      expect(fx.client.getNodeRaw(id)?.classIds).toContain(fx.eventoId);
    }
    // The source classes themselves still exist with all their members.
    expect(fx.client.getNodeRaw(fx.reunionId)?.isClass).toBe(true);
    expect(fx.client.getNodeRaw(fx.eventoId)?.isClass).toBe(true);
    expect(fx.client.getClassMembers(fx.reunionId)).toHaveLength(2);
    expect(fx.client.getClassMembers(fx.eventoId)).toHaveLength(1);
    // The decoy never got the meeting class.
    expect(fx.client.getNodeRaw(fx.eventosMember)?.classIds).not.toContain(MEETING_CLASS_ID);

    // The ensured family sits at the reserved ids with the date binding.
    expect(
      fx.client
        .getClassBindings(MEETING_CLASS_ID)
        .map((binding) => binding.propertySchemaId),
    ).toContain(SYSTEM_PROPERTY_UUIDS.meetingDate);
    expect(lines.join("\n")).toContain("done: 3 member(s) assigned, 0 failure(s)");
  });

  it("a second apply is duplicate-free and failure-tolerant", async () => {
    const fx = await fixture();
    await ensureMeetingFamily(fx.surface);
    const plan = await buildRemapPlan(fx.surface);
    await runRemap(fx.surface, plan, { apply: true });

    const again = await runRemap(fx.surface, plan, { apply: true });
    expect(again.assigned).toBe(3);
    expect(again.failures).toEqual([]);
    for (const id of [...fx.reunionMembers, ...fx.eventoMembers]) {
      expect(
        fx.client.getNodeRaw(id)?.classIds.filter((classId) => classId === MEETING_CLASS_ID),
      ).toHaveLength(1);
    }

    // A member that vanishes mid-run fails individually, the rest still apply.
    const failing: RemapScriptSurface = {
      ...fx.surface,
      assignClass: async (objectId, classId) => {
        if (objectId === fx.reunionMembers[0]) throw new Error("boom");
        return fx.surface.assignClass(objectId, classId);
      },
    };
    const tolerant = await runRemap(failing, plan, { apply: true });
    expect(tolerant.assigned).toBe(2);
    expect(tolerant.failures).toEqual([
      { id: fx.reunionMembers[0], name: "Weekly sync", error: "boom" },
    ]);
  });
});
