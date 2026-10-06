/**
 * Template family tests: ensureTemplateProperty authors the
 * has-template schema + system-class binding at the reserved UUID
 * (the fixed-UUID lesson — a reserved UUID is dead without an author),
 * self-heals an unseeded workspace, and is a complete no-op once present;
 * listClassTemplates resolves a class's bound templates in authored order,
 * dropping stale/trashed/non-template targets and reading [] before the
 * schema exists.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  ensureTemplateProperty,
  listClassTemplates,
  templatePropertyPresent,
} from "../src/ui/components/templateFamily.js";

const WS = "0192a000-0000-7000-8000-0000000000f1";
const ACTOR = "0192a000-0000-7000-8000-0000000000f2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

/** A server-seeded workspace carries the template class from boot. */
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

describe("ensureTemplateProperty", () => {
  it("authors the schema at the reserved id and binds it to the system class", async () => {
    const client = await seedClient();
    expect(templatePropertyPresent(client)).toBe(false);

    await ensureTemplateProperty(client);

    const schema = client
      .listPropertySchemas()
      .find((entry) => entry.id === SYSTEM_PROPERTY_UUIDS.hasTemplate);
    expect(schema).toBeDefined();
    expect(schema?.name).toBe("Templates");
    expect(schema?.type).toBe("object");
    expect(schema?.multi).toBe(true);
    expect(schema?.targetClassFilter).toEqual([SYSTEM_CLASS_UUIDS.template]);
    expect(
      client
        .getClassBindings(SYSTEM_CLASS_UUIDS.class)
        .map((binding) => binding.propertySchemaId),
    ).toContain(SYSTEM_PROPERTY_UUIDS.hasTemplate);
    expect(templatePropertyPresent(client)).toBe(true);
  });

  it("is idempotent: a second call authors nothing", async () => {
    const client = await seedClient();
    await ensureTemplateProperty(client);
    const schemasAfterFirst = client.listPropertySchemas().length;
    const bindingsAfterFirst = client.getClassBindings(SYSTEM_CLASS_UUIDS.class).length;

    await ensureTemplateProperty(client);
    await ensureTemplateProperty(client);

    expect(client.listPropertySchemas()).toHaveLength(schemasAfterFirst);
    expect(client.getClassBindings(SYSTEM_CLASS_UUIDS.class)).toHaveLength(bindingsAfterFirst);
  });

  it("self-heals an unseeded (offline-first) workspace, including the system class node", async () => {
    const client = await seedClient(new MemoryRelay());
    await ensureTemplateProperty(client);

    const classNode = client.getNode(SYSTEM_CLASS_UUIDS.class);
    expect(classNode?.isClass).toBe(true);
    expect(templatePropertyPresent(client)).toBe(true);
  });

  it("is a no-op when the schema already exists with a different authored shape", async () => {
    const client = await seedClient();
    // Pre-author by hand (e.g. a future server seed): the ensure must not
    // overwrite the existing schema row.
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.hasTemplate,
      name: "has-template",
      type: "object",
      multi: true,
      scope: "class",
      targetClassFilter: [SYSTEM_CLASS_UUIDS.template],
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.class, SYSTEM_PROPERTY_UUIDS.hasTemplate, {
      sequence: 0,
    });
    const before = client.listPropertySchemas().length;
    await ensureTemplateProperty(client);
    expect(client.listPropertySchemas()).toHaveLength(before);
  });
});

describe("listClassTemplates", () => {
  it("resolves bound templates in authored order and drops stale targets", async () => {
    const client = await seedClient();
    const classId = await client.createClass("meeting");
    const tplA = await client.createObject({
      presentAsMain: true,
      name: "Sync template",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    const tplB = await client.createObject({
      presentAsMain: true,
      name: "Retro template",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    // Not a template — must be filtered out even if referenced.
    const plain = await client.createObject({ presentAsMain: true, name: "Plain page" });
    // Trashed template — resolved via active-only getNode, so dropped.
    const trashed = await client.createObject({
      presentAsMain: true,
      name: "Old template",
      classIds: [SYSTEM_CLASS_UUIDS.template],
    });
    await client.deleteObject(trashed);

    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: tplB }, 0);
    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: tplA }, 1);
    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: plain }, 2);
    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: trashed }, 3);
    await client.setProperty(classId, SYSTEM_PROPERTY_UUIDS.hasTemplate, { nodeId: tplB }, 4); // duplicate

    const templates = listClassTemplates(client, classId);
    expect(templates.map((node) => node.id)).toEqual([tplB, tplA]);
    expect(templates.every((node) => node.classIds.includes(SYSTEM_CLASS_UUIDS.template))).toBe(
      true,
    );
  });

  it("returns [] for a class without templates and before the schema exists", async () => {
    const client = await seedClient();
    const classId = await client.createClass("empty");
    expect(listClassTemplates(client, classId)).toEqual([]);
  });
});
