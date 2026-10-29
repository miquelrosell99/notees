/**
 * Source duplicate grouping tests (task 12 — the detection half of the
 * Zotero-like duplicates feature; task 13's view + merge modal consumes
 * the groups):
 *
 * - groupSourceDuplicates over the Sources-hub row projection
 *   (runSourcesQuery rows — title/authorsText/year/citekey/doi/isbn):
 *   IDENTIFIER edges (DOI case-insensitive trimmed, ISBN digit/X-stripped,
 *   citekey case-insensitive trimmed — the quick-create
 *   findSourceByIdentifier idiom) and FUZZY edges (normalized title AND
 *   publication year OR first-author token), unioned transitively.
 * - Only ≥2-member groups surface; singletons never appear.
 * - Normalization: case, diacritics, punctuation, whitespace.
 * - Determinism: shuffled input → identical output (groups sorted by
 *   first member id, members sorted by id — input order never leaks).
 * - Non-duplicates (shared title but neither year nor author; wholly
 *   distinct metadata) stay ungrouped.
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js, the
 * sources-data convention) — the rows are produced end-to-end by
 * runSourcesQuery, so the projection's doi/isbn read contract is under
 * test too.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { runSourcesQuery, type SourceRow } from "../src/features/sources/sourcesQuery.js";
import { groupSourceDuplicates } from "../src/features/sources/duplicates.js";

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

async function seedSchema(client: WorkspaceClient): Promise<void> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  for (const name of ["source", "journal_article", "agent", "person"] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SOURCE]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.person, [SYSTEM_CLASS_UUIDS.agent]);

  const schema = async (
    key: keyof typeof SYSTEM_PROPERTY_UUIDS,
    spec: Parameters<WorkspaceClient["createPropertySchema"]>[0],
  ) => {
    await client.createPropertySchema({ id: P[key], ...spec });
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
  });
  await schema("doi", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.doi,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  await schema("isbn", {
    name: SYSTEM_PROPERTY_DISPLAY_NAMES.isbn,
    type: "text",
    scopeClassIds: [SOURCE],
  });
  for (const key of ["givenName", "familyName"] as const) {
    await schema(key, {
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: "text",
      scopeClassIds: [SYSTEM_CLASS_UUIDS.person],
    });
  }
  for (const key of ["authors", "linkedAuthors", "publicationDate", "citekey", "doi", "isbn"] as const) {
    await client.setClassProperty(SOURCE, P[key], {});
  }
}

export interface DupItems {
  ada: string;
  k1: string;
  k2: string;
  k3: string;
  b1: string;
  b2: string;
  g1: string;
  g2: string;
  g3: string;
  tr1: string;
  tr2: string;
  tr3: string;
  la1: string;
  la2: string;
  n1: string;
  n2: string;
  n3: string;
  n4: string;
}

/** The seeded library — five duplicate clusters + four non-duplicates. */
async function seedItems(client: WorkspaceClient): Promise<DupItems> {
  const P = SYSTEM_PROPERTY_UUIDS;
  const create = async (title: string): Promise<string> =>
    client.createObject({
      isEmbedded: false,
      name: title,
      classIds: [SYSTEM_CLASS_UUIDS.journal_article],
    });

  const ada = await client.createObject({
    isEmbedded: false,
    name: "Ada Lovelace",
    classIds: [SYSTEM_CLASS_UUIDS.person],
  });
  await client.setProperty(ada, P.givenName, "Ada", 0);
  await client.setProperty(ada, P.familyName, "Lovelace", 0);

  // k-cluster: k1—k2 share a DOI (case/whitespace variants), k1—k3 share a
  // citekey (case/whitespace variants) → ONE three-member group by union.
  const k1 = await create("The Rust Programming Language");
  await client.setProperty(k1, P.authors, "Klabnik, Steve; Nichols, Carol", 0);
  await client.setProperty(k1, P.doi, "10.1000/rust.1", 0);
  await client.setProperty(k1, P.citekey, "klabnik2018rust", 0);
  const { year: y2018 } = await client.ensureDateChain("2018-01-01");
  await client.setProperty(k1, P.publicationDate, { nodeId: y2018 }, 0);

  const k2 = await create("Rust Programming Language, 2nd ed.");
  await client.setProperty(k2, P.authors, "Klabnik, Steve", 0);
  await client.setProperty(k2, P.doi, " 10.1000/RUST.1 ", 0);
  const { year: y2019 } = await client.ensureDateChain("2019-01-01");
  await client.setProperty(k2, P.publicationDate, { nodeId: y2019 }, 0);

  const k3 = await create("Rust Lang (ebook import)");
  await client.setProperty(k3, P.authors, "Someone, Else", 0);
  await client.setProperty(k3, P.citekey, " Klabnik2018Rust ", 0);

  // b-cluster: b1—b2 share an ISBN (hyphen-stripped variants), nothing else.
  const b1 = await create("The Art of Computer Programming, Vol 1");
  await client.setProperty(b1, P.authors, "Knuth, Donald", 0);
  await client.setProperty(b1, P.isbn, "978-0-201-89683-1", 0);
  const { year: y1997 } = await client.ensureDateChain("1997-01-01");
  await client.setProperty(b1, P.publicationDate, { nodeId: y1997 }, 0);

  const b2 = await create("TAOCP Volume One");
  await client.setProperty(b2, P.authors, "Knuth, Donald", 0);
  await client.setProperty(b2, P.isbn, "9780201896831", 0);
  const { year: y1998 } = await client.ensureDateChain("1998-01-01");
  await client.setProperty(b2, P.publicationDate, { nodeId: y1998 }, 0);

  // g-cluster: g1—g2 share title+year (case/diacritic/punctuation variants
  // on the title), g1—g3 share title+first-author (year absent on g3) →
  // ONE three-member group by fuzzy union.
  const g1 = await create("Cien años de soledad");
  await client.setProperty(g1, P.authors, "García Márquez, Gabriel", 0);
  const { year: y1967 } = await client.ensureDateChain("1967-01-01");
  await client.setProperty(g1, P.publicationDate, { nodeId: y1967 }, 0);

  const g2 = await create("CIEN AÑOS DE SOLEDAD!");
  await client.setProperty(g2, P.authors, "Otro, Autor", 0);
  await client.setProperty(g2, P.publicationDate, { nodeId: y1967 }, 0);

  const g3 = await create("Cien años de soledad");
  await client.setProperty(g3, P.authors, "García Márquez, Gabriel", 0);

  // tr-cluster: the transitive proof — tr1—tr2 share a DOI, tr2—tr3 share
  // title+year, tr1 and tr3 share NOTHING → still ONE group.
  const tr1 = await create("Distributed Systems");
  await client.setProperty(tr1, P.authors, "Kleppmann, Martin", 0);
  await client.setProperty(tr1, P.doi, "10.1/ds.001", 0);
  const { year: y2021 } = await client.ensureDateChain("2021-01-01");
  await client.setProperty(tr1, P.publicationDate, { nodeId: y2021 }, 0);

  const tr2 = await create("Designing Data-Intensive Applications");
  await client.setProperty(tr2, P.authors, "Kleppmann, Martin", 0);
  await client.setProperty(tr2, P.doi, "10.1/DS.001", 0);
  const { year: y2017 } = await client.ensureDateChain("2017-01-01");
  await client.setProperty(tr2, P.publicationDate, { nodeId: y2017 }, 0);

  const tr3 = await create("Designing Data-Intensive Applications");
  await client.setProperty(tr3, P.authors, "Different, Person", 0);
  await client.setProperty(tr3, P.publicationDate, { nodeId: y2017 }, 0);

  // la-cluster: la1's author rides linkedAuthors (the agent familyName
  // derivation in the row projection), la2's rides the authors text — the
  // first-author token links them with no year anywhere.
  const la1 = await create("Notes on the Analytical Engine");
  await client.setProperty(la1, P.linkedAuthors, { nodeId: ada }, 0);

  const la2 = await create("Notes on the Analytical Engine");
  await client.setProperty(la2, P.authors, "Lovelace, Ada", 0);

  // Non-duplicates: wholly distinct metadata …
  const n1 = await create("Category Theory for Programmers");
  await client.setProperty(n1, P.authors, "Milewski, Bartosz", 0);
  const { year: y2014 } = await client.ensureDateChain("2014-01-01");
  await client.setProperty(n1, P.publicationDate, { nodeId: y2014 }, 0);

  const n2 = await create("Purely Functional Data Structures");
  await client.setProperty(n2, P.authors, "Okasaki, Chris", 0);
  const { year: y1999 } = await client.ensureDateChain("1999-01-01");
  await client.setProperty(n2, P.publicationDate, { nodeId: y1999 }, 0);

  // … and a shared title with NEITHER year NOR author in common: the fuzzy
  // key must not fire on the title alone (both years absent ≠ equal).
  const n3 = await create("Untitled Draft");
  await client.setProperty(n3, P.authors, "Alpha, One", 0);
  const n4 = await create("Untitled Draft");
  await client.setProperty(n4, P.authors, "Beta, Two", 0);

  return { ada, k1, k2, k3, b1, b2, g1, g2, g3, tr1, tr2, tr3, la1, la2, n1, n2, n3, n4 };
}

async function seededClient(): Promise<{ client: WorkspaceClient; items: DupItems }> {
  const client = await seedClient();
  await seedSchema(client);
  const items = await seedItems(client);
  return { client, items };
}

/** The group list as comparable ids — members and groups id-sorted. */
function groupIds(groups: ReturnType<typeof groupSourceDuplicates>): string[][] {
  return groups.map((group) => group.members.map((member) => member.id));
}

describe("groupSourceDuplicates", () => {
  it("unions identifier edges (DOI case/whitespace, citekey case) into one group", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const groups = groupSourceDuplicates(rows);
    const ids = groupIds(groups);
    expect(ids).toContainEqual([items.k1, items.k2, items.k3].sort());
    expect(ids).toHaveLength(5);
  });

  it("groups ISBN edges stripped to digits+X", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const ids = groupIds(groupSourceDuplicates(rows));
    expect(ids).toContainEqual([items.b1, items.b2].sort());
  });

  it("groups fuzzy edges on normalized title + year, folding case/diacritics/punctuation", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const ids = groupIds(groupSourceDuplicates(rows));
    expect(ids).toContainEqual([items.g1, items.g2, items.g3].sort());
  });

  it("links transitively: a DOI edge and a title edge chain into ONE group", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const ids = groupIds(groupSourceDuplicates(rows));
    expect(ids).toContainEqual([items.tr1, items.tr2, items.tr3].sort());
  });

  it("matches the first-author token across the linkedAuthors derivation", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const ids = groupIds(groupSourceDuplicates(rows));
    expect(ids).toContainEqual([items.la1, items.la2].sort());
  });

  it("leaves non-duplicates ungrouped — distinct metadata, and title-only collisions", async () => {
    const { client, items } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const ids = groupIds(groupSourceDuplicates(rows));
    const grouped = new Set(ids.flat());
    for (const id of [items.n1, items.n2, items.n3, items.n4]) {
      expect(grouped.has(id)).toBe(false);
    }
    // Exactly the five seeded clusters surface, nothing more.
    expect(ids).toHaveLength(5);
  });

  it("returns only ≥2-member groups with members id-sorted and groups ordered by first member id", async () => {
    const { client } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const groups = groupSourceDuplicates(rows);
    for (const group of groups) {
      expect(group.members.length).toBeGreaterThanOrEqual(2);
      const memberIds = group.members.map((member) => member.id);
      expect(memberIds).toEqual([...memberIds].sort());
    }
    const firsts = groups.map((group) => group.members[0]!.id);
    expect(firsts).toEqual([...firsts].sort());
  });

  it("is deterministic under input shuffle", async () => {
    const { client } = await seededClient();
    const rows = await runSourcesQuery(client, {}, null);
    const forward = groupIds(groupSourceDuplicates(rows));
    // Rotate + reverse: same set, different order — output must not move.
    const rotated = rows.map((_, index) => rows[(index + 5) % rows.length]!);
    const backward = groupIds(groupSourceDuplicates([...rotated].reverse()));
    expect(backward).toEqual(forward);
  });

  it("empty input yields no groups", () => {
    expect(groupSourceDuplicates([])).toEqual([]);
  });

  it("never merges rows whose concatenated bucket keys would collide (field separators)", () => {
    // Pure rows — the pinning case: title "A" + author token "bc" and
    // title "AB" + token "c" both spell "…abc" unseparated; "Chapter 3" +
    // 2021 and "Chapter 32" + … spell the same digit run. Neither pair
    // shares a real edge, so no group may form.
    const row = (id: string, title: string, authorsText: string, year: number | null): SourceRow => ({
      id,
      classKey: "journal_article",
      title,
      authorsText,
      year,
      venue: "",
      citekey: "",
      doi: "",
      isbn: "",
      attachmentCount: 0,
      isActive: true,
    });
    const groups = groupSourceDuplicates([
      row("00000000-0000-7000-8000-0000000000a1", "A", "bc, X", null),
      row("00000000-0000-7000-8000-0000000000a2", "AB", "c, Y", null),
      row("00000000-0000-7000-8000-0000000000b1", "Chapter 3", "P, Q", 2021),
      row("00000000-0000-7000-8000-0000000000b2", "Chapter 32", "R, S", null),
    ]);
    expect(groups).toEqual([]);
  });
});
