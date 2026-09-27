/**
 * CSL-JSON as the canonical interchange for the bibliography round-trip
 * (pure, IO-free — lives next to the BibTeX parser in `@notees/export`).
 *
 * Three mappings, all keyed on the fixed system seeds from `@notees/domain`:
 *
 *  - BibTeX entry type ↔ source class (v1 precedent
 *    `app/plugins/builtin/bibtex/importer.py`): book/inbook/incollection →
 *    book; article/inproceedings/conference → paper; phd/mastersthesis →
 *    thesis; everything else → document.
 *  - source class ↔ CSL type: book → book; paper → article-journal;
 *    article → article; thesis → thesis; document → article (M1 fallback —
 *    CSL has no document-ish type, so a document drifts to article on
 *    round-trip; documented deviation).
 *  - CSL type → BibTeX type for re-serialization: book → book;
 *    article-journal/article → article; paper-conference → inproceedings;
 *    thesis → phdthesis; otherwise → misc.
 *
 * Authors are CSL `[{family, given}]`: person nodes contribute their
 * familyName/givenName property values; bare literal names are parsed
 * (comma form `Family, Given` wins; otherwise last token = family).
 * Dates are year-only `date-parts` taken from the first 4-digit run of the
 * publicationDate value (M1).
 */

import {
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "@notees/domain";

import type { BibEntry } from "./bibtex.js";
import type { ExportPropertyValue } from "./markdown.js";

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
  issued?: { "date-parts": number[][] };
  "container-title"?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  ISBN?: string;
  URL?: string;
}

export type SourceClassName = "book" | "paper" | "article" | "thesis" | "document";

export const SOURCE_CLASS_IDS: Record<SourceClassName, string> = {
  book: SYSTEM_CLASS_UUIDS.book,
  paper: SYSTEM_CLASS_UUIDS.paper,
  article: SYSTEM_CLASS_UUIDS.article,
  thesis: SYSTEM_CLASS_UUIDS.thesis,
  document: SYSTEM_CLASS_UUIDS.document,
};

export const SOURCE_CLASS_NAMES = Object.keys(SOURCE_CLASS_IDS) as SourceClassName[];

/** BibTeX entry type → source class name (v1 importer precedent). */
export const BIB_TYPE_TO_CLASS_NAME: Record<string, SourceClassName> = {
  book: "book",
  inbook: "book",
  incollection: "book",
  article: "paper",
  inproceedings: "paper",
  conference: "paper",
  phdthesis: "thesis",
  mastersthesis: "thesis",
};

export const DEFAULT_CLASS_NAME: SourceClassName = "document";

export function bibTypeToClassName(entryType: string): SourceClassName {
  return BIB_TYPE_TO_CLASS_NAME[entryType.toLowerCase()] ?? DEFAULT_CLASS_NAME;
}

/** Source class name → CSL type (document → article is the M1 fallback). */
export const CLASS_NAME_TO_CSL_TYPE: Record<SourceClassName, CslType> = {
  book: "book",
  paper: "article-journal",
  article: "article",
  thesis: "thesis",
  document: "article",
};

/** CSL type → BibTeX entry type for re-serialization. */
export const CSL_TYPE_TO_BIB_TYPE: Record<string, string> = {
  book: "book",
  "article-journal": "article",
  article: "article",
  "paper-conference": "inproceedings",
  thesis: "phdthesis",
};

/** CSL type → source class name for import (the inverse of CLASS_NAME_TO_CSL_TYPE). */
export function cslTypeToClassName(type: CslType): SourceClassName {
  switch (type) {
    case "book":
      return "book";
    case "article-journal":
    case "paper-conference":
      return "paper";
    case "article":
      return "article";
    case "thesis":
      return "thesis";
    default:
      return DEFAULT_CLASS_NAME;
  }
}

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

/** First 4-digit year of a date-ish value (publicationDate is M1 year-only). */
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
  const authors = parseAuthors(fields.author ?? fields.editor);
  if (authors.length > 0) item.author = authors;
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
  if (fields.url !== undefined && fields.url.length > 0) item.URL = fields.url;
  return item;
}

export function cslToBib(item: CslItem): BibEntry {
  const fields: Record<string, string> = {};
  if (item.title !== undefined && item.title.length > 0) fields.title = item.title;
  if (item.author !== undefined && item.author.length > 0) fields.author = formatAuthors(item.author);
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
  if (item.URL !== undefined && item.URL.length > 0) fields.url = item.URL;
  return {
    entryType: CSL_TYPE_TO_BIB_TYPE[item.type] ?? "misc",
    citeKey: item.id,
    fields,
  };
}

// --- node graph ↔ CSL --------------------------------------------------------------

/** The person-node shape the author resolution needs (satisfied by the object API). */
export interface BibliographicPerson {
  id: string;
  name: string | null;
  givenName?: string | null;
  familyName?: string | null;
}

/** The node shape `nodeToCsl` needs — satisfied by the object-API full object. */
export interface BibliographicNode {
  id: string;
  name: string | null;
  classIds: string[];
}

function propValue(props: readonly ExportPropertyValue[], schemaId: string): unknown {
  return props.find((prop) => prop.schemaId === schemaId)?.value;
}

function propText(props: readonly ExportPropertyValue[], schemaId: string): string | undefined {
  const value = propValue(props, schemaId);
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

/**
 * Project a source node + its property values + resolved author person nodes
 * into CSL. `authors` must be the person nodes referenced by the node's
 * `authors` property values, in property order.
 */
export function nodeToCsl(
  node: BibliographicNode,
  props: readonly ExportPropertyValue[],
  authors: readonly BibliographicPerson[],
): CslItem {
  const className = sourceClassOf(node.classIds) ?? DEFAULT_CLASS_NAME;
  const item: CslItem = {
    id: propText(props, SYSTEM_PROPERTY_UUIDS.citekey) ?? node.id,
    type: CLASS_NAME_TO_CSL_TYPE[className],
  };
  if (node.name !== null && node.name.trim().length > 0) item.title = node.name.trim();
  const names: CslName[] = authors
    .map((person) => {
      const family = person.familyName?.trim();
      const given = person.givenName?.trim();
      if (family !== undefined && family.length > 0) {
        return given !== undefined && given.length > 0 ? { family, given } : { family };
      }
      if (typeof person.name === "string" && person.name.trim().length > 0) {
        return parseAuthorName(person.name);
      }
      return { literal: "" };
    })
    .filter((name) => Object.keys(name).length > 0 && formatAuthorName(name).length > 0);
  if (names.length > 0) item.author = names;
  const year = yearFromDate(propValue(props, SYSTEM_PROPERTY_UUIDS.publicationDate));
  if (year !== undefined) item.issued = { "date-parts": [[year]] };
  const doi = propText(props, SYSTEM_PROPERTY_UUIDS.doi);
  if (doi !== undefined) item.DOI = doi;
  const isbn = propText(props, SYSTEM_PROPERTY_UUIDS.isbn);
  if (isbn !== undefined) item.ISBN = isbn;
  const url = propText(props, SYSTEM_PROPERTY_UUIDS.url);
  if (url !== undefined) item.URL = url;
  const publisher = propText(props, SYSTEM_PROPERTY_UUIDS.publisher);
  if (publisher !== undefined) item.publisher = publisher;
  return item;
}

/** The import-side spec: everything the CLI needs to find-or-create a source. */
export interface CslNodeSpec {
  className: SourceClassName;
  citekey: string;
  title: string;
  authors: CslName[];
  doi?: string;
  isbn?: string;
  url?: string;
  publisher?: string;
  /** Year-only ISO date (`1962`) per the seeded date property. */
  publicationDate?: string;
}

export function cslToNodeSpecs(item: CslItem): CslNodeSpec {
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  return {
    className: cslTypeToClassName(item.type),
    citekey: item.id,
    title: item.title ?? item.id,
    authors: item.author ?? [],
    ...(item.DOI !== undefined && item.DOI.length > 0 ? { doi: item.DOI } : {}),
    ...(item.ISBN !== undefined && item.ISBN.length > 0 ? { isbn: item.ISBN } : {}),
    ...(item.URL !== undefined && item.URL.length > 0 ? { url: item.URL } : {}),
    ...(item.publisher !== undefined && item.publisher.length > 0 ? { publisher: item.publisher } : {}),
    ...(year !== undefined ? { publicationDate: String(year) } : {}),
  };
}
