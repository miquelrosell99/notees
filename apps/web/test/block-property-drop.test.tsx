/**
 * S5 block-to-property drop tests (owner ruling 2026-10-20): the decision
 * matrix and the composed property.set, over the in-process client.
 *
 * - single text slot, EMPTY → one property.set {value:{nodeId}} at idx 0
 * - single text slot, OCCUPIED → no-op (never an overwrite)
 * - multi text slot → APPEND: nextIdx + a writer-minted UUIDv7 elementId
 *   (the PG5 OR-Set add)
 * - same-owner only: a block parented elsewhere is refused
 * - eligibility: a schema whose scopeClassIds excludes the owner is refused
 *   (R3's applier guard is the backstop)
 * - garbage: the owner itself or an ancestor of it is refused
 * - text slots only: a non-text schema is refused
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  executePropertyDrop,
  planPropertyDrop,
  propertyDropVerdict,
  workspacePropertyDropId,
  type PropertyDropArgs,
} from "../src/ui/property-drop.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

async function createBlock(
  client: WorkspaceClient,
  parentId: string | null,
  text: string,
): Promise<string> {
  return client.createObject({
    parentId,
    contentAst: [{ type: "text", text }],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("S5 property drop — the decision matrix", () => {
  it("namespaced droppable ids never collide with block ids", () => {
    expect(workspacePropertyDropId("owner", "schema")).toBe("workspace-prop-drop:owner:schema");
  });

  it("single slot, empty → set at idx 0; executes one property.set", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const block = await createBlock(client, owner, "Drag me");
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const args: PropertyDropArgs = { blockId: block, ownerNodeId: owner, propertySchemaId: schemaId };

    expect(propertyDropVerdict(client, args)).toBe("set");
    const plan = planPropertyDrop(client, args);
    expect(plan).toEqual({ kind: "set", idx: 0 });
    await executePropertyDrop(client, args, plan);

    const authored = client
      .getEffectiveProperties(owner)
      .filter((row) => row.propertySchemaId === schemaId && row.source === "authored");
    expect(authored).toHaveLength(1);
    expect(authored[0]!.value).toEqual({ nodeId: block });
    // The block stays a child of the owner (no move op).
    expect(client.getNode(block)!.parentId).toBe(owner);
  });

  it("single slot, occupied → no-op (never an overwrite)", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const first = await createBlock(client, owner, "First");
    const second = await createBlock(client, owner, "Second");
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    await client.setProperty(owner, schemaId, { nodeId: first }, 0);
    const args: PropertyDropArgs = { blockId: second, ownerNodeId: owner, propertySchemaId: schemaId };

    expect(propertyDropVerdict(client, args)).toBe("noop");
    const plan = planPropertyDrop(client, args);
    expect(plan.kind).toBe("noop");
    await executePropertyDrop(client, args, plan);

    const authored = client
      .getEffectiveProperties(owner)
      .filter((row) => row.propertySchemaId === schemaId && row.source === "authored");
    expect(authored).toHaveLength(1);
    expect(authored[0]!.value).toEqual({ nodeId: first });
  });

  it("multi slot → append with a fresh UUIDv7 elementId", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const first = await createBlock(client, owner, "First");
    const second = await createBlock(client, owner, "Second");
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text", multi: true });
    await client.setProperty(owner, schemaId, { nodeId: first }, 0);
    const args: PropertyDropArgs = { blockId: second, ownerNodeId: owner, propertySchemaId: schemaId };

    expect(propertyDropVerdict(client, args)).toBe("append");
    const plan = planPropertyDrop(client, args);
    expect(plan.kind).toBe("append");
    if (plan.kind !== "append") throw new Error("unreachable");
    expect(plan.idx).toBe(1);
    expect(plan.elementId).toMatch(UUID_RE);
    await executePropertyDrop(client, args, plan);

    const authored = client
      .getEffectiveProperties(owner)
      .filter((row) => row.propertySchemaId === schemaId && row.source === "authored")
      .sort((a, b) => a.idx - b.idx);
    expect(authored).toHaveLength(2);
    expect(authored.map((row) => row.value)).toEqual([{ nodeId: first }, { nodeId: second }]);
  });

  it("refuses a block parented to another node (same-owner only)", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const other = await createBlock(client, null, "Other");
    const foreign = await createBlock(client, other, "Foreign");
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });

    expect(
      propertyDropVerdict(client, { blockId: foreign, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("noop");
  });

  it("refuses when the schema's scope excludes the owner (R3 backstop)", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const block = await createBlock(client, owner, "Drag me");
    const otherClass = await client.createClass("Elsewhere");
    const schemaId = await client.createPropertySchema({
      name: "local",
      type: "text",
      scopeClassIds: [otherClass],
    });

    expect(
      propertyDropVerdict(client, { blockId: block, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("noop");
  });

  it("accepts when the owner carries a scope class (extends-aware)", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const block = await createBlock(client, owner, "Drag me");
    const cls = await client.createClass("Member");
    const schemaId = await client.createPropertySchema({
      name: "local",
      type: "text",
      scopeClassIds: [cls],
    });
    await client.assignClass(owner, cls);

    expect(
      propertyDropVerdict(client, { blockId: block, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("set");
  });

  it("refuses the owner itself and ancestors of the owner (garbage)", async () => {
    const client = await seedClient();
    const grandparent = await createBlock(client, null, "Grandparent");
    const owner = await createBlock(client, grandparent, "Owner");
    const block = await createBlock(client, owner, "Drag me");
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });

    expect(
      propertyDropVerdict(client, { blockId: owner, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("noop");
    expect(
      propertyDropVerdict(client, {
        blockId: grandparent,
        ownerNodeId: owner,
        propertySchemaId: schemaId,
      }),
    ).toBe("noop");
    // A sibling child of the owner is fine.
    expect(
      propertyDropVerdict(client, { blockId: block, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("set");
  });

  it("refuses non-text schemas (the row component is the offer surface)", async () => {
    const client = await seedClient();
    const owner = await createBlock(client, null, "Owner");
    const block = await createBlock(client, owner, "Drag me");
    const schemaId = await client.createPropertySchema({ name: "count", type: "number" });

    expect(
      propertyDropVerdict(client, { blockId: block, ownerNodeId: owner, propertySchemaId: schemaId }),
    ).toBe("noop");
  });
});
