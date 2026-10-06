/**
 * scripts/remap-reunion-evento.mts tests (owner reshape directive)
 * — the remap core (title→target matching, plan assembly, dry-run/apply)
 * driven against the in-process client harness (WorkspaceClient over a
 * MemoryRelay), through the same surface the script's HTTP adapter
 * implements. Safety properties under test: dry run writes NOTHING; --apply
 * assigns each source class's members to its OWN system target (reunión →
 * meeting, evento → event) one op per member while leaving the source
 * classes AND their memberships untouched (no deletions, no unassigns); the
 * ensure authors the event root + meeting subclass + the extends edge;
 * re-apply is duplicate-free; the title match is exact (case-insensitive,
 * trimmed) — "Eventos"/"reunion" stay put.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  ensureMeetingFamily,
  EVENT_CLASS_ID,
  MEETING_CLASS_ID,
} from "../src/ui/components/meetingFamily.js";
import {
  buildRemapPlan,
  isRemapSourceTitle,
  remapTargetFor,
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
    getClassParents: async (classId) => client.getClassParents(classId),
    createClass: (name, opts) => client.createClass(name, opts),
    createPropertySchema: (input) => client.createPropertySchema(input),
    setClassProperty: (classId, propertySchemaId, fields) =>
      client.setClassProperty(classId, propertySchemaId, fields),
    setClassExtends: (classId, parentClassIds) => client.setClassExtends(classId, parentClassIds),
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

describe("title → target matching (exact, case-insensitive, trimmed)", () => {
  it("maps the register's titles to their own system targets and rejects lookalikes", () => {
    expect(remapTargetFor("reunión")).toBe(SYSTEM_CLASS_UUIDS.meeting);
    expect(remapTargetFor("REUNIÓN")).toBe(SYSTEM_CLASS_UUIDS.meeting);
    expect(remapTargetFor("evento")).toBe(SYSTEM_CLASS_UUIDS.event);
    expect(remapTargetFor(" Evento ")).toBe(SYSTEM_CLASS_UUIDS.event);
    expect(isRemapSourceTitle("reunión")).toBe(true);
    expect(isRemapSourceTitle("evento")).toBe(true);
    // No accent folding ("reunion" ≠ "reunión"), no plurals, no substrings.
    expect(remapTargetFor("reunion")).toBeUndefined();
    expect(remapTargetFor("reuniones")).toBeUndefined();
    expect(remapTargetFor("Eventos")).toBeUndefined();
    expect(remapTargetFor("eventos especiales")).toBeUndefined();
    expect(remapTargetFor("")).toBeUndefined();
  });
});

describe("remap plan + dry run", () => {
  it("plans each source class with its OWN target and its members, and writes nothing", async () => {
    const fx = await fixture();
    const plan = await buildRemapPlan(fx.surface);

    expect(plan.memberCount).toBe(3);
    const reunionEntry = plan.entries.find((entry) => entry.classId === fx.reunionId);
    expect(reunionEntry).toMatchObject({
      title: "reunión",
      targetClassId: MEETING_CLASS_ID,
    });
    expect(reunionEntry?.members.map((member) => member.id).sort()).toEqual(
      [...fx.reunionMembers].sort(),
    );
    const eventoEntry = plan.entries.find((entry) => entry.classId === fx.eventoId);
    expect(eventoEntry).toMatchObject({ title: "Evento", targetClassId: EVENT_CLASS_ID });
    expect(eventoEntry?.members.map((member) => member.id)).toEqual(fx.eventoMembers);

    const lines: string[] = [];
    const result = await runRemap(fx.surface, plan, { apply: false, log: (line) => lines.push(line) });

    expect(result.dryRun).toBe(true);
    expect(result.assigned).toBe(0);
    expect(result.failures).toEqual([]);
    // The plan names the blast radius per target; the decoys are absent.
    expect(lines.join("\n")).toContain("Weekly sync");
    expect(lines.join("\n")).not.toContain("Not a match");

    // Nothing was written: no system classes, no membership, decoys untouched.
    expect(fx.client.getNodeRaw(MEETING_CLASS_ID)).toBeUndefined();
    expect(fx.client.getNodeRaw(EVENT_CLASS_ID)).toBeUndefined();
    for (const id of [...fx.reunionMembers, ...fx.eventoMembers, fx.eventosMember]) {
      expect(fx.client.getNodeRaw(id)?.classIds).not.toContain(MEETING_CLASS_ID);
      expect(fx.client.getNodeRaw(id)?.classIds).not.toContain(EVENT_CLASS_ID);
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
  it("ensures the family (with the extends edge), assigns each source to its own target, and leaves the source classes intact", async () => {
    const fx = await fixture();

    // The script's exact flow: 1. ensure the targets, 2. plan, 3. apply.
    await ensureMeetingFamily(fx.surface);
    const plan = await buildRemapPlan(fx.surface);
    const lines: string[] = [];
    const result = await runRemap(fx.surface, plan, { apply: true, log: (line) => lines.push(line) });

    expect(result).toMatchObject({ dryRun: false, assigned: 3, failures: [] });

    // reunión members → meeting; evento members → event; each exactly once…
    for (const id of fx.reunionMembers) {
      const classIds = fx.client.getNodeRaw(id)?.classIds;
      expect(classIds).toContain(MEETING_CLASS_ID);
      expect(classIds?.filter((classId) => classId === MEETING_CLASS_ID)).toHaveLength(1);
      expect(classIds).not.toContain(EVENT_CLASS_ID);
    }
    for (const id of fx.eventoMembers) {
      const classIds = fx.client.getNodeRaw(id)?.classIds;
      expect(classIds).toContain(EVENT_CLASS_ID);
      expect(classIds?.filter((classId) => classId === EVENT_CLASS_ID)).toHaveLength(1);
      expect(classIds).not.toContain(MEETING_CLASS_ID);
    }
    // …AND the source memberships stay (assignment only — no unassigns).
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
    // The decoy never got a system class.
    expect(fx.client.getNodeRaw(fx.eventosMember)?.classIds).not.toContain(MEETING_CLASS_ID);
    expect(fx.client.getNodeRaw(fx.eventosMember)?.classIds).not.toContain(EVENT_CLASS_ID);

    // The ensured family sits at the reserved ids: both classes, both date
    // bindings, and the meeting→event extends edge.
    expect(fx.client.getNodeRaw(EVENT_CLASS_ID)?.isClass).toBe(true);
    expect(fx.client.getNodeRaw(MEETING_CLASS_ID)?.isClass).toBe(true);
    expect(fx.client.getClassParents(MEETING_CLASS_ID)).toContain(EVENT_CLASS_ID);
    expect(
      fx.client.getClassBindings(EVENT_CLASS_ID).map((binding) => binding.propertySchemaId),
    ).toContain(SYSTEM_PROPERTY_UUIDS.eventDate);
    expect(
      fx.client.getClassBindings(MEETING_CLASS_ID).map((binding) => binding.propertySchemaId),
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
    for (const id of fx.reunionMembers) {
      expect(
        fx.client.getNodeRaw(id)?.classIds.filter((classId) => classId === MEETING_CLASS_ID),
      ).toHaveLength(1);
    }
    for (const id of fx.eventoMembers) {
      expect(
        fx.client.getNodeRaw(id)?.classIds.filter((classId) => classId === EVENT_CLASS_ID),
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
