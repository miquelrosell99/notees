/**
 * logseq-db flow specs — the Logseq DB (.sqlite) reconcile against a
 * MemoryTransport client (spec §4): the transit-kvs fixture decodes
 * through decodeKvs/buildLogseqDbModel, classes map by title
 * (unmapped → reported, members imported unclassed), the explicit
 * property table drives typed writes, matched nodes fill MISSING values
 * only (Notees wins — existing values never overwritten), missing nodes
 * are created with their PRESERVED Logseq uuid, unmapped properties are
 * reported with values not written, and views/system/assets land in the
 * skipped counts.
 *
 * The kvs rows are hand-rolled transit verbose JSON (the same dialect the
 * package specs encode with transit-js): `["^ ","~:keys",[[e,a,v,tx],…]]`
 * with "~:" keywords and "~u" uuids — ground forms only, no cache refs.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { buildLogseqDbModel, decodeKvs, type KvsRow, type LogseqDbModel } from "@notees/export";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  LOGSEQ_DB_PROPERTY_MAP,
  planLogseqDbImport,
  runLogseqDbImport,
} from "../src/features/import/flows/logseq-db.js";

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

// --- the transit-kvs fixture ------------------------------------------------

const KW = (s: string) => `~:${s}`;
const UU = (s: string) => `~u${s}`;
type Datom = [number, string, unknown, number];

function pageRow(addr: number, datoms: Datom[]): KvsRow {
  return { addr, content: JSON.stringify(["^ ", KW("keys"), datoms]) };
}

function fixtureRows(): KvsRow[] {
  const CLASS_PERSON = 10;
  const CLASS_UNMAPPED = 11;
  const PROP_AUTOR = 20;
  const PROP_SEXO = 21;
  const PROP_RATING = 22;
  const PROP_READ = 23;
  const PROP_DATE = 24;
  const PROP_UNMAPPED = 25;
  const CLOSED_MUJER = 30;
  const AUTHOR = 40;
  const EXISTING = 50; // pre-existing in the workspace
  const NEW_NODE = 51; // missing → created with preserved uuid
  const CHILD_BLOCK = 52; // parented under NEW_NODE
  const JOURNAL = 60;
  return [
    { addr: 0, content: JSON.stringify(["^ ", KW("schema"), 1]) },
    { addr: 1, content: "[]" },
    pageRow(1000, [
      [CLASS_PERSON, KW("db/ident"), KW("user.class/person-aaaa"), 1],
      [CLASS_PERSON, KW("block/title"), "Person", 1],
      [CLASS_PERSON, KW("block/uuid"), UU("aaaaaaaa-0000-4000-8000-000000000010"), 1],
    ]),
    pageRow(1001, [
      [CLASS_UNMAPPED, KW("db/ident"), KW("user.class/unmapped-bbbb"), 1],
      [CLASS_UNMAPPED, KW("block/title"), "LogseqOnlyClass", 1],
      [CLASS_UNMAPPED, KW("block/uuid"), UU("bbbbbbbb-0000-4000-8000-000000000011"), 1],
    ]),
    pageRow(1002, [
      [PROP_AUTOR, KW("db/ident"), KW("user.property/autor-cccc"), 1],
      [PROP_AUTOR, KW("block/title"), "Autor", 1],
      [PROP_AUTOR, KW("logseq.property/type"), KW("node"), 1],
      [PROP_AUTOR, KW("db/cardinality"), KW("db.cardinality/many"), 1],
    ]),
    pageRow(1003, [
      [PROP_SEXO, KW("db/ident"), KW("user.property/sexo-dddd"), 1],
      [PROP_SEXO, KW("block/title"), "Sexo", 1],
      [PROP_SEXO, KW("logseq.property/type"), KW("default"), 1],
    ]),
    pageRow(1004, [
      [PROP_RATING, KW("db/ident"), KW("user.property/valoracion-eeee"), 1],
      [PROP_RATING, KW("block/title"), "Valoración", 1],
      [PROP_RATING, KW("logseq.property/type"), KW("number"), 1],
    ]),
    pageRow(1005, [
      [PROP_READ, KW("db/ident"), KW("user.property/consumido-ffff"), 1],
      [PROP_READ, KW("block/title"), "Consumido", 1],
      [PROP_READ, KW("logseq.property/type"), KW("checkbox"), 1],
    ]),
    pageRow(1006, [
      [PROP_DATE, KW("db/ident"), KW("user.property/fecha-1111"), 1],
      [PROP_DATE, KW("block/title"), "Fecha", 1],
      [PROP_DATE, KW("logseq.property/type"), KW("date"), 1],
    ]),
    pageRow(1007, [
      [PROP_UNMAPPED, KW("db/ident"), KW("user.property/paginas-2222"), 1],
      [PROP_UNMAPPED, KW("block/title"), "Páginas", 1],
      [PROP_UNMAPPED, KW("logseq.property/type"), KW("number"), 1],
    ]),
    pageRow(1008, [
      [CLOSED_MUJER, KW("block/title"), "Mujer", 1],
      [CLOSED_MUJER, KW("block/uuid"), UU("30303030-0000-4000-8000-000000000030"), 1],
      [CLOSED_MUJER, KW("logseq.property/closed-value-property"), PROP_SEXO, 1],
    ]),
    pageRow(1009, [
      [AUTHOR, KW("block/uuid"), UU("40404040-0000-4000-8000-000000000040"), 1],
      [AUTHOR, KW("block/title"), "Ada Lovelace", 1],
    ]),
    pageRow(1010, [
      [EXISTING, KW("block/uuid"), UU("50505050-0000-4000-8000-000000000050"), 1],
      [EXISTING, KW("block/title"), "Existing Book", 1],
      [EXISTING, KW("block/tags"), CLASS_PERSON, 1],
      [EXISTING, KW("user.property/valoracion-eeee"), 1.5, 1],
      [EXISTING, KW("user.property/consumido-ffff"), true, 1],
      [EXISTING, KW("user.property/paginas-2222"), 300, 1],
    ]),
    pageRow(1011, [
      [NEW_NODE, KW("block/uuid"), UU("51515151-0000-4000-8000-000000000051"), 1],
      [NEW_NODE, KW("block/title"), "New Book", 1],
      [NEW_NODE, KW("block/tags"), CLASS_PERSON, 1],
      [NEW_NODE, KW("block/tags"), CLASS_UNMAPPED, 1],
      [NEW_NODE, KW("user.property/autor-cccc"), AUTHOR, 1],
      [NEW_NODE, KW("user.property/sexo-dddd"), CLOSED_MUJER, 1],
      [NEW_NODE, KW("user.property/valoracion-eeee"), 4.5, 1],
      [NEW_NODE, KW("user.property/consumido-ffff"), true, 1],
      [NEW_NODE, KW("user.property/fecha-1111"), JOURNAL, 1],
      [NEW_NODE, KW("user.property/paginas-2222"), 200, 1],
    ]),
    pageRow(1012, [
      [CHILD_BLOCK, KW("block/uuid"), UU("52525252-0000-4000-8000-000000000052"), 1],
      [CHILD_BLOCK, KW("block/title"), "A nested quote", 1],
      [CHILD_BLOCK, KW("block/parent"), NEW_NODE, 1],
      [CHILD_BLOCK, KW("block/order"), "a0", 1],
    ]),
    pageRow(1013, [
      [JOURNAL, KW("block/uuid"), UU("60606060-0000-4000-8000-000000000060"), 1],
      [JOURNAL, KW("block/journal-day"), 20240203, 1],
    ]),
    // a $$$views subtree and system + asset entities — skipped, counted.
    pageRow(1014, [
      [70, KW("block/title"), "$$$views", 1],
      [70, KW("block/uuid"), UU("70707070-0000-4000-8000-000000000070"), 1],
      [71, KW("block/title"), "view config", 1],
      [71, KW("block/uuid"), UU("71717171-0000-4000-8000-000000000071"), 1],
      [71, KW("block/parent"), 70, 1],
      [72, KW("db/ident"), KW("logseq.class/Root"), 1],
      [72, KW("block/title"), "Root Tag", 1],
      [73, KW("block/uuid"), UU("73737373-0000-4000-8000-000000000073"), 1],
      [73, KW("logseq.property.asset/checksum"), "abc", 1],
    ]),
  ];
}

function buildModel(): LogseqDbModel {
  return buildLogseqDbModel(decodeKvs(fixtureRows()));
}

// --- the workspace ------------------------------------------------------------

interface WorkspaceFixture {
  personClass: string;
  linkedAuthors: string;
  sexo: string;
  valoracion: string;
  consumido: string;
  fecha: string;
  existingId: string;
}

async function seedWorkspace(client: WorkspaceClient): Promise<WorkspaceFixture> {
  const personClass = await client.createClass("Person");
  const linkedAuthors = await client.createPropertySchema({ name: "Linked authors", type: "object", multi: true });
  const sexo = await client.createPropertySchema({
    name: "Sexo",
    type: "select",
    options: [
      { id: "opt-mujer", label: "Mujer" },
      { id: "opt-hombre", label: "Hombre" },
    ],
  });
  const valoracion = await client.createPropertySchema({ name: "Valoración", type: "number" });
  const consumido = await client.createPropertySchema({ name: "Consumido", type: "boolean" });
  const fecha = await client.createPropertySchema({ name: "Fecha", type: "datetime" });
  // The matched node pre-exists with its Logseq uuid, a Person, and an
  // EXISTING Valoración value the import must not overwrite.
  const existingId = "50505050-0000-4000-8000-000000000050";
  await client.createObject({ id: existingId, name: "Existing Book", classIds: [personClass] });
  await client.setProperty(existingId, valoracion, 1.5, 0);
  return {
    personClass,
    linkedAuthors,
    sexo,
    valoracion,
    consumido,
    fecha,
    existingId,
  };
}

const authoredValue = (client: WorkspaceClient, nodeId: string, schemaId: string) =>
  client
    .getEffectiveProperties(nodeId)
    .filter((row) => row.propertySchemaId === schemaId && row.source === "authored")
    .map((row) => row.value);

describe("logseq-db reconcile", () => {
  it("the fixture decodes into the expected model", () => {
    const model = buildModel();
    expect(model.classes.map((c) => c.title).sort()).toEqual(["LogseqOnlyClass", "Person"]);
    expect(model.skipped).toEqual({ views: 2, system: 1, assets: 1 });
    expect(model.dateByUuid.get("60606060-0000-4000-8000-000000000060")).toBe("20240203");
    const newBook = model.nodes.find((n) => n.uuid.endsWith("00051"))!;
    expect(newBook.classTitles).toEqual(["Person", "LogseqOnlyClass"]);
  });

  it("plan: counts create/fill/skip and reports unmapped classes/properties", async () => {
    const client = await seedClient();
    await seedWorkspace(client);
    const plan = planLogseqDbImport(buildModel(), client);
    // Creates: New Book + nested block + Ada + the "Mujer" closed value
    // (the parse layer ships closed values as ordinary graph entities).
    expect(plan.counts.create).toBe(4);
    expect(plan.counts.fill).toBe(1); // Existing Book (Consumido missing)
    expect(plan.counts.skip).toBe(0);
    expect(plan.unmappedClasses).toContain("LogseqOnlyClass");
    expect(plan.unmappedProperties).toContain("Páginas");
    expect(plan.samples.create.length).toBeGreaterThan(0);
  });

  it("run: creates missing nodes with preserved uuids, classes and typed properties", async () => {
    const client = await seedClient();
    const fixture = await seedWorkspace(client);
    const report = await runLogseqDbImport(buildModel(), client);
    expect(report.failures).toEqual([]);

    const newBookId = "51515151-0000-4000-8000-000000000051";
    const node = client.getNodeRaw(newBookId);
    expect(node).not.toBeUndefined();
    expect(node!.classIds).toContain(fixture.personClass);
    // Unmapped class → imported unclassed (never guessed).
    expect(node!.classIds.some((id) => id !== fixture.personClass)).toBe(false);

    // Properties typed per the mapping table.
    expect(authoredValue(client, newBookId, fixture.valoracion)).toEqual([4.5]);
    expect(authoredValue(client, newBookId, fixture.consumido)).toEqual([true]);
    expect(authoredValue(client, newBookId, fixture.sexo)).toEqual(["opt-mujer"]);
    // Autor (node ref to a model node) → per-idx node ref; the target was
    // created by the same import (two-pass).
    const authors = authoredValue(client, newBookId, fixture.linkedAuthors);
    expect(authors).toHaveLength(1);
    const authorId = (authors[0] as { nodeId: string }).nodeId;
    expect(client.getNodeRaw(authorId)?.contentAst).toEqual([
      { type: "text", text: "Ada Lovelace" },
    ]);
    // Fecha (date) → the day-node chain.
    const fecha = authoredValue(client, newBookId, fixture.fecha)[0] as { nodeId: string };
    expect(client.getNodeRaw(fecha.nodeId)).not.toBeUndefined();

    // The nested block resolves its parent to the created node.
    const child = client.getNodeRaw("52525252-0000-4000-8000-000000000052")!;
    expect(child.parentId).toBe(newBookId);

    // Unmapped property values were NOT written.
    expect(authoredValue(client, newBookId, "user.property/paginas-2222")).toEqual([]);

    expect(report.created).toBe(4);
    expect(report.filled).toBe(1);
    expect(report.skippedEntities).toEqual({ views: 2, system: 1, assets: 1 });
  });

  it("run: matched nodes fill MISSING values only — existing values win", async () => {
    const client = await seedClient();
    const fixture = await seedWorkspace(client);
    const before = authoredValue(client, fixture.existingId, fixture.valoracion);
    expect(before).toEqual([1.5]);

    const report = await runLogseqDbImport(buildModel(), client);
    expect(report.filled).toBe(1);

    // The pre-existing Valoración was NOT overwritten (Notees wins)…
    expect(authoredValue(client, fixture.existingId, fixture.valoracion)).toEqual([1.5]);
    // …and the title never changes.
    const node = client.getNodeRaw(fixture.existingId)!;
    expect(node.contentAst).toEqual([{ type: "text", text: "Existing Book" }]);
  });

  it("run is idempotent — a second pass fills nothing", async () => {
    const client = await seedClient();
    await seedWorkspace(client);
    await runLogseqDbImport(buildModel(), client);
    const second = await runLogseqDbImport(buildModel(), client);
    expect(second.created).toBe(0);
    expect(second.filled).toBe(0);
  });
});

describe("LOGSEQ_DB_PROPERTY_MAP", () => {
  it("carries the owner-validated table (Logseq title → Notees schema name)", () => {
    expect(LOGSEQ_DB_PROPERTY_MAP["Autor"]).toBe("Linked authors");
    expect(LOGSEQ_DB_PROPERTY_MAP["Sexo"]).toBe("Sexo");
    expect(LOGSEQ_DB_PROPERTY_MAP["Última consulta"]).toBe("Última consulta");
    expect(LOGSEQ_DB_PROPERTY_MAP["Tipo de estudio"]).toBe("Tipo de estudio");
    expect(Object.keys(LOGSEQ_DB_PROPERTY_MAP)).toHaveLength(13);
  });
});
