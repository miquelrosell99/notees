/**
 * The Zotero RDF import planner (scripts/import-zotero-rdf.mts, planner
 * portion) — matching parsed RDF items against workspace state and
 * producing the write plan with conflict reporting.
 *
 * The reader is FAKED per case: the real adapter over a scratch Store is
 * Task 7's wiring. Rules pinned here:
 *  - citekey exact match → `update`; doi/isbn match → `adopt` (the Zotero
 *    citationKey rides into `sets` under the citekey key — a node carrying
 *    a DIFFERENT citekey reports it in `conflicts` too, never silently);
 *  - no match → `create`, classKey via ZOTERO_ITEM_TYPE_TO_CLASS
 *    (`case` → `document`); an item with nothing to match on (no
 *    citationKey, no doi/isbn) still plans as `create`;
 *  - equal values (whitespace-collapsed; doi case-insensitive; isbn
 *    digit/X-normalized — the duplicates.ts precedents) are removed from
 *    `sets`; creators compare as "; "-joined strings;
 *  - `keepExisting: true` drops conflicting fields from `sets` (they stay
 *    in `conflicts`); false keeps them (RDF wins);
 *  - a citationKey repeated WITHIN the file flags every occurrence after
 *    the first via `duplicateOf` (plan index of the first entry) plus a
 *    conflict entry — the plan must never silently double-create.
 */

import { describe, expect, it } from "vitest";

import {
  planImport,
  type ImportPlanEntry,
  type ImportStateReader,
} from "../../../scripts/import-zotero-rdf.mts";
import type { ZoteroRdfItem } from "../../../scripts/zotero-rdf-parser.mts";

interface FakeHit {
  nodeId: string;
  citekey: string;
  doi?: string;
  isbn?: string;
}

/** A reader backed by plain maps — find* first-hit-wins, then nodeValues. */
function fakeReader(opts: {
  byCitekey?: Map<string, FakeHit>;
  byDoi?: Map<string, FakeHit>;
  byIsbn?: Map<string, FakeHit>;
  values?: Map<string, Record<string, string>>;
}): ImportStateReader {
  return {
    findSourceByCitekey: (key) => opts.byCitekey?.get(key) ?? null,
    findSourceByIdentifier: (prop, value) =>
      (prop === "doi" ? opts.byDoi?.get(value) : opts.byIsbn?.get(value)) ?? null,
    nodeValues: (nodeId) => opts.values?.get(nodeId) ?? {},
  };
}

function item(partial: Partial<ZoteroRdfItem> & Pick<ZoteroRdfItem, "uri" | "itemType" | "title">): ZoteroRdfItem {
  return { fields: {}, creators: [], attachmentRefs: [], ...partial };
}

describe("planImport", () => {
  it("(a) citekey hit → update, equal values excluded from sets", () => {
    const rdfItem = item({
      uri: "urn:isbn:978-0-323-85755-0",
      itemType: "book",
      title: "Safety risk management for medical devices",
      citationKey: "elahi2022",
      fields: {
        doi: "10.1016/C2020-0-1234-5",
        publisher: "Academic Press",
        language: "en",
      },
      creators: [{ role: "authors", names: ["Elahi, Bijan"] }],
    });
    const state = fakeReader({
      byCitekey: new Map([
        ["elahi2022", { nodeId: "node-1", citekey: "elahi2022", doi: "10.1016/c2020-0-1234-5" }],
      ]),
      values: new Map([
        [
          "node-1",
          {
            citekey: "elahi2022",
            // case-different DOI + whitespace-padded authors → equal after
            // normalization, so both must be EXCLUDED from sets.
            doi: "10.1016/c2020-0-1234-5",
            publisher: "Academic Press",
            authors: "  Elahi,   Bijan ",
          },
        ],
      ]),
    });

    const plan = planImport([rdfItem], state, { keepExisting: false });
    expect(plan).toHaveLength(1);
    const entry = plan[0]!;
    expect(entry.action).toBe("update");
    expect(entry.nodeId).toBe("node-1");
    expect(entry.classKey).toBe("book");
    // Equal values (doi, publisher, authors) removed; only the new field stays.
    expect(entry.sets).toEqual({ language: "en" });
    expect(entry.conflicts).toEqual([]);
  });

  it("(b) doi hit with empty node citekey → adopt, citekey lands in sets", () => {
    const rdfItem = item({
      uri: "http://zotero.org/users/1/items/ABC",
      itemType: "journalArticle",
      title: "Some article",
      citationKey: "smith2020",
      fields: { doi: "10.1000/smith2020", publicationTitle: "A Journal" },
    });
    const state = fakeReader({
      byDoi: new Map([["10.1000/smith2020", { nodeId: "node-7", citekey: "" }]]),
      values: new Map([
        ["node-7", { doi: "10.1000/smith2020", publicationTitle: "A Journal" }],
      ]),
    });

    const [entry] = planImport([rdfItem], state, { keepExisting: false });
    expect(entry!.action).toBe("adopt");
    expect(entry!.nodeId).toBe("node-7");
    expect(entry!.classKey).toBe("journal_article");
    // doi + publicationTitle equal → dropped; citekey adopted.
    expect(entry!.sets).toEqual({ citekey: "smith2020" });
    expect(entry!.conflicts).toEqual([]);
  });

  it("(c) doi hit with a DIFFERENT node citekey → adopt + citekey conflict (Review Focus 3)", () => {
    const rdfItem = item({
      uri: "http://zotero.org/users/1/items/ABC",
      itemType: "journalArticle",
      title: "Some article",
      citationKey: "smith2020",
      fields: { doi: "10.1000/smith2020" },
    });
    const state = fakeReader({
      byDoi: new Map([["10.1000/smith2020", { nodeId: "node-7", citekey: "smith" }]]),
      values: new Map([["node-7", { doi: "10.1000/smith2020", citekey: "smith" }]]),
    });

    const [entry] = planImport([rdfItem], state, { keepExisting: false });
    expect(entry!.action).toBe("adopt");
    expect(entry!.nodeId).toBe("node-7");
    // RDF wins by default: the new citekey stays in sets AND the old-vs-new
    // pair is reported — never silently merged.
    expect(entry!.sets).toEqual({ citekey: "smith2020" });
    expect(entry!.conflicts).toEqual([
      { property: "citekey", nodeValue: "smith", rdfValue: "smith2020" },
    ]);
  });

  it("(d) no hit → create with classKey (case → document)", () => {
    const legalCase = item({
      uri: "http://zotero.org/users/1/items/CASE",
      itemType: "case",
      title: "Caso ejemplar",
      citationKey: "caso2021",
      fields: { court: "Tribunal Supremo", dateDecided: "2021-03-04" },
    });
    // Nothing to match on: no citationKey, no doi/isbn — still a create.
    const orphan = item({
      uri: "http://zotero.org/users/1/items/NOKEY",
      itemType: "book",
      title: "Keyless book",
      fields: { publisher: "Some Press" },
    });
    const state = fakeReader({});

    const plan = planImport([legalCase, orphan], state, { keepExisting: false });
    expect(plan).toHaveLength(2);
    expect(plan[0]!.action).toBe("create");
    expect(plan[0]!.nodeId).toBeUndefined();
    expect(plan[0]!.classKey).toBe("document");
    expect(plan[0]!.sets).toEqual({
      citekey: "caso2021",
      court: "Tribunal Supremo",
      dateDecided: "2021-03-04",
    });
    expect(plan[1]!.action).toBe("create");
    expect(plan[1]!.sets).toEqual({ publisher: "Some Press" });
    for (const entry of plan) expect(entry.conflicts).toEqual([]);
  });

  it("(e) keepExisting: true → conflicting fields dropped from sets, still in conflicts", () => {
    const rdfItem = item({
      uri: "http://zotero.org/users/1/items/DEF",
      itemType: "book",
      title: "A book",
      citationKey: "doe2022",
      fields: { publicationDate: "2022", language: "en" },
    });
    const state = fakeReader({
      byCitekey: new Map([["doe2022", { nodeId: "node-9", citekey: "doe2022" }]]),
      values: new Map([
        ["node-9", { citekey: "doe2022", publicationDate: "2021", authors: "Doe, Jane" }],
      ]),
    });

    const [entry] = planImport([rdfItem], state, { keepExisting: true });
    expect(entry!.action).toBe("update");
    // publicationDate conflicts → DROPPED from sets (keepExisting); the
    // empty language still fills; the node's authors stay untouched.
    expect(entry!.sets).toEqual({ language: "en" });
    expect(entry!.conflicts).toEqual([
      { property: "publicationDate", nodeValue: "2021", rdfValue: "2022" },
    ]);

    // And with keepExisting: false the same conflict stays in sets (RDF wins).
    const [rdfWins] = planImport([rdfItem], state, { keepExisting: false });
    expect(rdfWins!.sets).toEqual({ publicationDate: "2022", language: "en" });
    expect(rdfWins!.conflicts).toEqual(entry!.conflicts);
  });

  it("(f) duplicate citationKey within the file → second entry flagged, never double-created", () => {
    const first = item({
      uri: "http://zotero.org/users/1/items/DUP1",
      itemType: "book",
      title: "First copy",
      citationKey: "dup2020",
      fields: { publisher: "Press A" },
    });
    const second = item({
      uri: "http://zotero.org/users/1/items/DUP2",
      itemType: "book",
      title: "Second copy",
      citationKey: "dup2020",
      fields: { publisher: "Press B" },
    });
    const state = fakeReader({});

    const plan = planImport([first, second], state, { keepExisting: false });
    expect(plan).toHaveLength(2);
    expect(plan[0]!.action).toBe("create");
    expect(plan[0]!.duplicateOf).toBeUndefined();
    expect(plan[0]!.conflicts).toEqual([]);

    // Second occurrence: still planned (reportable) but flagged as a
    // same-file duplicate of plan index 0 — the CLI must skip it on apply.
    expect(plan[1]!.action).toBe("create");
    expect(plan[1]!.duplicateOf).toBe(0);
    expect(plan[1]!.conflicts).toEqual([
      {
        property: "citationKey",
        nodeValue: "(earlier item in this file)",
        rdfValue: "dup2020",
      },
    ]);
  });

  it("(g) datetime equality at the claimed precision: human RDF date vs ISO node read-back → zero writes", () => {
    // The node side reads back ISO truncated at the ref's precision
    // ("2016-06", the valueTextOf parseDateNodeId spelling); the RDF side
    // is verbatim Zotero ("June 2016"). Same date at the same precision
    // must plan NOTHING — otherwise every re-run conflicts and re-writes.
    const rdfItem = item({
      uri: "http://zotero.org/users/1/items/DATE1",
      itemType: "journalArticle",
      title: "Human date article",
      citationKey: "june2016",
      fields: { publicationDate: "June 2016" },
    });
    const state = fakeReader({
      byCitekey: new Map([["june2016", { nodeId: "node-d1", citekey: "june2016" }]]),
      values: new Map([
        ["node-d1", { citekey: "june2016", publicationDate: "2016-06" }],
      ]),
    });

    const [entry] = planImport([rdfItem], state, { keepExisting: false });
    expect(entry!.action).toBe("update");
    expect(entry!.sets).toEqual({});
    expect(entry!.conflicts).toEqual([]);

    // The same pin across the new tiers: MM/YYYY and day + month name.
    const variants = item({
      ...rdfItem,
      fields: { publicationDate: "01/2022" },
      citationKey: "jan2022",
    });
    const stateVariants = fakeReader({
      byCitekey: new Map([["jan2022", { nodeId: "node-d2", citekey: "jan2022" }]]),
      values: new Map([["node-d2", { citekey: "jan2022", publicationDate: "2022-01" }]]),
    });
    const [mmyyyy] = planImport([variants], stateVariants, { keepExisting: false });
    expect(mmyyyy!.sets).toEqual({});
    expect(mmyyyy!.conflicts).toEqual([]);
  });

  it("(h) datetime keys with GENUINELY different dates still conflict and plan the set", () => {
    const rdfItem = item({
      uri: "http://zotero.org/users/1/items/DATE2",
      itemType: "journalArticle",
      title: "Human date article",
      citationKey: "june2016",
      fields: { publicationDate: "June 2016" },
    });
    const state = fakeReader({
      byCitekey: new Map([["june2016", { nodeId: "node-d1", citekey: "june2016" }]]),
      values: new Map([
        ["node-d1", { citekey: "june2016", publicationDate: "2017-06" }],
      ]),
    });

    const [entry] = planImport([rdfItem], state, { keepExisting: false });
    expect(entry!.sets).toEqual({ publicationDate: "June 2016" });
    expect(entry!.conflicts).toEqual([
      { property: "publicationDate", nodeValue: "2017-06", rdfValue: "June 2016" },
    ]);
  });
});

export type { ImportPlanEntry };
