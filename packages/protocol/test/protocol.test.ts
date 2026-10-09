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

describe("canonical fixtures (SCHEMA.md gate)", () => {
  const fixtures = loadFixtures();

  it("has exactly the twenty-five required fixtures", () => {
    const names = fixtures.map((f) => f.name).sort();
    expect(names).toEqual([
      "class-convert.json",
      "class-delete-managed.json",
      "class-extends-cycle.json",
      "class-extends-m2m.json",
      "class-property-active.json",
      "class-property-defaults.json",
      "class-unassign.json",
      "code-block.json",
      "embed-ref-view.json",
      "envelope-minimal.json",
      "hr.json",
      "object-color.json",
      "object-create.json",
      "object-move-before.json",
      "object-move.json",
      "object-restore.json",
      "object-wire-fields.json",
      "property-asset-type.json",
      "property-date-qualifier.json",
      "property-datetime.json",
      "property-set-lww.json",
      "property-value-elements.json",
      "typed-link-mark-deleted.json",
      "typed-link-mark.json",
      "workspace-feature-set.json",
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

  it("object-wire-fields fixture exercises the node wire fields through set + clear", () => {
    const fixture = fixtures.find((f) => f.name === "object-wire-fields.json")!;
    const page = "0192a000-0000-7000-8000-00000000052a";
    const asset = "0192a000-0000-7000-8000-00000000052b";
    const main = "0192a000-0000-7000-8000-00000000052c";
    const updates = fixture.envelopes.filter((env) => env.opType === "object.update");
    expect(updates.map((env) => env.payload as Record<string, unknown>)).toEqual([
      { objectId: page, coverAssetId: asset },
      { objectId: page, bannerAssetId: asset, aliasedNodeId: main },
      { objectId: page, aliasedNodeId: null },
      { objectId: page, coverAssetId: null },
      { objectId: page, bannerAssetId: null },
      { objectId: page, description: "Subtitle text" },
      { objectId: page, description: null },
    ]);
    // Strict schema: a non-uuid reference is rejected outright, and so is
    // every field on object.create (the fields are object.update-only).
    for (const key of ["coverAssetId", "bannerAssetId", "aliasedNodeId"]) {
      expect(
        objectUpdatePayload.safeParse({ objectId: page, [key]: "not-a-uuid" }).success,
      ).toBe(false);
      expect(
        payloadSchemaFor("object.create")!.safeParse({ objectId: page, [key]: asset }).success,
      ).toBe(false);
    }
    // The description is the page-subtitle wire field: object.update-only,
    // plain text with a hard 512-char cap.
    expect(
      payloadSchemaFor("object.create")!.safeParse({ objectId: page, description: "x" }).success,
    ).toBe(false);
    expect(
      objectUpdatePayload.safeParse({ objectId: page, description: "x".repeat(513) }).success,
    ).toBe(false);
    expect(
      objectUpdatePayload.safeParse({ objectId: page, description: null }).success,
    ).toBe(true);
    // Applicable in sequence: HLCs strictly ascend.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("class-convert fixture exercises the declaration capability on existing nodes", () => {
    const fixture = fixtures.find((f) => f.name === "class-convert.json")!;
    const page = "0192a000-0000-7000-8000-00000000053a";
    const shelf = "0192a000-0000-7000-8000-00000000053c";
    const fresh = "0192a000-0000-7000-8000-00000000053d";
    const creates = fixture.envelopes.filter((env) => env.opType === "class.create");
    expect(creates.map((env) => (env.payload as { classId: string }).classId)).toEqual([
      page,
      shelf,
      page,
      fresh,
    ]);
    // Conversion carries NO content — the node's existing title is the
    // class's title (title-is-content; the payload schema already accepts a
    // bare id, so the capability is applier semantics, not a new key).
    expect(creates[0]!.payload).toEqual({ classId: page });
    expect(creates[3]!.payload).toMatchObject({ classId: fresh, contentAst: [{ type: "text", text: "Fresh genre" }] });
    // Strict schema: an unknown declaration key is rejected outright.
    expect(
      payloadSchemaFor("class.create")!.safeParse({ classId: page, isClass: true }).success,
    ).toBe(false);
    // Applicable in sequence: HLCs strictly ascend.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("property-asset-type fixture exercises the asset property type through create + update", () => {
    const fixture = fixtures.find((f) => f.name === "property-asset-type.json")!;
    const creates = fixture.envelopes.filter((env) => env.opType === "propertySchema.create");
    expect(creates.map((env) => (env.payload as { type: string }).type)).toEqual([
      "asset",
      "asset",
    ]);
    expect(creates[0]!.payload).toMatchObject({ multi: true, scope: "class" });
    expect(creates[1]!.payload).toMatchObject({ multi: false, scope: "object" });
    // The update coexists with an asset-typed schema (type rides create only).
    const update = fixture.envelopes.find((env) => env.opType === "propertySchema.update")!;
    expect(update.payload).toEqual({
      propertySchemaId: "0192a000-0000-7000-8000-000000000542",
      name: "Cover file (renamed)",
    });
    // Strict schema: an unknown property type is rejected outright (the
    // "asset" enum value is the only addition).
    expect(
      payloadSchemaFor("propertySchema.create")!.safeParse({
        propertySchemaId: "0192a000-0000-7000-8000-000000000541",
        name: "x",
        type: "file",
      }).success,
    ).toBe(false);
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

  it("workspace-feature-set fixture races the (workspace, feature) slot; the higher-HLC disable wins", () => {
    const fixture = fixtures.find((f) => f.name === "workspace-feature-set.json")!;
    const tasks = fixture.envelopes.filter(
      (env) => (env.payload as { feature: string }).feature === "tasks",
    );
    expect(tasks.map((env) => (env.payload as { enabled: boolean }).enabled)).toEqual([
      true,
      false,
    ]);
    const hlcA = tasks[0]!.hlc as { physical: number; logical: number };
    const hlcB = tasks[1]!.hlc as { physical: number; logical: number };
    expect(compareHlc(hlcA, hlcB)).toBeLessThan(0);
    // The core families (owner reshape): a single events disable…
    const events = fixture.envelopes.filter(
      (env) => (env.payload as { feature: string }).feature === "events",
    );
    expect(events.map((env) => (env.payload as { enabled: boolean }).enabled)).toEqual([false]);
    // …and a sources off→on pair — the re-enable is the winner.
    const sources = fixture.envelopes.filter(
      (env) => (env.payload as { feature: string }).feature === "sources",
    );
    expect(sources.map((env) => (env.payload as { enabled: boolean }).enabled)).toEqual([
      false,
      true,
    ]);
    // Applicable in sequence: every HLC strictly follows the previous one.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
    // Strict schema: a retired pre-reshape feature id is rejected outright.
    expect(
      payloadSchemaFor("workspace.feature.set")!.safeParse({ feature: "journals", enabled: false })
        .success,
    ).toBe(false);
    expect(
      payloadSchemaFor("workspace.feature.set")!.safeParse({ feature: "spreadsheets", enabled: true })
        .success,
    ).toBe(false);
  });

  it("class-delete-managed fixture: the delete addresses the seeded task class (F4 routing target)", () => {
    const fixture = fixtures.find((f) => f.name === "class-delete-managed.json")!;
    const [create, member, del, reenable] = fixture.envelopes;
    expect(create!.opType).toBe("class.create");
    expect((create!.payload as { classId: string }).classId).toBe(
      "00000000-0000-0000-0001-000000000012",
    );
    expect((member!.payload as { classIds: string[] }).classIds).toEqual([
      "00000000-0000-0000-0001-000000000012",
    ]);
    expect(del!.opType).toBe("class.delete");
    expect(reenable!.opType).toBe("workspace.feature.set");
    expect((reenable!.payload as { feature: string; enabled: boolean })).toEqual({
      feature: "tasks",
      enabled: true,
    });
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("code-block fixture: the token survives promotion stringification (survivor set)", () => {
    const fixture = fixtures.find((f) => f.name === "code-block.json")!;
    const blockCreate = fixture.envelopes[1]!;
    const ast = contentAstSchema.parse((blockCreate.payload as { contentAst: unknown }).contentAst);
    expect(ast[1]).toEqual({
      type: "code_block",
      language: "python",
      text: "print('hi')\nprint('bye')",
    });
    // The promotion is the third envelope: presentAsMain true on the block.
    expect(fixture.envelopes[2]!.payload).toMatchObject({ presentAsMain: true });
    // A language-less code_block is legal (plain text default).
    const plain = fixture.envelopes[3]!;
    expect((plain.payload as { contentAst: unknown[] }).contentAst).toEqual([
      { type: "code_block", text: "plain snippet" },
    ]);
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("hr fixture: the token rides inline blocks and flattens away on promotion", () => {
    const fixture = fixtures.find((f) => f.name === "hr.json")!;
    const blockCreate = fixture.envelopes[1]!;
    const ast = contentAstSchema.parse((blockCreate.payload as { contentAst: unknown }).contentAst);
    expect(ast.map((token) => token.type)).toEqual(["text", "hr", "text"]);
    expect(fixture.envelopes[2]!.payload).toMatchObject({ presentAsMain: true });
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("embed-ref-view fixture: absent view = default embed; card views ride the token", () => {
    const fixture = fixtures.find((f) => f.name === "embed-ref-view.json")!;
    const update = fixture.envelopes[3]!;
    const ast = contentAstSchema.parse((update.payload as { contentAst: unknown }).contentAst);
    expect(ast[0]).toEqual({
      type: "embed_ref",
      nodeId: "0192a000-0000-7000-8000-000000000640",
    });
    expect(ast[1]).toEqual({
      type: "embed_ref",
      nodeId: "0192a000-0000-7000-8000-000000000640",
      view: "wide_card",
    });
    // Strict schema: a foreign view value is rejected outright.
    expect(
      contentAstSchema.safeParse([
        { type: "embed_ref", nodeId: "0192a000-0000-7000-8000-000000000640", view: "huge" },
      ]).success,
    ).toBe(false);
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("code_block and hr strict schemas reject unknown keys and bad shapes", () => {
    expect(
      contentAstSchema.safeParse([{ type: "code_block", text: "x", theme: "dark" }]).success,
    ).toBe(false);
    expect(contentAstSchema.safeParse([{ type: "code_block" }]).success).toBe(false);
    expect(
      contentAstSchema.safeParse([{ type: "code_block", language: "PyThOn", text: "x" }]).success,
    ).toBe(false);
    expect(contentAstSchema.safeParse([{ type: "hr", color: "red" }]).success).toBe(false);
  });

  it("property-value-elements fixture: same-idx element adds coexist; remove + re-add ride the OR-Set", () => {
    const fixture = fixtures.find((f) => f.name === "property-value-elements.json")!;
    const sets = fixture.envelopes.filter((env) => env.opType === "property.set");
    const unsets = fixture.envelopes.filter((env) => env.opType === "property.unset");
    const withId = sets.filter((env) => "elementId" in (env.payload as object));
    const positional = sets.filter((env) => !("elementId" in (env.payload as object)));
    // Three element adds with DISTINCT ids…
    expect(withId.map((env) => (env.payload as { elementId: string }).elementId)).toEqual([
      "0192a000-0000-7000-8000-000000000721",
      "0192a000-0000-7000-8000-000000000722",
      "0192a000-0000-7000-8000-000000000723",
      // …the last two sharing idx 1 (concurrent adds — both must survive)…
      "0192a000-0000-7000-8000-000000000722",
    ]);
    // …and one legacy positional add (no elementId — the pre-PG5 carrier).
    expect(positional.map((env) => (env.payload as { idx: number }).idx)).toEqual([4]);
    expect(
      withId
        .slice(1, 3)
        .map((env) => (env.payload as { idx: number }).idx),
    ).toEqual([1, 1]);
    // The unset addresses the element, not a position.
    expect(unsets).toHaveLength(1);
    expect(unsets[0]!.payload).toMatchObject({
      elementId: "0192a000-0000-7000-8000-000000000722",
    });
    // Strict schema: a malformed element id is rejected outright.
    expect(
      payloadSchemaFor("property.set")!.safeParse({
        objectId: "0192a000-0000-7000-8000-000000000712",
        propertySchemaId: "0192a000-0000-7000-8000-000000000711",
        value: "x",
        elementId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      payloadSchemaFor("property.unset")!.safeParse({
        objectId: "0192a000-0000-7000-8000-000000000712",
        propertySchemaId: "0192a000-0000-7000-8000-000000000711",
        elementId: "not-a-uuid",
      }).success,
    ).toBe(false);
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("class-property-active fixture: the disable wins the row LWW race; authored value survives inert", () => {
    const fixture = fixtures.find((f) => f.name === "class-property-active.json")!;
    const flips = fixture.envelopes.filter((env) => env.opType === "class.property.set");
    // Binding → enable (lower HLC, race loser) → disable (newer, winner) →
    // authored value → re-enable. The active flag rides the row LWW.
    expect(flips.map((env) => (env.payload as { active?: boolean }).active)).toEqual([
      undefined,
      true,
      false,
      true,
    ]);
    const hlcA = flips[1]!.hlc as { physical: number; logical: number };
    const hlcB = flips[2]!.hlc as { physical: number; logical: number };
    expect(compareHlc(hlcA, hlcB)).toBeLessThan(0);
    // Strict schema: a non-boolean active is rejected outright.
    expect(
      payloadSchemaFor("class.property.set")!.safeParse({
        classId: "0192a000-0000-7000-8000-000000000742",
        propertySchemaId: "0192a000-0000-7000-8000-000000000741",
        active: "yes",
      }).success,
    ).toBe(false);
    // Display moved OFF the binding — it is a retired key there,
    // rejected by the strict schema like nodeType.
    expect(
      payloadSchemaFor("class.property.set")!.safeParse({
        classId: "0192a000-0000-7000-8000-000000000742",
        propertySchemaId: "0192a000-0000-7000-8000-000000000741",
        display: "bullet",
      }).success,
    ).toBe(false);
    expect(
      payloadSchemaFor("class.property.set")!.safeParse({
        classId: "0192a000-0000-7000-8000-000000000742",
        propertySchemaId: "0192a000-0000-7000-8000-000000000741",
        hideWhenEmpty: true,
      }).success,
    ).toBe(false);
    // The fixture's display write rides propertySchema.update instead.
    const displayUpdate = fixture.envelopes.find((env) => env.opType === "propertySchema.update")!;
    expect(displayUpdate).toBeDefined();
    expect(displayUpdate.payload).toEqual({
      propertySchemaId: "0192a000-0000-7000-8000-000000000741",
      display: "bullet",
    });
    // The schema op accepts the three values, rejects the unknown one, and
    // treats null as clear (the keep/clear contract).
    for (const value of ["panel", "bullet", "inline", null]) {
      expect(
        payloadSchemaFor("propertySchema.update")!.safeParse({
          propertySchemaId: "0192a000-0000-7000-8000-000000000741",
          display: value,
        }).success,
      ).toBe(true);
    }
    expect(
      payloadSchemaFor("propertySchema.update")!.safeParse({
        propertySchemaId: "0192a000-0000-7000-8000-000000000741",
        display: "hover",
      }).success,
    ).toBe(false);
    // The fixture's options carry the icon in the color grammar.
    const create = fixture.envelopes.find((env) => env.opType === "propertySchema.create")!;
    expect((create.payload as { options: Array<Record<string, unknown>> }).options[0]).toEqual({
      id: "opt-a",
      label: "A",
      icon: "mdiCircle",
      color: "yellow",
    });
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("property-date-qualifier fixture: refs ride the chain; the legacy string normalizes on write", () => {
    const fixture = fixtures.find((f) => f.name === "property-date-qualifier.json")!;
    const sets = fixture.envelopes.filter((env) => env.opType === "property.set");
    expect(sets).toHaveLength(2);
    // idx 0: canonical date-node refs through the year/month/day chain.
    expect((sets[0]!.payload as { metadata: unknown }).metadata).toEqual({
      startDate: { nodeId: "00000000-0000-0000-00dd-202003040000" },
      endDate: { nodeId: "00000000-0000-0000-00dd-202205060000" },
    });
    // idx 1: the legacy ISO string (the applier normalizes it to the
    // deterministic day-node ref — pinned by the store suite).
    expect((sets[1]!.payload as { metadata: unknown }).metadata).toEqual({
      startDate: "2019-01-15",
    });
    // The chain nodes exist (year/month/day for both qualifier dates).
    const created = new Set(
      fixture.envelopes
        .filter((env) => env.opType === "object.create")
        .map((env) => (env.payload as { objectId: string }).objectId),
    );
    for (const id of [
      "00000000-0000-0000-00bb-202000000000",
      "00000000-0000-0000-00aa-202003000000",
      "00000000-0000-0000-00dd-202003040000",
      "00000000-0000-0000-00bb-202200000000",
      "00000000-0000-0000-00aa-202205000000",
      "00000000-0000-0000-00dd-202205060000",
      "00000000-0000-0000-00bb-201900000000",
      "00000000-0000-0000-00aa-201901000000",
      "00000000-0000-0000-00dd-201901150000",
    ]) {
      expect(created.has(id), id).toBe(true);
    }
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
  });

  it("property-datetime fixture exercises the unified datetime value union end to end", () => {
    const fixture = fixtures.find((f) => f.name === "property-datetime.json")!;
    const creates = fixture.envelopes.filter((env) => env.opType === "propertySchema.create");
    // Day-precision default schema + a year-precision schema.
    expect(creates.map((env) => (env.payload as { type: string }).type)).toEqual([
      "datetime",
      "datetime",
    ]);
    expect(creates[0]!.payload).toMatchObject({
      propertySchemaId: "0192a000-0000-7000-8000-000000000810",
      name: "When",
    });
    expect(creates[1]!.payload).toMatchObject({
      propertySchemaId: "0192a000-0000-7000-8000-000000000811",
      name: "Year",
      datePrecision: "year",
    });
    // Strict schema: the retired date/date_range types are rejected outright.
    for (const retired of ["date", "date_range"]) {
      expect(
        payloadSchemaFor("propertySchema.create")!.safeParse({
          propertySchemaId: "0192a000-0000-7000-8000-000000000810",
          name: "x",
          type: retired,
        }).success,
      ).toBe(false);
    }
    // The value writes: full-day point, timed point, open range, timed range
    // end, year-precision point — every referenced chain node created first.
    const sets = fixture.envelopes.filter((env) => env.opType === "property.set");
    expect(sets.map((env) => (env.payload as { value: unknown }).value)).toEqual([
      { nodeId: "00000000-0000-0000-00dd-202407260000" },
      { nodeId: "00000000-0000-0000-00dd-202407260000", time: "14:30" },
      { start: { nodeId: "00000000-0000-0000-00dd-202407260000" }, end: null },
      {
        start: { nodeId: "00000000-0000-0000-00dd-202407260000" },
        end: { nodeId: "00000000-0000-0000-00dd-202408020000", time: "09:15" },
      },
      { nodeId: "00000000-0000-0000-00bb-202400000000" },
    ]);
    expect((sets[4]!.payload as { propertySchemaId: string }).propertySchemaId).toBe(
      "0192a000-0000-7000-8000-000000000811",
    );
    const created = new Set(
      fixture.envelopes
        .filter((env) => env.opType === "object.create")
        .map((env) => (env.payload as { objectId: string }).objectId),
    );
    for (const id of [
      "00000000-0000-0000-00bb-202400000000",
      "00000000-0000-0000-00aa-202407000000",
      "00000000-0000-0000-00dd-202407260000",
      "00000000-0000-0000-00aa-202408000000",
      "00000000-0000-0000-00dd-202408020000",
    ]) {
      expect(created.has(id), id).toBe(true);
    }
    // Applicable in sequence: HLCs strictly ascend.
    const hlcs = fixture.envelopes.map((env) => (env.hlc as { physical: number }).physical);
    expect([...hlcs].sort((x, y) => x - y)).toEqual(hlcs);
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

  it("accepts the encryption slot without interpreting it", () => {
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

describe("property schema dates (SCHEMA.md \"Datetime\")", () => {
  const create = payloadSchemaFor("propertySchema.create")!;
  const update = payloadSchemaFor("propertySchema.update")!;

  it("propertySchema.create accepts optional datePrecision/dateQualified", () => {
    const base = {
      propertySchemaId: "0192a000-0000-7000-8000-0000000000d1",
      name: "founded",
      type: "datetime",
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
