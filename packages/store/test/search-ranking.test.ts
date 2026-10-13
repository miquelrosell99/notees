/**
 * Search store batch: ranked search, snippets, and property values in
 * the FTS index.
 *
 *  - Ranking: priority tiers computed in JS over the FTS candidate set
 *    (literal main-title > literal block > ordered terms > parent-title >
 *    partial), FTS score, recency, id — identical on BOTH adapters (the
 *    tier scorer is one shared implementation; FTS5's bm25 and FTS4's
 *    matchinfo hit count differ only as the final in-tier tiebreak).
 *  - Snippets: searchSnippet excerpts the densest query-term cluster with
 *    char-accurate match spans, computed in JS over the derived plaintext
 *    (the stock sql.js FTS4 snippet() emits its column index into the
 *    output — verified — so the SQL function is not used).
 *  - Property values: text-ish values (carrier content, scalar strings, select
 *    labels, numbers) fold into the indexed plaintext on property.set /
 *    property.unset; reindexAllSearch rebuilds the same rows.
 *
 * Runs against BOTH shipped adapters, like the main store suite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope, type ContentAst, type Envelope } from "@notees/protocol";

import { Store, reindexAllSearch, type StoreBackend } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";
import { sqljsBackend } from "../src/adapters/sqljs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

function env(
  opType: string,
  payload: Record<string, unknown>,
  physical: number,
  logical = 0,
  actor = ACTOR,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: actor,
    deviceId: "test-device-search",
    hlc: { physical, logical },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function text(textValue: string): ContentAst {
  return [{ type: "text", text: textValue }];
}

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const adapters: { name: string; makeBackend: () => StoreBackend }[] = [
  { name: "sqljs", makeBackend: () => sqljsBackend(sqlModule) },
  {
    name: "better-sqlite3",
    makeBackend: () => {
      const dir = mkdtempSync(join(tmpdir(), "notees-search-test-"));
      tmpDirs.push(dir);
      return betterSqlite3Backend(join(dir, "store.db"));
    },
  },
];

describe.each(adapters)("$name", ({ makeBackend }) => {
  function makeStore(): Store {
    return Store.open(makeBackend());
  }

  describe("relevance ranking + recency", () => {
    it("a document with more term hits outranks a single-hit document at equal title shape", () => {
      const store = makeStore();
      // Equal-length titles: the tier + length tie, so the in-tier FTS
      // score decides — the denser document ranks first even though it is
      // OLDER (relevance dominates the recency tiebreak).
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f1", contentAst: text("needle needle needle x") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f2", contentAst: text("needle in a haystack y") }, 1727200002000));
      const hits = store.search("needle", 10).map((h) => h.nodeId);
      expect(hits[0]).toBe("0192a000-0000-7000-8000-0000000000f1");
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000f2");
    });

    it("a shorter literal title match outranks a longer one (directness first)", () => {
      const store = makeStore();
      // Both titles carry the literal at position 0 — the shorter, more
      // direct title wins (the priority-ranking subscore, ahead of the
      // FTS hit count: density no longer promotes long content pages over
      // an exact title match).
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f1", contentAst: text("needle needle needle haystack") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f2", contentAst: text("needle in a haystack") }, 1727200002000));
      expect(store.search("needle", 10).map((h) => h.nodeId)).toEqual([
        "0192a000-0000-7000-8000-0000000000f2",
        "0192a000-0000-7000-8000-0000000000f1",
      ]);
    });

    it("equal shape tiebreaks by updated_at recency (newer first)", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f3", contentAst: text("tournesol alfa") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f4", contentAst: text("tournesol beta") }, 1727200002000));
      expect(store.search("tournesol", 10).map((h) => h.nodeId)).toEqual(["0192a000-0000-7000-8000-0000000000f4", "0192a000-0000-7000-8000-0000000000f3"]);
    });

    it("prefix terms rank like full terms", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f5", contentAst: text("synchronoflash generator") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f6", contentAst: text("syncopated rhythm") }, 1727200002000));
      const hits = store.search("sync", 10).map((h) => h.nodeId);
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000f5");
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000f6");
    });

    it("the limit caps the ranked list", () => {
      const store = makeStore();
      for (let i = 0; i < 5; i++) {
        store.apply(env("object.create", { objectId: `0192a000-0000-7000-8000-00000000002${i}`, contentAst: text("calibrachoa bloom") }, 1727200001000 + i * 1000));
      }
      expect(store.search("calibrachoa", 3)).toHaveLength(3);
    });

    it("ranked order is deterministic across repeated queries", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000fc", contentAst: text("rhodochrosite rhodochrosite gem") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000fd", contentAst: text("rhodochrosite from peru") }, 1727200002000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000fe", contentAst: text("rhodochrosite from argentina") }, 1727200003000));
      // All three are literal main-title matches (tier 0) at position 0 —
      // the shorter title ranks first (peru 24 < argentina 28 < the
      // double-hit 29); hit density no longer leads inside the tier. The
      // same order must come out of FTS5's bm25 rank and FTS4's matchinfo
      // scoring, and stay stable across queries.
      const expected = ["0192a000-0000-7000-8000-0000000000fd", "0192a000-0000-7000-8000-0000000000fe", "0192a000-0000-7000-8000-0000000000fc"];
      for (let i = 0; i < 3; i++) {
        expect(store.search("rhodochrosite", 10).map((h) => h.nodeId)).toEqual(expected);
      }
    });
  });

  describe("priority ranking (owner 2026-10-13)", () => {
    // The GMI scenario: an exact-title main node must lead the results,
    // ahead of content-heavy pages, blocks, and partial matches.
    const ORG = "0192a000-0000-7000-8000-0000000000d1";
    const HEAVY = "0192a000-0000-7000-8000-0000000000d2";
    const BLOCK = "0192a000-0000-7000-8000-0000000000d3";
    const BLOCK_PARENT = "0192a000-0000-7000-8000-0000000000d4";
    const ECUADOR = "0192a000-0000-7000-8000-0000000000d5";

    function gmiStore(): Store {
      const store = makeStore();
      store.apply(env("object.create", { objectId: ORG, contentAst: text("GMI Dental Implantology, S.L") }, 1727200001000));
      store.apply(
        env("object.create", { objectId: HEAVY, contentAst: text("GMI Dental Implantology/RP-DAD-25134 usability evaluation gmi dental gmi dental gmi dental") }, 1727200002000),
      );
      store.apply(env("object.create", { objectId: BLOCK_PARENT, contentAst: text("Parent page") }, 1727200003000));
      store.apply(env("object.create", { objectId: BLOCK, parentId: BLOCK_PARENT, contentAst: text("notes about gmi dental products") }, 1727200004000));
      store.apply(env("object.create", { objectId: ECUADOR, contentAst: text("GMI Ecuador") }, 1727200005000));
      return store;
    }

    it("literal main-title matches lead; blocks and partial matches follow", () => {
      const hits = gmiStore().search("gmi dental", 20).map((h) => h.nodeId);
      expect(hits).toEqual([ORG, HEAVY, BLOCK, ECUADOR]);
    });

    it("the direct title match leads for prefix refinements and ordered terms", () => {
      const store = gmiStore();
      // Both prefix refinements of the direct title.
      expect(store.search("gmi denta", 20).map((h) => h.nodeId)[0]).toBe(ORG);
      expect(store.search("gmi dental impl", 20).map((h) => h.nodeId)[0]).toBe(ORG);
      // Ordered but non-adjacent: "gmi … implantology" — the shorter title
      // still wins the tier subscore.
      expect(store.search("gmi implantology", 20).map((h) => h.nodeId)[0]).toBe(ORG);
    });

    it("ordered non-adjacent term matches rank between literal and partial", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e1", contentAst: text("alpha beta") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e2", contentAst: text("alpha omega beta") }, 1727200002000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e3", contentAst: text("alpha") }, 1727200003000));
      expect(store.search("alpha beta", 10).map((h) => h.nodeId)).toEqual([
        "0192a000-0000-7000-8000-0000000000e1",
        "0192a000-0000-7000-8000-0000000000e2",
        "0192a000-0000-7000-8000-0000000000e3",
      ]);
    });

    it("a fully quoted query is exact mode: exact substring, no partials", () => {
      const store = gmiStore();
      // Ordered-but-not-literal: both terms, in order, never adjacent.
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d6", contentAst: text("gmi and dental chronicle") }, 1727200006000));
      // Default mode includes the scattered node as an ordered match…
      expect(store.search("gmi dental", 20).map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000d6");
      // …exact mode does not: only exact substrings rank.
      expect(store.search('"gmi dental"', 20).map((h) => h.nodeId)).toEqual([ORG, HEAVY, BLOCK]);
      // Case-insensitive, punctuation intact.
      expect(store.search('"S.L"', 10).map((h) => h.nodeId)).toContain(ORG);
      expect(store.search('""', 10)).toEqual([]);
    });

    it("a leading caret is starts-with mode: position 0 only", () => {
      const store = gmiStore();
      // A block whose TEXT starts with the query (its title doesn't exist —
      // a block's text is the haystack).
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000d7", parentId: BLOCK_PARENT, contentAst: text("gmi dental products notes") }, 1727200006000));
      const hits = store.search("^gmi dental", 20).map((h) => h.nodeId);
      expect(hits).toEqual([ORG, HEAVY, "0192a000-0000-7000-8000-0000000000d7"]);
      // BLOCK's text mentions the query mid-string — excluded in starts mode.
      expect(hits).not.toContain(BLOCK);
      // A broader prefix: every "gmi…" title qualifies, the shortest first.
      const broad = store.search("^gmi", 10).map((h) => h.nodeId);
      expect(broad[0]).toBe(ECUADOR);
      expect(broad).toContain(ORG);
      expect(store.search("^", 10)).toEqual([]);
    });

    it("a block surfaces when its first parent's title matches the query", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e4", contentAst: text("Q3 Roadmap") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e5", parentId: "0192a000-0000-7000-8000-0000000000e4", contentAst: text("budget figures") }, 1727200002000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e6", contentAst: text("roadmap archive") }, 1727200003000));
      // "budget figures" carries no "roadmap" — the block rides its parent's
      // title (tier 4), below every main-node match but in the list.
      const hits = store.search("roadmap", 10).map((h) => h.nodeId);
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000e5");
      expect(hits.indexOf("0192a000-0000-7000-8000-0000000000e5")).toBeGreaterThan(
        hits.indexOf("0192a000-0000-7000-8000-0000000000e4"),
      );
      expect(hits.indexOf("0192a000-0000-7000-8000-0000000000e5")).toBeGreaterThan(
        hits.indexOf("0192a000-0000-7000-8000-0000000000e6"),
      );
    });

    it("a matching alias page also contributes its terminal node", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e7", contentAst: text("Acme Industries") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000e8", contentAst: text("Acme Corp") }, 1727200002000));
      store.apply(env("object.update", { objectId: "0192a000-0000-7000-8000-0000000000e8", aliasedNodeId: "0192a000-0000-7000-8000-0000000000e7" }, 1727200003000));
      // The alias leads (its title IS the query); the terminal appears as
      // an option even though only one term matches its own title.
      const hits = store.search("acme corp", 10).map((h) => h.nodeId);
      expect(hits[0]).toBe("0192a000-0000-7000-8000-0000000000e8");
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000e7");
      // A broader query: both rank as literal main-title matches, the
      // alias first (shorter title).
      const broad = store.search("acme", 10).map((h) => h.nodeId);
      expect(broad).toEqual([
        "0192a000-0000-7000-8000-0000000000e8",
        "0192a000-0000-7000-8000-0000000000e7",
      ]);
    });
  });

  describe("diacritics + fuzzy rescue (owner 2026-10-13)", () => {
    it("folds diacritics both directions (`peru` <-> \"Perú\") in default and exact modes", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c1", contentAst: text("GMI Perú") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c2", contentAst: text("El Peruano") }, 1727200002000));
      expect(store.search("peru").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000c1");
      expect(store.search("perú").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000c2");
      expect(store.search('"peru"').map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000c1");
      // The snippet keeps the ORIGINAL characters while folding the hit check.
      const snippet = store.getSearchSnippet("0192a000-0000-7000-8000-0000000000c1", "peru");
      expect(snippet?.text).toContain("Perú");
    });

    it("fuzzy subsequence rescues queries no token prefix matches", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c3", contentAst: text("GMI Dental Implantology") }, 1727200001000));
      // No token starts with "dntl" — only the subsequence saves it.
      const hits = store.search("gmi dntl", 10).map((h) => h.nodeId);
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000c3");
    });

    it("the fuzzy scan stays off when an exact title match exists", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c4", contentAst: text("GMI Dental Implantology") }, 1727200001000));
      // Fuzzy-matches "gmi dental" as a subsequence but shares no
      // query-term prefix — it could only enter through the rescue scan.
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c5", contentAst: text("Gulf Marine Inspection Depot North Trade Lane") }, 1727200002000));
      const hits = store.search("gmi dental", 10).map((h) => h.nodeId);
      expect(hits[0]).toBe("0192a000-0000-7000-8000-0000000000c4");
      expect(hits).not.toContain("0192a000-0000-7000-8000-0000000000c5");
    });
  });

  describe("snippets", () => {
    it("excerpts around the match with char-accurate spans", () => {
      const store = makeStore();
      const id = "0192a000-0000-7000-8000-0000000000f7";
      store.apply(
        env("object.create", { objectId: id, contentAst: text("the quick brown fox jumps over the lazy dog") }, 1727200001000),
      );
      const snippet = store.getSearchSnippet(id, "quick");
      expect(snippet).not.toBeNull();
      // Short text: the whole plaintext fits the window (no ellipsis).
      expect(snippet!.text).toBe("the quick brown fox jumps over the lazy dog");
      expect(snippet!.matches).toEqual([{ start: 4, length: 5 }]);
      const { start, length } = snippet!.matches[0]!;
      expect(snippet!.text.slice(start, start + length)).toBe("quick");
    });

    it("query terms match by prefix and mark the whole token", () => {
      const store = makeStore();
      const id = "0192a000-0000-7000-8000-0000000000f8";
      store.apply(env("object.create", { objectId: id, contentAst: text("a synchronization primer") }, 1727200001000));
      const snippet = store.getSearchSnippet(id, "sync");
      expect(snippet).not.toBeNull();
      expect(snippet!.text.slice(snippet!.matches[0]!.start, snippet!.matches[0]!.start + snippet!.matches[0]!.length)).toBe(
        "synchronization",
      );
    });

    it("windows a long text with an ellipsis at the cut", () => {
      const store = makeStore();
      const id = "0192a000-0000-7000-8000-0000000000f9";
      const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
      store.apply(env("object.create", { objectId: id, contentAst: text(`${words} zymurgy ${words}`) }, 1727200001000));
      const snippet = store.getSearchSnippet(id, "zymurgy", { maxTokens: 10 });
      expect(snippet).not.toBeNull();
      expect(snippet!.text.startsWith("…")).toBe(true);
      expect(snippet!.text.endsWith("…")).toBe(true);
      const { start, length } = snippet!.matches[0]!;
      expect(snippet!.text.slice(start, start + length)).toBe("zymurgy");
    });

    it("centers on the densest cluster, not merely the first hit", () => {
      const store = makeStore();
      const id = "0192a000-0000-7000-8000-0000000000fa";
      store.apply(
        env(
          "object.create",
          { objectId: id, contentAst: text("alpha one two three four five six seven eight nine ten eleven alpha alpha alpha alpha omega") },
          1727200001000,
        ),
      );
      const snippet = store.getSearchSnippet(id, "alpha", { maxTokens: 6 });
      expect(snippet).not.toBeNull();
      // The trailing cluster (four hits in one window) beats the lone
      // opening hit; the earliest maximal-density window wins the tie.
      expect(snippet!.matches).toHaveLength(4);
      for (const { start, length } of snippet!.matches) {
        expect(snippet!.text.slice(start, start + length)).toBe("alpha");
      }
    });

    it("returns null for unmatched nodes and unknown ids", () => {
      const store = makeStore();
      const id = "0192a000-0000-7000-8000-0000000000fb";
      store.apply(env("object.create", { objectId: id, contentAst: text("plain prose") }, 1727200001000));
      expect(store.getSearchSnippet(id, "absentterm")).toBeNull();
      expect(store.getSearchSnippet("0192a000-0000-7000-8000-000000000099", "prose")).toBeNull();
    });
  });

  describe("property values in the FTS index", () => {
    const SCHEMA_TEXT = "0192a000-0000-7000-8000-0000000000a1";
    const SCHEMA_SELECT = "0192a000-0000-7000-8000-0000000000a2";
    const SCHEMA_URL = "0192a000-0000-7000-8000-0000000000a3";
    const SCHEMA_NUMBER = "0192a000-0000-7000-8000-0000000000a4";
    const SCHEMA_DATE = "0192a000-0000-7000-8000-0000000000a5";
    const CARRIER = "0192a000-0000-7000-8000-0000000000b1";
    const DAY_NODE = "0192a000-0000-7000-8000-0000000000b2";

    function seededStore(): Store {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f0", contentAst: text("plain owner title") }, 1727200001000));
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_TEXT, name: "notes", type: "text" }, 1727200000100));
      store.apply(
        env("propertySchema.create", { propertySchemaId: SCHEMA_SELECT, name: "status", type: "select", options: [{ id: "opt-1", label: "Backlog" }] }, 1727200000100),
      );
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_URL, name: "link", type: "url" }, 1727200000100));
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_NUMBER, name: "year", type: "number" }, 1727200000100));
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_DATE, name: "when", type: "datetime" }, 1727200000100));
      return store;
    }

    it("a scalar text property value is searchable on the owner", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, value: "synchronoflash" }, 1727200002000));
      expect(store.search("synchronoflash").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
    });

    it("a text carrier's content is searchable on the owner", () => {
      const store = seededStore();
      store.apply(env("object.create", { objectId: CARRIER, parentId: "0192a000-0000-7000-8000-0000000000f0", contentAst: text("zymurgy carrier prose") }, 1727200002000));
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, value: { nodeId: CARRIER } }, 1727200002100));
      const hits = store.search("zymurgy").map((h) => h.nodeId);
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000f0");
      expect(hits).toContain(CARRIER); // the carrier is a node in its own right
    });

    it("select labels, urls and numbers are searchable; date refs are not", () => {
      const store = seededStore();
      store.apply(
        env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_SELECT, value: "opt-1" }, 1727200002000),
      );
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_URL, value: "https://example.invalid/qux" }, 1727200002100));
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_NUMBER, value: 1901 }, 1727200002200));
      store.apply(env("object.create", { objectId: DAY_NODE, contentAst: text("2026-09-27") }, 1727200000900));
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_DATE, value: { nodeId: DAY_NODE } }, 1727200002300));
      expect(store.search("Backlog").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
      expect(store.search("qux").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
      expect(store.search("1901").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
      // The day node is found by its own label; the owner is NOT — a date
      // ref is structural and contributes no text.
      expect(store.search("2026").map((h) => h.nodeId)).not.toContain("0192a000-0000-7000-8000-0000000000f0");
    });

    it("unset reindexes the owner (the old term stops matching)", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, value: "synchronoflash" }, 1727200002000));
      expect(store.search("synchronoflash").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
      store.apply(env("property.unset", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, idx: 0 }, 1727200003000));
      expect(store.search("synchronoflash")).toEqual([]);
    });

    it("reindexAllSearch rebuilds the same property-inclusive rows", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, value: "synchronoflash" }, 1727200002000));
      store.database.prepare("DELETE FROM search_index_docid").run();
      store.database.prepare("DELETE FROM search_index").run();
      expect(store.search("synchronoflash")).toEqual([]);
      // The full rebuild (also the cross-backend restore repair path).
      reindexAllSearch(store.database);
      expect(store.search("synchronoflash").map((h) => h.nodeId)).toContain("0192a000-0000-7000-8000-0000000000f0");
    });

    it("a snippet can land in property-value text", () => {
      const store = seededStore();
      store.apply(env("property.set", { objectId: "0192a000-0000-7000-8000-0000000000f0", propertySchemaId: SCHEMA_TEXT, value: "synchronoflash notes" }, 1727200002000));
      const snippet = store.getSearchSnippet("0192a000-0000-7000-8000-0000000000f0", "synchronoflash");
      expect(snippet).not.toBeNull();
      expect(snippet!.text).toContain("synchronoflash");
      expect(snippet!.text).toContain("plain owner title");
    });
  });

  describe("C1: quoted phrases in the MATCH query", () => {
    function phraseStore(): Store {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c1", contentAst: text("the quick brown fox jumps") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c2", contentAst: text("quick fox brown jumps the") }, 1727200002000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000c3", contentAst: text("quick brownish fox leaps") }, 1727200003000));
      return store;
    }

    it("a quoted phrase matches only the exact adjacency", () => {
      const hits = phraseStore().search('"quick brown fox"', 10).map((h) => h.nodeId);
      expect(hits).toEqual(["0192a000-0000-7000-8000-0000000000c1"]);
    });

    it("phrase + bare term AND together", () => {
      const store = phraseStore();
      // "brown fox" adjacent AND prefixed `jump*` — only c1 qualifies.
      expect(store.search('"brown fox" jump', 10).map((h) => h.nodeId)).toEqual([
        "0192a000-0000-7000-8000-0000000000c1",
      ]);
      // c2 carries both terms but not adjacently — the phrase excludes it.
      expect(store.search('"brown fox" jump', 10)).not.toContainEqual({
        nodeId: "0192a000-0000-7000-8000-0000000000c2",
      });
    });

    it("unbalanced quotes degrade to plain text (never break the MATCH)", () => {
      const store = phraseStore();
      expect(store.search('"quick brown', 10).map((h) => h.nodeId)).toContain(
        "0192a000-0000-7000-8000-0000000000c1",
      );
    });
  });

  describe("C5: cursor-paginated search", () => {
    function pagedStore(): Store {
      const store = makeStore();
      for (let i = 0; i < 7; i++) {
        store.apply(
          env(
            "object.create",
            { objectId: `0192a000-0000-7000-8000-0000000001${String(i).padStart(2, "0")}`, contentAst: text("pageword result") },
            1727200001000 + i * 1000,
          ),
        );
      }
      return store;
    }

    it("pages the deterministic order with a cursor until exhausted", () => {
      const store = pagedStore();
      const first = store.searchPage("pageword", { limit: 3 });
      expect(first.hits).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
      const second = store.searchPage("pageword", { limit: 3, cursor: first.nextCursor });
      expect(second.hits).toHaveLength(3);
      // No overlap between pages.
      const firstIds = new Set(first.hits.map((h) => h.nodeId));
      expect(second.hits.every((h) => !firstIds.has(h.nodeId))).toBe(true);
      const third = store.searchPage("pageword", { limit: 3, cursor: second.nextCursor });
      expect(third.hits).toHaveLength(1);
      expect(third.nextCursor).toBeNull();
      // The concatenation equals the single-shot ranked list.
      const all = store.search("pageword", 10).map((h) => h.nodeId);
      expect([...first.hits, ...second.hits, ...third.hits].map((h) => h.nodeId)).toEqual(all);
    });

    it("a garbage cursor fails loud", () => {
      const store = pagedStore();
      expect(() => store.searchPage("pageword", { cursor: "not-a-number" })).toThrow(/invalid cursor/);
    });
  });
});

describe("v18 -> v19: the diacritic-folding index rebuild (better-sqlite3 only)", () => {
  it("an unfolded pre-v19 index migrates to folding, rows preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-migrate-v19-"));
    tmpDirs.push(dir);
    const path = join(dir, "store.db");
    const PERU = "0192a000-0000-7000-8000-0000000000c9";
    const GUIDES = "0192a000-0000-7000-8000-0000000000ca";

    // Fresh v19 store with two nodes, then DOWNGRADE to the v18 shape: drop
    // the index and insert UNfolded plaintext rows by hand (reindexNode
    // folds now, so the downgrade cannot ride it), pin user_version 18.
    // The reopen below must run the v19 migration step.
    const store = Store.open(betterSqlite3Backend(path));
    store.apply(env("object.create", { objectId: PERU, contentAst: text("GMI Perú") }, 1727200001000));
    store.apply(env("object.create", { objectId: GUIDES, contentAst: text("Peru official docs") }, 1727200002000));
    store.database.exec("DROP TABLE search_index");
    store.database.exec("CREATE VIRTUAL TABLE search_index USING fts5(content, tokenize = 'unicode61')");
    const insertRow = (nodeId: string, textValue: string): void => {
      store.database.prepare("INSERT INTO search_index (content) VALUES (?)").run(textValue);
      store.database
        .prepare("INSERT OR REPLACE INTO search_index_docid (node_id, docid) VALUES (?, last_insert_rowid())")
        .run(nodeId);
    };
    insertRow(PERU, "GMI Perú"); // unfolded, the v18 shape
    insertRow(GUIDES, "Peru official docs");
    store.database.pragma("user_version = 18");
    store.close();

    const reopened = Store.open(betterSqlite3Backend(path));
    // The migration rebuilt the index from the derived plaintext…
    const row = reopened.database
      .prepare(
        `SELECT s.content AS indexed FROM search_index s
         JOIN search_index_docid d ON d.docid = s.rowid WHERE d.node_id = ?`,
      )
      .get(PERU) as { indexed: string };
    expect(row.indexed).toBe("GMI Peru"); // diacritics folded at insert (case rides the tokenizer's fold)
    // …both rows survived, and the exact-title ordering is tier-0 clean.
    expect(reopened.search("peru", 10).map((h) => h.nodeId)).toEqual([GUIDES, PERU]);
    reopened.close();
  });
});
