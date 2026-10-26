/**
 * Logseq DB (.sqlite) decoder specs — the kvs transit-datom store decoded
 * into a canonical entity map (per-entity max-tx merge, transit cache
 * references resolved) and resolved into the import model: class/property
 * definitions, content nodes with parents/orders/tags, typed property values
 * (`:node` → uuid, `:date` → journal day, closed values → their title),
 * journal days indexed by uuid, and the skip classification ($$$views
 * subtrees, Logseq system idents, asset metadata).
 *
 * Fixtures are encoded in-test with the transit writer (the same dialect the
 * decoder reads), so cache-reference handling is exercised by construction.
 */

import transit from "transit-js";
import { describe, expect, it } from "vitest";

import {
  buildLogseqDbModel,
  decodeKvs,
  type KvsRow,
} from "../src/index.js";

const reader = transit.reader("json-verbose");
const writer = transit.writer("json-verbose");
const kw = (s: string) => transit.keyword(s);
const uu = (s: string) => transit.uuid(s);

type Datom = [number, unknown, unknown, number];

function rowsOf(pages: Datom[][], extraRows: { addr: number; value: unknown }[] = []): KvsRow[] {
  const rows: KvsRow[] = [
    // addr 0 (schema row) and addr 1 (kv index) must be ignored by the decoder.
    { addr: 0, content: writer.write(transit.map([kw("schema"), transit.map([kw("x"), 1])])) },
    { addr: 1, content: writer.write([[1, kw("kv/value"), 1, 1]]) },
    ...extraRows.map((r) => ({ addr: r.addr, content: writer.write(r.value) })),
    ...pages.map((datoms, i) => ({
      addr: 1000 + i,
      content: writer.write(transit.map([kw("keys"), datoms])),
    })),
  ];
  // Sanity: our own fixtures must round-trip through the reader.
  for (const r of rows) reader.read(r.content);
  return rows;
}

describe("decodeKvs", () => {
  it("merges datoms across rows into per-entity attributes", () => {
    const rows = rowsOf([
      [
        [1, kw("block/uuid"), uu("11111111-2222-4333-8444-555555555555"), 10],
        [1, kw("block/title"), "Hello", 10],
      ],
    ]);
    const entities = decodeKvs(rows);
    expect(entities.get(1)).toEqual({
      ":block/uuid": "11111111-2222-4333-8444-555555555555",
      ":block/title": "Hello",
    });
  });

  it("keeps the highest-tx value per attribute", () => {
    const rows = rowsOf(
      [
        [[1, kw("block/title"), "Old", 5]],
        [[1, kw("block/title"), "New", 9]],
      ],
    );
    const entities = decodeKvs(rows);
    expect(entities.get(1)?.[":block/title"]).toBe("New");
  });

  it("resolves transit cache references emitted by the writer", () => {
    // The writer cache-dedupes repeated keywords — decoding must follow refs.
    const rows = rowsOf([
      [
        [1, kw("block/tags"), 7, 1],
        [1, kw("block/tags"), 8, 1],
        [2, kw("block/tags"), 7, 1],
      ],
    ]);
    const entities = decodeKvs(rows);
    expect(entities.get(1)?.[":block/tags"]).toEqual([7, 8]);
    expect(entities.get(2)?.[":block/tags"]).toEqual(7);
  });
});

describe("buildLogseqDbModel", () => {
  const CLASS_PERSON = 10;
  const CLASS_QUOTE = 11;
  const PROP_AUTHOR = 20;
  const PROP_READ = 21;
  const PROP_SEXO = 22;
  const PERSON_NODE = 30;
  const PAGE = 40;
  const BLOCK = 41;
  const JOURNAL = 50;

  function fixtureRows(): KvsRow[] {
    return rowsOf([
      // user class: Person
      [
        [CLASS_PERSON, kw("db/ident"), kw("user.class/person-aaaa"), 1],
        [CLASS_PERSON, kw("block/title"), "Person", 1],
        [CLASS_PERSON, kw("block/uuid"), uu("aaaaaaaa-0000-4000-8000-000000000001"), 1],
      ],
      // logseq system class — must be classified system, not a mapped class
      [
        [CLASS_QUOTE, kw("db/ident"), kw("logseq.class/Root"), 1],
        [CLASS_QUOTE, kw("block/title"), "Root Tag", 1],
      ],
      // property: Autor (node, cardinality many)
      [
        [PROP_AUTHOR, kw("db/ident"), kw("user.property/autor-bbbb"), 1],
        [PROP_AUTHOR, kw("block/title"), "Autor", 1],
        [PROP_AUTHOR, kw("logseq.property/type"), kw("node"), 1],
        [PROP_AUTHOR, kw("db/cardinality"), kw("db.cardinality/many"), 1],
      ],
      // property: Última consulta (date)
      [
        [PROP_READ, kw("db/ident"), kw("user.property/ultima-cccc"), 1],
        [PROP_READ, kw("block/title"), "Última consulta", 1],
        [PROP_READ, kw("logseq.property/type"), kw("date"), 1],
      ],
      // property: Sexo (default with closed values)
      [
        [PROP_SEXO, kw("db/ident"), kw("user.property/sexo-dddd"), 1],
        [PROP_SEXO, kw("block/title"), "Sexo", 1],
        [PROP_SEXO, kw("logseq.property/type"), kw("default"), 1],
      ],
      // closed value: Mujer
      [
        [60, kw("block/title"), "Mujer", 1],
        [60, kw("block/uuid"), uu("bbbbbbbb-0000-4000-8000-000000000060"), 1],
        [60, kw("logseq.property/closed-value-property"), PROP_SEXO, 1],
      ],
      // a person node (target of Autor)
      [
        [PERSON_NODE, kw("block/uuid"), uu("cccccccc-0000-4000-8000-000000000030"), 1],
        [PERSON_NODE, kw("block/title"), "Ada Lovelace", 1],
      ],
      // journal day 2024-02-03
      [
        [JOURNAL, kw("block/uuid"), uu("dddddddd-0000-4000-8000-000000000050"), 1],
        [JOURNAL, kw("block/journal-day"), 20240203, 1],
      ],
      // a page
      [
        [PAGE, kw("block/uuid"), uu("eeeeeeee-0000-4000-8000-000000000040"), 1],
        [PAGE, kw("block/title"), "My Page", 1],
      ],
      // a block under the page with tags + properties
      [
        [BLOCK, kw("block/uuid"), uu("ffffffff-0000-4000-8000-000000000041"), 1],
        [BLOCK, kw("block/title"), "A quote", 1],
        [BLOCK, kw("block/parent"), PAGE, 1],
        [BLOCK, kw("block/order"), "a0", 1],
        [BLOCK, kw("block/tags"), CLASS_PERSON, 1],
        [BLOCK, kw("user.property/autor-bbbb"), PERSON_NODE, 1],
        [BLOCK, kw("user.property/ultima-cccc"), JOURNAL, 1],
        [BLOCK, kw("user.property/sexo-dddd"), 60, 1],
      ],
      // a $$$views subtree — skipped
      [
        [70, kw("block/title"), "$$$views", 1],
        [70, kw("block/uuid"), uu("99999999-0000-4000-8000-000000000070"), 1],
      ],
      [
        [71, kw("block/title"), "some view config", 1],
        [71, kw("block/uuid"), uu("99999999-0000-4000-8000-000000000071"), 1],
        [71, kw("block/parent"), 70, 1],
      ],
      // an asset metadata node — counted as asset, not imported
      [
        [80, kw("block/uuid"), uu("88888888-0000-4000-8000-000000000080"), 1],
        [80, kw("logseq.property.asset/checksum"), "abc123", 1],
      ],
    ]);
  }

  it("extracts class and property definitions", () => {
    const model = buildLogseqDbModel(decodeKvs(fixtureRows()));
    expect(model.classes).toEqual([
      {
        uuid: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "Person",
        logseqIdent: ":user.class/person-aaaa",
      },
    ]);
    expect(model.properties).toEqual([
      {
        ident: ":user.property/autor-bbbb",
        title: "Autor",
        valueType: ":node",
        cardinalityMany: true,
      },
      {
        ident: ":user.property/ultima-cccc",
        title: "Última consulta",
        valueType: ":date",
        cardinalityMany: false,
      },
      {
        ident: ":user.property/sexo-dddd",
        title: "Sexo",
        valueType: ":default",
        cardinalityMany: false,
      },
    ]);
  });

  it("resolves nodes with parents, orders, class titles and typed property values", () => {
    const model = buildLogseqDbModel(decodeKvs(fixtureRows()));
    const block = model.nodes.find((n) => n.uuid.endsWith("00041"));
    expect(block).toMatchObject({
      title: "A quote",
      parentUuid: "eeeeeeee-0000-4000-8000-000000000040",
      order: "a0",
      classTitles: ["Person"],
    });
    expect(block?.props).toEqual([
      {
        ident: ":user.property/autor-bbbb",
        title: "Autor",
        values: [{ kind: "node", uuid: "cccccccc-0000-4000-8000-000000000030" }],
      },
      {
        ident: ":user.property/ultima-cccc",
        title: "Última consulta",
        values: [{ kind: "date", day: "20240203" }],
      },
      {
        ident: ":user.property/sexo-dddd",
        title: "Sexo",
        values: [{ kind: "text", text: "Mujer" }],
      },
    ]);
  });

  it("indexes journal days by uuid and excludes them from nodes", () => {
    const model = buildLogseqDbModel(decodeKvs(fixtureRows()));
    expect(model.dateByUuid.get("dddddddd-0000-4000-8000-000000000050")).toBe("20240203");
    expect(model.nodes.some((n) => n.uuid.endsWith("00050"))).toBe(false);
  });

  it("classifies views, system, asset and closed-value entities as skipped", () => {
    const model = buildLogseqDbModel(decodeKvs(fixtureRows()));
    expect(model.skipped.views).toBe(2);
    expect(model.skipped.system).toBe(1);
    expect(model.skipped.assets).toBe(1);
    expect(model.skipped.closedValues).toBe(1);
    expect(model.nodes.some((n) => n.uuid.endsWith("00070") || n.uuid.endsWith("00071"))).toBe(false);
    expect(model.nodes.some((n) => n.uuid.endsWith("00080"))).toBe(false);
    // The closed value (Mujer) is a select option's backing entity — never a
    // page. Its property-value resolution still works by title (the decode
    // spec above: Sexo → "Mujer").
    expect(model.nodes.some((n) => n.uuid.endsWith("00060"))).toBe(false);
  });

  it("normalizes a checkbox string 'true'/'false' to boolean", () => {
    const rows = rowsOf([
      [
        [1, kw("block/uuid"), uu("11111111-2222-4333-8444-555555555555"), 1],
        [2, kw("db/ident"), kw("user.property/done-zzzz"), 1],
        [2, kw("block/title"), "Done", 1],
        [2, kw("logseq.property/type"), kw("checkbox"), 1],
        [1, kw("user.property/done-zzzz"), "true", 1],
      ],
    ]);
    const model = buildLogseqDbModel(decodeKvs(rows));
    expect(model.nodes[0]!.props).toEqual([
      { ident: ":user.property/done-zzzz", title: "Done", values: [{ kind: "boolean", value: true }] },
    ]);
  });
});
