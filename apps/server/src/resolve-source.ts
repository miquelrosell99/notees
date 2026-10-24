/**
 * THE METADATA RESOLVER — the source-library resolver behind
 * GET /api/resolve?doi=…|?isbn=…|?arxiv=… (slices 3–6 task 3), the server's
 * FIRST (and, so far, only) outbound network egress.
 *
 * THE HONEST PRIVACY NOTE (the egress contract): nothing else in the server
 * process fetches out — no webhooks, no telemetry, no update checks. When a
 * caller asks the resolver to look up an identifier, exactly ONE thing leaves
 * the server: the queried identifier itself, embedded in the URL path/query
 * the provider expects. There is no request body and no identifying header
 * beyond what a plain GET carries. Workspace content — titles, notes,
 * properties, anything — NEVER rides along. The three providers below are
 * the complete egress list:
 *
 *  - Crossref    https://api.crossref.org/works/{doi}          (DOI)
 *  - OpenLibrary https://openlibrary.org/isbn/{isbn}.json      (ISBN)
 *  - arXiv       http://export.arxiv.org/api/query?id_list={id} (arXiv id)
 *
 * Responses are normalized into ONE record shape (the task-4 create flow and
 * the task-6 web client consume it verbatim):
 *
 *    { classKey, title, authors[], editors[], fields{}, doi?, isbn?, url?, year? }
 *
 *  - classKey  the system class via ZOTERO_ITEM_TYPE_TO_CLASS — the provider's
 *              item type maps to a Zotero citable type first, then the
 *              manifest maps it to the class (nothing hand-maintains a second
 *              copy of that mapping);
 *  - authors/editors  "Family, Given" strings (the source base's creator
 *              family format);
 *  - fields    pool-key → value for the class's OWN bindings only
 *              (SYSTEM_SOURCE_CLASS_BINDINGS); base-bound properties
 *              (publisher, publicationDate, …) and the creator family never
 *              appear here — doi/isbn/url/year are top-level instead;
 *  - year      the publication year as a number.
 *
 * The pref gate: the workspace's `sources` feature-row settings
 * (`resolverEnabled === false`) answer 403 resolver_disabled; an absent row
 * or absent key means ALLOWED (default ON — the task-5 web settings UI owns
 * the toggle). The cache: resolved records live in a server-state
 * `resolve_cache` table on the shared relay.db (the prefs/shares/plugins
 * ruling — coordination state, never log state), keyed on the NORMALIZED
 * identifier, 24 h TTL.
 *
 * Failure taxonomy: a provider error status, network failure, or timeout
 * (AbortController, NOTEES_RESOLVER_TIMEOUT_MS) answers 502
 * resolver_unavailable; an identifier the provider has never heard of
 * answers 404 not_found. Fail loud, never half-resolved.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import {
  SYSTEM_SOURCE_CLASS_BINDINGS,
  ZOTERO_ITEM_TYPE_TO_CLASS,
  type SystemClassName,
  type ZoteroItemType,
} from "@notees/domain";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";

/** The unified resolver record (task 4 + task 6 consume it verbatim). */
export interface SourceMetadataRecord {
  classKey: SystemClassName;
  title: string;
  /** "Family, Given" strings (the source base creator format). */
  authors: string[];
  /** "Family, Given" strings; [] when the provider names no editors. */
  editors: string[];
  /** pool-key → value, the class's own bindings only (never base fields). */
  fields: Record<string, string>;
  doi?: string;
  isbn?: string;
  url?: string;
  year?: number;
}

/** Cache freshness: 24 h (server coordination state, not log state). */
export const RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CROSSREF_WORKS = "https://api.crossref.org/works";
const OPENLIBRARY_ISBN = "https://openlibrary.org/isbn";
const ARXIV_API = "http://export.arxiv.org/api/query";

const CACHE_DDL = `
CREATE TABLE IF NOT EXISTS resolve_cache (
    identifier TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
`;

/**
 * The resolved-record cache: identifier → response JSON + fetch time on the
 * shared relay.db (the plugin-registry pattern — additive CREATE-IF-NOT-EXISTS
 * migration, WAL, one writer among the server's own storages).
 */
export class ResolveCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(CACHE_DDL);
  }

  /** The fresh cached record, or null (miss, or older than the TTL). */
  get(identifier: string, now = Date.now()): SourceMetadataRecord | null {
    const row = this.db
      .prepare("SELECT response, fetched_at FROM resolve_cache WHERE identifier = ?")
      .get(identifier) as { response: string; fetched_at: number } | undefined;
    if (row === undefined) return null;
    if (now - row.fetched_at > RESOLVE_CACHE_TTL_MS) return null;
    return JSON.parse(row.response) as SourceMetadataRecord;
  }

  /** Upsert the record under its normalized identifier. */
  set(identifier: string, record: SourceMetadataRecord, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO resolve_cache (identifier, response, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(identifier) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at`,
      )
      .run(identifier, JSON.stringify(record), now);
  }

  close(): void {
    this.db.close();
  }
}

// --- identifier normalization ------------------------------------------------

type IdentifierKind = "doi" | "isbn" | "arxiv";

/**
 * The cache key's identity half: DOIs case-fold (and a pasted doi.org URL
 * unwraps to the bare DOI); ISBNs keep digits + X only; arXiv ids drop the
 * `arXiv:` prefix and the `vN` version suffix (versions are one work).
 */
export function normalizeIdentifier(kind: IdentifierKind, raw: string): string {
  const trimmed = raw.trim();
  switch (kind) {
    case "doi":
      return trimmed
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
        .toLowerCase();
    case "isbn":
      return trimmed.replace(/[^0-9Xx]/g, "").toUpperCase();
    case "arxiv":
      return trimmed.replace(/^arxiv:/i, "").replace(/v\d+$/, "").toLowerCase();
  }
}

// --- the provider fetch ------------------------------------------------------

/**
 * One outbound GET with the AbortController timeout. Throws 502
 * resolver_unavailable on timeout/network failure; the CALLER maps the
 * response status (404 → not resolved, other errors → 502).
 */
async function fetchProvider(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError(502, "resolver_unavailable", `metadata provider timed out (${url})`);
    }
    throw new AppError(
      502,
      "resolver_unavailable",
      `metadata provider unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function providerError(provider: string, status: number): AppError {
  return new AppError(502, "resolver_unavailable", `${provider} answered ${status}`);
}

// --- loose-JSON helpers --------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const text = str(entry);
    if (text !== undefined) return text;
  }
  return undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "Family, Given" from separate family/given parts (Crossref). */
function familyGiven(family: string | undefined, given: string | undefined): string | undefined {
  if (family !== undefined && given !== undefined) return `${family}, ${given}`;
  return family ?? given;
}

/** "Family, Given" best-effort from one full name (OpenLibrary/arXiv). */
function invertFullName(name: string): string {
  const cleaned = collapseWhitespace(name);
  const at = cleaned.lastIndexOf(" ");
  if (at <= 0) return cleaned;
  return `${cleaned.slice(at + 1)}, ${cleaned.slice(0, at)}`;
}

function yearFromDateParts(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parts = (value as { "date-parts"?: unknown })["date-parts"];
  const first = Array.isArray(parts) ? parts[0] : undefined;
  const year = Array.isArray(first) ? first[0] : undefined;
  return typeof year === "number" && Number.isFinite(year) ? year : undefined;
}

function yearFromDateString(value: unknown): number | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const match = /(\d{4})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** Build the unified record: only the class's OWN bindings survive into fields. */
function buildRecord(input: {
  classKey: SystemClassName;
  title: string;
  authors: string[];
  editors: string[];
  candidates: Record<string, string | undefined>;
  doi?: string | undefined;
  isbn?: string | undefined;
  url?: string | undefined;
  year?: number | undefined;
}): SourceMetadataRecord {
  const fields: Record<string, string> = {};
  for (const key of SYSTEM_SOURCE_CLASS_BINDINGS[input.classKey] ?? []) {
    const value = input.candidates[key];
    if (value !== undefined && value.length > 0) fields[key] = value;
  }
  const record: SourceMetadataRecord = {
    classKey: input.classKey,
    title: input.title,
    authors: input.authors,
    editors: input.editors,
    fields,
  };
  if (input.doi !== undefined) record.doi = input.doi;
  if (input.isbn !== undefined) record.isbn = input.isbn;
  if (input.url !== undefined) record.url = input.url;
  if (input.year !== undefined) record.year = input.year;
  return record;
}

// --- Crossref (DOI) -----------------------------------------------------------

/**
 * Crossref type → Zotero citable type; the class then comes from
 * ZOTERO_ITEM_TYPE_TO_CLASS (the one manifest — this table is a pure
 * type-name bridge). posted-content resolves by subtype: only a real
 * preprint lands on the preprint class, anything else falls back to
 * document. reference-book/entry map encyclopedia/dictionary respectively.
 */
const CROSSREF_TYPE_TO_ZOTERO: Record<string, ZoteroItemType> = {
  "journal-article": "journalArticle",
  "book-chapter": "bookSection",
  book: "book",
  "proceedings-article": "conferencePaper",
  report: "report",
  standard: "standard",
  dataset: "dataset",
  dissertation: "thesis",
  "magazine-article": "magazineArticle",
  "newspaper-article": "newspaperArticle",
  "reference-book": "encyclopediaArticle",
  "reference-entry": "dictionaryEntry",
};

interface CrossrefContributor {
  family?: unknown;
  given?: unknown;
}

function crossrefContributors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value as CrossrefContributor[]) {
    const name = familyGiven(str(entry.family), str(entry.given));
    if (name !== undefined) names.push(name);
  }
  return names;
}

async function resolveDoi(
  doi: string,
  timeoutMs: number,
): Promise<SourceMetadataRecord | null> {
  const res = await fetchProvider(
    `${CROSSREF_WORKS}/${encodeURIComponent(normalizeIdentifier("doi", doi))}`,
    timeoutMs,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw providerError("Crossref", res.status);
  let body: { message?: Record<string, unknown> };
  try {
    body = (await res.json()) as { message?: Record<string, unknown> };
  } catch {
    throw new AppError(502, "resolver_unavailable", "Crossref returned an unparsable payload");
  }
  const work = body.message ?? {};
  const typeName = str(work.type);
  const zoteroType: ZoteroItemType =
    typeName === "posted-content" && str(work.subtype) === "preprint"
      ? "preprint"
      : (typeName !== undefined ? CROSSREF_TYPE_TO_ZOTERO[typeName] : undefined) ?? "document";
  const title = firstString(work.title);
  if (title === undefined) {
    throw new AppError(502, "resolver_unavailable", "Crossref work carried no title");
  }
  return buildRecord({
    classKey: ZOTERO_ITEM_TYPE_TO_CLASS[zoteroType],
    title: collapseWhitespace(title),
    authors: crossrefContributors(work.author),
    editors: crossrefContributors(work.editor),
    candidates: {
      publicationTitle: firstString(work["container-title"]),
      volume: str(work.volume),
      issue: str(work.issue),
      pages: str(work.page),
      issn: firstString(work.ISSN),
      place: str(work["publisher-location"]),
      publisher: str(work.publisher),
    },
    doi: str(work.DOI) ?? normalizeIdentifier("doi", doi),
    url: str(work.URL),
    year: yearFromDateParts(work.issued),
  });
}

// --- OpenLibrary (ISBN) --------------------------------------------------------

interface OpenLibraryWork extends Record<string, unknown> {
  title?: unknown;
  publish_date?: unknown;
  publishers?: unknown;
  publish_places?: unknown;
  number_of_pages?: unknown;
  isbn_13?: unknown;
  isbn_10?: unknown;
  authors?: unknown;
}

/** OpenLibrary place/publisher entries are strings or {name: …} objects. */
function openLibraryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return str((value as { name?: unknown }).name);
  }
  return undefined;
}

function firstOpenLibraryName(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const name = openLibraryName(entry);
    if (name !== undefined) return name;
  }
  return undefined;
}

async function resolveIsbn(
  isbn: string,
  timeoutMs: number,
): Promise<SourceMetadataRecord | null> {
  const normalized = normalizeIdentifier("isbn", isbn);
  const res = await fetchProvider(
    `${OPENLIBRARY_ISBN}/${encodeURIComponent(normalized)}.json`,
    timeoutMs,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw providerError("OpenLibrary", res.status);
  let work: OpenLibraryWork;
  try {
    work = (await res.json()) as OpenLibraryWork;
  } catch {
    throw new AppError(502, "resolver_unavailable", "OpenLibrary returned an unparsable payload");
  }
  const title = str(work.title);
  if (title === undefined) {
    throw new AppError(502, "resolver_unavailable", "OpenLibrary edition carried no title");
  }
  // Authors: the edition lists author KEYS, not names. Best-effort within the
  // egress budget — ONE extra fetch, for the first author only; a multi-author
  // edition resolves its first author and no more (documented, deliberate).
  const authors: string[] = [];
  if (Array.isArray(work.authors) && work.authors.length > 0) {
    const first = work.authors[0] as { key?: unknown };
    const key = str(first?.key);
    if (key !== undefined) {
      const authorRes = await fetchProvider(`https://openlibrary.org${key}.json`, timeoutMs);
      if (authorRes.ok) {
        try {
          const author = (await authorRes.json()) as { name?: unknown };
          const name = str(author.name);
          if (name !== undefined) authors.push(invertFullName(name));
        } catch {
          // A malformed author payload degrades to no authors, not a 502 —
          // the edition metadata itself already resolved.
        }
      }
    }
  }
  return buildRecord({
    classKey: "book",
    title: collapseWhitespace(title),
    authors,
    editors: [],
    candidates: {
      place: firstOpenLibraryName(work.publish_places),
      numPages: typeof work.number_of_pages === "number" ? String(work.number_of_pages) : undefined,
      publisher: firstOpenLibraryName(work.publishers),
    },
    isbn: firstString(work.isbn_13) ?? firstString(work.isbn_10) ?? normalized,
    url: `${OPENLIBRARY_ISBN}/${normalized}`,
    year: yearFromDateString(work.publish_date),
  });
}

// --- arXiv (Atom XML, DOM-less) -------------------------------------------------

/** Minimal tag reader over one Atom <entry> block (the whole parse — no DOM). */
function arxivTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return match === null ? null : decodeXmlEntities(match[1]!);
}

function arxivTags(block: string, tag: string): string[] {
  const matches = block.match(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "g"));
  return matches === null ? [] : matches;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function resolveArxiv(
  id: string,
  timeoutMs: number,
): Promise<SourceMetadataRecord | null> {
  const normalized = normalizeIdentifier("arxiv", id);
  const res = await fetchProvider(
    `${ARXIV_API}?id_list=${encodeURIComponent(normalized)}`,
    timeoutMs,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw providerError("arXiv", res.status);
  const xml = await res.text();
  const entryMatch = /<entry[^>]*>([\s\S]*?)<\/entry>/.exec(xml);
  if (entryMatch === null) return null;
  const entry = entryMatch[1]!;
  const title = arxivTag(entry, "title");
  if (title === null) {
    throw new AppError(502, "resolver_unavailable", "arXiv entry carried no title");
  }
  const authors = arxivTags(entry, "author")
    .map((block) => arxivTag(block, "name"))
    .filter((name): name is string => name !== null)
    .map(invertFullName);
  const published = arxivTag(entry, "published");
  const year = published === null ? undefined : yearFromDateString(published);
  return buildRecord({
    classKey: "preprint",
    title: collapseWhitespace(title),
    authors,
    editors: [],
    candidates: {
      abstract: (() => {
        const summary = arxivTag(entry, "summary");
        return summary === null ? undefined : collapseWhitespace(summary);
      })(),
      repository: "arXiv",
    },
    doi: arxivTag(entry, "arxiv:doi") ?? undefined,
    url: arxivTag(entry, "id") ?? undefined,
    year,
  });
}

// --- the route entry ------------------------------------------------------------

/**
 * Resolve one metadata identifier to the unified record. Exactly one of
 * doi/isbn/arxiv (400 otherwise — the route only delegates here when at least
 * one is present, so this is the two-or-more guard). The pref gate runs
 * before the cache: a hard-off resolver answers 403 even for cached records.
 * Provider misses answer 404; provider failures/timeouts answer 502.
 */
export async function resolveSourceMetadata(
  ctx: ServerContext,
  workspaceId: string,
  params: { doi?: string | undefined; isbn?: string | undefined; arxiv?: string | undefined },
): Promise<SourceMetadataRecord> {
  const present = (
    [
      ["doi", params.doi],
      ["isbn", params.isbn],
      ["arxiv", params.arxiv],
    ] as Array<[IdentifierKind, string | undefined]>
  ).filter((entry): entry is [IdentifierKind, string] => entry[1] !== undefined);
  if (present.length !== 1) {
    throw new AppError(
      400,
      "validation_failed",
      "exactly one of ?doi=, ?isbn=, or ?arxiv= is required",
    );
  }
  const [kind, raw] = present[0]!;

  // THE PREF GATE: the workspace's `sources` feature-row settings; absent row
  // or absent key means ALLOWED (default ON — the web settings UI owns the
  // toggle in task 5).
  const settings = ctx.workspaces.storeFor(workspaceId).getFeatureRow(workspaceId, "sources")
    ?.settings;
  if (settings?.resolverEnabled === false) {
    throw new AppError(403, "resolver_disabled", "the metadata resolver is disabled (sources settings)");
  }

  const key = `${kind}:${normalizeIdentifier(kind, raw)}`;
  const cached = ctx.resolverCache.get(key);
  if (cached !== null) return cached;

  const timeoutMs = ctx.config.resolverTimeoutMs;
  const record =
    kind === "doi"
      ? await resolveDoi(raw, timeoutMs)
      : kind === "isbn"
        ? await resolveIsbn(raw, timeoutMs)
        : await resolveArxiv(raw, timeoutMs);
  if (record === null) {
    throw new AppError(404, "not_found", `no metadata found for ${kind} "${raw}"`);
  }
  ctx.resolverCache.set(key, record);
  return record;
}
