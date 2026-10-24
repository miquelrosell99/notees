/**
 * CSL-JSON as the canonical interchange for the bibliography round-trip
 * (pure, IO-free — lives next to the BibTeX parser in `@notees/export`).
 *
 * Source-library slices 3–6 task 1 (owner 2026-10-24): the bidirectional
 * rework over the 39-class roster. Every mapping below is DERIVED at module
 * scope from the domain manifest, not hand-maintained per direction:
 *
 *  - The roster IS the domain data: the distinct classes of
 *    `ZOTERO_ITEM_TYPE_TO_CLASS` (36 — Zotero's 37 citable types, with
 *    `case` falling back to `document`) plus the three kept classes with no
 *    exact Zotero counterpart (`conference` ← the conferencePaper +
 *    presentation union, `song` ← audioRecording, `tv_series` ← tvBroadcast —
 *    the source-class-bindings header documents the same substitutions).
 *  - `CLASS_BIBLIOGRAPHY` — the ONE hand-written table: each class's BibTeX
 *    entry type + CSL type (39 entries). The CSL types follow Zotero's own
 *    schema mapping (`zotero-schema.json` `csl.types`); the BibTeX types
 *    follow Zotero/citeproc conventions, keeping the two nonstandard types
 *    the old table established (`movie` for film/video, `series` for the
 *    broadcast family). Where BibTeX has no type (most of the long tail),
 *    the class exports as `misc` and re-imports as `document` — the family
 *    fallback, documented per entry.
 *  - BibTeX → class: first-wins over the roster, with documented canonical
 *    picks for the shared types (inproceedings → conference, song → song,
 *    series → tv_series) and the legacy aliases (incollection, conference,
 *    proceedings, mastersthesis, video, tv). `misc` and anything unknown →
 *    document (DEFAULT_CLASS_NAME).
 *  - class → CSL: the table verbatim. CSL → class for import: first-wins with
 *    canonical picks for the shared types (broadcast → tv_series,
 *    personal_communication → letter, paper-conference → conference,
 *    song → song) and `legal_case → document` (the `case` class was never
 *    seeded — ZOTERO_ITEM_TYPE_TO_CLASS documents the same fallback).
 *    Unknown CSL types → document.
 *  - CSL → BibTeX for re-serialization: first-wins with `broadcast → series`
 *    and `article → article` canonical picks. Types no class exports fall to
 *    `misc` at serialize time (cslToBib's default).
 *
 * Authorship (SCHEMA.md "Citations — source family and authorship", owner
 * 2026-10-23): DUAL-TRACK, and the read contract is IMPLEMENTED HERE (this
 * rework is what shipped it — the "designed-not-built" note retired):
 * `nodeToCsl` reads `authors` (free-text multi, "Family, Given" strings — the
 * citation/export source of truth) straight off the node's property rows,
 * parsing each to a CSL name (comma split, family first; natural form falls
 * back to last-token family). When NO authors row resolves to a name, the
 * contract derives from `linkedAuthors` (object→agent): each target resolves
 * through the caller's `resolveAgentName` (agent givenName/familyName,
 * title fallback — the export package is ctx-free, so the IR builder / CLI
 * resolves; nodeToCsl owns the ORDER). `editors` (text multi) projects to
 * CSL `editor` and, on re-serialization, the BibTeX `editor` field.
 * `linkedAuthors` is the independent people-graph track — never written here.
 *
 * The per-class pool fields (journal_article → publicationTitle/volume/
 * issue/pages/ISSN, …) come from `SYSTEM_SOURCE_CLASS_BINDINGS` — the class's
 * Zotero field list: nodeToCsl walks the class's binding list and maps the
 * bound pool fields the node actually carries onto the CSL container/
 * volume/issue/page slots (a node carrying a field its class doesn't bind
 * does NOT export it — the binding list is the locality authority). The PG15
 * schema-NAME convention (journal/booktitle/volume/number/pages) remains the
 * fallback for workspaces whose schemas predate the pool.
 *
 * Dates are year-only `date-parts` taken from the first 4-digit run of the
 * publicationDate value.
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  ZOTERO_ITEM_TYPE_TO_CLASS,
  type SystemPropertyName,
} from "@notees/domain";

import type { BibEntry } from "./bibtex.js";
import type { ExportPropertyValue } from "./document.js";

// --- CSL-JSON subset -----------------------------------------------------------

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

export type CslType =
  | "book"
  | "article-journal"
  | "article"
  | "paper-conference"
  | "thesis"
  | string;

export interface CslItem {
  id: string;
  type: CslType;
  title?: string;
  author?: CslName[];
  editor?: CslName[];
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  URL?: string;
}

// --- the 39-class roster (derived from the domain manifest) ----------------------

/** The 39 source type-classes (the roster). The TYPE lists the names; the
 *  RUNTIME {@link SOURCE_CLASS_NAMES} derives the same set from the domain
 *  manifest (the test pins them equal — the manifest is the derivation
 *  source, this union is the typed view). */
export type SourceClassName =
  | "artwork"
  | "audio_recording"
  | "bill"
  | "blog_post"
  | "book"
  | "book_section"
  | "computer_program"
  | "conference"
  | "conference_paper"
  | "dataset"
  | "dictionary_entry"
  | "document"
  | "email"
  | "encyclopedia_article"
  | "film"
  | "forum_post"
  | "hearing"
  | "instant_message"
  | "interview"
  | "journal_article"
  | "letter"
  | "magazine_article"
  | "manuscript"
  | "map"
  | "newspaper_article"
  | "patent"
  | "podcast"
  | "preprint"
  | "presentation"
  | "radio_broadcast"
  | "report"
  | "song"
  | "standard"
  | "statute"
  | "thesis"
  | "tv_broadcast"
  | "tv_series"
  | "video_recording"
  | "web_page";

/** Kept classes with no exact Zotero counterpart (the source-class-bindings
 *  header documents the same substitutions: conference ← conferencePaper ∪
 *  presentation, song ← audioRecording, tv_series ← tvBroadcast). */
const JUDGMENT_CLASSES: readonly SourceClassName[] = ["conference", "song", "tv_series"];

function deriveRecord<K extends string, V>(entries: Iterable<readonly [K, V]>): Record<K, V> {
  return Object.fromEntries(entries) as Record<K, V>;
}

/** The 39 source type-classes, in derivation order (the Zotero manifest's
 *  insertion order, then the three judgment classes). */
export const SOURCE_CLASS_NAMES: readonly SourceClassName[] = [
  ...new Set<SourceClassName>(Object.values(ZOTERO_ITEM_TYPE_TO_CLASS) as SourceClassName[]),
  ...JUDGMENT_CLASSES,
];

export const SOURCE_CLASS_IDS: Record<SourceClassName, string> = deriveRecord(
  SOURCE_CLASS_NAMES.map((name) => [name, SYSTEM_CLASS_UUIDS[name]] as const),
);

/** The one hand-written table: each class's BibTeX entry type + CSL type.
 *  CSL types follow Zotero's schema mapping; BibTeX types follow
 *  Zotero/citeproc conventions (`misc` where BibTeX has no type — those
 *  classes re-import as `document`, the family fallback). `movie` and
 *  `series` are the two nonstandard types the pre-roster table established;
 *  the tolerant parser re-imports both. */
export interface ClassBibliography {
  bib: string;
  csl: CslType;
}

export const CLASS_BIBLIOGRAPHY: Record<SourceClassName, ClassBibliography> = {
  artwork: { bib: "misc", csl: "graphic" },
  // ← audioRecording; a recording exports as @song (the kept-class convention).
  audio_recording: { bib: "song", csl: "song" },
  bill: { bib: "misc", csl: "bill" },
  blog_post: { bib: "misc", csl: "post-weblog" },
  book: { bib: "book", csl: "book" },
  book_section: { bib: "inbook", csl: "chapter" },
  // The family fallback: misc ⇄ document is round-trip stable.
  document: { bib: "misc", csl: "document" },
  computer_program: { bib: "misc", csl: "software" },
  conference_paper: { bib: "inproceedings", csl: "paper-conference" },
  dataset: { bib: "misc", csl: "dataset" },
  // Zotero exports reference entries as @inbook — both re-import as book_section.
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
  // BibTeX @unpublished is the canonical manuscript type.
  manuscript: { bib: "unpublished", csl: "manuscript" },
  map: { bib: "misc", csl: "map" },
  newspaper_article: { bib: "article", csl: "article-newspaper" },
  patent: { bib: "misc", csl: "patent" },
  podcast: { bib: "misc", csl: "broadcast" },
  // CSL `article` (Zotero's preprint mapping) re-serializes as @article per
  // the pre-roster table — a preprint re-imports as journal_article either way.
  preprint: { bib: "misc", csl: "article" },
  // Zotero exports presentations as @misc (no canonical BibTeX type).
  presentation: { bib: "misc", csl: "speech" },
  radio_broadcast: { bib: "misc", csl: "broadcast" },
  report: { bib: "techreport", csl: "report" },
  standard: { bib: "misc", csl: "standard" },
  statute: { bib: "misc", csl: "legislation" },
  thesis: { bib: "phdthesis", csl: "thesis" },
  tv_broadcast: { bib: "series", csl: "broadcast" },
  video_recording: { bib: "movie", csl: "motion_picture" },
  web_page: { bib: "misc", csl: "webpage" },
  // Judgment classes (no exact Zotero counterpart — the header above documents
  // the substitutions). conference ← conferencePaper ∪ presentation; a talk
  // and a proceedings paper both cite/export as @inproceedings.
  conference: { bib: "inproceedings", csl: "paper-conference" },
  song: { bib: "song", csl: "song" },
  tv_series: { bib: "series", csl: "broadcast" },
};

export const DEFAULT_CLASS_NAME: SourceClassName = "document";

// --- BibTeX ↔ class --------------------------------------------------------------

/** Canonical picks for the BibTeX types several classes share (documented
 *  deviations — the first-wins derivation lands on the alphabetically-first
 *  class; these keep the pre-roster import behavior). */
const BIB_CANONICAL_OVERRIDES: Record<string, SourceClassName> = {
  inproceedings: "conference", // conference_paper shares the type
  song: "song", // audio_recording shares the type
  series: "tv_series", // tv_broadcast shares the type
};

/** Legacy aliases the tolerant parser has always accepted. */
const BIB_TYPE_ALIASES: Record<string, SourceClassName> = {
  incollection: "book_section",
  conference: "conference",
  proceedings: "conference",
  mastersthesis: "thesis",
  video: "film",
  tv: "tv_series",
};

/** BibTeX entry type → source class name (derived: first-wins over the
 *  roster, then the canonical picks and legacy aliases above). `misc` is
 *  deliberately absent — unknown/misc entries import as the `document`
 *  fallback via {@link DEFAULT_CLASS_NAME}. */
export const BIB_TYPE_TO_CLASS_NAME: Record<string, SourceClassName> = (() => {
  const table: Record<string, SourceClassName> = {};
  for (const name of SOURCE_CLASS_NAMES) {
    const bib = CLASS_BIBLIOGRAPHY[name].bib;
    if (bib === "misc") continue;
    if (table[bib] === undefined) table[bib] = name;
  }
  Object.assign(table, BIB_CANONICAL_OVERRIDES, BIB_TYPE_ALIASES);
  return table;
})();

export function bibTypeToClassName(entryType: string): SourceClassName {
  return BIB_TYPE_TO_CLASS_NAME[entryType.toLowerCase()] ?? DEFAULT_CLASS_NAME;
}

// --- class ↔ CSL -----------------------------------------------------------------

/** Source class name → CSL type (the table verbatim). */
export const CLASS_NAME_TO_CSL_TYPE: Record<SourceClassName, CslType> = deriveRecord(
  (Object.entries(CLASS_BIBLIOGRAPHY) as Array<[SourceClassName, ClassBibliography]>).map(
    ([name, entry]) => [name, entry.csl] as const,
  ),
);

/** Canonical picks for the CSL types several classes share, plus the
 *  case-type fallback (`legal_case` has no class — the Zotero manifest maps
 *  `case` to `document` the same way). */
const CSL_CANONICAL_OVERRIDES: Record<string, SourceClassName> = {
  article: "journal_article", // preprint shares the type
  broadcast: "tv_series", // podcast/radio_broadcast/tv_broadcast share the type
  song: "song", // audio_recording shares the type
  personal_communication: "letter", // email/instant_message share the type
  "paper-conference": "conference", // conference_paper shares the type
  legal_case: "document", // `case` has no class (owner ruling)
};

/** CSL type → source class name for import (the derived inverse of
 *  {@link CLASS_NAME_TO_CSL_TYPE}; unknown types → document). */
export const CSL_TYPE_TO_CLASS_NAME: Record<string, SourceClassName> = (() => {
  const table: Record<string, SourceClassName> = {};
  for (const name of SOURCE_CLASS_NAMES) {
    const csl = CLASS_BIBLIOGRAPHY[name].csl;
    if (table[csl] === undefined) table[csl] = name;
  }
  Object.assign(table, CSL_CANONICAL_OVERRIDES);
  return table;
})();

export function cslTypeToClassName(type: CslType): SourceClassName {
  return CSL_TYPE_TO_CLASS_NAME[type] ?? DEFAULT_CLASS_NAME;
}

/** Canonical re-serialization picks: a CSL `broadcast` re-serializes as the
 *  established nonstandard @series, and bare CSL `article` as @article (both
 *  pre-roster behaviors). */
const CSL_TO_BIB_OVERRIDES: Record<string, string> = {
  broadcast: "series",
  article: "article",
};

/** CSL type → BibTeX entry type for re-serialization (derived first-wins over
 *  the roster plus the picks above; types no class exports fall to `misc` at
 *  serialize time — cslToBib's default). */
export const CSL_TYPE_TO_BIB_TYPE: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  for (const name of SOURCE_CLASS_NAMES) {
    const csl = CLASS_BIBLIOGRAPHY[name].csl;
    if (table[csl] === undefined) table[csl] = CLASS_BIBLIOGRAPHY[name].bib;
  }
  Object.assign(table, CSL_TO_BIB_OVERRIDES);
  return table;
})();

// --- author names ----------------------------------------------------------------

/** Parse one literal author name into CSL family/given. */
export function parseAuthorName(literal: string): CslName {
  const name = literal.trim().replace(/\s+/g, " ");
  if (name.length === 0) return { literal: "" };
  const comma = name.indexOf(",");
  if (comma !== -1) {
    const family = name.slice(0, comma).trim();
    const given = name.slice(comma + 1).trim();
    return given.length > 0 ? { family, given } : { family };
  }
  const tokens = name.split(" ");
  if (tokens.length === 1) return { family: tokens[0]! };
  return { given: tokens.slice(0, -1).join(" "), family: tokens[tokens.length - 1]! };
}

/** Split a BibTeX author field on the `and` separator into CSL names. */
export function parseAuthors(field: string | undefined): CslName[] {
  if (field === undefined) return [];
  return field
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map(parseAuthorName);
}

/** Format one CSL name in BibTeX `Family, Given` form. */
export function formatAuthorName(name: CslName): string {
  const family = name.family?.trim();
  const given = name.given?.trim();
  if (family !== undefined && family.length > 0 && given !== undefined && given.length > 0) {
    return `${family}, ${given}`;
  }
  if (family !== undefined && family.length > 0) return family;
  if (given !== undefined && given.length > 0) return given;
  return name.literal?.trim() ?? "";
}

/** Join CSL names into one BibTeX author field. */
export function formatAuthors(names: readonly CslName[]): string {
  return names.map(formatAuthorName).filter((name) => name.length > 0).join(" and ");
}

/** First 4-digit year of a date-ish value (publicationDate is year-only). */
export function yearFromDate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /(\d{4})/.exec(value);
  return match !== null ? Number.parseInt(match[1]!, 10) : undefined;
}

// --- BibTeX ↔ CSL ------------------------------------------------------------------

export function bibToCsl(entry: BibEntry): CslItem {
  const item: CslItem = {
    id: entry.citeKey,
    type: CLASS_NAME_TO_CSL_TYPE[bibTypeToClassName(entry.entryType)],
  };
  const fields = entry.fields;
  if (fields.title !== undefined && fields.title.length > 0) item.title = fields.title;
  const authors = parseAuthors(fields.author);
  if (authors.length > 0) item.author = authors;
  const editors = parseAuthors(fields.editor);
  if (editors.length > 0) item.editor = editors;
  const yearText = fields.year ?? fields.date;
  const year = yearText !== undefined ? yearFromDate(yearText) : undefined;
  if (year !== undefined) item.issued = { "date-parts": [[year]] };
  const container = fields.journal ?? fields.booktitle;
  if (container !== undefined && container.length > 0) item["container-title"] = container;
  const publisher = fields.publisher ?? fields.school ?? fields.institution;
  if (publisher !== undefined && publisher.length > 0) item.publisher = publisher;
  if (fields.volume !== undefined) item.volume = fields.volume;
  if (fields.number !== undefined) item.issue = fields.number;
  if (fields.pages !== undefined) item.page = fields.pages;
  if (fields.doi !== undefined && fields.doi.length > 0) item.DOI = fields.doi;
  if (fields.isbn !== undefined && fields.isbn.length > 0) item.ISBN = fields.isbn;
  if (fields.issn !== undefined && fields.issn.length > 0) item.ISSN = fields.issn;
  if (fields.url !== undefined && fields.url.length > 0) item.URL = fields.url;
  return item;
}

export function cslToBib(item: CslItem): BibEntry {
  const fields: Record<string, string> = {};
  if (item.title !== undefined && item.title.length > 0) fields.title = item.title;
  if (item.author !== undefined && item.author.length > 0) fields.author = formatAuthors(item.author);
  if (item.editor !== undefined && item.editor.length > 0) fields.editor = formatAuthors(item.editor);
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  if (year !== undefined) fields.year = String(year);
  if (item["container-title"] !== undefined && item["container-title"].length > 0) {
    fields[item.type === "paper-conference" ? "booktitle" : "journal"] = item["container-title"];
  }
  if (item.publisher !== undefined && item.publisher.length > 0) fields.publisher = item.publisher;
  if (item.volume !== undefined) fields.volume = item.volume;
  if (item.issue !== undefined) fields.number = item.issue;
  if (item.page !== undefined) fields.pages = item.page;
  if (item.DOI !== undefined && item.DOI.length > 0) fields.doi = item.DOI;
  if (item.ISBN !== undefined && item.ISBN.length > 0) fields.isbn = item.ISBN;
  if (item.ISSN !== undefined && item.ISSN.length > 0) fields.issn = item.ISSN;
  if (item.URL !== undefined && item.URL.length > 0) fields.url = item.URL;
  return {
    entryType: CSL_TYPE_TO_BIB_TYPE[item.type] ?? "misc",
    citeKey: item.id,
    fields,
  };
}

// --- node graph ↔ CSL --------------------------------------------------------------

/** The node shape `nodeToCsl` needs — satisfied by the object-API full object. */
export interface BibliographicNode {
  id: string;
  name: string | null;
  classIds: readonly string[];
}

function propValue(props: readonly ExportPropertyValue[], schemaId: string): unknown {
  return props.find((prop) => prop.schemaId === schemaId)?.value;
}

function propText(props: readonly ExportPropertyValue[], schemaId: string): string | undefined {
  const value = propValue(props, schemaId);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A property value looked up by schema NAME (the loose, convention-based
 * direction — PG15): the fallback branch completes the CSL mapping through
 * the BibTeX field vocabulary by schema name — `journal`/`booktitle` →
 * container-title, `volume` → volume, `number` → issue, `pages` → page (the
 * exact inverse of bibToCsl's field mapping, so a BibTeX→Notees→BibTeX round
 * trip stays stable for workspaces that carry schemas under those names).
 * The pool-bound read (the class's SYSTEM_SOURCE_CLASS_BINDINGS list) is the
 * primary; this is the pre-pool fallback only.
 */
function propTextByName(props: readonly ExportPropertyValue[], schemaName: string): string | undefined {
  const value = props.find((prop) => prop.schemaName === schemaName)?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Every string a multi-value text property's rows carry, in row order. The
 * object API may project one row per element or one row holding the element
 * array — both flatten here. Non-string elements (a stale `{nodeId}` value
 * riding the post-flip text `authors` schema — the migration keeps broken
 * refs untouched) are skipped, so an all-stale property reads as EMPTY and
 * the linkedAuthors fallback half of the read contract takes over.
 */
function textLiterals(props: readonly ExportPropertyValue[], schemaId: string): string[] {
  const literals: string[] = [];
  for (const row of props) {
    if (row.schemaId !== schemaId) continue;
    const values = Array.isArray(row.value) ? row.value : [row.value];
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) literals.push(value);
    }
  }
  return literals;
}

/** Every `{nodeId}` ref an object property's rows carry, in row order. */
function nodeRefs(props: readonly ExportPropertyValue[], schemaId: string): string[] {
  const refs: string[] = [];
  for (const row of props) {
    if (row.schemaId !== schemaId) continue;
    const values = Array.isArray(row.value) ? row.value : [row.value];
    for (const value of values) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { nodeId?: unknown }).nodeId === "string"
      ) {
        refs.push((value as { nodeId: string }).nodeId);
      }
    }
  }
  return refs;
}

/** First source class on the node (classIds order), if any. */
export function sourceClassOf(classIds: readonly string[]): SourceClassName | undefined {
  for (const classId of classIds) {
    for (const name of SOURCE_CLASS_NAMES) {
      if (SOURCE_CLASS_IDS[name] === classId) return name;
    }
  }
  return undefined;
}

/** The pool fields that fill each CSL slot, candidate-ordered. The class's
 *  binding list (SYSTEM_SOURCE_CLASS_BINDINGS) is the authority for which
 *  candidates a class exports; the first bound candidate the node actually
 *  carries wins. */
type CslSlot = "container-title" | "volume" | "issue" | "page";

const CSL_SLOT_CANDIDATES: Record<CslSlot, readonly SystemPropertyName[]> = {
  "container-title": [
    "publicationTitle",
    "bookTitle",
    "proceedingsTitle",
    "websiteTitle",
    "blogTitle",
    "forumTitle",
    "programTitle",
    "seriesTitle",
  ],
  volume: ["volume"],
  issue: ["issue", "number"],
  page: ["pages", "codePages"],
};

/** Caller-resolved lookups for {@link nodeToCsl} (the export package is
 *  ctx-free — the IR builder / CLI resolves targets at build time). */
export interface NodeToCslOptions {
  /** Resolve a `{nodeId}` property ref to the target's display name (the
   *  publicationDate date-node ref — year-only values ride the date chain
   *  since the import-format change; plain-string values still win). */
  resolveName?: ((id: string) => string | undefined) | undefined;
  /** Resolve a `linkedAuthors` target (an agent node) to its citation name
   *  — "Family, Given" from the agent's familyName/givenName properties,
   *  falling back to its display title. nodeToCsl applies the read contract's
   *  ORDER (authors rows first; linkedAuthors-derived names only when no
   *  authors row resolves); the caller owns the agent→name derivation. */
  resolveAgentName?: ((id: string) => string | undefined) | undefined;
}

/**
 * Project a source node + its property rows into CSL — the dual-track read
 * contract implemented (SCHEMA.md "Citations", owner 2026-10-23):
 *
 *  - `authors` (text multi, "Family, Given" strings) reads straight off the
 *    rows; each literal parses to a CSL name (comma form wins, family first;
 *    natural form falls back to last-token family).
 *  - `authors` EMPTY (no row, or only stale non-string values) → derive from
 *    `linkedAuthors` (object→agent): each target resolves through
 *    `options.resolveAgentName` (agent givenName/familyName, title fallback).
 *  - `editors` (text multi) → CSL `editor`.
 *  - The class's pool bindings (SYSTEM_SOURCE_CLASS_BINDINGS) complete the
 *    container/volume/issue/page slots from the rows the node carries; the
 *    PG15 schema-name convention is the pre-pool fallback.
 */
export function nodeToCsl(
  node: BibliographicNode,
  props: readonly ExportPropertyValue[],
  options?: NodeToCslOptions,
): CslItem {
  const className = sourceClassOf(node.classIds) ?? DEFAULT_CLASS_NAME;
  const item: CslItem = {
    id: propText(props, SYSTEM_PROPERTY_UUIDS.citekey) ?? node.id,
    type: CLASS_NAME_TO_CSL_TYPE[className],
  };
  if (node.name !== null && node.name.trim().length > 0) item.title = node.name.trim();

  const authorLiterals = textLiterals(props, SYSTEM_PROPERTY_UUIDS.authors);
  const authorNames =
    authorLiterals.length > 0
      ? authorLiterals
          .map((literal) => parseAuthorName(literal))
          .filter((name) => formatAuthorName(name).length > 0)
      : // The fallback half of the read contract: authors empty → the
        // linkedAuthors people-graph track, caller-resolved.
        nodeRefs(props, SYSTEM_PROPERTY_UUIDS.linkedAuthors)
          .map((ref) => parseAuthorName(options?.resolveAgentName?.(ref) ?? ""))
          .filter((name) => formatAuthorName(name).length > 0);
  if (authorNames.length > 0) item.author = authorNames;

  const editorNames = textLiterals(props, SYSTEM_PROPERTY_UUIDS.editors)
    .map((literal) => parseAuthorName(literal))
    .filter((name) => formatAuthorName(name).length > 0);
  if (editorNames.length > 0) item.editor = editorNames;

  const pubValue = propValue(props, SYSTEM_PROPERTY_UUIDS.publicationDate);
  const pubText =
    typeof pubValue === "string"
      ? pubValue
      : typeof (pubValue as { nodeId?: unknown } | undefined)?.nodeId === "string"
        ? options?.resolveName?.((pubValue as { nodeId: string }).nodeId)
        : undefined;
  const year = yearFromDate(pubText);
  if (year !== undefined) item.issued = { "date-parts": [[year]] };
  const doi = propText(props, SYSTEM_PROPERTY_UUIDS.doi);
  if (doi !== undefined) item.DOI = doi;
  const isbn = propText(props, SYSTEM_PROPERTY_UUIDS.isbn);
  if (isbn !== undefined) item.ISBN = isbn;
  const issn = propText(props, SYSTEM_PROPERTY_UUIDS.issn);
  if (issn !== undefined) item.ISSN = issn;
  const url = propText(props, SYSTEM_PROPERTY_UUIDS.url);
  if (url !== undefined) item.URL = url;
  const publisher = propText(props, SYSTEM_PROPERTY_UUIDS.publisher);
  if (publisher !== undefined) item.publisher = publisher;

  // The per-class pool bindings complete the container/volume/issue/page
  // slots: walk the class's binding list (alphabetical — deterministic), and
  // for each still-empty slot take the first bound candidate the node
  // carries. A field the class does NOT bind never exports, whatever the
  // node carries (the binding list is the locality authority).
  const bindings = SYSTEM_SOURCE_CLASS_BINDINGS[className];
  if (bindings !== undefined) {
    for (const candidate of bindings) {
      for (const slot of Object.keys(CSL_SLOT_CANDIDATES) as CslSlot[]) {
        if (item[slot] !== undefined) continue;
        if (!CSL_SLOT_CANDIDATES[slot].includes(candidate)) continue;
        const text = propText(props, SYSTEM_PROPERTY_UUIDS[candidate]);
        if (text !== undefined) item[slot] = text;
      }
    }
  }
  // PG15 fallback: a workspace whose schemas predate the pool completes the
  // mapping by schema-name convention (see propTextByName).
  if (item["container-title"] === undefined) {
    const containerTitle = propTextByName(props, "journal") ?? propTextByName(props, "booktitle");
    if (containerTitle !== undefined) item["container-title"] = containerTitle;
  }
  if (item.volume === undefined) {
    const volume = propTextByName(props, "volume");
    if (volume !== undefined) item.volume = volume;
  }
  if (item.issue === undefined) {
    const issue = propTextByName(props, "number");
    if (issue !== undefined) item.issue = issue;
  }
  if (item.page === undefined) {
    const page = propTextByName(props, "pages");
    if (page !== undefined) item.page = page;
  }
  return item;
}

/** The import-side spec: everything the CLI needs to find-or-create a source.
 * `authors` is the formatted `Family, Given` name-string list (the citation
 * track; `linkedAuthors` — the people-graph track — is caller material: the
 * CLI find-or-creates one agent node per name and links it there). */
export interface CslNodeSpec {
  className: SourceClassName;
  citekey: string;
  title: string;
  authors: string[];
  editors?: string[];
  doi?: string;
  isbn?: string;
  url?: string;
  publisher?: string;
  /** Year-only ISO date (`1962`) per the seeded datetime property. */
  publicationDate?: string;
}

export function cslToNodeSpecs(item: CslItem): CslNodeSpec {
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  return {
    className: cslTypeToClassName(item.type),
    citekey: item.id,
    title: item.title ?? item.id,
    authors: (item.author ?? [])
      .map((name) => formatAuthorName(name))
      .filter((literal) => literal.length > 0),
    ...(item.editor !== undefined && item.editor.length > 0
      ? {
          editors: item.editor
            .map((name) => formatAuthorName(name))
            .filter((literal) => literal.length > 0),
        }
      : {}),
    ...(item.DOI !== undefined && item.DOI.length > 0 ? { doi: item.DOI } : {}),
    ...(item.ISBN !== undefined && item.ISBN.length > 0 ? { isbn: item.ISBN } : {}),
    ...(item.URL !== undefined && item.URL.length > 0 ? { url: item.URL } : {}),
    ...(item.publisher !== undefined && item.publisher.length > 0 ? { publisher: item.publisher } : {}),
    ...(year !== undefined ? { publicationDate: String(year) } : {}),
  };
}
