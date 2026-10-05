// @vitest-environment node
/**
 * The session undo journal (§34.63) — two layers:
 *
 *  1. Unit tests over the pure pieces: invertEnvelope's full inversion
 *     matrix (a fake capture source answers the pre-apply questions), the
 *     journal mechanics (stacks, redo clearing, bounds, coalescing with a
 *     fake clock, batch grouping, labels), and the honest skip list.
 *  2. Integration tests through a real WorkspaceClient (sql.js +
 *     MemoryTransport): every write family round-trips write → undo → redo
 *     against the actual store, and the multi-tab honesty (a second client
 *     has its own, empty journal) holds.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  invertEnvelope,
  UndoJournal,
  type UndoCaptureSource,
  type UndoNodeSnapshot,
  type UndoSchemaSnapshot,
} from "../src/core/undo-journal.js";

const ACTOR = "0192a000-0000-7000-8000-000000000002";
const WS = "0192a000-0000-7000-8000-000000000001";
const NODE = "0192a000-0000-7000-8000-0000000000a1";
const OTHER = "0192a000-0000-7000-8000-0000000000a2";
const CLASS_A = "0192a000-0000-7000-8000-0000000000c1";
const CLASS_B = "0192a000-0000-7000-8000-0000000000c2";
const TAG = "0192a000-0000-7000-8000-0000000000b1";
const SCHEMA = "0192a000-0000-7000-8000-0000000000d1";

function env(opType: string, payload: Record<string, unknown>): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: [],
    opType,
    payload,
  });
}

/** A mutable fake store the capture source answers from — set the pre-op
 *  facts, then call invertEnvelope/prepare exactly like the real seam does.
 *  Explicit null means "row absent" (distinct from omitting the override). */
function fakeCapture(overrides: {
  node?: UndoNodeSnapshot | null;
  placement?: { parentId: string | null; afterId: string | null; beforeId: string | null } | null;
  property?: {
    elementId: string;
    idx: number;
    value: unknown;
    metadata: Record<string, unknown> | null;
  } | null;
  binding?: {
    sequence: number;
    required: boolean | null;
    defaultValue: unknown;
    active: boolean;
  } | null;
  parents?: string[];
  schema?: Partial<UndoSchemaSnapshot> | null;
  description?: string | null;
  asset?: {
    assetId: string;
    hash: string;
    mimeType: string;
    size: number;
    originalName: string;
  } | null;
  member?: boolean;
  feature?: boolean;
}): UndoCaptureSource {
  const defaultNode: UndoNodeSnapshot = {
    presentAsMain: false,
    icon: null,
    color: null,
    contentAst: [{ type: "text", text: "before" }],
    classIds: [CLASS_A],
    tagIds: [TAG],
    active: true,
  };
  const node: UndoNodeSnapshot | null =
    overrides.node !== undefined ? overrides.node : defaultNode;
  const defaultPlacement = { parentId: OTHER, afterId: null, beforeId: null };
  const defaultSchema = {
    name: "Status",
    type: "select",
    multi: false,
    scope: "global",
    options: [],
    targetClassFilter: null,
    datePrecision: null,
    dateQualified: null,
    display: null,
    readonly: null,
    hideWhenEmpty: null,
  };
  return {
    nodeSnapshot: () => node,
    nodePlacement: () =>
      overrides.placement !== undefined ? overrides.placement : defaultPlacement,
    classDescription: () => overrides.description ?? null,
    propertyValue: () => (overrides.property !== undefined ? overrides.property : null),
    classBinding: () => (overrides.binding !== undefined ? overrides.binding : null),
    classParents: () => overrides.parents ?? [CLASS_B],
    schemaSnapshot: () =>
      overrides.schema !== undefined ? { ...defaultSchema, ...overrides.schema } : defaultSchema,
    assetSnapshot: () => (overrides.asset !== undefined ? overrides.asset : null),
    collectionMembership: () => overrides.member ?? false,
    featureEnabled: () => overrides.feature ?? true,
  };
}

describe("invertEnvelope — the inversion matrix", () => {
  const snapOf = (overrides: Partial<UndoNodeSnapshot> = {}): UndoNodeSnapshot => ({
    presentAsMain: false,
    icon: null,
    color: null,
    contentAst: [{ type: "text", text: "before" }],
    classIds: [CLASS_A],
    tagIds: [TAG],
    active: true,
    ...overrides,
  });

  it("fresh object.create inverts as a soft delete", () => {
    const specs = invertEnvelope(
      env("object.create", { objectId: NODE, contentAst: [] }),
      fakeCapture({ node: null }),
    );
    expect(specs).toEqual([
      { opType: "object.delete", payload: { objectId: NODE, permanent: false }, affected: [NODE] },
    ]);
  });

  it("the re-issued create (assign carrier) inverts per added membership only", () => {
    // Node already carries CLASS_A + TAG; the payload adds CLASS_B only.
    const specs = invertEnvelope(
      env("object.create", { objectId: NODE, classIds: [CLASS_A, CLASS_B], tagIds: [TAG] }),
      fakeCapture({}),
    );
    expect(specs).toEqual([
      { opType: "class.unassign", payload: { objectId: NODE, classId: CLASS_B }, affected: [NODE] },
    ]);
  });

  it("a fully redundant create carrier is a no-op (not journaled)", () => {
    expect(
      invertEnvelope(env("object.create", { objectId: NODE, classIds: [CLASS_A] }), fakeCapture({})),
    ).toBeNull();
  });

  it("object.update restores exactly the touched fields from the snapshot", () => {
    const snap = snapOf();
    const specs = invertEnvelope(
      env("object.update", { objectId: NODE, contentAst: [{ type: "text", text: "after" }], color: "sky" }),
      fakeCapture({ node: { ...snap, color: "rose" } }),
    );
    expect(specs).toEqual([
      {
        opType: "object.update",
        payload: { objectId: NODE, contentAst: snap.contentAst, color: "rose" },
        affected: [NODE],
      },
    ]);
  });

  it("object.update touching icon with a NULL prior is not journaled (no clear on the wire)", () => {
    expect(
      invertEnvelope(env("object.update", { objectId: NODE, icon: "mdi-star" }), fakeCapture({})),
    ).toBeNull();
  });

  it("soft object.delete inverts as object.restore; permanent delete is data loss (skipped)", () => {
    expect(invertEnvelope(env("object.delete", { objectId: NODE }), fakeCapture({}))).toEqual([
      { opType: "object.restore", payload: { objectId: NODE }, affected: [NODE] },
    ]);
    expect(
      invertEnvelope(env("object.delete", { objectId: NODE, permanent: true }), fakeCapture({})),
    ).toBeNull();
  });

  it("deleting an already-trashed node is a no-op (not journaled)", () => {
    const snap = snapOf();
    expect(
      invertEnvelope(
        env("object.delete", { objectId: NODE }),
        fakeCapture({ node: { ...snap, active: false } }),
      ),
    ).toBeNull();
  });

  it("object.restore inverts as a soft delete; restoring an active node is a no-op", () => {
    const snap = snapOf();
    expect(
      invertEnvelope(
        env("object.restore", { objectId: NODE }),
        fakeCapture({ node: { ...snap, active: false } }),
      ),
    ).toEqual([
      { opType: "object.delete", payload: { objectId: NODE, permanent: false }, affected: [NODE] },
    ]);
    expect(invertEnvelope(env("object.restore", { objectId: NODE }), fakeCapture({}))).toBeNull();
  });

  it("object.move restores the prior parent with the prior sibling anchor", () => {
    expect(
      invertEnvelope(
        env("object.move", { objectId: NODE, parentId: TAG }),
        fakeCapture({ placement: { parentId: OTHER, afterId: CLASS_A, beforeId: CLASS_B } }),
      ),
    ).toEqual([
      {
        opType: "object.move",
        payload: { objectId: NODE, parentId: OTHER, afterId: CLASS_A },
        affected: [NODE],
      },
    ]);
  });

  it("object.move of a former first child uses beforeId; a root node carries no anchor", () => {
    expect(
      invertEnvelope(
        env("object.move", { objectId: NODE, parentId: TAG }),
        fakeCapture({ placement: { parentId: OTHER, afterId: null, beforeId: CLASS_B } }),
      ),
    ).toEqual([
      {
        opType: "object.move",
        payload: { objectId: NODE, parentId: OTHER, beforeId: CLASS_B },
        affected: [NODE],
      },
    ]);
    expect(
      invertEnvelope(
        env("object.move", { objectId: NODE, parentId: TAG }),
        fakeCapture({ placement: { parentId: null, afterId: null, beforeId: null } }),
      ),
    ).toEqual([
      { opType: "object.move", payload: { objectId: NODE, parentId: null }, affected: [NODE] },
    ]);
  });

  it("class.unassign inverts as the add carrier; tag.unassign likewise", () => {
    expect(
      invertEnvelope(env("class.unassign", { objectId: NODE, classId: CLASS_A }), fakeCapture({})),
    ).toEqual([
      {
        opType: "object.create",
        payload: { objectId: NODE, classIds: [CLASS_A] },
        affected: [NODE],
      },
    ]);
    expect(
      invertEnvelope(env("tag.unassign", { objectId: NODE, tagId: TAG }), fakeCapture({})),
    ).toEqual([
      { opType: "object.create", payload: { objectId: NODE, tagIds: [TAG] }, affected: [NODE] },
    ]);
  });

  it("class.reorder inverts as the prior effective order", () => {
    const snap = snapOf();
    expect(
      invertEnvelope(env("class.reorder", { objectId: NODE, classIds: [CLASS_B] }), fakeCapture({ node: { ...snap, classIds: [CLASS_A, CLASS_B] } })),
    ).toEqual([
      {
        opType: "class.reorder",
        payload: { objectId: NODE, classIds: [CLASS_A, CLASS_B] },
        affected: [NODE],
      },
    ]);
  });

  it("class.setExtends inverts as the prior parent set", () => {
    expect(
      invertEnvelope(env("class.setExtends", { classId: CLASS_A, parentClassIds: [TAG] }), fakeCapture({ parents: [CLASS_B] })),
    ).toEqual([
      {
        opType: "class.setExtends",
        payload: { classId: CLASS_A, parentClassIds: [CLASS_B] },
        affected: [CLASS_A, CLASS_B],
      },
    ]);
  });

  it("class.property.set restores touched fields (a NULL flag restores as false — the applier's null→0 coercion); a first bind inverts as unset", () => {
    const binding = {
      sequence: 2,
      required: null,
      defaultValue: undefined,
      active: true,
    };
    expect(
      invertEnvelope(
        env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA, required: true, sequence: 5 }),
        fakeCapture({ binding }),
      ),
    ).toEqual([
      {
        opType: "class.property.set",
        payload: { classId: CLASS_A, propertySchemaId: SCHEMA, required: false, sequence: 2 },
        affected: [CLASS_A],
      },
    ]);
    expect(
      invertEnvelope(
        env("class.property.set", { classId: CLASS_A, propertySchemaId: SCHEMA, required: true }),
        fakeCapture({ binding: null }),
      ),
    ).toEqual([
      {
        opType: "class.property.unset",
        payload: { classId: CLASS_A, propertySchemaId: SCHEMA },
        affected: [CLASS_A],
      },
    ]);
  });

  it("class.property.unset restores the full captured row; an empty unset is a no-op", () => {
    const binding = {
      sequence: 3,
      required: true,
      defaultValue: "draft",
      active: false,
    };
    expect(
      invertEnvelope(
        env("class.property.unset", { classId: CLASS_A, propertySchemaId: SCHEMA }),
        fakeCapture({ binding }),
      ),
    ).toEqual([
      {
        opType: "class.property.set",
        payload: {
          classId: CLASS_A,
          propertySchemaId: SCHEMA,
          sequence: 3,
          required: true,
          defaultValue: "draft",
          active: false,
        },
        affected: [CLASS_A],
      },
    ]);
    expect(
      invertEnvelope(
        env("class.property.unset", { classId: CLASS_A, propertySchemaId: SCHEMA }),
        fakeCapture({ binding: null }),
      ),
    ).toBeNull();
  });

  it("class.create inverts as class.delete; class.delete itself is not invertible", () => {
    expect(invertEnvelope(env("class.create", { classId: CLASS_A }), fakeCapture({}))).toEqual([
      { opType: "class.delete", payload: { classId: CLASS_A }, affected: [CLASS_A] },
    ]);
    expect(invertEnvelope(env("class.delete", { classId: CLASS_A }), fakeCapture({}))).toBeNull();
  });

  it("property.set restores the captured row (element id carried) or unsets an empty slot", () => {
    expect(
      invertEnvelope(env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "new", idx: 0 }), fakeCapture({
        property: { elementId: `${NODE}:${SCHEMA}:0`, idx: 0, value: "old", metadata: null },
      })),
    ).toEqual([
      {
        opType: "property.set",
        payload: { objectId: NODE, propertySchemaId: SCHEMA, value: "old", idx: 0 },
        affected: [NODE],
      },
    ]);
    expect(
      invertEnvelope(env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "new", idx: 1 }), fakeCapture({ property: null })),
    ).toEqual([
      {
        opType: "property.unset",
        payload: { objectId: NODE, propertySchemaId: SCHEMA, idx: 1 },
        affected: [NODE],
      },
    ]);
  });

  it("a PG5 element add inverts as an element-addressed remove", () => {
    expect(
      invertEnvelope(
        env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "x", idx: 0, elementId: OTHER }),
        fakeCapture({}),
      ),
    ).toEqual([
      {
        opType: "property.unset",
        payload: { objectId: NODE, propertySchemaId: SCHEMA, elementId: OTHER },
        affected: [NODE],
      },
    ]);
  });

  it("property.unset restores the captured row; an empty slot is a no-op", () => {
    expect(
      invertEnvelope(env("property.unset", { objectId: NODE, propertySchemaId: SCHEMA, idx: 0 }), fakeCapture({
        property: { elementId: `${NODE}:${SCHEMA}:0`, idx: 0, value: "old", metadata: { startDate: { nodeId: TAG } } },
      })),
    ).toEqual([
      {
        opType: "property.set",
        payload: {
          objectId: NODE,
          propertySchemaId: SCHEMA,
          value: "old",
          idx: 0,
          metadata: { startDate: { nodeId: TAG } },
        },
        affected: [NODE],
      },
    ]);
    expect(
      invertEnvelope(env("property.unset", { objectId: NODE, propertySchemaId: SCHEMA, idx: 0 }), fakeCapture({ property: null })),
    ).toBeNull();
  });

  it("propertySchema.update restores touched fields (NULL precision → the day default)", () => {
    expect(
      invertEnvelope(env("propertySchema.update", { propertySchemaId: SCHEMA, name: "Renamed", datePrecision: "month" }), fakeCapture({
        schema: {
          name: "Status",
          type: "select",
          multi: false,
          scope: "global",
          options: [],
          targetClassFilter: null,
          datePrecision: null,
          dateQualified: null,
          display: null,
          readonly: null,
          hideWhenEmpty: null,
        },
      })),
    ).toEqual([
      {
        opType: "propertySchema.update",
        payload: { propertySchemaId: SCHEMA, name: "Status", datePrecision: "day" },
        affected: [],
      },
    ]);
  });

  it("propertySchema.update restores the §34.90 render contracts it touches", () => {
    expect(
      invertEnvelope(env("propertySchema.update", { propertySchemaId: SCHEMA, display: "bullet", readonly: true }), fakeCapture({
        schema: {
          name: "Status",
          type: "select",
          multi: false,
          scope: "global",
          options: [],
          targetClassFilter: null,
          datePrecision: null,
          dateQualified: null,
          display: "inline",
          readonly: null,
          hideWhenEmpty: false,
        },
      })),
    ).toEqual([
      {
        opType: "propertySchema.update",
        payload: { propertySchemaId: SCHEMA, display: "inline", readonly: null },
        affected: [],
      },
    ]);
  });

  it("propertySchema.delete restores the full captured row via create", () => {
    expect(
      invertEnvelope(env("propertySchema.delete", { propertySchemaId: SCHEMA }), fakeCapture({
        schema: {
          name: "Status",
          type: "select",
          multi: true,
          scope: "class",
          options: [{ id: "a", label: "Active" }],
          targetClassFilter: [CLASS_A],
          datePrecision: "year",
          dateQualified: true,
        },
      })),
    ).toEqual([
      {
        opType: "propertySchema.create",
        payload: {
          propertySchemaId: SCHEMA,
          name: "Status",
          type: "select",
          multi: true,
          scope: "class",
          options: [{ id: "a", label: "Active" }],
          targetClassFilter: [CLASS_A],
          datePrecision: "year",
          dateQualified: true,
        },
        affected: [],
      },
    ]);
  });

  it("asset.attach inverts as detach (fresh row) / re-attach (upserted row)", () => {
    const asset = { assetId: OTHER, hash: "h".repeat(64), mimeType: "image/png", size: 3, originalName: "a.png" };
    expect(
      invertEnvelope(env("asset.attach", { objectId: NODE, assetId: OTHER, hash: asset.hash, mimeType: "image/png", size: 9, originalName: "b.png" }), fakeCapture({ asset: null })),
    ).toEqual([
      { opType: "asset.detach", payload: { objectId: NODE, assetId: OTHER }, affected: [NODE, OTHER] },
    ]);
    expect(
      invertEnvelope(env("asset.attach", { objectId: NODE, assetId: OTHER, hash: asset.hash, mimeType: "image/png", size: 9, originalName: "b.png" }), fakeCapture({ asset })),
    ).toEqual([
      {
        opType: "asset.attach",
        payload: { objectId: NODE, assetId: OTHER, hash: asset.hash, mimeType: "image/png", size: 3, originalName: "a.png" },
        affected: [NODE, OTHER],
      },
    ]);
  });

  it("collection.member.add/remove invert as the complement; redundant flips are no-ops", () => {
    const add = env("collection.member.add", { collectionId: CLASS_A, objectId: NODE });
    const remove = env("collection.member.remove", { collectionId: CLASS_A, objectId: NODE });
    expect(invertEnvelope(add, fakeCapture({ member: false }))).toEqual([
      { opType: "collection.member.remove", payload: { collectionId: CLASS_A, objectId: NODE }, affected: [CLASS_A, NODE] },
    ]);
    expect(invertEnvelope(add, fakeCapture({ member: true }))).toBeNull();
    expect(invertEnvelope(remove, fakeCapture({ member: true }))).toEqual([
      { opType: "collection.member.add", payload: { collectionId: CLASS_A, objectId: NODE }, affected: [CLASS_A, NODE] },
    ]);
    expect(invertEnvelope(remove, fakeCapture({ member: false }))).toBeNull();
  });

  it("workspace.feature.set inverts as the captured prior state; a redundant toggle is a no-op", () => {
    expect(
      invertEnvelope(env("workspace.feature.set", { feature: "tasks", enabled: false }), fakeCapture({ feature: true })),
    ).toEqual([
      { opType: "workspace.feature.set", payload: { feature: "tasks", enabled: true }, affected: [] },
    ]);
    expect(
      invertEnvelope(env("workspace.feature.set", { feature: "tasks", enabled: false }), fakeCapture({ feature: false })),
    ).toBeNull();
  });
});

describe("UndoJournal — mechanics (fake clock)", () => {
  const capture = fakeCapture({});

  function makeJournal(opts: { now: () => number; limit?: number }): UndoJournal {
    return new UndoJournal({ capture, now: opts.now, ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
  }

  let clock = 0;
  const textEdit = (nodeId: string, text: string) =>
    env("object.update", { objectId: nodeId, contentAst: [{ type: "text", text }] });

  it("records to the undo stack, clears redo on a new normal write", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(env("object.delete", { objectId: NODE })), "normal");
    expect(journal.canUndo()).toBe(true);
    expect(journal.undoLabel()).toBe("Undo delete");
    // The undo loop relabels the redo-side entry with the ORIGINAL verb.
    journal.commit(
      journal.prepare(env("object.update", { objectId: NODE, color: "sky" })),
      "undo",
      "delete",
    );
    expect(journal.canRedo()).toBe(true);
    expect(journal.redoLabel()).toBe("Redo delete");
    journal.commit(journal.prepare(env("object.move", { objectId: NODE, parentId: null })), "normal");
    expect(journal.canRedo()).toBe(false); // a new write invalidates the redo line
    expect(journal.undoLabel()).toBe("Undo move");
  });

  it("coalesces contiguous same-node text edits inside the window into one entry", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(textEdit(NODE, "a")), "normal");
    clock += 400; // one editor-flush pause
    journal.commit(journal.prepare(textEdit(NODE, "ab")), "normal");
    clock += 400;
    journal.commit(journal.prepare(textEdit(NODE, "abc")), "normal");
    expect(journal.undoDepth()).toBe(1);
    const entry = journal.takeUndo()!;
    expect(entry.inverseSpecs[0]?.payload.contentAst).toEqual([{ type: "text", text: "before" }]);
    expect(entry.applySpecs[0]?.payload.contentAst).toEqual([{ type: "text", text: "abc" }]);
  });

  it("a pause past the window starts a new entry; other nodes never coalesce", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(textEdit(NODE, "a")), "normal");
    clock += 2000; // past the 1500 ms window
    journal.commit(journal.prepare(textEdit(NODE, "b")), "normal");
    expect(journal.undoDepth()).toBe(2);
    journal.commit(journal.prepare(textEdit(OTHER, "x")), "normal");
    expect(journal.undoDepth()).toBe(3);
  });

  it("icon/color/presentAsMain updates do not coalesce with text edits", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(textEdit(NODE, "a")), "normal");
    clock += 100;
    journal.commit(journal.prepare(env("object.update", { objectId: NODE, color: "sky" })), "normal");
    expect(journal.undoDepth()).toBe(2);
  });

  it("bounds both stacks at the limit (oldest dropped)", () => {
    const journal = makeJournal({ now: () => clock, limit: 3 });
    for (let i = 0; i < 5; i += 1) {
      clock += 2000;
      journal.commit(journal.prepare(env("object.move", { objectId: NODE, parentId: null })), "normal");
    }
    expect(journal.undoDepth()).toBe(3);
    // undo three, redo three — the redo stack is bounded the same way.
    journal.takeUndo();
    journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "undo");
    journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "undo");
    journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "undo");
    journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "undo");
    expect(journal.redoDepth()).toBe(3);
  });

  it("batch() groups a multi-envelope gesture into one entry (inverses reversed)", () => {
    const journal = makeJournal({ now: () => clock });
    journal.batch(() => {
      journal.commit(journal.prepare(env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "v", idx: 0 })), "normal");
      journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "normal");
    });
    expect(journal.undoDepth()).toBe(1);
    const entry = journal.takeUndo()!;
    expect(entry.applySpecs.map((s) => s.opType)).toEqual(["property.set", "object.delete"]);
    // Undo runs the gesture's SECOND write inverse first.
    expect(entry.inverseSpecs.map((s) => s.opType)).toEqual(["object.restore", "property.unset"]);

    // The undo/redo loops batch with mode: the inverses land as ONE redo entry.
    journal.batch(() => {
      journal.commit(journal.prepare(env("object.delete", { objectId: OTHER })), "undo", "promote to block");
      journal.commit(journal.prepare(env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "v", idx: 0 })), "undo", "promote to block");
    });
    expect(journal.redoDepth()).toBe(1);
    const redoEntry = journal.takeRedo()!;
    expect(redoEntry.verb).toBe("promote to block");
    // Redo re-applies the original gesture in its original order.
    expect(redoEntry.inverseSpecs.map((s) => s.opType)).toEqual(["property.unset", "object.restore"]);
  });

  it("restoreUndo/restoreRedo put a taken entry back after a failed apply", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(env("object.delete", { objectId: NODE })), "normal");
    const entry = journal.takeUndo()!;
    expect(journal.canUndo()).toBe(false);
    journal.restoreUndo(entry);
    expect(journal.canUndo()).toBe(true);
    expect(journal.undoLabel()).toBe("Undo delete");
  });

  it("labels come from the op type (with gesture refinements)", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(textEdit(NODE, "a")), "normal");
    expect(journal.undoLabel()).toBe("Undo edit text");
    journal.commit(journal.prepare(env("object.update", { objectId: NODE, presentAsMain: true })), "normal");
    expect(journal.undoLabel()).toBe("Undo promote");
    journal.commit(journal.prepare(env("object.update", { objectId: NODE, color: "sky" })), "normal");
    expect(journal.undoLabel()).toBe("Undo change color");
    journal.commit(journal.prepare(env("property.set", { objectId: NODE, propertySchemaId: SCHEMA, value: "v" })), "normal");
    expect(journal.undoLabel()).toBe("Undo set property");
    expect(journal.redoLabel()).toBeNull();
  });

  it("clear() drops everything (workspace switch / session end)", () => {
    const journal = makeJournal({ now: () => clock });
    journal.commit(journal.prepare(env("object.delete", { objectId: NODE })), "normal");
    journal.commit(journal.prepare(env("object.restore", { objectId: OTHER })), "undo");
    journal.clear();
    expect(journal.canUndo()).toBe(false);
    expect(journal.canRedo()).toBe(false);
  });
});

// --- integration: the real client, store, and outbox path -----------------------

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function createClient(relay: MemoryRelay): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  await client.bootstrapWorkspace(WS);
  clients.push(client);
  return client;
}

describe("WorkspaceClient undo/redo — integration over the outbox path", () => {
  it("create → undo trashes the node, redo revives it", async () => {
    const client = await createClient(new MemoryRelay());
    const id = await client.createObject({ presentAsMain: true, name: "Hello" });
    expect(client.getNode(id)).not.toBeUndefined();
    expect(client.undoDepth()).toEqual({ undo: 1, redo: 0 });

    expect(await client.undo()).toBe(true);
    expect(client.getNode(id)).toBeUndefined();
    expect(client.getNodeRaw(id)?.isActive).toBe(false);
    expect(client.undoDepth()).toEqual({ undo: 0, redo: 1 });

    expect(await client.redo()).toBe(true);
    expect(client.getNode(id)).not.toBeUndefined();
    expect((await client.undoState()).canRedo).toBe(false);
  });

  it("undo on an empty journal is an honest no-op", async () => {
    const client = await createClient(new MemoryRelay());
    expect(await client.undo()).toBe(false);
    expect(await client.redo()).toBe(false);
  });

  it("two contiguous text edits coalesce: one undo restores the pre-typing text", async () => {
    const client = await createClient(new MemoryRelay());
    const id = await client.createObject({ presentAsMain: true, name: "Start" });
    await client.updateObject(id, { contentAst: [{ type: "text", text: "Start typing" }] });
    await client.updateObject(id, { contentAst: [{ type: "text", text: "Start typing more" }] });
    // create + ONE coalesced text entry (both edits landed inside the window).
    expect(client.undoDepth().undo).toBe(2);
    await client.undo();
    expect(client.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Start" }]);
    // Redo lands the LATEST text (the coalesced entry keeps the final op).
    await client.redo();
    expect(client.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Start typing more" }]);
  });

  it("rename (text update) → undo restores the prior content; redo reapplies", async () => {
    const client = await createClient(new MemoryRelay());
    const id = await client.createObject({
      presentAsMain: true,
      contentAst: [{ type: "text", text: "Original" }],
    });
    await client.updateObject(id, { contentAst: [{ type: "text", text: "Renamed" }] });
    expect(client.undoDepth().undo).toBe(2);

    expect(await client.undo()).toBe(true);
    expect(client.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Original" }]);
    expect((await client.undoState()).undoLabel).toBe("Undo create");

    expect(await client.redo()).toBe(true);
    expect(client.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Renamed" }]);
  });

  it("color update → undo restores the prior color", async () => {
    const client = await createClient(new MemoryRelay());
    const id = await client.createObject({ presentAsMain: true, name: "Page" });
    await client.updateObject(id, { color: "sky" });
    expect(client.getNode(id)?.color).toBe("sky");
    await client.undo();
    expect(client.getNode(id)?.color).toBeNull();
  });

  it("delete → undo restores the subtree; a permanent delete is not journaled", async () => {
    const client = await createClient(new MemoryRelay());
    const page = await client.createObject({ presentAsMain: true, name: "P" });
    const child = await client.createObject({ parentId: page, name: "child" });
    await client.deleteObject(page);
    expect(client.getNode(page)).toBeUndefined();
    expect(await client.undo()).toBe(true);
    expect(client.getNode(page)).not.toBeUndefined();
    expect(client.getNode(child)).not.toBeUndefined();

    // Permanent delete: honest data loss, no journal entry.
    const doomed = await client.createObject({ presentAsMain: true, name: "Doomed" });
    const depthBefore = client.undoDepth().undo;
    await client.deleteObject(doomed, { permanent: true });
    expect(client.getNodeRaw(doomed)).toBeUndefined();
    expect(client.undoDepth().undo).toBe(depthBefore);
    expect((await client.undoState()).undoLabel).not.toBe("Undo delete");
  });

  it("move → undo restores the prior parent AND the prior sibling position", async () => {
    const client = await createClient(new MemoryRelay());
    const page = await client.createObject({ presentAsMain: true, name: "P" });
    const a = await client.createObject({ parentId: page, name: "A" });
    const b = await client.createObject({ parentId: page, name: "B" });
    const c = await client.createObject({ parentId: page, name: "C" });
    expect(client.getChildren(page).map((n) => n.id)).toEqual([a, b, c]);

    // Move C up, right after A.
    await client.moveObject(c, page, a);
    expect(client.getChildren(page).map((n) => n.id)).toEqual([a, c, b]);

    await client.undo();
    expect(client.getChildren(page).map((n) => n.id)).toEqual([a, b, c]);

    // Move B under A (indent), then undo.
    await client.moveObject(b, a);
    expect(client.getChildren(a).map((n) => n.id)).toEqual([b]);
    await client.undo();
    expect(client.getChildren(a)).toEqual([]);
    expect(client.getChildren(page).map((n) => n.id)).toEqual([a, b, c]);
  });

  it("property.set → undo restores the prior value; property.unset → undo restores it", async () => {
    const client = await createClient(new MemoryRelay());
    const node = await client.createObject({ presentAsMain: true, name: "N" });
    const schema = await client.createPropertySchema({ name: "Note", type: "text" });

    // First write: slot was empty → undo unsets.
    await client.setProperty(node, schema, "first");
    expect(client.getPropertyReferences(schema).map((n) => n.id)).toEqual([node]);
    await client.undo();
    expect(client.getPropertyReferences(schema)).toEqual([]);

    // Overwrite: undo restores the prior value.
    await client.setProperty(node, schema, "first");
    await client.setProperty(node, schema, "second");
    await client.undo();
    const row = client.store.database
      .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
      .get(node, schema) as { value: string };
    expect(JSON.parse(row.value)).toBe("first");

    // unset → undo brings the value back.
    await client.unsetProperty(node, schema);
    expect(client.getPropertyReferences(schema)).toEqual([]);
    await client.undo();
    expect(client.getPropertyReferences(schema).map((n) => n.id)).toEqual([node]);
  });

  it("assignClass → undo removes the class; unassignClass → undo re-adds it", async () => {
    const client = await createClient(new MemoryRelay());
    const node = await client.createObject({ presentAsMain: true, name: "N" });
    const cls = await client.createClass("Kind");
    await client.assignClass(node, cls);
    expect(client.getNode(node)?.classIds).toEqual([cls]);
    expect((await client.undoState()).undoLabel).toBe("Undo assign class");
    await client.undo();
    expect(client.getNode(node)?.classIds).toEqual([]);

    await client.assignClass(node, cls);
    await client.unassignClass(node, cls);
    expect(client.getNode(node)?.classIds).toEqual([]);
    await client.undo();
    expect(client.getNode(node)?.classIds).toEqual([cls]);
  });

  it("assignTag → undo removes the tag", async () => {
    const client = await createClient(new MemoryRelay());
    const tag = await client.createObject({ presentAsMain: true, name: "TagPage" });
    const node = await client.createObject({ presentAsMain: true, name: "N" });
    await client.assignTag(node, tag);
    expect(client.getNode(node)?.tagIds).toEqual([tag]);
    expect((await client.undoState()).undoLabel).toBe("Undo assign tag");
    await client.undo();
    expect(client.getNode(node)?.tagIds).toEqual([]);
  });

  it("class.setExtends → undo restores the prior parent set", async () => {
    const client = await createClient(new MemoryRelay());
    const base = await client.createClass("Base");
    const child = await client.createClass("Child");
    await client.setClassExtends(child, [base]);
    expect(client.getClassParents(child)).toEqual([base]);
    await client.undo();
    expect(client.getClassParents(child)).toEqual([]);
    await client.redo();
    expect(client.getClassParents(child)).toEqual([base]);
  });

  it("class.property.set → undo restores the touched fields; unset → undo restores the row", async () => {
    const client = await createClient(new MemoryRelay());
    const cls = await client.createClass("Bound");
    const schema = await client.createPropertySchema({ name: "S", type: "text" });

    await client.setClassProperty(cls, schema, { sequence: 7, required: true });
    let binding = client.getClassBindings(cls).find((b) => b.propertySchemaId === schema);
    expect(binding?.sequence).toBe(7);
    expect(binding?.required).toBe(true);
    await client.undo();
    binding = client.getClassBindings(cls).find((b) => b.propertySchemaId === schema);
    expect(binding).toBeUndefined(); // first bind → inverse was unset

    await client.setClassProperty(cls, schema, { sequence: 1 });
    await client.setClassProperty(cls, schema, { sequence: 9, required: true });
    await client.undo();
    binding = client.getClassBindings(cls).find((b) => b.propertySchemaId === schema);
    expect(binding?.sequence).toBe(1);
    // The prior flag was SQL NULL; the wire coerces null → false at apply
    // time, so the honest restore lands on false (the "cleared" value).
    expect(binding?.required).toBe(false);

    await client.unsetClassProperty(cls, schema);
    expect(client.getClassBindings(cls).find((b) => b.propertySchemaId === schema)).toBeUndefined();
    await client.undo();
    binding = client.getClassBindings(cls).find((b) => b.propertySchemaId === schema);
    expect(binding?.sequence).toBe(1);
  });

  it("multi-tab honesty: a second client on the same relay has its own empty journal", async () => {
    const relay = new MemoryRelay();
    const clientA = await createClient(relay);
    const clientB = await createClient(relay);
    await clientA.createObject({ presentAsMain: true, name: "From A" });
    expect(clientA.undoDepth().undo).toBe(1);
    // B syncs A's op through the log — remote ops never enter B's journal.
    await clientB.sync();
    expect(clientB.getNode(clientA.roots()[0]!.id)).not.toBeUndefined();
    expect(clientB.undoDepth().undo).toBe(0);
    expect(await clientB.undo()).toBe(false);
  });

  it("undo/redo ride the normal write path: the inverse lands in the outbox and syncs", async () => {
    const relay = new MemoryRelay();
    const clientA = await createClient(relay);
    const clientB = await createClient(relay);
    const id = await clientA.createObject({ presentAsMain: true, name: "Sync me" });
    await clientA.updateObject(id, { contentAst: [{ type: "text", text: "edited" }] });
    await clientA.undo();
    await clientA.push();
    await clientB.pull();
    expect(clientB.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Sync me" }]);
  });
});
