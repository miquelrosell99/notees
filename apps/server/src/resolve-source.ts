/**
 * THE METADATA RESOLVER — the source-library resolver behind
 * GET /api/resolve?doi=…|?isbn=…|?arxiv=…|?pmid=…|?ads=… (slices 3–6 task 3,
 * the PMID + ADS providers added 2026-11-02) and
 * POST /api/resolve/pdf (task 4 — the owner's PDF flow), the server's
 * FIRST (and, so far, only) outbound network egress.
 *
 * THE HONEST PRIVACY NOTE (the egress contract): nothing else in the server
 * process fetches out — no webhooks, no telemetry, no update checks. When a
 * caller asks the resolver to look up an identifier, exactly ONE thing leaves
 * the server: the queried identifier itself, embedded in the URL path/query
 * the metadata provider expects. There is no request body and no identifying
 * header beyond what a plain GET carries — ONE deliberate exception: the ADS
 * provider requires per-user authentication, so the calling user's own ADS
 * API token (their per-user pref, relay.db coordination state) rides the
 * Authorization header to api.adsabs.harvard.edu and nowhere else. Workspace
 * content — titles, notes, properties, anything — NEVER rides along. The
 * metadata providers below are the complete METADATA egress list. The one
 * additional egress is the task-4
 * PDF flow: when a caller passes `?url=`, the server fetches that ONE PDF
 * itself — http(s) only, loopback/private/link-local literals refused (SSRF
 * guard), 25MB cap, same timeout (see resolvePdfSource below); the metadata
 * providers then see only the extracted DOI, never the URL or the bytes.
 *
 *  - Crossref    https://api.crossref.org/works/{doi}          (DOI)
 *  - OpenLibrary https://openlibrary.org/isbn/{isbn}.json      (ISBN)
 *  - arXiv       http://export.arxiv.org/api/query?id_list={id} (arXiv id)
 *  - PubMed      https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi
 *                ?db=pubmed&id={pmid}&retmode=json             (PMID)
 *  - ADS         https://api.adsabs.harvard.edu/v1/search/query?q=bibcode:…
 *                (ADS bibcode — the caller's own API token rides the
 *                Authorization header; see the egress note above)
 *  - Unpaywall   https://api.unpaywall.org/v2/{doi}?email=…    (open-access
 *                PDF enrichment — only ever sees the resolved DOI and the
 *                generic notees-resolver contact constant, never workspace
 *                content; a failure degrades to "no prefilled PDF", never a
 *                failed resolve)
 *
 * Responses are normalized into ONE record shape (the task-4 create flow and
 * the task-6 web client consume it verbatim):
 *
 *    { classKey, title, authors[], editors[], fields{}, doi?, isbn?, pmid?,
 *      url?, year?, publisher? }
 *
 *  - classKey  the system class via ZOTERO_ITEM_TYPE_TO_CLASS — the provider's
 *              item type maps to a Zotero citable type first, then the
 *              manifest maps it to the class (nothing hand-maintains a second
 *              copy of that mapping);
 *  - authors/editors  "Family, Given" strings (the source base's creator
 *              family format);
 *  - fields    pool-key → value for the class's OWN bindings only
 *              (SYSTEM_SOURCE_CLASS_BINDINGS); base-bound properties
 *              (publicationDate, …) and the creator family never
 *              appear here — doi/isbn/url/year/publisher are top-level instead;
 *  - year      the publication year as a number;
 *  - publisher the publishing house (Crossref `publisher`, OpenLibrary
 *              `publishers[0]`) — a top-level record field, never a `fields`
 *              entry (the publisher binding rides the source base).
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
  sourceBindingPropertyOf,
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
  /** The PubMed identifier (the PMID provider's own record). */
  pmid?: string;
  /** The PubMed Central identifier (the PMID provider's own record; NCBI
   *  includes the "PMC" prefix, e.g. "PMC4321079" — passed through verbatim). */
  pmcid?: string;
  url?: string;
  year?: number;
  /** The publishing house (Crossref `publisher` / OpenLibrary `publishers[0]`). */
  publisher?: string;
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

type IdentifierKind = "doi" | "isbn" | "arxiv" | "pmid" | "ads";

/**
 * The cache key's identity half: DOIs case-fold (and a pasted doi.org URL
 * unwraps to the bare DOI); ISBNs keep digits + X only; arXiv ids drop the
 * `arXiv:` prefix and the `vN` version suffix (versions are one work);
 * PMIDs keep digits only; ADS bibcodes case-fold (the canonical form is
 * uppercase).
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
    case "pmid":
      return trimmed.replace(/\D/g, "");
    case "ads":
      return trimmed.toUpperCase();
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

/**
 * "Family, Given" from a PubMed esummary author name — NCBI's convention is
 * FAMILY FIRST plus trailing initials ("Derks J", "van der Meer JJW"), the
 * opposite shape of invertFullName's "Given Family" input. The family is
 * everything before the LAST space when the final token reads as initials
 * (1–5 letters, dots/hyphens tolerated); anything else falls back to the
 * name unchanged.
 */
function pubmedAuthorName(name: string): string {
  const cleaned = collapseWhitespace(name);
  const match = /^(.*?)\s+([A-Za-z][A-Za-z.-]{0,5})$/.exec(cleaned);
  if (match === null || match[1] === "") return cleaned;
  return `${match[1]}, ${match[2]}`;
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
  pmid?: string | undefined;
  pmcid?: string | undefined;
  url?: string | undefined;
  year?: number | undefined;
  publisher?: string | undefined;
}): SourceMetadataRecord {
  const fields: Record<string, string> = {};
  for (const ref of SYSTEM_SOURCE_CLASS_BINDINGS[input.classKey] ?? []) {
    const key = sourceBindingPropertyOf(ref);
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
  if (input.pmid !== undefined) record.pmid = input.pmid;
  if (input.pmcid !== undefined) record.pmcid = input.pmcid;
  if (input.url !== undefined) record.url = input.url;
  if (input.year !== undefined) record.year = input.year;
  if (input.publisher !== undefined) record.publisher = input.publisher;
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
    },
    doi: str(work.DOI) ?? normalizeIdentifier("doi", doi),
    url: str(work.URL),
    year: yearFromDateParts(work.issued),
    publisher: str(work.publisher),
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
    },
    isbn: firstString(work.isbn_13) ?? firstString(work.isbn_10) ?? normalized,
    url: `${OPENLIBRARY_ISBN}/${normalized}`,
    year: yearFromDateString(work.publish_date),
    publisher: firstOpenLibraryName(work.publishers),
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

// --- PubMed (PMID, esummary JSON) ------------------------------------------------

const NCBI_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

interface PubmedSummaryEntry {
  uid?: unknown;
  title?: unknown;
  authors?: unknown;
  source?: unknown;
  fulljournalname?: unknown;
  pubdate?: unknown;
  volume?: unknown;
  issue?: unknown;
  pages?: unknown;
  articleids?: unknown;
}

/**
 * PubMed by PMID: ONE esummary GET, JSON (no XML parse). Authors arrive in
 * NCBI's FAMILY-FIRST convention ("Derks J") and map to the creator family
 * format ("Derks, J" — pubmedAuthorName); the journal rides fulljournalname
 * (falling back to the MEDLINE abbreviation);
 * volume/issue/pages arrive as plain strings — supplements like
 * "42 Suppl 16:S158-S171" are an ordinary volume+issue+pages triple; the DOI
 * is picked out of articleids. NCBI's unauthenticated rate budget (3 req/s)
 * is a non-issue for a single-user resolver and the 24 h cache absorbs
 * repeats — no API-key config. An unknown PMID answers a 200 with no entry
 * for the id (or an error field) → null (404 not_found downstream).
 */
async function resolvePmid(
  pmid: string,
  timeoutMs: number,
): Promise<SourceMetadataRecord | null> {
  const normalized = normalizeIdentifier("pmid", pmid);
  const res = await fetchProvider(
    `${NCBI_ESUMMARY}?db=pubmed&id=${encodeURIComponent(normalized)}&retmode=json`,
    timeoutMs,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw providerError("PubMed", res.status);
  let body: { result?: Record<string, unknown> };
  try {
    body = (await res.json()) as { result?: Record<string, unknown> };
  } catch {
    throw new AppError(502, "resolver_unavailable", "PubMed returned an unparsable payload");
  }
  const entry = body.result?.[normalized] as PubmedSummaryEntry | undefined;
  if (entry === undefined || typeof entry !== "object") return null;
  const title = str(entry.title);
  if (title === undefined) {
    throw new AppError(502, "resolver_unavailable", "PubMed summary carried no title");
  }
  const authors = Array.isArray(entry.authors)
    ? (entry.authors as Array<{ name?: unknown }>)
        .map((author) => str(author.name))
        .filter((name): name is string => name !== undefined)
        .map(pubmedAuthorName)
    : [];
  const ids = Array.isArray(entry.articleids)
    ? (entry.articleids as Array<{ idtype?: unknown; value?: unknown }>)
    : [];
  const articleId = (idtype: string): string | undefined => {
    for (const id of ids) {
      if (id.idtype === idtype) {
        const value = str(id.value);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  };
  const doi = articleId("doi");
  // NCBI includes the "PMC" prefix (e.g. "PMC4321079") — passed through verbatim.
  const pmcid = articleId("pmc");
  return buildRecord({
    classKey: ZOTERO_ITEM_TYPE_TO_CLASS.journalArticle,
    title: collapseWhitespace(title),
    authors,
    editors: [],
    candidates: {
      publicationTitle: str(entry.fulljournalname) ?? str(entry.source),
      volume: str(entry.volume),
      issue: str(entry.issue),
      pages: str(entry.pages),
    },
    doi,
    pmid: normalized,
    pmcid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${normalized}/`,
    year: yearFromDateString(entry.pubdate),
  });
}

// --- ADS (bibcode, authenticated Solr search) -------------------------------------

const ADS_SEARCH = "https://api.adsabs.harvard.edu/v1/search/query";

interface AdsDocument {
  title?: unknown;
  author?: unknown;
  pub?: unknown;
  pub_raw?: unknown;
  year?: unknown;
  volume?: unknown;
  page?: unknown;
  doi?: unknown;
  abstract?: unknown;
}

/**
 * ADS by bibcode: ONE Solr search GET (q=bibcode:"…", rows 1), the caller's
 * own API token on the Authorization header — the one egress exception, see
 * the header contract. Authors already arrive "Family, G." (the creator
 * family format — no inversion). A 403 means the token was rejected (check
 * it in Settings → Account); a 200 with no docs means the bibcode is unknown
 * → null (404 downstream). The record's URL is the ADS abstract page.
 */
async function resolveAds(
  bibcode: string,
  apiToken: string,
  timeoutMs: number,
): Promise<SourceMetadataRecord | null> {
  const normalized = normalizeIdentifier("ads", bibcode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(
      `${ADS_SEARCH}?q=${encodeURIComponent(`bibcode:"${normalized}"`)}` +
        `&fl=title,author,pub,pub_raw,year,volume,page,doi,abstract&rows=1`,
      { signal: controller.signal, headers: { Authorization: `Bearer ${apiToken}` } },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError(502, "resolver_unavailable", `metadata provider timed out (${ADS_SEARCH})`);
    }
    throw new AppError(
      502,
      "resolver_unavailable",
      `metadata provider unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (res.status === 403) {
    throw new AppError(
      502,
      "resolver_unavailable",
      "ADS rejected the API token (403) — check the token in Settings → Account",
    );
  }
  if (!res.ok) throw providerError("ADS", res.status);
  let body: { response?: { docs?: unknown } };
  try {
    body = (await res.json()) as { response?: { docs?: unknown } };
  } catch {
    throw new AppError(502, "resolver_unavailable", "ADS returned an unparsable payload");
  }
  const doc = Array.isArray(body.response?.docs) ? (body.response.docs[0] as AdsDocument | undefined) : undefined;
  if (doc === undefined || typeof doc !== "object") return null;
  const title = firstString(doc.title);
  if (title === undefined) {
    throw new AppError(502, "resolver_unavailable", "ADS document carried no title");
  }
  const authors = Array.isArray(doc.author)
    ? (doc.author as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const yearValue = typeof doc.year === "string" || typeof doc.year === "number" ? Number(doc.year) : NaN;
  return buildRecord({
    classKey: ZOTERO_ITEM_TYPE_TO_CLASS.journalArticle,
    title: collapseWhitespace(title),
    authors,
    editors: [],
    candidates: {
      publicationTitle: str(doc.pub_raw) ?? str(doc.pub),
      volume: str(doc.volume),
      pages: firstString(doc.page),
      abstract: str(doc.abstract),
    },
    doi: firstString(doc.doi),
    url: `https://ui.adsabs.harvard.edu/abs/${normalized}`,
    year: Number.isFinite(yearValue) ? yearValue : undefined,
  });
}

// --- Unpaywall (open-access PDF enrichment) ----------------------------------------

const UNPAYWALL_API = "https://api.unpaywall.org/v2";
/** The generic contact constant Unpaywall's API requires — no personal data. */
const UNPAYWALL_EMAIL = "notees-resolver@notees.local";

/**
 * Best-effort open-access PDF link for a resolved record: ONE Unpaywall GET
 * keyed on the record's DOI; `best_oa_location.url_for_pdf` (falling back to
 * the landing page) becomes the attach intent the create form shows in its
 * PDF field. NEVER fails the resolve — a non-2xx, unparsable body, or absent
 * OA location simply leaves the record without a pdf.url. Only called when a
 * DOI exists (PubMed supplies it from articleids; ADS from its own index).
 */
async function enrichOpenAccessPdf(
  record: PdfResolveResult,
  timeoutMs: number,
): Promise<void> {
  if (record.doi === undefined) return;
  let res: Response;
  try {
    res = await fetchProvider(
      `${UNPAYWALL_API}/${encodeURIComponent(record.doi)}?email=${UNPAYWALL_EMAIL}`,
      timeoutMs,
    );
  } catch {
    return;
  }
  if (!res.ok) return;
  try {
    const body = (await res.json()) as {
      best_oa_location?: { url_for_pdf?: unknown; url?: unknown } | null;
    };
    const location = body.best_oa_location;
    if (location === null || location === undefined) return;
    const pdfUrl = str(location.url_for_pdf) ?? str(location.url);
    if (pdfUrl !== undefined) record.pdf = { url: pdfUrl };
  } catch {
    // An unparsable Unpaywall body degrades to no prefilled PDF.
  }
}

// --- the route entry ------------------------------------------------------------

/**
 * THE PREF GATE: the workspace's `sources` feature-row settings; absent row
 * or absent key means ALLOWED (default ON — the web settings UI owns the
 * toggle in task 5). Exported because the PDF flow must run the gate BEFORE
 * its own outbound fetch (?url= mode) — a hard-off resolver never touches
 * the network.
 */
export function assertResolverEnabled(ctx: ServerContext, workspaceId: string): void {
  const settings = ctx.workspaces.storeFor(workspaceId).getFeatureRow(workspaceId, "sources")
    ?.settings;
  if (settings?.resolverEnabled === false) {
    throw new AppError(403, "resolver_disabled", "the metadata resolver is disabled (sources settings)");
  }
}

/**
 * Resolve one metadata identifier to the unified record. Exactly one of
 * doi/isbn/arxiv/pmid/ads (400 otherwise — the route only delegates here when
 * at least one is present, so this is the two-or-more guard). The pref gate
 * runs before the cache: a hard-off resolver answers 403 even for cached
 * records. The ADS provider needs the calling user's own API token (their
 * per-user pref, read by the route) — an ads lookup without one is a 422,
 * never a silent skip. After a successful resolve with a DOI, the Unpaywall
 * enrichment adds the open-access PDF link when one exists (never fails the
 * resolve). Provider misses answer 404; provider failures/timeouts answer 502.
 */
export async function resolveSourceMetadata(
  ctx: ServerContext,
  workspaceId: string,
  params: {
    doi?: string | undefined;
    isbn?: string | undefined;
    arxiv?: string | undefined;
    pmid?: string | undefined;
    ads?: string | undefined;
  },
  options: { adsApiToken?: string | undefined } = {},
): Promise<SourceMetadataRecord> {
  const present = (
    [
      ["doi", params.doi],
      ["isbn", params.isbn],
      ["arxiv", params.arxiv],
      ["pmid", params.pmid],
      ["ads", params.ads],
    ] as Array<[IdentifierKind, string | undefined]>
  ).filter((entry): entry is [IdentifierKind, string] => entry[1] !== undefined);
  if (present.length !== 1) {
    throw new AppError(
      400,
      "validation_failed",
      "exactly one of ?doi=, ?isbn=, ?arxiv=, ?pmid=, or ?ads= is required",
    );
  }
  const [kind, raw] = present[0]!;

  assertResolverEnabled(ctx, workspaceId);

  const key = `${kind}:${normalizeIdentifier(kind, raw)}`;
  const cached = ctx.resolverCache.get(key);
  if (cached !== null) return cached;

  if (kind === "ads" && (options.adsApiToken ?? "") === "") {
    throw new AppError(
      422,
      "validation_failed",
      "an ADS API token is required for bibcode lookups — add yours in Settings → Account",
    );
  }

  const timeoutMs = ctx.config.resolverTimeoutMs;
  const record =
    kind === "doi"
      ? await resolveDoi(raw, timeoutMs)
      : kind === "isbn"
        ? await resolveIsbn(raw, timeoutMs)
        : kind === "arxiv"
          ? await resolveArxiv(raw, timeoutMs)
          : kind === "pmid"
            ? await resolvePmid(raw, timeoutMs)
            : await resolveAds(raw, options.adsApiToken!, timeoutMs);
  if (record === null) {
    throw new AppError(404, "not_found", `no metadata found for ${kind} "${raw}"`);
  }
  await enrichOpenAccessPdf(record, timeoutMs);
  ctx.resolverCache.set(key, record);
  return record;
}


// --- the PDF flow (POST /api/resolve/pdf, task 4) --------------------------------

/**
 * The owner's PDF flow: hand the server a PDF (multipart upload or `?url=`)
 * and get the source-metadata record for the DOI printed in it. The scan is
 * deliberately primitive — NO new dependency, NO PDF parser: the raw bytes
 * latin1-decoded, run over with the DOI pattern. A DOI lives in the first
 * pages' uncompressed text layer for the vast majority of papers (fonts
 * uncompressed enough for the ASCII to survive verbatim), and deflate-encoded
 * object streams simply yield no hit — an honest 422, never a half-guess.
 */

/** The PDF intake cap for BOTH paths (multipart and ?url=): 25MB. */
export const RESOLVE_PDF_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The Crossref DOI pattern (their own documented shape): `10.` + 4–9 digits +
 * `/` + one or more of the allowed suffix characters. `g` + `i` flags, reset
 * per scan (`lastIndex` is shared module state otherwise).
 */
const PDF_DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;

/** The trailing punctuation the raw match may swallow (PDF text-layer noise). */
const DOI_TRAILING_PUNCTUATION = /[.,;)\]}]+$/u;

/**
 * The first stable hit: first regex match whose normalized form is non-empty.
 * The latin1 text is percent-DECODED before scanning (best-effort, `%XX` →
 * byte) so href-style DOIs (`10.1000%2Fxyz123`) surface as ordinary DOIs.
 * Per-match normalization: trim trailing `. , ; ) ] }`, decode (again —
 * idempotent for plain text), then trim again. A trailing `/pdf`-style suffix
 * is KEPT — it is part of the matched token and Crossref's normalization
 * sorts the lookup out. Multiple DOIs in one document: first hit wins
 * (documented; the owner's flow points at one paper per PDF).
 */
export function extractDoiFromPdfBytes(bytes: Buffer): string | null {
  const text = bytes
    .toString("latin1")
    .replace(/%[0-9A-Fa-f]{2}/g, (hex) => String.fromCharCode(Number.parseInt(hex.slice(1), 16)));
  PDF_DOI_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PDF_DOI_PATTERN.exec(text)) !== null) {
    const candidate = match[0]
      .replace(DOI_TRAILING_PUNCTUATION, "")
      .replace(/%[0-9A-Fa-f]{2}/g, (hex) =>
        String.fromCharCode(Number.parseInt(hex.slice(1), 16)),
      )
      .replace(DOI_TRAILING_PUNCTUATION, "");
    if (candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * The v4 special-use ranges the guard refuses: loopback (127/8), private
 * (10/8, 172.16/12, 192.168/16, 100.64/10), link-local (169.254/16),
 * unspecified (0.0.0.0), multicast/reserved (≥224). Shared by literal IPv4
 * hosts and the tails of IPv4-mapped IPv6 literals (`::ffff:…`).
 */
function isRefusedIpv4(first: number, second: number): boolean {
  return (
    first === 127 ||
    first === 10 ||
    first === 0 ||
    first >= 224 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127)
  );
}

/**
 * The SSRF guard for `?url=` — the server fetches a caller-named URL, so the
 * bar is higher than for the fixed provider hosts above: http(s) ONLY, and
 * host literals that are loopback / private / link-local / unspecified are
 * refused outright. IPv4: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
 * 0.0.0.0, 100.64/10, ≥224 (isRefusedIpv4). IPv6: ::, ::1, fc00::/7, and the
 * WHOLE link-local fe80::/10 (first hextet & 0xffc0 == 0xfe80 — a plain
 * `fe80:` prefix check misses fe90::…febf::). IPv4-mapped literals
 * (`::ffff:a.b.c.d`, `::ffff:hex:hex`) are unwrapped and the mapped v4 tail
 * runs isRefusedIpv4 — undici treats `::ffff:127.0.0.1` as loopback, so
 * without this clause the guard was bypassable with a literal address.
 * `localhost` is refused by name. DNS names are NOT re-resolved per redirect
 * hop — the deployment contract is a single-user self-hosted server; the
 * guard blocks the literal-address attacks, redirect-following to a private
 * address stays the operator's network-trust call. Anything refused → 422
 * validation_failed, never a fetch.
 */
export function assertFetchablePdfUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError(422, "validation_failed", `url is not a valid URL ("${rawUrl}")`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(
      422,
      "validation_failed",
      `url must be http(s) (got "${parsed.protocol}")`,
    );
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  let refused: boolean;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const mappedDotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (ipv4 !== null) {
    refused = isRefusedIpv4(Number(ipv4[1]), Number(ipv4[2]));
  } else if (mappedDotted !== null) {
    refused = isRefusedIpv4(Number(mappedDotted[1]), Number(mappedDotted[2]));
  } else if (mappedHex !== null) {
    const tail =
      (Number.parseInt(mappedHex[1]!, 16) << 16) | Number.parseInt(mappedHex[2]!, 16);
    refused = isRefusedIpv4((tail >>> 24) & 0xff, (tail >>> 16) & 0xff);
  } else if (host.includes(":")) {
    // Any other IPv6 literal: link-local is the full fe80::/10, not just the
    // fe80:: spelling (fe90::…febf:: are the same range).
    const firstHextet = Number.parseInt(host.split(":", 1)[0] ?? "", 16);
    refused =
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      (!Number.isNaN(firstHextet) && (firstHextet & 0xffc0) === 0xfe80);
  } else {
    refused = host === "localhost" || host === "0.0.0.0";
  }
  if (refused) {
    throw new AppError(
      422,
      "validation_failed",
      `url host "${host}" is loopback/private/link-local (SSRF guard)`,
    );
  }
  return parsed;
}

/**
 * Fetch the PDF bytes for `?url=` mode: SSRF guard first, then the one
 * outbound GET (same AbortController timeout budget as the providers). The
 * cap is enforced twice — on the declared content-length before reading and
 * on the actual bytes after (chunked responses may declare nothing). A host
 * failure or non-2xx answers 502 resolver_unavailable (the resolver's
 * upstream fetch failed); a size breach answers 422 validation_failed.
 */
async function fetchPdfBytes(rawUrl: string, timeoutMs: number): Promise<Buffer> {
  const target = assertFetchablePdfUrl(rawUrl);
  let res: Response;
  try {
    res = await fetchProvider(target.toString(), timeoutMs);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError(502, "resolver_unavailable", `pdf could not be fetched (${error.message})`);
    }
    throw error;
  }
  if (!res.ok) {
    throw new AppError(502, "resolver_unavailable", `pdf host answered ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESOLVE_PDF_MAX_BYTES) {
    throw new AppError(
      422,
      "validation_failed",
      `pdf exceeds the ${RESOLVE_PDF_MAX_BYTES}-byte cap (declared ${declared})`,
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > RESOLVE_PDF_MAX_BYTES) {
    throw new AppError(
      422,
      "validation_failed",
      `pdf exceeds the ${RESOLVE_PDF_MAX_BYTES}-byte cap (received ${bytes.length})`,
    );
  }
  return bytes;
}

/** The pdf-mode answer: the unified record, flattened, plus the asset-attach intent. */
export type PdfResolveResult = SourceMetadataRecord & { pdf?: { url?: string } };

/**
 * The PDF flow's core: intake bytes (multipart) or fetch them (`?url=`),
 * extract the DOI, resolve it through the ordinary DOI path (pref gate —
 * which also runs BEFORE the outbound PDF fetch — cache, Crossref, the whole
 * contract). No DOI in the bytes → 422 no_identifier_found (a pinned taxonomy
 * code beside resolver_disabled/resolver_unavailable).
 */
export async function resolvePdfSource(
  ctx: ServerContext,
  workspaceId: string,
  input: { bytes?: Buffer | undefined; url?: string | undefined },
): Promise<PdfResolveResult> {
  // The gate runs before ANY egress: a hard-off resolver never fetches the PDF.
  assertResolverEnabled(ctx, workspaceId);

  let bytes: Buffer;
  let sourceUrl: string | undefined;
  if (input.bytes !== undefined) {
    bytes = input.bytes;
  } else if (input.url !== undefined) {
    sourceUrl = input.url;
    bytes = await fetchPdfBytes(input.url, ctx.config.resolverTimeoutMs);
  } else {
    throw new AppError(422, "validation_failed", "a multipart file part or ?url= is required");
  }
  if (bytes.length > RESOLVE_PDF_MAX_BYTES) {
    throw new AppError(
      422,
      "validation_failed",
      `pdf exceeds the ${RESOLVE_PDF_MAX_BYTES}-byte cap (received ${bytes.length})`,
    );
  }

  const doi = extractDoiFromPdfBytes(bytes);
  if (doi === null) {
    throw new AppError(422, "no_identifier_found", "the PDF carried no extractable DOI");
  }
  const record = await resolveSourceMetadata(ctx, workspaceId, { doi });
  return sourceUrl !== undefined ? { ...record, pdf: { url: sourceUrl } } : { ...record };
}
