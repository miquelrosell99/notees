/**
 * Clone engine tests — two layers:
 *
 * 1. Composition over a SYNTHETIC template subtree + fake read surface: the
 *    emitted op list is asserted exactly — fresh ids, beforeId/afterId
 *    anchor chaining, A3 reference semantics per token kind (mention /
 *    class_chip / typed_link keep targets, asset_ref same CAS, embed_ref
 *    same live embed), tags re-issued, class assignments minus the template
 *    marker, whiteboard card geometry re-keyed, authored-only property
 *    values with idx/metadata (derived defaults never materialized).
 *
 * 2. Integration through a real WorkspaceClient (MemoryTransport): the
 *    composed carriers apply to the store — instantiate-at-create grafts the
 *    root onto the created object + clones children in order; D2 shows
 *    template-authored values beating binding defaults while unset
 *    properties stay derived; cloneSubtree stays generic (T4 duplicate).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import {
  cloneSubtree,
  composeSubtreeClone,
  composeTemplateGraft,
  instantiateTemplate,
  type CloneOp,
  type CloneReadSurface,
} from "../src/core/clone.js";
import {
  WorkspaceClient,
  type ClientNode,
  type EffectiveProperty,
} from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

// --- synthetic subtree fixture -------------------------------------------------

function fakeNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: WS,
    isClass: false,
    presentAsMain: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [],
    icon: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

function authoredProp(
  propertySchemaId: string,
  idx: number,
  value: unknown,
  metadata: Record<string, unknown> | null = null,
): EffectiveProperty {
  return {
    propertySchemaId,
    idx,
    elementId: `element:${propertySchemaId}:${idx}`,
    schema: null,
    value,
    metadata,
    source: "authored",
    boundBy: null,
    required: null,
    readonly: null,
    hideWhenEmpty: null,
    sequence: null,
    display: null,
  };
}

function derivedProp(propertySchemaId: string, idx: number, value: unknown): EffectiveProperty {
  return { ...authoredProp(propertySchemaId, idx, value), source: "default", boundBy: "class-x" };
}

class FakeReads implements CloneReadSurface {
  constructor(
    private nodes: Map<string, ClientNode>,
    private childOrder: Map<string, string[]>,
    private props: Map<string, EffectiveProperty[]>,
  ) {}
  getNode(id: string): ClientNode | undefined {
    return this.nodes.get(id);
  }
  getChildren(id: string): ClientNode[] {
    return (this.childOrder.get(id) ?? [])
      .map((childId) => this.nodes.get(childId))
      .filter((node): node is ClientNode => node !== undefined);
  }
  getEffectiveProperties(id: string): EffectiveProperty[] {
    return this.props.get(id) ?? [];
  }
  /** Test hook: add a node outside the fixture (e.g. the graft target). */
  setNode(node: ClientNode): void {
    this.nodes.set(node.id, node);
  }
}

const MEETING = "00000000-0000-7000-8000-0000000000m1";
const TAG_A = "00000000-0000-7000-8000-0000000000t1";
const TAG_B = "00000000-0000-7000-8000-0000000000t2";
const PERSON = "00000000-0000-7000-8000-0000000000p1";
const PAGE9 = "00000000-0000-7000-8000-0000000000p9";
const ASSET1 = "00000000-0000-7000-8000-0000000000a1";
const EMBED1 = "00000000-0000-7000-8000-0000000000e9";

const TPL_ROOT_AST: ContentAst = [
  { type: "text", text: "Weekly sync" },
  { type: "mention", targetNodeId: PERSON, text: "Alice" },
  { type: "class_chip", classId: MEETING },
  { type: "typed_link", verb: "prepares", text: "prepares" },
  { type: "asset_ref", assetId: ASSET1 },
  { type: "embed_ref", nodeId: EMBED1 },
];

/** Builds the synthetic template subtree (ids are arbitrary at compose level). */
function fixture() {
  const nodes = new Map<string, ClientNode>([
    [
      "tpl",
      fakeNode({
        id: "tpl",
        presentAsMain: true,
        classIds: [SYSTEM_CLASS_UUIDS.template, MEETING],
        tagIds: [TAG_A],
        contentAst: TPL_ROOT_AST,
      }),
    ],
    [
      "c1",
      fakeNode({
        id: "c1",
        presentAsMain: false,
        classIds: ["checklist"],
        tagIds: [TAG_B],
        contentAst: [
          { type: "text", text: "Agenda" },
          { type: "mention", targetNodeId: PAGE9, text: "Roadmap" },
        ],
      }),
    ],
    ["g1", fakeNode({ id: "g1", contentAst: [{ type: "text", text: "Deep dive" }] })],
    [
      "c2",
      fakeNode({
        id: "c2",
        contentAst: [
          {
            type: "whiteboard",
            layout: {
              cards: {
                w1: { x: 1, y: 2, w: 3, h: 4 },
                "elsewhere-card": { x: 9, y: 9, w: 1, h: 1 },
              },
              shapes: [{ id: "shape-1", kind: "rect", x: 0, y: 0, w: 10, h: 10 }],
              strokes: [{ id: "stroke-1", points: [0, 0, 5, 5] }],
            },
          },
        ],
      }),
    ],
    ["w1", fakeNode({ id: "w1", contentAst: [{ type: "text", text: "Card" }] })],
  ]);
  const childOrder = new Map<string, string[]>([
    ["tpl", ["c1", "c2"]],
    ["c1", ["g1"]],
    ["c2", ["w1"]],
  ]);
  const props = new Map<string, EffectiveProperty[]>([
    [
      "tpl",
      [
        authoredProp("schema-note", 0, "Bring slides", { locator: "p. 2" }),
        authoredProp("schema-link", 0, { nodeId: PERSON }),
        authoredProp("schema-multi", 1, "second value"),
        derivedProp("schema-default", 0, "DERIVED-DEFAULT"),
      ],
    ],
    ["c1", [authoredProp("schema-note", 0, "child note")]],
  ]);
  return new FakeReads(nodes, childOrder, props);
}

/** Deterministic fresh-id generator: fresh-1, fresh-2, … */
function idSequence(): () => string {
  let n = 0;
  return () => `fresh-${++n}`;
}

const createsOf = (ops: CloneOp[], objectId: string) =>
  ops.filter((op) => op.opType === "object.create" && op.payload.objectId === objectId);
const setsOf = (ops: CloneOp[], objectId: string) =>
  ops.filter((op) => op.opType === "property.set" && op.payload.objectId === objectId);
const create = (ops: CloneOp[], objectId: string) => {
  const found = createsOf(ops, objectId);
  expect(found, `one object.create for ${objectId}`).toHaveLength(1);
  const op = found[0]!;
  if (op.opType !== "object.create") throw new Error("unreachable");
  return op.payload;
};

describe("composeSubtreeClone", () => {
  it("emits a fresh-id create per node, depth-first, with anchor-chained siblings", () => {
    const reads = fixture();
    const { ops, rootId, idMap } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      stripClassIds: [SYSTEM_CLASS_UUIDS.template],
      newId: idSequence(),
    });

    // Pre-order id assignment: tpl→fresh-1, c1→fresh-2, g1→fresh-3, c2→fresh-4, w1→fresh-5.
    expect(rootId).toBe("fresh-1");
    expect(idMap.get("tpl")).toBe("fresh-1");
    expect(idMap.get("w1")).toBe("fresh-5");
    // 5 creates + 4 authored property sets (3 on tpl, 1 on c1); the derived
    // default row is never materialized.
    expect(ops.filter((op) => op.opType === "object.create")).toHaveLength(5);
    expect(ops.filter((op) => op.opType === "property.set")).toHaveLength(4);

    // Every emitted id is fresh — none of the source ids appears as an
    // objectId, and anchors reference fresh ids only.
    const sourceIds = new Set(["tpl", "c1", "g1", "c2", "w1"]);
    for (const op of ops) {
      expect(sourceIds.has(op.payload.objectId)).toBe(false);
    }

    // Root: placement + copied content + stripped classes + re-issued tags.
    const root = create(ops, "fresh-1");
    expect(root.parentId).toBe("dest-parent");
    expect(root.afterId).toBeUndefined();
    expect(root.presentAsMain).toBe(true);
    expect(root.contentAst).toEqual(TPL_ROOT_AST);
    expect(root.classIds).toEqual([MEETING]); // template marker stripped
    expect(root.tagIds).toEqual([TAG_A]); // tag re-issued on the fresh id

    // Sibling anchor chaining: c1 appends (first), c2 lands afterId = c1's
    // fresh id — replay converges to the source order on every backend.
    const first = create(ops, "fresh-2");
    expect(first.parentId).toBe("fresh-1");
    expect(first.afterId).toBeUndefined();
    expect(first.classIds).toEqual(["checklist"]);
    expect(first.tagIds).toEqual([TAG_B]);
    expect(first.presentAsMain).toBe(false);
    const second = create(ops, "fresh-4");
    expect(second.parentId).toBe("fresh-1");
    expect(second.afterId).toBe("fresh-2");

    // Nesting: g1 under c1's fresh id; w1 under c2's.
    expect(create(ops, "fresh-3").parentId).toBe("fresh-2");
    expect(create(ops, "fresh-5").parentId).toBe("fresh-4");
  });

  it("A3: content references are links — mention/chip/typed_link/asset_ref/embed_ref keep targets", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      stripClassIds: [SYSTEM_CLASS_UUIDS.template],
      newId: idSequence(),
    });
    // Root tokens unchanged, token for token.
    expect(create(ops, "fresh-1").contentAst).toEqual(TPL_ROOT_AST);
    // The child's mention still points at the same page.
    const childAst = create(ops, "fresh-2").contentAst;
    expect(childAst).toEqual([
      { type: "text", text: "Agenda" },
      { type: "mention", targetNodeId: PAGE9, text: "Roadmap" },
    ]);
  });

  it("whiteboard card geometry is re-keyed to cloned fresh ids; shapes/strokes copy unchanged", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      stripClassIds: [SYSTEM_CLASS_UUIDS.template],
      newId: idSequence(),
    });
    const whiteboard = create(ops, "fresh-4").contentAst?.[0];
    expect(whiteboard?.type).toBe("whiteboard");
    if (whiteboard?.type !== "whiteboard") throw new Error("unreachable");
    const layout = whiteboard.layout as {
      cards: Record<string, unknown>;
      shapes: unknown[];
      strokes: unknown[];
    };
    // w1 cloned as fresh-5 → geometry re-keyed; the out-of-subtree key stays.
    expect(layout.cards).toEqual({
      "fresh-5": { x: 1, y: 2, w: 3, h: 4 },
      "elsewhere-card": { x: 9, y: 9, w: 1, h: 1 },
    });
    expect(layout.shapes).toEqual([{ id: "shape-1", kind: "rect", x: 0, y: 0, w: 10, h: 10 }]);
    expect(layout.strokes).toEqual([{ id: "stroke-1", points: [0, 0, 5, 5] }]);
  });

  it("copies authored property values only, preserving idx and metadata", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      stripClassIds: [SYSTEM_CLASS_UUIDS.template],
      newId: idSequence(),
    });
    const rootSets = setsOf(ops, "fresh-1");
    expect(rootSets.map((op) => (op.opType === "property.set" ? op.payload.propertySchemaId : ""))).toEqual([
      "schema-note",
      "schema-link",
      "schema-multi",
    ]);
    const note = rootSets[0]!;
    if (note.opType !== "property.set") throw new Error("unreachable");
    expect(note.payload.value).toBe("Bring slides");
    expect(note.payload.idx).toBe(0);
    expect(note.payload.metadata).toEqual({ locator: "p. 2" });
    const link = rootSets[1]!;
    if (link.opType !== "property.set") throw new Error("unreachable");
    expect(link.payload.value).toEqual({ nodeId: PERSON }); // node-typed ref copied
    const multi = rootSets[2]!;
    if (multi.opType !== "property.set") throw new Error("unreachable");
    expect(multi.payload.idx).toBe(1);
    // Child-authored values land on the child's fresh id.
    expect(setsOf(ops, "fresh-2")).toHaveLength(1);
    expect(setsOf(ops, "fresh-3")).toHaveLength(0);
  });

  it("without a strip set, class assignments copy verbatim (the T4 duplicate path)", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      newId: idSequence(),
    });
    expect(create(ops, "fresh-1").classIds).toEqual([SYSTEM_CLASS_UUIDS.template, MEETING]);
  });

  it("supports a caller-chosen root render bit and beforeId anchoring", () => {
    const reads = fixture();
    const { ops } = composeSubtreeClone(reads, {
      rootId: "tpl",
      parentId: "dest-parent",
      beforeId: "existing-sibling",
      rootPresentAsMain: false,
      newId: idSequence(),
    });
    const root = create(ops, "fresh-1");
    expect(root.beforeId).toBe("existing-sibling");
    expect(root.afterId).toBeUndefined();
    expect(root.presentAsMain).toBe(false);
  });

  it("fails loud when the root is missing", () => {
    const reads = fixture();
    expect(() =>
      composeSubtreeClone(reads, { rootId: "nope", parentId: "dest-parent" }),
    ).toThrow(/nope not found/);
  });
});

describe("composeTemplateGraft", () => {
  it("grafts the root onto the object and clones children beneath it in order", () => {
    const reads = fixture();
    reads.setNode(fakeNode({ id: "obj-1", classIds: [MEETING], presentAsMain: true }));

    const { ops, rootId } = composeTemplateGraft(reads, {
      templateRootId: "tpl",
      objectId: "obj-1",
      newId: idSequence(),
    });
    expect(rootId).toBe("obj-1");

    // 1 update + 1 tag re-issue (root's tag-a; meeting class already on the
    // object, template marker stripped → no class re-issue) + 3 authored
    // root property sets + 3 child creates + 1 child prop set. The derived
    // default row is never materialized.
    expect(ops[0]).toEqual({
      opType: "object.update",
      payload: { objectId: "obj-1", contentAst: TPL_ROOT_AST },
    });
    expect(createsOf(ops, "obj-1")).toEqual([
      { opType: "object.create", payload: { objectId: "obj-1", tagIds: [TAG_A] } },
    ]);
    expect(setsOf(ops, "obj-1")).toHaveLength(3);
    // Children clone beneath the object with the same anchor chain — the
    // graft does not clone the root, so children take fresh-1..fresh-4.
    const first = create(ops, "fresh-1");
    expect(first.parentId).toBe("obj-1");
    expect(first.afterId).toBeUndefined();
    const second = create(ops, "fresh-3");
    expect(second.parentId).toBe("obj-1");
    expect(second.afterId).toBe("fresh-1");
    expect(create(ops, "fresh-2").parentId).toBe("fresh-1");
    expect(create(ops, "fresh-4").parentId).toBe("fresh-3");
    // The instance never references the template root id.
    for (const op of ops) {
      expect(op.payload.objectId).not.toBe("tpl");
      expect(op.payload.objectId).not.toBe(SYSTEM_CLASS_UUIDS.template);
    }
  });

  it("re-issues root classes the object does not already carry (minus the marker)", () => {
    const reads = fixture();
    reads.setNode(fakeNode({ id: "obj-1", classIds: [], presentAsMain: true }));
    const { ops } = composeTemplateGraft(reads, {
      templateRootId: "tpl",
      objectId: "obj-1",
      newId: idSequence(),
    });
    // One OR-Set add carrier for `meeting` only (template stripped), plus
    // the root's tag re-issue.
    expect(createsOf(ops, "obj-1")).toEqual([
      { opType: "object.create", payload: { objectId: "obj-1", classIds: [MEETING] } },
      { opType: "object.create", payload: { objectId: "obj-1", tagIds: [TAG_A] } },
    ]);
  });
});

// --- integration through a real client ------------------------------------------

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

function seedEnvelope(
  opType: string,
  payload: Record<string, unknown>,
  affected: string[],
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device",
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

function seededRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope(
      "class.create",
      {
        classId: SYSTEM_CLASS_UUIDS.template,
        contentAst: [{ type: "text", text: "template" }],
        icon: "mdiFileDocumentOutline",
      },
      [SYSTEM_CLASS_UUIDS.template],
    ),
  ]);
  return relay;
}

async function seedClient(relay: MemoryRelay = seededRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

describe("instantiateTemplate (real client)", () => {
  it("grafts the root and clones children: order, strip rule, A3 refs, D2 precedence", async () => {
    const client = await seedClient();
    const meetingId = await client.createClass("meeting");
    const personId = await client.createObject({ presentAsMain: true, name: "Alice" });

    // Two bound schemas on the meeting class: Priority has a binding default
    // AND a template-authored value (template must win); Venue has only a
    // binding default (must stay derived on the instance).
    const prioId = await client.createPropertySchema({ name: "Priority", type: "select" });
    const venueId = await client.createPropertySchema({ name: "Venue", type: "text" });
    await client.setClassProperty(meetingId, prioId, { defaultValue: "low" });
    await client.setClassProperty(meetingId, venueId, { defaultValue: "room-1" });

    // Template: meeting-classed root (plus the marker), two children, an
    // authored Priority value, a mention of the person.
    const tplId = await client.createObject({
      presentAsMain: true,
      name: "Weekly sync",
      classIds: [SYSTEM_CLASS_UUIDS.template, meetingId],
    });
    await client.setProperty(tplId, prioId, "high", 0);
    await client.createObject({
      parentId: tplId,
      contentAst: [{ type: "text", text: "Agenda" }],
    });
    const discussId = await client.createObject({
      parentId: tplId,
      contentAst: [
        { type: "text", text: "Discuss with" },
        { type: "mention", targetNodeId: personId, text: "Alice" },
      ],
    });
    await client.assignTag(tplId, personId); // any page can be a tag

    // Create-with-template: fresh object of the picked class + graft.
    const objId = await client.createObject({ presentAsMain: true, classIds: [meetingId] });
    await instantiateTemplate(
      { reads: client, writes: client },
      { templateRootId: tplId, objectId: objId },
    );

    const instance = client.getNode(objId);
    expect(instance).toBeDefined();
    // Root contentAst grafted (flattened to text-only: the object presents
    // as main).
    expect(instance!.contentAst).toEqual([{ type: "text", text: "Weekly sync" }]);
    // Strip rule: the instance carries meeting, never the marker class.
    expect(instance!.classIds).toEqual([meetingId]);
    expect(instance!.classIds).not.toContain(SYSTEM_CLASS_UUIDS.template);
    // Tag re-issued on the instance.
    expect(instance!.tagIds).toEqual([personId]);
    // Template untouched.
    expect(client.getNode(tplId)!.contentAst).toEqual([{ type: "text", text: "Weekly sync" }]);
    expect(client.getChildren(tplId)).toHaveLength(2);

    // Children cloned beneath the instance in template order (anchor chain).
    const children = client.getChildren(objId);
    expect(children.map((child) => child.contentAst)).toEqual([
      [{ type: "text", text: "Agenda" }],
      [
        { type: "text", text: "Discuss with" },
        { type: "mention", targetNodeId: personId, text: "Alice" },
      ],
    ]);
    expect(children[1]!.id).not.toBe(discussId); // fresh ids
    expect(children.every((child) => child.parentId === objId)).toBe(true);

    // D2: authored template value beats the binding default; the unset
    // property stays a derived default.
    const effective = client.getEffectiveProperties(objId);
    const prio = effective.find((entry) => entry.propertySchemaId === prioId);
    expect(prio?.value).toBe("high");
    expect(prio?.source).toBe("authored");
    const venue = effective.find((entry) => entry.propertySchemaId === venueId);
    expect(venue?.value).toBe("room-1");
    expect(venue?.source).toBe("default");
    expect(venue?.boundBy).toBe(meetingId);
  });

  it("cloneSubtree clones any subtree generically (the T4 duplicate path)", async () => {
    const client = await seedClient();
    const meetingId = await client.createClass("meeting");
    const tplId = await client.createObject({
      presentAsMain: true,
      name: "T",
      classIds: [SYSTEM_CLASS_UUIDS.template, meetingId],
    });
    await client.createObject({ parentId: tplId, contentAst: [{ type: "text", text: "Only child" }] });

    // Duplicate semantics: no strip — even the template marker is preserved.
    const dupId = await cloneSubtree(
      { reads: client, writes: client },
      { rootId: tplId, parentId: null },
    );
    const dup = client.getNode(dupId);
    expect(dup).toBeDefined();
    expect(dup!.classIds).toContain(SYSTEM_CLASS_UUIDS.template);
    expect(dup!.classIds).toContain(meetingId);
    expect(dup!.parentId).toBeNull();
    expect(client.getChildren(dupId)).toHaveLength(1);
    expect(client.getNode(tplId)).toBeDefined(); // source intact
  });
});
