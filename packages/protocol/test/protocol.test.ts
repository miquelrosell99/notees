import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Clock,
  compareHlc,
  contentAstSchema,
  envelopeSchema,
  extractTypedLinkMarks,
  KNOWN_OP_TYPES,
  newEnvelope,
  objectUpdatePayload,
  payloadSchemaFor,
  PROTOCOL_VERSION,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

interface FixtureFile {
  name: string;
  envelopes: Record<string, unknown>[];
}

function loadFixtures(): FixtureFile[] {
  return readdirSync(fixturesDir, { encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Record<
        string,
        unknown
      >;
      const envelopes = Array.isArray(raw.envelopes)
        ? (raw.envelopes as Record<string, unknown>[])
        : [raw];
      return { name, envelopes };
    });
}

describe("canonical fixtures (SCHEMA.md / 00-INDEX gate)", () => {
  const fixtures = loadFixtures();

  it("has exactly the thirteen required fixtures", () => {
    const names = fixtures.map((f) => f.name).sort();
    expect(names).toEqual([
      "class-extends-cycle.json",
      "class-extends-m2m.json",
      "class-property-defaults.json",
      "class-unassign.json",
      "envelope-minimal.json",
      "object-color.json",
      "object-create.json",
      "object-move-before.json",
      "object-move.json",
      "object-restore.json",
      "property-set-lww.json",
      "typed-link-mark-deleted.json",
      "typed-link-mark.json",
    ]);
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      for (const [i, raw] of fixture.envelopes.entries()) {
        it(`envelope ${i} matches the v3 envelope schema`, () => {
          const parsed = envelopeSchema.safeParse(raw);
          expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
        });

        it(`envelope ${i} has a known opType and a valid payload`, () => {
          const opType = raw.opType as string;
          expect(KNOWN_OP_TYPES).toContain(opType);
          const schema = payloadSchemaFor(opType);
          expect(schema).toBeDefined();
          const parsed = schema!.safeParse(raw.payload);
          expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
        });
      }
    });
  }

  it("typed-link-mark carries a verb mark with locator and record-don't-resolve spans", () => {
    const fixture = fixtures.find((f) => f.name === "typed-link-mark.json")!;
    const payload = fixture.envelopes[0]!.payload as {
      contentAst: unknown;
    };
    const ast = contentAstSchema.parse(payload.contentAst);
    const marks = extractTypedLinkMarks(ast);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      verb: "cites",
      text: "cites",
      metadata: { locator: "p. 42", candidateSpans: ["tok_3", "tok_7"] },
    });
  });

  it("typed-link-mark-deleted removes the mark with its word (honest lifecycle)", () => {
    const fixture = fixtures.find((f) => f.name === "typed-link-mark-deleted.json")!;
    const payload = fixture.envelopes[0]!.payload as { contentAst: unknown };
    const ast = contentAstSchema.parse(payload.contentAst);
    expect(extractTypedLinkMarks(ast)).toHaveLength(0);
  });

  it("property-set-lww races the same slot; higher HLC is the LWW winner", () => {
    const fixture = fixtures.find((f) => f.name === "property-set-lww.json")!;
    const [a, b] = fixture.envelopes;
    const pa = a!.payload as { propertySchemaId: string; idx: number; value: { nodeId: string } };
    const pb = b!.payload as { propertySchemaId: string; idx: number; value: { nodeId: string } };
    expect(pa.propertySchemaId).toBe(pb.propertySchemaId);
    expect(pa.idx).toBe(pb.idx);
    expect(pa.value.nodeId).not.toBe(pb.value.nodeId);
    const hlcA = (a!.hlc as { physical: number; logical: number }) ?? { physical: 0, logical: 0 };
    const hlcB = (b!.hlc as { physical: number; logical: number }) ?? { physical: 0, logical: 0 };
    expect(compareHlc(hlcA, hlcB)).toBeLessThan(0);
  });

  it("object-color fixture exercises the full color grammar: token, hex, clear, class clear", () => {
    const fixture = fixtures.find((f) => f.name === "object-color.json")!;
    const updates = fixture.envelopes.filter((env) => env.opType === "object.update");
    expect(updates.map((env) => (env.payload as { color: unknown }).color)).toEqual([
      "sky",
      "#123abc",
      null,
    ]);
    const classOps = fixture.envelopes.filter(
      (env) => env.opType === "class.create" || env.opType === "class.update",
    );
    expect(classOps.map((env) => (env.payload as { color: unknown }).color)).toEqual(["pink", null]);
    // Retired CSS-variable encoding is rejected outright by the strict schema.
    const legacy = objectUpdatePayload.safeParse({
      objectId: "0192a000-0000-7000-8000-0000000000f2",
      color: "var(--color-preset-red)",
    });
    expect(legacy.success).toBe(false);
    // Long garbage strings no longer slip through as "colors" either.
    const garbage = objectUpdatePayload.safeParse({
      objectId: "0192a000-0000-7000-8000-0000000000f2",
      color: "not-a-color",
    });
    expect(garbage.success).toBe(false);
    // Applicable in sequence: HLCs strictly ascend.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("object-move fixture reparents C under A and reorders B after A within P", () => {
    const fixture = fixtures.find((f) => f.name === "object-move.json")!;
    const p = "0192a000-0000-7000-8000-000000000020";
    const a = "0192a000-0000-7000-8000-000000000021";
    const b = "0192a000-0000-7000-8000-000000000022";
    const c = "0192a000-0000-7000-8000-000000000023";
    const moves = fixture.envelopes.filter((env) => env.opType === "object.move");
    expect(moves).toHaveLength(2);
    expect(moves[0]!.payload).toMatchObject({ objectId: c, parentId: a });
    expect(moves[1]!.payload).toMatchObject({ objectId: b, parentId: p, afterId: a });
    // Applicable in sequence: move HLCs strictly follow every create HLC.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("class-property-defaults binds priority on Task and Project, aggregates on the node, and unsets Task's binding last", () => {
    const fixture = fixtures.find((f) => f.name === "class-property-defaults.json")!;
    const [schema, task, project, node, taskBinding, projectBinding, assignProject, unsetTask] =
      fixture.envelopes;
    const priority = "0192a000-0000-7000-8000-000000000301";
    const nodePayload = node!.payload as { objectId: string };
    const taskPayload = task!.payload as { classId: string };
    expect(schema!.opType).toBe("propertySchema.create");
    expect(task!.payload).toMatchObject({ contentAst: [{ type: "text", text: "Task" }] });
    expect(project!.payload).toMatchObject({ contentAst: [{ type: "text", text: "Project" }] });
    // The node is created with Task, then Project is assigned via the OR-Set
    // add carrier (a re-issued object.create on the same id).
    expect(node!.opType).toBe("object.create");
    expect(assignProject!.opType).toBe("object.create");
    expect(assignProject!.payload).toMatchObject({ objectId: nodePayload.objectId });
    // Both bindings carry defaults; Task's unset is the final envelope.
    expect(taskBinding!.payload).toMatchObject({
      propertySchemaId: priority,
      defaultValue: "medium",
    });
    expect(projectBinding!.payload).toMatchObject({
      propertySchemaId: priority,
      defaultValue: "high",
    });
    expect(unsetTask!.opType).toBe("class.property.unset");
    expect(unsetTask!.payload).toMatchObject({
      classId: taskPayload.classId,
      propertySchemaId: priority,
    });
    // Applicable in sequence: every HLC strictly follows the previous one.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("class-unassign fixture: binds two defaults, authors one value, unassigns, then re-assigns", () => {
    const fixture = fixtures.find((f) => f.name === "class-unassign.json")!;
    const [effort, impact, task, node, effortBinding, impactBinding, authored, unassign, reassign] =
      fixture.envelopes;
    const effortSchema = "0192a000-0000-7000-8000-000000000410";
    const impactSchema = "0192a000-0000-7000-8000-000000000411";
    const taskId = "0192a000-0000-7000-8000-000000000412";
    const nodeId = "0192a000-0000-7000-8000-000000000413";
    expect(effort!.opType).toBe("propertySchema.create");
    expect(impact!.opType).toBe("propertySchema.create");
    // The node is created classed with Task; Task binds 'effort' (default 'xs')
    // and 'impact' (default 'xl'); impact is then AUTHORED at idx 0 (shadowing
    // the default) so the unassign can pin both read outcomes on one node.
    expect(node!.opType).toBe("object.create");
    expect(node!.payload).toMatchObject({ objectId: nodeId, classIds: [taskId] });
    expect(effortBinding!.payload).toMatchObject({
      classId: taskId,
      propertySchemaId: effortSchema,
      defaultValue: "xs",
    });
    expect(impactBinding!.payload).toMatchObject({
      classId: taskId,
      propertySchemaId: impactSchema,
      defaultValue: "xl",
    });
    expect(authored!.opType).toBe("property.set");
    expect(authored!.payload).toMatchObject({
      objectId: nodeId,
      propertySchemaId: impactSchema,
      value: "authored",
    });
    // The OR-Set remove is the class.unassign envelope…
    expect(unassign!.opType).toBe("class.unassign");
    expect(unassign!.payload).toMatchObject({ objectId: nodeId, classId: taskId });
    // …and the final re-issued object.create re-assigns Task (add-wins with a
    // newer HLC), so a replay restores the derived default end to end.
    expect(reassign!.opType).toBe("object.create");
    expect(reassign!.payload).toMatchObject({ objectId: nodeId, classIds: [taskId] });
    // Applicable in sequence: every HLC strictly follows the previous one.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("no fixture payload carries a relation op or seeded relation vocabulary", () => {
    for (const fixture of fixtures) {
      for (const env of fixture.envelopes) {
        expect(String(env.opType)).not.toMatch(/^relation\./);
      }
    }
  });
});

describe("envelope v3", () => {
  it("rejects a missing protocolVersion", () => {
    const raw = {
      id: "0192a000-0000-7000-8000-0000000000ff",
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "dev",
      hlc: { physical: 1, logical: 0 },
      affectedNodeIds: [],
      opType: "object.create",
      timestamp: "2026-09-24T12:00:00.000Z",
      payload: {},
    };
    expect(envelopeSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects the retired protocolVersion 2", () => {
    const raw = {
      id: "0192a000-0000-7000-8000-0000000000ff",
      protocolVersion: 2,
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "dev",
      hlc: { physical: 1, logical: 0 },
      affectedNodeIds: [],
      opType: "object.create",
      timestamp: "2026-09-24T12:00:00.000Z",
      payload: {},
    };
    expect(envelopeSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects the retired nodeType key on object.create and object.update (no wire compat)", () => {
    // Revision 11 retires nodeType outright; old stored logs are rewritten
    // by the one-time migration script — payloads carrying it must fail.
    const createParsed = payloadSchemaFor("object.create")!.safeParse({
      objectId: "0192a000-0000-7000-8000-000000000010",
      nodeType: "page",
      parentId: null,
    });
    expect(createParsed.success).toBe(false);
    const updateParsed = payloadSchemaFor("object.update")!.safeParse({
      objectId: "0192a000-0000-7000-8000-000000000010",
      nodeType: "page",
    });
    expect(updateParsed.success).toBe(false);
  });

  it("accepts the M3 encryption slot without interpreting it", () => {
    const env = newEnvelope({
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "dev",
      hlc: { physical: 1, logical: 0 },
      opType: "object.create",
      payload: { $e: { iv: "aa", ct: "bb" } },
    });
    expect(env.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it("stamps uuidv7 ids and provenance claims", () => {
    const env = newEnvelope({
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "laptop",
      client: "agent:scout",
      hlc: { physical: 1, logical: 0 },
      opType: "property.set",
      payload: {},
    });
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.client).toBe("agent:scout");
    expect(env.deviceId).toBe("laptop");
  });

  it("object.update rejects two simultaneous content carriers", () => {
    const schema = payloadSchemaFor("object.update")!;
    const parsed = schema.safeParse({
      objectId: "0192a000-0000-7000-8000-000000000010",
      contentAst: [],
      contentDeltaB64: "AA==",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("property schema dates (SCHEMA.md \"Dates\")", () => {
  const create = payloadSchemaFor("propertySchema.create")!;
  const update = payloadSchemaFor("propertySchema.update")!;

  it("propertySchema.create accepts optional datePrecision/dateQualified", () => {
    const base = {
      propertySchemaId: "0192a000-0000-7000-8000-0000000000d1",
      name: "founded",
      type: "date",
    };
    expect(create.safeParse(base).success).toBe(true);
    const full = create.safeParse({ ...base, datePrecision: "year", dateQualified: true });
    expect(full.success).toBe(true);
    if (full.success) {
      expect(full.data.datePrecision).toBe("year");
      expect(full.data.dateQualified).toBe(true);
    }
    // Absent stays absent (the read model applies the day/not-qualified defaults).
    const bare = create.safeParse(base);
    expect(bare.success && bare.data.datePrecision).toBeUndefined();
    // Invalid precision values fail loud.
    expect(create.safeParse({ ...base, datePrecision: "decade" }).success).toBe(false);
  });

  it("propertySchema.update patches datePrecision/dateQualified", () => {
    const parsed = update.safeParse({
      propertySchemaId: "0192a000-0000-7000-8000-0000000000d1",
      datePrecision: "month",
      dateQualified: false,
    });
    expect(parsed.success).toBe(true);
    expect(update.safeParse({ propertySchemaId: "0192a000-0000-7000-8000-0000000000d1" }).success).toBe(
      true,
    );
  });
});

describe("HLC clock", () => {
  it("is monotonic within a device", () => {
    const clock = new Clock("dev");
    const a = clock.now(1000);
    const b = clock.now(1000);
    const c = clock.now(999);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, c)).toBeLessThan(0);
  });

  it("merges received clocks without going backwards", () => {
    const clock = new Clock("dev");
    clock.now(1000);
    const merged = clock.update({ physical: 2000, logical: 5 }, 1500);
    expect(merged.physical).toBe(2000);
    expect(merged.logical).toBeGreaterThanOrEqual(6);
    const next = clock.now(2000);
    expect(compareHlc(next, merged)).toBeGreaterThan(0);
  });
});
