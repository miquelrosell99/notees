/**
 * The bidirectional source tables over the 39-class roster + the dual-track
 * read contract (source-library slices 3–6 task 1).
 *
 * The roster, the class→BibTeX/CSL table, and all three derived mappings are
 * pinned here verbatim — the domain manifest (ZOTERO_ITEM_TYPE_TO_CLASS,
 * SYSTEM_SOURCE_CLASS_BINDINGS) is the derivation source, this test is the
 * convergence pin.
 */

import { describe, expect, it } from "vitest";

import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  ZOTERO_CITABLE_ITEM_TYPES,
  ZOTERO_ITEM_TYPE_TO_CLASS,
} from "@notees/domain";

import {
  BIB_TYPE_TO_CLASS_NAME,
  bibToCsl,
  bibTypeToClassName,
  CLASS_BIBLIOGRAPHY,
  CLASS_NAME_TO_CSL_TYPE,
  cslToBib,
  CSL_TYPE_TO_BIB_TYPE,
  CSL_TYPE_TO_CLASS_NAME,
  nodeToCsl,
  parseBibtex,
  sourceClassOf,
  SOURCE_CLASS_IDS,
  SOURCE_CLASS_NAMES,
  type SourceClassName,
} from "../src/index.js";

const AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.authors;
const LINKED_AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const EDITORS_ID = SYSTEM_PROPERTY_UUIDS.editors;

/** The pinned 39-entry table (the one hand-written source of the module). */
const EXPECTED_BIBLIOGRAPHY: Record<SourceClassName, { bib: string; csl: string }> = {
  artwork: { bib: "misc", csl: "graphic" },
  audio_recording: { bib: "song", csl: "song" },
  bill: { bib: "misc", csl: "bill" },
  blog_post: { bib: "misc", csl: "post-weblog" },
  book: { bib: "book", csl: "book" },
  book_section: { bib: "inbook", csl: "chapter" },
  document: { bib: "misc", csl: "document" },
  computer_program: { bib: "misc", csl: "software" },
  conference_paper: { bib: "inproceedings", csl: "paper-conference" },
  dataset: { bib: "misc", csl: "dataset" },
  dictionary_entry: { bib: "inbook", csl: "entry-dictionary" },
  email: { bib: "misc", csl: "personal_communication" },
  encyclopedia_article: { bib: "inbook", csl: "entry-encyclopedia" },
  film: { bib: "movie", csl: "motion_picture" },
  forum_post: { bib: "misc", csl: "post" },
  hearing: { bib: "misc", csl: "hearing" },
  instant_message: { bib: "misc", csl: "personal_communication" },
  interview: { bib: "misc", csl: "interview" },
  journal_article: { bib: "article", csl: "article-journal" },
  letter: { bib: "misc", csl: "personal_communication" },
  magazine_article: { bib: "article", csl: "article-magazine" },
  manuscript: { bib: "unpublished", csl: "manuscript" },
  map: { bib: "misc", csl: "map" },
  newspaper_article: { bib: "article", csl: "article-newspaper" },
  patent: { bib: "misc", csl: "patent" },
  podcast: { bib: "misc", csl: "broadcast" },
  preprint: { bib: "misc", csl: "article" },
  presentation: { bib: "misc", csl: "speech" },
  radio_broadcast: { bib: "misc", csl: "broadcast" },
  report: { bib: "techreport", csl: "report" },
  standard: { bib: "misc", csl: "standard" },
  statute: { bib: "misc", csl: "legislation" },
  thesis: { bib: "phdthesis", csl: "thesis" },
  tv_broadcast: { bib: "series", csl: "broadcast" },
  video_recording: { bib: "movie", csl: "motion_picture" },
  web_page: { bib: "misc", csl: "webpage" },
  conference: { bib: "inproceedings", csl: "paper-conference" },
  song: { bib: "song", csl: "song" },
  tv_series: { bib: "series", csl: "broadcast" },
};

describe("the 39-class roster", () => {
  it("derives from the Zotero manifest + the three judgment classes", () => {
    expect(SOURCE_CLASS_NAMES).toHaveLength(39);
    expect(new Set(SOURCE_CLASS_NAMES).size).toBe(39);
    // Every citable Zotero type maps onto a roster class (`case` → document
    // is the documented fallback — the case class was never seeded).
    for (const type of ZOTERO_CITABLE_ITEM_TYPES) {
      expect(SOURCE_CLASS_NAMES).toContain(ZOTERO_ITEM_TYPE_TO_CLASS[type]);
    }
    // The judgment classes have no exact Zotero counterpart.
    for (const name of ["conference", "song", "tv_series"] as const) {
      expect(SOURCE_CLASS_NAMES).toContain(name);
      expect(Object.values(ZOTERO_ITEM_TYPE_TO_CLASS)).not.toContain(name);
    }
  });

  it("every roster class extends source, and the ids are the system seeds", () => {
    for (const name of SOURCE_CLASS_NAMES) {
      expect(SYSTEM_CLASS_EXTENDS[name]).toContain("source");
      expect(SOURCE_CLASS_IDS[name]).toBe(SYSTEM_CLASS_UUIDS[name]);
    }
  });

  it("pins the hand-written BibTeX/CSL table verbatim", () => {
    expect(CLASS_BIBLIOGRAPHY).toEqual(EXPECTED_BIBLIOGRAPHY);
    expect(CLASS_NAME_TO_CSL_TYPE).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_BIBLIOGRAPHY).map(([name, entry]) => [name, entry.csl]),
      ),
    );
  });
});

describe("the derived import/serialization tables", () => {
  it("pins BibTeX entry type → class (canonical picks + legacy aliases)", () => {
    expect(BIB_TYPE_TO_CLASS_NAME).toEqual({
      book: "book",
      inbook: "book_section",
      incollection: "book_section",
      article: "journal_article",
      inproceedings: "conference",
      conference: "conference",
      proceedings: "conference",
      phdthesis: "thesis",
      mastersthesis: "thesis",
      techreport: "report",
      unpublished: "manuscript",
      song: "song",
      movie: "film",
      video: "film",
      series: "tv_series",
      tv: "tv_series",
    });
    expect(bibTypeToClassName("misc")).toBe("document");
    expect(bibTypeToClassName("NONSENSE")).toBe("document");
  });

  it("pins CSL type → class for import (shared types take the canonical class)", () => {
    expect(CSL_TYPE_TO_CLASS_NAME).toEqual({
      graphic: "artwork",
      song: "song",
      bill: "bill",
      "post-weblog": "blog_post",
      book: "book",
      chapter: "book_section",
      document: "document",
      software: "computer_program",
      "paper-conference": "conference",
      dataset: "dataset",
      "entry-dictionary": "dictionary_entry",
      personal_communication: "letter",
      "entry-encyclopedia": "encyclopedia_article",
      motion_picture: "film",
      post: "forum_post",
      hearing: "hearing",
      interview: "interview",
      "article-journal": "journal_article",
      "article-magazine": "magazine_article",
      manuscript: "manuscript",
      map: "map",
      "article-newspaper": "newspaper_article",
      patent: "patent",
      broadcast: "tv_series",
      article: "journal_article",
      speech: "presentation",
      report: "report",
      standard: "standard",
      legislation: "statute",
      thesis: "thesis",
      webpage: "web_page",
      legal_case: "document",
    });
  });

  it("pins CSL type → BibTeX entry type for re-serialization", () => {
    expect(CSL_TYPE_TO_BIB_TYPE).toEqual({
      graphic: "misc",
      song: "song",
      bill: "misc",
      "post-weblog": "misc",
      book: "book",
      chapter: "inbook",
      document: "misc",
      software: "misc",
      "paper-conference": "inproceedings",
      dataset: "misc",
      "entry-dictionary": "inbook",
      personal_communication: "misc",
      "entry-encyclopedia": "inbook",
      motion_picture: "movie",
      post: "misc",
      hearing: "misc",
      interview: "misc",
      "article-journal": "article",
      "article-magazine": "article",
      manuscript: "unpublished",
      map: "misc",
      "article-newspaper": "article",
      patent: "misc",
      broadcast: "series",
      article: "article",
      speech: "misc",
      report: "techreport",
      standard: "misc",
      legislation: "misc",
      thesis: "phdthesis",
      webpage: "misc",
    });
  });

  it("carries the editor and ISSN fields through BibTeX ↔ CSL both ways", () => {
    const entry = parseBibtex(
      "@collection{coll2024, title={Collected Papers}, editor={Doe, Jane and Roe, Richard}, issn={1234-5678}}",
    )[0]!;
    const item = bibToCsl(entry);
    expect(item.editor).toEqual([
      { family: "Doe", given: "Jane" },
      { family: "Roe", given: "Richard" },
    ]);
    expect(item.ISSN).toBe("1234-5678");
    // editor and author are independent tracks — no author key materializes
    // from the editor field.
    expect(item).not.toHaveProperty("author");

    const back = cslToBib(item);
    expect(back.fields.editor).toBe("Doe, Jane and Roe, Richard");
    expect(back.fields.issn).toBe("1234-5678");
  });
});

describe("nodeToCsl — the dual-track read contract", () => {
  const AGENT_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const AGENT_B = "aaaaaaaa-0000-4000-8000-0000000000a2";

  it("reads authors text rows (array and per-element shapes) and parses 'Family, Given'", () => {
    const arrayRow = nodeToCsl(
      { id: "n1", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [{ schemaId: AUTHORS_ID, schemaName: "authors", value: ["Lovelace, Ada", "Lord Byron", "  "] }],
    );
    expect(arrayRow.author).toEqual([
      { family: "Lovelace", given: "Ada" },
      { family: "Byron", given: "Lord" },
    ]);
    const perElement = nodeToCsl(
      { id: "n2", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [
        { schemaId: AUTHORS_ID, schemaName: "authors", value: "Lovelace, Ada" },
        { schemaId: AUTHORS_ID, schemaName: "authors", value: { nodeId: AGENT_A } },
        { schemaId: AUTHORS_ID, schemaName: "authors", value: "Prince" },
      ],
    );
    // The stale {nodeId} element rides untouched (the migration keeps broken
    // refs) — non-strings are skipped, the strings still win.
    expect(perElement.author).toEqual([
      { family: "Lovelace", given: "Ada" },
      { family: "Prince" },
    ]);
  });

  it("derives authors from the linkedAuthors targets when no authors row resolves", () => {
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [
        { schemaId: LINKED_AUTHORS_ID, schemaName: "linkedAuthors", value: [{ nodeId: AGENT_A }, { nodeId: AGENT_B }] },
      ],
      {
        resolveAgentName: (id) =>
          id === AGENT_A ? "Lovelace, Ada" : id === AGENT_B ? "Ada Lovelace" : undefined,
      },
    );
    // Caller-resolved: "Family, Given" parses family-first; the natural-form
    // title fallback parses last-token family; unresolved targets are skipped.
    expect(item.author).toEqual([
      { family: "Lovelace", given: "Ada" },
      { family: "Lovelace", given: "Ada" },
    ]);
  });

  it("a stale {nodeId}-only authors property reads as EMPTY and falls back to linkedAuthors", () => {
    const calls: string[] = [];
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [
        { schemaId: AUTHORS_ID, schemaName: "authors", value: { nodeId: AGENT_A } },
        { schemaId: LINKED_AUTHORS_ID, schemaName: "linkedAuthors", value: [{ nodeId: AGENT_B }] },
      ],
      { resolveAgentName: (id) => (calls.push(id), "Byron, Lord") },
    );
    expect(item.author).toEqual([{ family: "Byron", given: "Lord" }]);
    expect(calls).toEqual([AGENT_B]); // only the linkedAuthors targets resolve
  });

  it("authors present → the linkedAuthors track is never consulted", () => {
    const calls: string[] = [];
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [
        { schemaId: AUTHORS_ID, schemaName: "authors", value: ["Solo Author"] },
        { schemaId: LINKED_AUTHORS_ID, schemaName: "linkedAuthors", value: [{ nodeId: AGENT_A }] },
      ],
      { resolveAgentName: (id) => (calls.push(id), "Unused, Name") },
    );
    expect(item.author).toEqual([{ family: "Author", given: "Solo" }]);
    expect(calls).toEqual([]);
  });

  it("emits no author key when neither track resolves to a name", () => {
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book] },
      [{ schemaId: LINKED_AUTHORS_ID, schemaName: "linkedAuthors", value: [{ nodeId: AGENT_A }] }],
      { resolveAgentName: () => undefined },
    );
    expect(item).not.toHaveProperty("author");
  });

  it("projects editors text rows to CSL editor", () => {
    const item = nodeToCsl(
      { id: "n", name: "T", classIds: [SOURCE_CLASS_IDS.book_section] },
      [{ schemaId: EDITORS_ID, schemaName: "editors", value: ["Doe, Jane"] }],
    );
    expect(item.editor).toEqual([{ family: "Doe", given: "Jane" }]);
    expect(cslToBib(item).fields.editor).toBe("Doe, Jane");
    const noEditors = nodeToCsl({ id: "n2", name: "T2", classIds: [SOURCE_CLASS_IDS.book] }, []);
    expect(noEditors).not.toHaveProperty("editor");
  });
});

describe("nodeToCsl — the per-class pool fields (SYSTEM_SOURCE_CLASS_BINDINGS)", () => {
  const POOL = SYSTEM_PROPERTY_UUIDS;

  it("maps the journal_article bindings the node carries onto the CSL slots", () => {
    const item = nodeToCsl(
      { id: "paper", name: "A paper", classIds: [SOURCE_CLASS_IDS.journal_article] },
      [
        { schemaId: POOL.publicationTitle, schemaName: "Publication title", value: "Biometrika" },
        { schemaId: POOL.volume, schemaName: "Volume", value: "50" },
        { schemaId: POOL.issue, schemaName: "Issue", value: "1/2" },
        { schemaId: POOL.pages, schemaName: "Pages", value: "207--229" },
        { schemaId: POOL.issn, schemaName: "ISSN", value: "0006-3444" },
      ],
    );
    expect(item).toMatchObject({
      type: "article-journal",
      "container-title": "Biometrika",
      volume: "50",
      issue: "1/2",
      page: "207--229",
      ISSN: "0006-3444",
    });
  });

  it("maps each class's own container candidate (book → bookTitle, conference → proceedingsTitle, song → seriesTitle)", () => {
    const chapter = nodeToCsl(
      { id: "ch", name: "A chapter", classIds: [SOURCE_CLASS_IDS.book_section] },
      [
        { schemaId: POOL.bookTitle, schemaName: "Book title", value: "Collected Papers" },
        { schemaId: POOL.pages, schemaName: "Pages", value: "1--20" },
      ],
    );
    expect(chapter["container-title"]).toBe("Collected Papers");
    expect(chapter.page).toBe("1--20");
    expect(chapter).toMatchObject({ type: "chapter" });

    const paper = nodeToCsl(
      { id: "cp", name: "A conference paper", classIds: [SOURCE_CLASS_IDS.conference_paper] },
      [{ schemaId: POOL.proceedingsTitle, schemaName: "Proceedings title", value: "Proc. ACL" }],
    );
    expect(paper["container-title"]).toBe("Proc. ACL");

    const song = nodeToCsl(
      { id: "sg", name: "A song", classIds: [SOURCE_CLASS_IDS.song] },
      [{ schemaId: POOL.seriesTitle, schemaName: "Series title", value: "The Album" }],
    );
    expect(song["container-title"]).toBe("The Album");
  });

  it("the binding list is the locality authority: a field the class does not bind never exports", () => {
    // A journal_article carrying bookTitle (another class's container
    // candidate): the node carries it, the class does not bind it → absent.
    const item = nodeToCsl(
      { id: "paper", name: "A paper", classIds: [SOURCE_CLASS_IDS.journal_article] },
      [{ schemaId: POOL.bookTitle, schemaName: "Book title", value: "Not a book" }],
    );
    expect(item).not.toHaveProperty("container-title");
    // document binds none of the container candidates at all.
    const doc = nodeToCsl(
      { id: "doc", name: "A document", classIds: [SOURCE_CLASS_IDS.document] },
      [{ schemaId: POOL.publicationTitle, schemaName: "Publication title", value: "Ignored" }],
    );
    expect(doc).not.toHaveProperty("container-title");
  });

  it("a bound field the node does not carry stays absent", () => {
    const item = nodeToCsl(
      { id: "paper", name: "A paper", classIds: [SOURCE_CLASS_IDS.journal_article] },
      [{ schemaId: POOL.publicationTitle, schemaName: "Publication title", value: "Biometrika" }],
    );
    expect(item["container-title"]).toBe("Biometrika");
    expect(item).not.toHaveProperty("volume");
    expect(item).not.toHaveProperty("issue");
    expect(item).not.toHaveProperty("page");
  });

  it("the pool read wins over the PG15 schema-name fallback", () => {
    const item = nodeToCsl(
      { id: "paper", name: "A paper", classIds: [SOURCE_CLASS_IDS.journal_article] },
      [
        { schemaId: POOL.publicationTitle, schemaName: "Publication title", value: "Biometrika" },
        { schemaId: "j1", schemaName: "journal", value: "Legacy Journal Name" },
      ],
    );
    expect(item["container-title"]).toBe("Biometrika");
  });
});

describe("sourceClassOf over the roster", () => {
  it("recognizes every roster class id and ignores others", () => {
    for (const name of SOURCE_CLASS_NAMES) {
      expect(sourceClassOf([SOURCE_CLASS_IDS[name]])).toBe(name);
    }
    expect(sourceClassOf([SYSTEM_CLASS_UUIDS.person])).toBeUndefined();
    expect(sourceClassOf([SYSTEM_CLASS_UUIDS.source])).toBeUndefined(); // the family base is not a type-class
    expect(sourceClassOf([])).toBeUndefined();
  });
});
