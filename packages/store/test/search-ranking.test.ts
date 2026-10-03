/**
 * Search store batch (§34.30 register): M2 ranked search, M3 snippets, M5
 * property values in the FTS index.
 *
 *  - M2: ORDER BY rank + recency. FTS5 orders by the hidden rank column in
 *    SQL; the stock sql.js FTS4 has no rank column, so that backend scores
 *    matchinfo('x') hit counts in JS — both must produce relevance-first,
 *    recency-tiebroken, deterministic order (asserted on BOTH adapters).
 *  - M3: searchSnippet excerpts the densest query-term cluster with
 *    char-accurate match spans, computed in JS over the derived plaintext
 *    (the stock sql.js FTS4 snippet() emits its column index into the
 *    output — verified — so the SQL function is not used).
 *  - M5: text-ish property values (carrier content, scalar strings, select
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

  describe("M2: relevance ranking + recency", () => {
    it("a document with more term hits outranks a single-hit document", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f1", contentAst: text("needle needle needle haystack") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f2", contentAst: text("needle in a haystack") }, 1727200002000));
      const hits = store.search("needle", 10).map((h) => h.nodeId);
      // The richer document ranks first even though it is OLDER — relevance
      // dominates the recency tiebreak.
      expect(hits[0]).toBe("0192a000-0000-7000-8000-0000000000f1");
      expect(hits).toContain("0192a000-0000-7000-8000-0000000000f2");
    });

    it("equal relevance tiebreaks by updated_at recency (newer first)", () => {
      const store = makeStore();
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f3", contentAst: text("tournesol watch") }, 1727200001000));
      store.apply(env("object.create", { objectId: "0192a000-0000-7000-8000-0000000000f4", contentAst: text("tournesol dial") }, 1727200002000));
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
      // n-a carries two hits (relevance first despite being oldest); n-b and
      // n-c tie on one hit — the newer n-c wins the recency tiebreak. The
      // same order must come out of FTS5's bm25 rank and FTS4's matchinfo
      // scoring, and stay stable across queries.
      const expected = ["0192a000-0000-7000-8000-0000000000fc", "0192a000-0000-7000-8000-0000000000fe", "0192a000-0000-7000-8000-0000000000fd"];
      for (let i = 0; i < 3; i++) {
        expect(store.search("rhodochrosite", 10).map((h) => h.nodeId)).toEqual(expected);
      }
    });
  });

  describe("M3: snippets", () => {
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

  describe("M5: property values in the FTS index", () => {
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
      store.apply(env("propertySchema.create", { propertySchemaId: SCHEMA_DATE, name: "when", type: "date" }, 1727200000100));
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
});
