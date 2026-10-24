/**
 * Sources hub data-layer tests (task 2 — facet data + type facets pane):
 *
 * - buildSourcesAst: the QueryAST over the source family — the closure-aware
 *   class condition on the picked type, the content condition for q, the
 *   unknown-type fallback to the source base.
 * - runSourcesQuery: the display projection — title (title-is-content),
 *   primary classKey (the enabled-most-specific pick: non-archived preferred,
 *   roster-order tiebreak), authorsText per the SHIPPED read contract
 *   (authors text rows first, linkedAuthors agent derivation when empty),
 *   venue from the class's container binding, year from the publicationDate
 *   chain ref, citekey, attachment count.
 * - q filtering: title AND authorsText AND citekey — client-side over the
 *   loaded set, INCLUDING the linkedAuthors-derived names (the case the
 *   store-level narrow cannot express — agent names live behind {nodeId}
 *   refs).
 * - The type filter narrows by closure membership (a web_page+book node
 *   answers the web_page pick); multi-type nodes dedupe to ONE row by node
 *   id across the unfiltered table.
 * - facetCounts: ONE grouped read over the live source family (journal ×2,
 *   web_page ×3 + the multi-type node, archived artwork ×1 + its multi-type
 *   carrier), the archived flag off the class row's active bit, and the
 *   enable round-trip through the SAME setArchived seam the gallery and
 *   settings use.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js, the
 * sources-settings convention) — the roster seeds through client writes
 * (the add-source convention).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
} from "@notees/domain";
import type { QueryAst } from "@notees/query";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  buildSourcesAst,
  facetCounts,
  runSourcesQuery,
  type SourceRow,
} from "../src/features/sources/sourcesQuery.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

/** The roster subset this suite seeds (the everyday types + the archived
 *  artwork + the agent/asset support classes). */
const ROSTER = ["journal_article", "web_page", "book", "book_section", "artwork"] as const;
/** Classes beyond the type roster the seed needs. */
const SUPPORT = ["source", "agent", "person", "asset"] as const;

/** The base family bound on `source` (the SYSTEM_SOURCE_CLASS_BINDINGS
 *  convention — the shared base carries the bibliographic family). */
const BASE_BINDINGS = [
  "authors",
  "linkedAuthors",
  "publicationDate",
  "citekey",
  "attachments",
] as const;

/** Per-class container bindings for the seeded types (venue derivation —
 *  note `book` binds NO container field; `bookTitle` rides book_section). */
const VENUE_BINDINGS: Partial<Record<SystemClassName, string>> = {
  journal_article: "publicationTitle",
  book_section: "bookTitle",
  web_page: "websiteTitle",
};

async function seedRoster(client: WorkspaceClient): Promise<void> {
  for (const name of [...SUPPORT, ...ROSTER]) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  for (const name of ROSTER) {
    await client.setClassExtends(SYSTEM_CLASS_UUIDS[name], [SYSTEM_CLASS_UUIDS.source]);
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.person, [SYSTEM_CLASS_UUIDS.agent]);

  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  // The bibliographic pool — schemas scoped [source] (+ the person split),
  // the base family bound on `source`, each type's venue field on its class.
  const schema = async (
    key: keyof typeof SYSTEM_PROPERTY_UUIDS,
    spec: Parameters<WorkspaceClient["createPropertySchema"]>[0],
  ) => {
    await client.createPropertySchema({ id: SYSTEM_PROPERTY_UUIDS[key], ...spec });
  };
  await schema("authors", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.authors,
    type: "text",
    multi: true,
    scopeClassIds: [SOURCE],
  });
  await schema("linkedAuthors", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.linkedAuthors,
    type: "object",
    multi: true,
    scopeClassIds: [SOURCE],
    targetClassFilter: [SYSTEM_CLASS_UUIDS.agent],
  });
  await schema("publicationDate", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.publicationDate,
    type: "datetime",
    scopeClassIds: [SOURCE],
  });
  await schema("citekey", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.citekey,
    type: "text",
    scopeClassIds: [SOURCE],
    defaultValue: "",
  });
  await schema("attachments", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.attachments,
    type: "asset",
    multi: true,
    scopeClassIds: [SOURCE],
  });
  for (const key of ["publicationTitle", "bookTitle", "websiteTitle"] as const) {
    await schema(key, {
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: "text",
      scopeClassIds: [SOURCE],
    });
  }
  for (const key of ["givenName", "familyName"] as const) {
    await schema(key, {
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: "text",
      scopeClassIds: [SYSTEM_CLASS_UUIDS.person],
    });
  }
  for (const key of BASE_BINDINGS) {
    await client.setClassProperty(SOURCE, SYSTEM_PROPERTY_UUIDS[key], {});
  }
  for (const name of ROSTER) {
    const venue = VENUE_BINDINGS[name];
    if (venue !== undefined) {
      await client.setClassProperty(SYSTEM_CLASS_UUIDS[name], SYSTEM_PROPERTY_UUIDS[venue as keyof typeof SYSTEM_PROPERTY_UUIDS], {});
    }
  }
  // artwork rides SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES — archive it.
  await client.setArchived(SYSTEM_CLASS_UUIDS.artwork, false);
}

export interface SeededItems {
  a1: string;
  a2: string;
  w1: string;
  w2: string;
  w3: string;
  r1: string;
  m1: string;
  m2: string;
  ada: string;
}

/** The seeded library: journal ×2, web_page ×3, artwork ×1, two multi-type
 *  carriers (web_page+book, artwork+book), one linkedAuthors-only author. */
async function seedItems(client: WorkspaceClient): Promise<SeededItems> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const create = async (
    title: string,
    classes: SystemClassName[],
  ): Promise<string> =>
    client.createObject({ isEmbedded: false, name: title, classIds: classes.map((c) => SYSTEM_CLASS_UUIDS[c]) });

  const ada = await create("Ada Lovelace", ["person"]);
  await client.setProperty(ada, P.givenName, "Ada", 0);
  await client.setProperty(ada, P.familyName, "Lovelace", 0);

  const asset1 = await create("paper.pdf", ["asset"]);
  const asset2 = await create("supplement.pdf", ["asset"]);

  const a1 = await create("On the Analytical Engine", ["journal_article"]);
  await client.setProperty(a1, P.authors, "Lovelace, Ada", 0);
  await client.setProperty(a1, P.authors, "Turing, Alan", 1);
  await client.setProperty(a1, P.publicationTitle, "The Example Journal", 0);
  await client.setProperty(a1, P.citekey, "lovelace1843analytical", 0);
  await client.setProperty(a1, P.attachments, { nodeId: asset1 }, 0);
  await client.setProperty(a1, P.attachments, { nodeId: asset2 }, 1);
  const { year: y1843 } = await client.ensureDateChain("1843-01-01");
  await client.setProperty(a1, P.publicationDate, { nodeId: y1843 }, 0);

  const a2 = await create("Computing Machinery", ["journal_article"]);
  await client.setProperty(a2, P.authors, "Turing, Alan", 0);
  await client.setProperty(a2, P.publicationTitle, "Mind", 0);
  await client.setProperty(a2, P.citekey, "turing1950computing", 0);
  const { year: y1950 } = await client.ensureDateChain("1950-01-01");
  await client.setProperty(a2, P.publicationDate, { nodeId: y1950 }, 0);

  // w1: NO authors text rows — the linkedAuthors people-graph track carries
  // the author (the read contract's fallback half).
  const w1 = await create("A Great Article", ["web_page"]);
  await client.setProperty(w1, P.linkedAuthors, { nodeId: ada }, 0);
  await client.setProperty(w1, P.websiteTitle, "Example Blog", 0);

  const w2 = await create("Another Page", ["web_page"]);
  await client.setProperty(w2, P.authors, "Smith, John", 0);
  await client.setProperty(w2, P.websiteTitle, "Example Site", 0);
  const { year: y2020 } = await client.ensureDateChain("2020-01-01");
  await client.setProperty(w2, P.publicationDate, { nodeId: y2020 }, 0);

  const w3 = await create("Third Page", ["web_page"]);
  await client.setProperty(w3, P.authors, "Doe, Jane", 0);
  await client.setProperty(w3, P.websiteTitle, "Example Site", 0);

  const r1 = await create("A Painting", ["artwork"]);
  const { year: y1900 } = await client.ensureDateChain("1900-01-01");
  await client.setProperty(r1, P.publicationDate, { nodeId: y1900 }, 0);

  const m1 = await create("Dual Nature", ["web_page", "book_section"]);
  await client.setProperty(m1, P.authors, "Both, Authors", 0);
  await client.setProperty(m1, P.bookTitle, "A Book Container", 0);
  const { year: y2001 } = await client.ensureDateChain("2001-01-01");
  await client.setProperty(m1, P.publicationDate, { nodeId: y2001 }, 0);

  const m2 = await create("Archived Mix", ["artwork", "book"]);
  await client.setProperty(m2, P.authors, "Mix, Author", 0);
  const { year: y1999 } = await client.ensureDateChain("1999-01-01");
  await client.setProperty(m2, P.publicationDate, { nodeId: y1999 }, 0);

  return { a1, a2, w1, w2, w3, r1, m1, m2, ada };
}

async function seededClient(): Promise<{ client: WorkspaceClient; items: SeededItems }> {
  const client = await seedClient();
  await seedRoster(client);
  const items = await seedItems(client);
  return { client, items };
}

const byId = (rows: SourceRow[]): Map<string, SourceRow> => new Map(rows.map((r) => [r.id, r]));

// --- buildSourcesAst -----------------------------------------------------------------

describe("buildSourcesAst", () => {
  it("scopes the whole source family with no filters", () => {
    expect(buildSourcesAst({})).toEqual({
      version: 1,
      scope: { type: "entire_workspace" },
      root: {
        type: "group",
        logic: "and",
        children: [{ type: "class", classId: SYSTEM_CLASS_UUIDS.source }],
      },
    } satisfies QueryAst);
  });

  it("narrows to the picked type (closure-aware class condition)", () => {
    const ast = buildSourcesAst({ classKey: "journal_article" });
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [{ type: "class", classId: SYSTEM_CLASS_UUIDS.journal_article }],
    });
  });

  it("adds the content/title condition for q", () => {
    const ast = buildSourcesAst({ q: "smith" });
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [
        { type: "class", classId: SYSTEM_CLASS_UUIDS.source },
        { type: "content", op: "contains", value: "smith" },
      ],
    });
  });

  it("a stale/unknown type key degrades to the source base (never an empty table)", () => {
    const ast = buildSourcesAst({ classKey: "bogus_type" });
    expect(ast.root).toEqual({
      type: "group",
      logic: "and",
      children: [{ type: "class", classId: SYSTEM_CLASS_UUIDS.source }],
    });
  });
});

// --- runSourcesQuery — the display projection -----------------------------------------

describe("runSourcesQuery — the display projection", () => {
  it("projects every live source: title, classKey, authors, venue, year, citekey, attachments", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    expect(rows).toHaveLength(8);

    const row = byId(rows);
    const a1 = row.get(items.a1)!;
    expect(a1.title).toBe("On the Analytical Engine");
    expect(a1.classKey).toBe("journal_article");
    expect(a1.authorsText).toBe("Lovelace, Ada; Turing, Alan");
    expect(a1.venue).toBe("The Example Journal");
    // 1843 is BELOW the journal's 1900..2200 window — the year reads off
    // the chain id's FIXED payload (an imported bibliography mints pre-1900
    // refs; the hub must not lose them).
    expect(a1.year).toBe(1843);
    expect(a1.citekey).toBe("lovelace1843analytical");
    expect(a1.attachmentCount).toBe(2);
    expect(a1.isActive).toBe(true);

    const a2 = row.get(items.a2)!;
    expect(a2.attachmentCount).toBe(0); // no assets attached
    expect(a2.year).toBe(1950);
    expect(a2.venue).toBe("Mind");
  });

  it("authorsText falls back to linkedAuthors agent derivation when no authors rows exist", async () => {
    const { client, items } = await seededClient();
    const rows = byId(await runSourcesQuery(client, {}, null));
    const w1 = rows.get(items.w1)!;
    // Agent familyName/givenName → "Family, Given" (the read contract's
    // caller-resolved half, mirrored export-side).
    expect(w1.authorsText).toBe("Lovelace, Ada");
  });

  it("venue follows the class's container binding (book_section → bookTitle, web_page → websiteTitle)", async () => {
    const { client, items } = await seededClient();
    const rows = byId(await runSourcesQuery(client, {}, null));
    expect(rows.get(items.m1)!.venue).toBe("A Book Container");
    expect(rows.get(items.w2)!.venue).toBe("Example Site");
    // artwork binds no container field — the venue reads empty, never throws.
    expect(rows.get(items.r1)!.venue).toBe("");
    // …and neither does book (bookTitle rides book_section, not book).
    expect(rows.get(items.m2)!.venue).toBe("");
  });

  it("year is null when publicationDate is unset", async () => {
    const { client, items } = await seededClient();
    const rows = byId(await runSourcesQuery(client, {}, null));
    expect(rows.get(items.w1)!.year).toBeNull();
    expect(rows.get(items.w3)!.year).toBeNull();
  });

  it("citekey reads empty (not undefined) when only the bound default exists", async () => {
    const { client, items } = await seededClient();
    const rows = byId(await runSourcesQuery(client, {}, null));
    expect(rows.get(items.w1)!.citekey).toBe("");
  });

  it("multi-type node: ONE row, the enabled-most-specific classKey (roster-order tiebreak)", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    // Dedupe by node id (Review Focus 1): m1 answers both web_page and
    // book_section but rides the table exactly once.
    expect(rows.filter((r) => r.id === items.m1)).toHaveLength(1);
    // book_section precedes web_page in the SYSTEM roster — both enabled →
    // book_section.
    expect(rows.find((r) => r.id === items.m1)!.classKey).toBe("book_section");
  });

  it("multi-type pick prefers the non-archived type", async () => {
    const { client, items } = await seededClient();
    const rows = byId(await runSourcesQuery(client, {}, null));
    // m2 carries artwork (archived) + book (enabled) → book wins.
    expect(rows.get(items.m2)!.classKey).toBe("book");
  });

  it("the type filter narrows by closure membership (the multi-type carrier answers the web_page pick)", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, { classKey: "web_page" }, null);
    expect(rows.map((r) => r.id).sort()).toEqual([items.w1, items.w2, items.w3, items.m1].sort());
  });

  it("the archived type's items still read (the facet lists them under Hidden types)", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, { classKey: "artwork" }, null);
    expect(rows.map((r) => r.id).sort()).toEqual([items.r1, items.m2].sort());
  });
});

// --- q filtering ----------------------------------------------------------------------

describe("runSourcesQuery — q", () => {
  it("filters by title", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, { q: "computing" }, null);
    expect(rows.map((r) => r.id)).toEqual([items.a2]);
  });

  it("filters by authors text", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, { q: "turing" }, null);
    expect(rows.map((r) => r.id).sort()).toEqual([items.a1, items.a2].sort());
  });

  it("filters by citekey", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, { q: "lovelace1843" }, null);
    expect(rows.map((r) => r.id)).toEqual([items.a1]);
  });

  it("filters by the linkedAuthors-DERIVED authors text (the store narrow cannot express this)", async () => {
    const { client, items } = await seededClient();
    // w1 has no authors rows — only the linkedAuthors agent. A store-level
    // content/property narrow would miss it; the client-side pass must not.
    const rows = await runSourcesQuery(client, { q: "lovelace" }, null);
    expect(rows.map((r) => r.id).sort()).toEqual([items.a1, items.w1].sort());
  });

  it("the q filter composes with the type filter", async () => {
    const { client } = await seededClient();
    const rows = await runSourcesQuery(client, { classKey: "journal_article", q: "turing" }, null);
    expect(rows).toHaveLength(2);
  });
});

// --- sorting --------------------------------------------------------------------------

describe("runSourcesQuery — sort", () => {
  it("sorts by year ascending, unvalued years last", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, { field: "year", direction: "asc" });
    expect(rows.map((r) => r.id)).toEqual([
      items.a1, // 1843
      items.r1, // 1900
      items.a2, // 1950
      items.m2, // 1999
      items.m1, // 2001
      items.w2, // 2020
      items.w1, // null
      items.w3, // null
    ]);
  });

  it("sorts by title descending", async () => {
    const { client } = await seededClient();
    const rows = await runSourcesQuery(client, {}, { field: "title", direction: "desc" });
    expect(rows[0]!.title).toBe("Third Page");
    expect(rows.at(-1)!.title).toBe("A Great Article");
  });

  it("sorts by citekey ascending", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, { field: "citekey", direction: "asc" });
    const keys = rows.map((r) => r.citekey);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(rows.find((r) => r.id === items.a1)!.citekey).toBe("lovelace1843analytical");
  });
});

// --- facetCounts ----------------------------------------------------------------------

describe("facetCounts", () => {
  it("counts every roster type over ONE grouped read of the live source family", async () => {
    const { client } = await seededClient();
    const spy = vi.spyOn(client, "getClassMembers");
    const facets = facetCounts(client);
    // The ONE-grouped-query ruling: a single family read, not 39 count reads.
    expect(spy.mock.calls.filter((call) => call[0] === SYSTEM_CLASS_UUIDS.source)).toHaveLength(1);

    const byKey = new Map(facets.map((f) => [f.classKey, f]));
    expect(byKey.get("journal_article")!.count).toBe(2);
    // web_page ×3 + the multi-type carrier.
    expect(byKey.get("web_page")!.count).toBe(4);
    // book carries m2 alone; m1 rides book_section.
    expect(byKey.get("book")!.count).toBe(1);
    expect(byKey.get("book_section")!.count).toBe(1);
    // artwork ×1 + its multi-type carrier — the archived type still counts.
    expect(byKey.get("artwork")!.count).toBe(2);
    // Every roster type rides the list, unvalued at 0.
    expect(facets).toHaveLength(Object.keys(SYSTEM_SOURCE_CLASS_BINDINGS).length);
    expect(byKey.get("film")!.count).toBe(0);
  });

  it("labels from the live class title with the display-name fallback, archived off the active bit", async () => {
    const { client } = await seededClient();
    const facets = facetCounts(client);
    const artwork = facets.find((f) => f.classKey === "artwork")!;
    expect(artwork.label).toBe("Artwork");
    expect(artwork.archived).toBe(true);
    const book = facets.find((f) => f.classKey === "book")!;
    expect(book.archived).toBe(false);
  });

  it("the enable round-trip rides the SAME setArchived seam the gallery and settings use", async () => {
    const { client } = await seededClient();
    const before = facetCounts(client).find((f) => f.classKey === "artwork")!;
    expect(before.archived).toBe(true);

    await client.setArchived(SYSTEM_CLASS_UUIDS.artwork, true);
    const after = facetCounts(client).find((f) => f.classKey === "artwork")!;
    expect(after.archived).toBe(false);
    expect(after.count).toBe(2); // the count is untouched by the visibility flip
  });
});
