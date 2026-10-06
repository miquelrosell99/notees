/**
 * Bibliography round-trip tests: the tolerant BibTeX parser, the serializer's
 * stable field order + minimal escaping, the CSL-JSON interchange mappings,
 * and CSL→BibTeX→CSL field stability for the mapped subset.
 */

import { describe, expect, it } from "vitest";

import {
  bibToCsl,
  BIB_TYPE_TO_CLASS_NAME,
  bibTypeToClassName,
  cslToBib,
  cslToNodeSpecs,
  cslTypeToClassName,
  nodeToCsl,
  parseAuthorName,
  parseAuthors,
  parseBibtex,
  serializeBibEntry,
  serializeBibtex,
  sourceClassOf,
  SOURCE_CLASS_IDS,
  type CslItem,
} from "../src/index.js";

const FIXTURE = `% A realistic bibliography: a book, a journal paper, and noise.
@string{uchp = "University of Chicago Press"}

@comment{this file exercises the tolerant parser}

@book{kuhn1962structure,
  title     = {The {Structure} of {Scientific} {Revolutions}},
  author    = {Kuhn, Thomas S.},
  year      = 1962,
  publisher = {University of Chicago Press},
  isbn      = {9780226458120},
}

@article{david1962combinatorial,
  title   = {Combinatorial Chance, à la française — {Notes} on dérivés},
  author  = {David, F. N. and Barton, D. E.},
  journal = {Biometrika},
  year    = {1962},
  volume  = {50},
  number  = {1/2},
  pages   = {207--229},
  doi     = {10.2307/2333763},
  url     = "https://doi.org/10.2307/2333763"
}

@phdthesis{hagstrom1965,
  title = {Selection and {Adaptation} in {\textdollar}ant Populations},
  author = "Hagstrom, Warren O.",
  school = {University of California, Berkeley},
  year = 1965,
}
`;

describe("parseBibtex", () => {
  it("parses the realistic fixture: types, keys, fields, unicode, nested braces", () => {
    const entries = parseBibtex(FIXTURE);
    expect(entries.map((entry) => entry.entryType)).toEqual(["book", "article", "phdthesis"]);
    expect(entries.map((entry) => entry.citeKey)).toEqual([
      "kuhn1962structure",
      "david1962combinatorial",
      "hagstrom1965",
    ]);

    const kuhn = entries[0]!;
    expect(kuhn.fields.title).toBe("The Structure of Scientific Revolutions");
    expect(kuhn.fields.author).toBe("Kuhn, Thomas S.");
    expect(kuhn.fields.year).toBe("1962"); // bare scalar accepted
    expect(kuhn.fields.publisher).toBe("University of Chicago Press");
    expect(kuhn.fields.isbn).toBe("9780226458120");

    const david = entries[1]!;
    expect(david.fields.title).toContain("à la française — Notes on dérivés");
    expect(david.fields.author).toBe("David, F. N. and Barton, D. E.");
    expect(david.fields.doi).toBe("10.2307/2333763");
    expect(david.fields.url).toBe("https://doi.org/10.2307/2333763"); // quoted value
    expect(david.fields.journal).toBe("Biometrika");
  });

  it("skips @comment, @string, @preamble, and % line comments", () => {
    const entries = parseBibtex(FIXTURE);
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.citeKey)).not.toContain("uchp");
  });

  it("tolerates malformed input without throwing", () => {
    expect(parseBibtex("")).toEqual([]);
    expect(parseBibtex("no entries at all")).toEqual([]);
    // Unterminated entry clamps at EOF.
    const broken = parseBibtex("@book{key, title = {Unfinished");
    expect(broken).toHaveLength(1);
    expect(broken[0]?.fields.title).toBe("Unfinished");
    // Duplicate field: last write wins.
    const dup = parseBibtex("@misc{x, year = {1900}, year = {2000}}");
    expect(dup[0]?.fields.year).toBe("2000");
  });
});

describe("serializeBibtex", () => {
  it("emits a stable field order and braces/quotes-escaped values", () => {
    const entry = {
      entryType: "book",
      citeKey: "x2024escapes",
      fields: {
        isbn: "978-0-00",
        title: 'The {Brace} "Quote" Test\nNewline',
        author: "Doe, Jane",
        year: "2024",
      },
    };
    const text = serializeBibEntry(entry);
    const fieldLines = text.split("\n").slice(1, -1);
    expect(fieldLines.map((line) => line.trim().split(" ")[0])).toEqual([
      "author",
      "title",
      "year",
      "isbn",
    ]);
    expect(text).toContain(String.raw`The \{Brace\} "Quote" Test Newline`);
    expect(text.startsWith("@book{x2024escapes,")).toBe(true);
    expect(text.endsWith("}")).toBe(true);
  });

  it("concatenates entries with blank lines", () => {
    const entries = parseBibtex("@misc{a}\n@misc{b, year={2001}}");
    const text = serializeBibtex(entries);
    expect(text).toContain("@misc{a,");
    expect(text).toContain("@misc{b,");
    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("author name parsing", () => {
  it("parses comma form and natural form", () => {
    expect(parseAuthorName("Kuhn, Thomas S.")).toEqual({ family: "Kuhn", given: "Thomas S." });
    expect(parseAuthorName("Thomas S. Kuhn")).toEqual({ family: "Kuhn", given: "Thomas S." });
    expect(parseAuthorName("Prince")).toEqual({ family: "Prince" });
  });

  it("splits `and` lists, ignoring case and padding whitespace", () => {
    expect(parseAuthors("David, F. N. and Barton, D. E.")).toEqual([
      { family: "David", given: "F. N." },
      { family: "Barton", given: "D. E." },
    ]);
    expect(parseAuthors(undefined)).toEqual([]);
  });
});

describe("bibToCsl / cslToBib", () => {
  it("maps entry types to CSL types via the owner-decided source-family table", () => {
    const entries = parseBibtex(FIXTURE);
    expect(bibToCsl(entries[0]!).type).toBe("book");
    expect(bibToCsl(entries[1]!).type).toBe("article"); // article class → CSL article
    expect(bibToCsl(entries[2]!).type).toBe("thesis");
    expect(bibToCsl(parseBibtex("@misc{w}")[0]!).type).toBe("article"); // document fallback
    // The extended source family (owner decision 2026-09-27).
    expect(bibToCsl(parseBibtex("@inproceedings{w}")[0]!).type).toBe("paper-conference");
    expect(bibToCsl(parseBibtex("@conference{w}")[0]!).type).toBe("paper-conference");
    expect(bibToCsl(parseBibtex("@proceedings{w}")[0]!).type).toBe("paper-conference");
    expect(bibToCsl(parseBibtex("@song{w}")[0]!).type).toBe("song");
    expect(bibToCsl(parseBibtex("@movie{w}")[0]!).type).toBe("motion_picture");
    expect(bibToCsl(parseBibtex("@video{w}")[0]!).type).toBe("motion_picture");
    expect(bibToCsl(parseBibtex("@series{w}")[0]!).type).toBe("broadcast");
    expect(bibToCsl(parseBibtex("@tv{w}")[0]!).type).toBe("broadcast");
    // paper-conference and misc round out the re-serialization map.
    expect(cslToBib({ id: "c", type: "paper-conference", title: "C" }).entryType).toBe("inproceedings");
    expect(cslToBib({ id: "m", type: "manuscript", title: "M" }).entryType).toBe("misc");
    // The new families re-serialize to their (nonstandard but re-importable) types.
    expect(cslToBib({ id: "s", type: "song", title: "S" }).entryType).toBe("song");
    expect(cslToBib({ id: "mv", type: "motion_picture", title: "MV" }).entryType).toBe("movie");
    expect(cslToBib({ id: "tv", type: "broadcast", title: "TV" }).entryType).toBe("series");
  });

  it("entry-type ↔ class table: article → article, conference family → conference, fallback → document", () => {
    expect(BIB_TYPE_TO_CLASS_NAME).toMatchObject({
      book: "book",
      inbook: "book",
      incollection: "book",
      article: "article",
      inproceedings: "conference",
      conference: "conference",
      proceedings: "conference",
      phdthesis: "thesis",
      mastersthesis: "thesis",
      song: "song",
      movie: "movie",
      video: "movie",
      series: "tv_series",
      tv: "tv_series",
    });
    expect(bibTypeToClassName("misc")).toBe("document");
    expect(bibTypeToClassName("whatever")).toBe("document");
    expect(cslTypeToClassName("paper-conference")).toBe("conference");
    expect(cslTypeToClassName("song")).toBe("song");
    expect(cslTypeToClassName("motion_picture")).toBe("movie");
    expect(cslTypeToClassName("broadcast")).toBe("tv_series");
  });

  it("carries title/author/year/container/publisher identifiers through both ways", () => {
    const entry = parseBibtex(FIXTURE)[1]!;
    const item = bibToCsl(entry);
    expect(item).toMatchObject({
      id: "david1962combinatorial",
      type: "article",
      title: expect.stringContaining("à la française"),
      DOI: "10.2307/2333763",
      URL: "https://doi.org/10.2307/2333763",
      "container-title": "Biometrika",
      volume: "50",
      issue: "1/2",
      page: "207--229",
    });
    expect(item.author).toEqual([
      { family: "David", given: "F. N." },
      { family: "Barton", given: "D. E." },
    ]);
    expect(item.issued).toEqual({ "date-parts": [[1962]] });

    const back = cslToBib(item);
    expect(back.entryType).toBe("article");
    expect(back.fields.doi).toBe("10.2307/2333763");
    expect(back.fields.journal).toBe("Biometrika");
    expect(back.fields.year).toBe("1962");
  });

  it("CSL→BibTeX→CSL is field-stable for the mapped subset", () => {
    const original: CslItem = {
      id: "kuhn1962structure",
      type: "book",
      title: "The Structure of Scientific Revolutions",
      author: [{ family: "Kuhn", given: "Thomas S." }],
      issued: { "date-parts": [[1962]] },
      DOI: "10.7208/chicago/9780226458106.001.0001",
      ISBN: "9780226458120",
      publisher: "University of Chicago Press",
    };
    const restored = bibToCsl(cslToBib(original));
    expect(restored).toEqual(original);
  });
});

describe("nodeToCsl / cslToNodeSpecs", () => {
  const AUTHORS_SCHEMA = "00000000-0000-0000-0000-000000000012";
  const ISBN_SCHEMA = "00000000-0000-0000-0000-000000000013";
  const DOI_SCHEMA = "00000000-0000-0000-0000-000000000014";
  const PUBDATE_SCHEMA = "00000000-0000-0000-0000-000000000015";
  const PUBLISHER_SCHEMA = "00000000-0000-0000-0000-000000000016";
  const CITEKEY_SCHEMA = "00000000-0000-0000-0000-000000000023";

  it("projects a source node + resolved author name strings into CSL", () => {
    const item = nodeToCsl(
      {
        id: "aaaaaaaa-0000-4000-8000-000000000099",
        name: "The Structure of Scientific Revolutions",
        classIds: [SOURCE_CLASS_IDS.book],
      },
      [
        { schemaId: CITEKEY_SCHEMA, schemaName: "citekey", value: "kuhn1962structure" },
        { schemaId: DOI_SCHEMA, schemaName: "doi", value: "10.7208/chicago/9780226458106.001.0001" },
        { schemaId: PUBDATE_SCHEMA, schemaName: "publicationDate", value: "1962" },
        { schemaId: PUBLISHER_SCHEMA, schemaName: "publisher", value: "University of Chicago Press" },
        { schemaId: ISBN_SCHEMA, schemaName: "isbn", value: "9780226458120" },
        // The node-typed `authors` property is {nodeId} refs — the caller
        // resolves them to name strings; nodeToCsl takes the strings.
        { schemaId: AUTHORS_SCHEMA, schemaName: "authors", value: { nodeId: "person-1" } },
      ],
      ["Kuhn, Thomas S.", "Jane Doe"],
    );
    expect(item).toEqual({
      id: "kuhn1962structure",
      type: "book",
      title: "The Structure of Scientific Revolutions",
      author: [{ family: "Kuhn", given: "Thomas S." }, { family: "Doe", given: "Jane" }],
      issued: { "date-parts": [[1962]] },
      DOI: "10.7208/chicago/9780226458106.001.0001",
      ISBN: "9780226458120",
      publisher: "University of Chicago Press",
    });
  });

  it("parses each resolved author name string to family/given (comma form wins)", () => {
    const item = nodeToCsl(
      { id: "node-id", name: "Paper", classIds: [SOURCE_CLASS_IDS.paper] },
      [],
      ["F. N. David", "Prince"],
    );
    expect(item.id).toBe("node-id");
    expect(item.type).toBe("article-journal");
    expect(item.author).toEqual([{ family: "David", given: "F. N." }, { family: "Prince" }]);
  });

  it("skips empty author strings and emits no author key when none resolve", () => {
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [],
      ["  ", "Solo Author"],
    );
    expect(item.author).toEqual([{ family: "Author", given: "Solo" }]);
    const none = nodeToCsl({ id: "n2", name: "T2", classIds: [SOURCE_CLASS_IDS.book] }, [], []);
    expect(none).not.toHaveProperty("author");
  });

  it("cslToNodeSpecs produces name strings; nodeToCsl(node, resolvedNames) round-trips the item", () => {
    const item: CslItem = {
      id: "david1962combinatorial",
      type: "article-journal",
      title: "Combinatorial Chance",
      author: [{ family: "David", given: "F. N." }],
      issued: { "date-parts": [[1962]] },
      DOI: "10.2307/2333763",
    };
    const spec = cslToNodeSpecs(item);
    expect(spec).toEqual({
      className: "paper",
      citekey: "david1962combinatorial",
      title: "Combinatorial Chance",
      authors: ["David, F. N."],
      doi: "10.2307/2333763",
      publicationDate: "1962",
    });

    // Import spec → (CLI find-or-creates one agent node per name string) →
    // node-typed authors property → nodeToCsl with the resolved display names.
    const nodeItem = nodeToCsl(
      { id: "some-uuid", name: spec.title, classIds: [SOURCE_CLASS_IDS[spec.className]] },
      [
        { schemaId: CITEKEY_SCHEMA, schemaName: "citekey", value: spec.citekey },
        { schemaId: DOI_SCHEMA, schemaName: "doi", value: spec.doi! },
        { schemaId: PUBDATE_SCHEMA, schemaName: "publicationDate", value: spec.publicationDate! },
        { schemaId: AUTHORS_SCHEMA, schemaName: "authors", value: { nodeId: "person-david" } },
      ],
      spec.authors,
    );
    expect(nodeItem).toEqual(item);
  });

  it("has no awareness of the withdrawn linkedAuthors property (…0025)", () => {
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      // Even if a stale replica still carries the withdrawn schema's values,
      // they are ignored: only the caller-supplied name strings render.
      [{ schemaId: "00000000-0000-0000-0000-000000000025", schemaName: "linkedAuthors", value: { nodeId: "p1" } }],
      ["Kuhn, Thomas S."],
    );
    expect(item.author).toEqual([{ family: "Kuhn", given: "Thomas S." }]);
  });

  it("PG15: container fields complete the export mapping by schema-name convention", () => {
    const item = nodeToCsl(
      { id: "paper-1", name: "A combinatorial paper", classIds: [SOURCE_CLASS_IDS.paper] },
      [
        { schemaId: "j1", schemaName: "journal", value: "Biometrika" },
        { schemaId: "v1", schemaName: "volume", value: "50" },
        { schemaId: "n1", schemaName: "number", value: "1/2" },
        { schemaId: "p1", schemaName: "pages", value: "207--229" },
      ],
      [],
    );
    expect(item).toMatchObject({
      type: "article-journal",
      "container-title": "Biometrika",
      volume: "50",
      issue: "1/2",
      page: "207--229",
    });
    // Nodes without those schemas stay clean (no empty keys).
    const bare = nodeToCsl(
      { id: "book-1", name: "A book", classIds: [SOURCE_CLASS_IDS.book] },
      [],
      [],
    );
    expect(bare).not.toHaveProperty("container-title");
    expect(bare).not.toHaveProperty("volume");
    expect(bare).not.toHaveProperty("issue");
    expect(bare).not.toHaveProperty("page");
  });

  it("sourceClassOf picks the first source class in classIds order", () => {
    expect(sourceClassOf([SOURCE_CLASS_IDS.document, SOURCE_CLASS_IDS.book])).toBe("document");
    expect(sourceClassOf([SOURCE_CLASS_IDS.song])).toBe("song");
    expect(sourceClassOf([SOURCE_CLASS_IDS.tv_series, SOURCE_CLASS_IDS.conference])).toBe("tv_series");
    expect(sourceClassOf(["ffffffff-ffff-4fff-8fff-ffffffffffff"])).toBeUndefined();
  });
});
