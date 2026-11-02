/**
 * The Zotero RDF bulk importer (2026-11-02, the Zotero-full-alignment
 * slice): a Zotero library export becomes citekey-keyed upsert envelopes
 * on the workspace's op log — the sources library converges by APPENDED
 * envelopes (migrations.md Path A), never by editing the relay log.
 *
 * Two halves:
 *
 *  PLANNER (pure): parsed RDF items (zotero-rdf-parser.mts) matched against
 *  the workspace's existing source state, producing the write plan the CLI
 *  consumes verbatim. Match order per item (the duplicates.ts /
 *  citekeyTrack.ts semantics):
 *   1. citationKey exact hit → `update`;
 *   2. else DOI hit (case-insensitive) → `adopt` — the Zotero citationKey
 *      rides into `sets` under the citekey key;
 *   3. else ISBN hit (digit/X-normalized) → `adopt`, same;
 *   4. else `create` (also: nothing to match on — no citationKey AND no
 *      doi/isbn — still plans as a create).
 *  A doi/isbn match on a node carrying a DIFFERENT citekey reports the
 *  old-vs-new pair in `conflicts` — never silently merged (Review Focus 3).
 *  Value comparison: whitespace collapsed on both sides before equality;
 *  DOI case-insensitive, ISBN stripped to digits+X (uppercase); creators/
 *  editors compare as their "; "-joined strings. Equal values are removed
 *  from `sets` (log-growth hygiene — a re-run plans empty sets); differing
 *  values become `conflicts` entries — `keepExisting: true` drops them from
 *  `sets` (only empty fields fill), `false` keeps them (RDF wins).
 *  Same-file duplicate citationKeys: Zotero guarantees unique keys, a
 *  hand-edited file may not — every occurrence after the first is flagged
 *  `duplicateOf` plus a conflict entry; the CLI skips flagged entries.
 *
 *  CLI: argv (--file/--workspace/--data-dir/--server/--api-key/--apply/
 *  --keep-existing), the reader adapter over a scratch derived Store
 *  (latest snapshot + log tail — the sync server's hydration shape), the
 *  envelope writer and the report. DRY RUN BY DEFAULT: the report prints
 *  the per-entry action summary, the per-field conflict table, the
 *  skipped duplicates, the needs-hand-resolution list and the
 *  attachment/collection counts, and writes nothing.
 *
 * The reader adapter (`buildStateReader`): the source family walks
 * `classMembers(source)` (extends-aware, active-only — the same family
 * read the web engine keys on); identifier equality rides the
 * duplicates.ts normalizations (citekey trim+lowercase, doi
 * trim+lowercase, isbn digits+X uppercase). `nodeValues` returns the
 * matched node's pool-key → value map with multi-value rows "; "-joined
 * (the sourcesQuery.ts authorsText convention); {nodeId} carrier values
 * flatten to the target's display name, date refs to their display label
 * ("2022") — the form the RDF-side string compares against.
 *
 * The envelope writer (`buildImportEnvelopes`): `create` rides ONE
 * `object.create` — a parentless standalone node (isEmbedded false, the
 * quickCreate.ts draft-create precedent) with `classIds` carrying the
 * Zotero-type system class (class membership has no dedicated op — the
 * classIds OR-Set carrier is the assignment) and the title as its
 * contentAst (title-is-content) — followed by one `property.set` per
 * `sets` entry (a multi-value text field's "; "-joined value splits into
 * ONE ROW PER NAME at idx 0..n-1 — the sources contract is one name per
 * value); `update`/`adopt` ride the `property.set`s alone. A multi-value
 * schema whose node already carries rows is emptied first
 * (`property.empty` — a replace, never an accumulate). Datetime-typed
 * fields (publicationDate, accessDate) resolve through the deterministic
 * date chain: the year(/month/day) node is created when absent (the
 * client-dates.ts ensure shape — compact labels, locked parents/classes)
 * and the value rides a {nodeId} ref at the precision the RDF date
 * claims; an unparseable date is reported under needs-hand-resolution,
 * never written. Every envelope is zod-validated before insert; --apply
 * posts batched to the running server's POST /api/admin/append (the one
 * write path) or ingests into the relay directly, then verifies: the new
 * envelopes read back protocol-valid and a FRESH scratch store applies
 * the tail clean. Idempotent: a second run plans zero envelopes for
 * converged values (Review Focus 4) — date refs compare as ISO truncated
 * at the ref's precision, the spelling the RDF side arrives in.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server —
 * --dir, NOT --filter: the filter form runs through pnpm 9's recursive-exec
 * reporter, which prints a stray `undefined` line when the command fails,
 * e.g. on the schema-absent state-read error):
 *   pnpm --dir apps/server exec tsx ../../scripts/import-zotero-rdf.mts \
 *     --file "Mi biblioteca.rdf" --workspace <uuid> \
 *     [--data-dir config/notees/sync | --server http://localhost:8377 [--api-key …]] \
 *     [--apply] [--keep-existing]
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  envelopeSchema,
  newEnvelope,
  payloadSchemaFor,
  type ContentAst,
  type Envelope,
} from "../packages/protocol/src/index.ts";
import {
  dateNodeId,
  dateNodeLabel,
  dayNodeId,
  deriveDisplayName,
  monthNodeId,
  parseDateNodeId,
  parseIsoDate,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  yearNodeId,
  ZOTERO_ITEM_TYPE_TO_CLASS,
  type SystemClassName,
  type ZoteroItemType,
} from "../packages/domain/src/index.ts";
import { Store, visiblePropertyValueRows } from "../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../packages/store/src/adapters/better-sqlite3.ts";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";

import {
  parseZoteroRdf,
  type ZoteroRdfItem,
  type ZoteroRdfParseResult,
} from "./zotero-rdf-parser.mts";

/** The workspace-state read the planner matches against (Task 7 wires it
 *  over a scratch Store). Match methods return the node's identity fields;
 *  `nodeValues` returns its current pool-key → value map (joined strings
 *  for multi-value properties) for the equal/conflict diff. */
export interface ImportStateReader {
  findSourceByCitekey(key: string): {
    nodeId: string;
    citekey: string;
    doi?: string;
    isbn?: string;
  } | null;
  findSourceByIdentifier(
    prop: "doi" | "isbn",
    value: string,
  ): { nodeId: string; citekey: string } | null;
  nodeValues(nodeId: string): Record<string, string>;
}

export interface ImportPlanEntry {
  item: ZoteroRdfItem;
  /** adopt = matched by doi/isbn, the Zotero citekey will be set. */
  action: "create" | "update" | "adopt";
  /** Set for update/adopt. */
  nodeId?: string;
  /** ZOTERO_ITEM_TYPE_TO_CLASS result (`case` → `document`). */
  classKey: string;
  /** pool-key → RDF value, equal values already removed. */
  sets: Record<string, string>;
  conflicts: { property: string; nodeValue: string; rdfValue: string }[];
  /** Plan index of the first entry sharing this item's citationKey —
   *  set only for same-file duplicates; the CLI must skip these on apply. */
  duplicateOf?: number;
}

/** Identifier-equality normalizers — the duplicates.ts precedents. */
function normalizeFor(key: string, value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (key === "doi") return collapsed.toLowerCase();
  if (key === "isbn") return collapsed.replace(/[^0-9x]/gi, "").toUpperCase();
  if (key === "citekey") return collapsed.toLowerCase();
  return collapsed;
}

/** Datetime-typed pool keys (the only datetime schemas in the source
 *  family) — the diff compares these through parseRdfDate instead of
 *  verbatim text (datetime equality at the claimed precision). */
const DATETIME_POOL_KEYS: ReadonlySet<string> = new Set(["publicationDate", "accessDate"]);

/** Datetime equality at the precision each side claims (the datetime-
 *  equality pin): the node side reads back ISO truncated at the ref's
 *  precision ("2016-06" — the valueTextOf parseDateNodeId spelling) while
 *  the RDF side is verbatim Zotero ("June 2016"). Both parse through
 *  parseRdfDate (the node side through the strict ISO tier); equal ISOs at
 *  the same precision mean no write. An unparseable side is simply unequal
 *  — the writer reports it under hand-resolution, never as a conflict
 *  loop. */
function datetimeEquals(nodeValue: string, rdfValue: string): boolean {
  const nodeParsed = parseRdfDate(nodeValue);
  const rdfParsed = parseRdfDate(rdfValue);
  return nodeParsed !== null && rdfParsed !== null && nodeParsed.iso === rdfParsed.iso;
}

/** The RDF side of the diff: pool-key → value. `fields` is already
 *  pool-keyed; creators flatten under their role key with the "; " join
 *  (contributors/translators carry no pool property and are skipped);
 *  the citationKey rides under the citekey key (adopt's whole point). */
function rdfSetsOf(item: ZoteroRdfItem): Record<string, string> {
  const sets: Record<string, string> = { ...item.fields };
  for (const creator of item.creators) {
    if (creator.role !== "authors" && creator.role !== "editors") continue;
    if (creator.names.length === 0) continue;
    const joined = creator.names.join("; ");
    // The item's own fields always win over a container repeat.
    if (sets[creator.role] === undefined) sets[creator.role] = joined;
  }
  if (item.citationKey !== undefined && item.citationKey !== "") {
    sets.citekey = item.citationKey;
  }
  return sets;
}

function classKeyOf(item: ZoteroRdfItem): string {
  const mapped = ZOTERO_ITEM_TYPE_TO_CLASS[item.itemType as ZoteroItemType];
  if (mapped === undefined) {
    throw new Error(`Unknown Zotero itemType "${item.itemType}" (${item.uri})`);
  }
  return mapped;
}

export function planImport(
  items: ZoteroRdfItem[],
  state: ImportStateReader,
  opts: { keepExisting: boolean },
): ImportPlanEntry[] {
  const plan: ImportPlanEntry[] = [];
  /** Normalized citationKey → plan index of its first occurrence. */
  const seenKeys = new Map<string, number>();

  for (const item of items) {
    const sets = rdfSetsOf(item);
    const classKey = classKeyOf(item);

    // Match: citekey exact, else doi, else isbn, else create.
    let action: ImportPlanEntry["action"] = "create";
    let nodeId: string | undefined;
    const doi = sets.doi;
    const isbn = sets.isbn;
    if (item.citationKey !== undefined && item.citationKey !== "") {
      const hit = state.findSourceByCitekey(item.citationKey);
      if (hit !== null) {
        action = "update";
        nodeId = hit.nodeId;
      }
    }
    if (action === "create" && nodeId === undefined) {
      if (doi !== undefined) {
        const hit = state.findSourceByIdentifier("doi", doi);
        if (hit !== null) {
          action = "adopt";
          nodeId = hit.nodeId;
        }
      }
      if (action === "create" && isbn !== undefined) {
        const hit = state.findSourceByIdentifier("isbn", isbn);
        if (hit !== null) {
          action = "adopt";
          nodeId = hit.nodeId;
        }
      }
    }

    // Diff against the node's current values (creates have nothing to diff).
    const entrySets: Record<string, string> = {};
    const conflicts: ImportPlanEntry["conflicts"] = [];
    if (action === "create") {
      Object.assign(entrySets, sets);
    } else {
      const nodeValues = state.nodeValues(nodeId!);
      for (const [key, rdfValue] of Object.entries(sets)) {
        const nodeValue = nodeValues[key] ?? "";
        if (nodeValue.trim() === "") {
          entrySets[key] = rdfValue;
          continue;
        }
        if (DATETIME_POOL_KEYS.has(key)) {
          if (datetimeEquals(nodeValue, rdfValue)) continue;
        } else if (normalizeFor(key, nodeValue) === normalizeFor(key, rdfValue)) continue;
        conflicts.push({ property: key, nodeValue, rdfValue });
        if (!opts.keepExisting) entrySets[key] = rdfValue;
      }
    }

    const entry: ImportPlanEntry = { item, action, classKey, sets: entrySets, conflicts };
    if (nodeId !== undefined) entry.nodeId = nodeId;

    // Same-file duplicate citationKey: flag, never silently double-create.
    if (item.citationKey !== undefined && item.citationKey !== "") {
      const normalized = normalizeFor("citekey", item.citationKey);
      const firstIndex = seenKeys.get(normalized);
      if (firstIndex !== undefined) {
        entry.duplicateOf = firstIndex;
        entry.conflicts.push({
          property: "citationKey",
          nodeValue: "(earlier item in this file)",
          rdfValue: item.citationKey,
        });
      } else {
        seenKeys.set(normalized, plan.length);
      }
    }

    plan.push(entry);
  }

  return plan;
}

// --- CLI ----------------------------------------------------------------------

const ACTOR = "01920000-0000-7000-8000-0000000000a8";
const DEVICE = "import-zotero-rdf";
const CLIENT = "import-zotero-rdf";

/** The server's append ceiling (relay MAX_BATCH_ENVELOPES). */
const SERVER_BATCH = 500;

interface CliOptions {
  file: string;
  workspace: string;
  dataDir: string;
  apply: boolean;
  keepExisting: boolean;
  /** The live-stack path: apply through POST /api/admin/append. */
  server: string | null;
  apiKey: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const file = value("--file");
  const workspace = value("--workspace");
  if (file === undefined || file === "") {
    throw new Error("usage: import-zotero-rdf.mts --file <rdf> --workspace <uuid> " +
      "[--data-dir … | --server http://localhost:8377 [--api-key …]] [--apply] [--keep-existing]");
  }
  if (workspace === undefined || workspace === "") {
    throw new Error("--workspace <uuid> is required (the import is one workspace at a time)");
  }
  return {
    file,
    workspace,
    dataDir: value("--data-dir") ?? "config/notees/sync",
    apply: argv.includes("--apply"),
    keepExisting: argv.includes("--keep-existing"),
    server: value("--server") ?? null,
    apiKey: value("--api-key") ?? null,
  };
}

/** A local uuidv7 (the graph-loadtest-seed precedent — uuidv7 is not
 *  resolvable from scripts/, it lives in the packages' node_modules). */
function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  const t = BigInt(now);
  for (let i = 5; i >= 0; i--) b[i] = Number((t >> BigInt((5 - i) * 8)) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The operator credential for the --server path: --api-key wins, else the
 * stack's api_key.txt beside the data dir (the deploy layout).
 */
function operatorKeyOf(options: CliOptions): string {
  if (options.apiKey !== null) return options.apiKey;
  try {
    return readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();
  } catch {
    throw new Error(
      "--server needs the operator key: pass --api-key or keep api_key.txt beside --data-dir",
    );
  }
}

/**
 * Apply one batch through the running server (the one write path). Answers
 * the saved ids — an empty list means the batch was already applied
 * (idempotent re-run); the server's derived stores converge before the
 * response, so no restart or cache wipe follows.
 */
async function appendViaServer(
  options: CliOptions,
  workspaceId: string,
  envelopes: Envelope[],
): Promise<{ savedIds: string[]; pending: number }> {
  const base = options.server!.replace(/\/$/, "");
  const response = await fetch(`${base}/api/admin/append`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": operatorKeyOf(options) },
    body: JSON.stringify({ workspaceId, envelopes }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/admin/append answered ${response.status}: ${body}`);
  }
  const result = (await response.json()) as { savedIds: string[]; pending: number };
  return { savedIds: result.savedIds, pending: result.pending };
}

// --- scratch derived store ----------------------------------------------------

/**
 * Restore the workspace's latest snapshot into a fresh in-memory store and
 * apply every log envelope after it (the hydration shape the sync server
 * uses). Throws on any StoreError — a tail that cannot apply must block the
 * import, not be planned against.
 */
function buildScratchStore(relay: RelayStorage, workspaceId: string): Store {
  const store = Store.open(betterSqlite3Backend(":memory:"));
  const snapshot = relay.latestSnapshot(workspaceId);
  let afterSeq = 0;
  if (snapshot !== null) {
    const bytes = relay.readSnapshotData(snapshot.id);
    if (bytes === null) throw new Error(`snapshot ${snapshot.id} has no bytes on disk`);
    store.restore(new Uint8Array(bytes));
    afterSeq = snapshot.up_to_seq;
  }
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      try {
        store.apply(envelope);
      } catch (error) {
        store.close();
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`tail apply failed at seq > ${cursor}: ${detail}`);
      }
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  return store;
}

// --- the reader adapter ---------------------------------------------------------

/** schemaId → pool key, for the system bibliographic pool only. */
const POOL_KEY_OF_SCHEMA = new Map<string, string>(
  Object.entries(SYSTEM_PROPERTY_UUIDS).map(([key, id]) => [id, key]),
);

/** The duplicates.ts identifier normalizations, verbatim. */
function normalizeIdentifier(prop: "doi" | "isbn", value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return prop === "doi"
    ? collapsed.toLowerCase()
    : collapsed.replace(/[^0-9x]/gi, "").toUpperCase();
}

function normalizeCitekey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A stored property value flattened to its comparison text: strings as-is,
 *  {nodeId} refs to the target's display name (date refs to ISO truncated at
 *  the ref's precision — "2022" / "2022-03" / "2022-03-15", the spelling the
 *  RDF side arrives in), ranges as their two side labels. */
function valueTextOf(store: Store, raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  const ref = typeof record.nodeId === "string" ? record.nodeId : null;
  if (ref !== null) {
    const parsed = parseDateNodeId(ref);
    if (parsed !== null) {
      const year = String(parsed.year).padStart(4, "0");
      const month = String(parsed.month).padStart(2, "0");
      const day = String(parsed.day).padStart(2, "0");
      return parsed.precision === "year"
        ? year
        : parsed.precision === "month"
          ? `${year}-${month}`
          : `${year}-${month}-${day}`;
    }
    const row = store.database.prepare("SELECT content FROM node WHERE id = ?").get(ref) as
      | { content: string }
      | undefined;
    if (row === undefined) return "";
    try {
      const contentAst = JSON.parse(row.content) as ContentAst;
      return deriveDisplayName({ id: ref, contentAst });
    } catch {
      return "";
    }
  }
  if ("start" in record || "end" in record) {
    const sides = [record.start, record.end]
      .filter((side) => side !== null && side !== undefined)
      .map((side) => valueTextOf(store, side))
      .filter((side) => side !== "");
    return sides.join(" – ");
  }
  return "";
}

/**
 * The ImportStateReader over a scratch derived Store: the source family is
 * `classMembers(source)` (extends-aware, active-only — the same read the
 * web engine keys on); the index is built eagerly so `nodeValues` never
 * touches the store after construction.
 */
export function buildStateReader(store: Store): ImportStateReader {
  const valuesOf = (nodeId: string): Record<string, string> => {
    const byKey = new Map<string, string[]>();
    // Slot order — the "; " join must read idx 0..n-1 (the display order
    // every sources surface uses) or a re-run's comparison could scramble.
    const rows = visiblePropertyValueRows(store.database, nodeId).sort(
      (a, b) => a.idx - b.idx || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const row of rows) {
      const key = POOL_KEY_OF_SCHEMA.get(row.property_schema_id);
      if (key === undefined) continue;
      let text: string;
      try {
        text = valueTextOf(store, JSON.parse(row.value) as unknown);
      } catch {
        continue;
      }
      if (text.trim() === "") continue;
      const list = byKey.get(key) ?? [];
      list.push(text);
      byKey.set(key, list);
    }
    const values: Record<string, string> = {};
    for (const [key, list] of byKey) values[key] = list.join("; ");
    return values;
  };

  const members = store
    .classMembers(SYSTEM_CLASS_UUIDS.source)
    .filter((row) => row.is_class === 0)
    .map((row) => ({ nodeId: row.id, values: valuesOf(row.id) }));

  return {
    findSourceByCitekey(key) {
      const wanted = normalizeCitekey(key);
      if (wanted === "") return null;
      for (const member of members) {
        const citekey = member.values.citekey ?? "";
        if (citekey !== "" && normalizeCitekey(citekey) === wanted) {
          return {
            nodeId: member.nodeId,
            citekey,
            ...(member.values.doi !== undefined ? { doi: member.values.doi } : {}),
            ...(member.values.isbn !== undefined ? { isbn: member.values.isbn } : {}),
          };
        }
      }
      return null;
    },
    findSourceByIdentifier(prop, value) {
      const wanted = normalizeIdentifier(prop, value);
      if (wanted === "") return null;
      for (const member of members) {
        const hit = member.values[prop];
        if (hit !== undefined && hit !== "" && normalizeIdentifier(prop, hit) === wanted) {
          return { nodeId: member.nodeId, citekey: member.values.citekey ?? "" };
        }
      }
      return null;
    },
    nodeValues(nodeId) {
      return members.find((member) => member.nodeId === nodeId)?.values ?? {};
    },
  };
}

// --- the envelope writer ----------------------------------------------------------

interface SchemaShape {
  type: string;
  multi: boolean;
}

export interface ImportEnvelopeBuild {
  envelopes: Envelope[];
  /** Datetime fields whose RDF value did not parse — reported, never written. */
  unparsedDates: Array<{ index: number; key: string; value: string }>;
}

/** Full month names, English + Spanish (the owner's Zotero library is
 *  ES/EN). Keyed lowercase; the parse tier lowercases the candidate. */
const MONTH_NAME_TO_NUMBER: ReadonlyMap<string, number> = new Map(
  (
    [
      ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
      ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    ] as const
  ).flatMap((names) => names.map((name, index) => [name, index + 1] as const)),
);

/** 3-letter English month abbreviations (PubMed/MEDLINE `YYYY Mon [D]`).
 *  Exactly three letters — "Sept" is out of scope on purpose (a minimal,
 *  unambiguous surface). Keyed lowercase. */
const MONTH_ABBR_TO_NUMBER: ReadonlyMap<string, number> = new Map(
  (["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const).map(
    (abbr, index) => [abbr, index + 1] as const,
  ),
);

/** The precision an RDF date string claims — the coarsest shape present.
 *  A SANITATION PRE-PASS runs before all tiers (idempotent — the strips
 *  never re-introduce each other, and the loop runs until stable):
 *  trim whitespace; strip ONE trailing period (twice, so "2022.." →
 *  "2022") and one trailing comma; strip balanced surrounding wrappers
 *  when the WHOLE string is wrapped — "(2022)" → "2022", "[2022]" →
 *  "2022", "(June 2016)" → "June 2016" (INFIX wrappers never strip:
 *  "2022 (repr.)" stays unparsable); strip a leading circa marker
 *  ("c2022", "C2022", "ca. 2022", "ca 2022") and parse the rest — the
 *  rest's precision is kept ("ca. 2022" → year, "ca. 2022-03-15" → day).
 *  Zotero's `dc:date` carries these decorations verbatim from real
 *  library catalogs; without the pre-pass the end-anchored strict ISO
 *  tier demotes every decorated date to hand-resolution.
 *  Tiers, strictest first (Zotero exports `dc:date` verbatim, so real
 *  files carry human dates alongside the ISO shapes):
 *  1. strict ISO — `YYYY[-MM[-DD]]`, END-ANCHORED: a year prefix with
 *     trailing garbage ("2022 (repr.)", "2023/09/07") rejects instead of
 *     silently reading the year;
 *  2. full month name + year, case-insensitive, optional comma ("June 2016",
 *     "JUNE 2022", "June, 2016", "enero 2020") → month precision; day +
 *     month name + year ("14 June 2024", "14 junio 2024") → day precision;
 *     a day RANGE "D-D Month YYYY" (EN or ES names) takes the START day;
 *     the Spanish "de" long form ("28 de julio de 2023", second de
 *     optional) parses the same; month-first "March 13 2013" (comma
 *     optional) → day precision — EN or ES month names (the bilingual
 *     table accepts "marzo 13 2013" too; harmless, unambiguous);
 *     every candidate is real-calendar
 *     validated through parseIsoDate;
 *  3. PubMed/MEDLINE year-first "YYYY Mon [D]" — exactly 3-letter English
 *     abbreviations, case-insensitive ("2023 Sep" → month, "2024 Dec 11"
 *     → day; "Sept" and longer reject), real-calendar validated;
 *  4. numeric MM/YYYY ("01/2022") → month precision, MM 01-12 (two-part
 *     only — never swallowed by tier 5);
 *  5. all-numeric three-part DD/MM/YYYY or DD-MM-YYYY → day precision.
 *     OWNER-LOCALE RULING (single-owner deployment, explicit): two-separator
 *     all-numeric dates are day-first Spanish, NOT US month-first — so
 *     "07/09/2023" is 7 September 2023 and "01/12/2025" is 1 December 2025;
 *     single-digit days ("8/05/2015") parse; real-calendar validated
 *     ("31/02/2024" is rejected, not clamped).
 *  Everything else — abbreviations outside the PubMed tier, bare ranges
 *  without month/year, garbage — returns null and lands in the
 *  hand-resolution list. */
export function parseRdfDate(value: string): { iso: string; precision: "year" | "month" | "day" } | null {
  let text = value.trim();
  // Sanitation pre-pass — documented in the header. Loop until stable so
  // composed decorations ("(2022).") collapse; bounded, idempotent.
  for (let pass = 0; pass < 4; pass++) {
    const before = text;
    // One trailing period (a second pass collapses "2022.."), one comma.
    if (text.endsWith(".") || text.endsWith(",")) text = text.slice(0, -1).trim();
    // Whole-string wrappers only — never infix.
    if (
      text.length > 2 &&
      ((text.startsWith("(") && text.endsWith(")")) || (text.startsWith("[") && text.endsWith("]")))
    ) {
      text = text.slice(1, -1).trim();
    }
    // Leading circa marker, only when a digit follows ("c2022", "ca. 2022").
    text = text.replace(/^c(?:a\.?)?\s*(?=\d)/i, "");
    if (text === before) break;
  }
  const strict = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (strict !== null) {
    const [, year, month, day] = strict;
    const iso =
      month === undefined
        ? `${year}-01-01`
        : day === undefined
          ? `${year}-${month}-01`
          : `${year}-${month}-${day}`;
    try {
      parseIsoDate(iso);
    } catch {
      return null;
    }
    return { iso, precision: day !== undefined ? "day" : month !== undefined ? "month" : "year" };
  }
  // "D Month YYYY", "D-D Month YYYY" (range → start day), the Spanish "de"
  // long form (second de optional). Month-first is a separate tier below.
  const named = /^(?:(\d{1,2})\s*(?:-\s*(\d{1,2})\s*)?(?:de\s+)?)?([a-z]+),?\s+(?:de\s+)?(\d{4})$/i.exec(text);
  if (named !== null) {
    const startDay = named[1] === undefined ? undefined : Number(named[1]);
    const endDay = named[2] === undefined ? undefined : Number(named[2]);
    const month = MONTH_NAME_TO_NUMBER.get(named[3]!.toLowerCase());
    if (month !== undefined && (endDay === undefined || endDay >= (startDay ?? 1))) {
      const iso = `${named[4]}-${String(month).padStart(2, "0")}-${String(startDay ?? 1).padStart(2, "0")}`;
      try {
        parseIsoDate(iso);
      } catch {
        return null;
      }
      return { iso, precision: startDay !== undefined ? "day" : "month" };
    }
  }
  // Month-first "Month D YYYY" / "Month D, YYYY" → day precision. EN or
  // ES month names both accept (the bilingual table makes ES month-first
  // parse too — deliberate, harmless, unambiguous).
  const monthFirst = /^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
  if (monthFirst !== null) {
    const month = MONTH_NAME_TO_NUMBER.get(monthFirst[1]!.toLowerCase());
    if (month !== undefined) {
      const iso = `${monthFirst[3]}-${String(month).padStart(2, "0")}-${monthFirst[2]!.padStart(2, "0")}`;
      try {
        parseIsoDate(iso);
      } catch {
        return null;
      }
      return { iso, precision: "day" };
    }
  }
  // PubMed/MEDLINE year-first "YYYY Mon [D]" — exactly 3-letter English
  // abbreviations, case-insensitive; calendar-validated. ("Sept" is 4
  // letters: no tier claims it.)
  const pubmed = /^(\d{4})\s+([a-z]{3})(?:\s+(\d{1,2}))?$/i.exec(text);
  if (pubmed !== null) {
    const month = MONTH_ABBR_TO_NUMBER.get(pubmed[2]!.toLowerCase());
    if (month !== undefined) {
      const day = pubmed[3];
      const iso = `${pubmed[1]}-${String(month).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`;
      try {
        parseIsoDate(iso);
      } catch {
        return null;
      }
      return { iso, precision: day !== undefined ? "day" : "month" };
    }
  }
  const slash = /^(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash !== null) {
    const month = Number(slash[1]);
    if (month >= 1 && month <= 12) {
      const iso = `${slash[2]}-${String(month).padStart(2, "0")}-01`;
      try {
        parseIsoDate(iso);
      } catch {
        return null;
      }
      return { iso, precision: "month" };
    }
  }
  // Owner-locale ruling: three-part all-numeric is day-first DD/MM/YYYY
  // ("/" or "-"), never month-first. Two-part stays in the MM/YYYY tier
  // above, so "01/2022" keeps month precision.
  const numericDay = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (numericDay !== null) {
    const iso = `${numericDay[3]}-${numericDay[2].padStart(2, "0")}-${numericDay[1].padStart(2, "0")}`;
    try {
      parseIsoDate(iso);
    } catch {
      return null;
    }
    return { iso, precision: "day" };
  }
  return null;
}

/**
 * The write plan as envelopes, one ingest:
 *  - `create` — object.create (parentless standalone node, isEmbedded false —
 *    the quickCreate draft-create precedent; classIds carry the Zotero-type
 *    system class, the OR-Set membership carrier is the assignment; the
 *    title rides the contentAst, title-is-content) + one property.set per
 *    sets entry (a multi-value text field's joined value splits into one
 *    row per name);
 *  - `update`/`adopt` — one property.set per sets entry (same split).
 * Multi-value schemas whose node already carries rows are emptied first
 * (a replace, never an accumulate). Datetime values resolve through the
 * deterministic date chain, creating the missing chain nodes (the
 * client-dates.ts ensure shape).
 */
export function buildImportEnvelopes(
  workspaceId: string,
  plan: ImportPlanEntry[],
  store: Store,
): ImportEnvelopeBuild {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const unparsedDates: ImportEnvelopeBuild["unparsedDates"] = [];
  let logical = 0;
  const stamp = (opType: string, payload: Record<string, unknown>, affected: string[]): Envelope =>
    newEnvelope({
      workspaceId,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: CLIENT,
      hlc: { physical, logical: logical++ },
      affectedNodeIds: affected,
      opType,
      payload,
    });

  const schemaShapes = new Map<string, SchemaShape | undefined>();
  const shapeOf = (schemaId: string): SchemaShape | undefined => {
    if (!schemaShapes.has(schemaId)) {
      const row = store.database
        .prepare("SELECT type, multi FROM property_schema WHERE id = ?")
        .get(schemaId) as { type: string; multi: number } | undefined;
      schemaShapes.set(
        schemaId,
        row === undefined ? undefined : { type: row.type, multi: row.multi === 1 },
      );
    }
    return schemaShapes.get(schemaId);
  };

  const nodeExists = (nodeId: string): boolean =>
    store.database.prepare("SELECT 1 FROM node WHERE id = ?").get(nodeId) !== undefined;
  const hasValueRows = (nodeId: string, schemaId: string): boolean =>
    visiblePropertyValueRows(store.database, nodeId).some(
      (row) => row.property_schema_id === schemaId,
    );

  /** Chain nodes emitted by THIS build — two items sharing a year mint it once. */
  const mintedChain = new Set<string>();
  const ensureChainNode = (
    id: string,
    parentId: string | null,
    classKey: "year" | "month" | "day",
    iso: string,
  ): void => {
    if (mintedChain.has(id) || nodeExists(id)) return;
    mintedChain.add(id);
    const parts = parseIsoDate(iso);
    envelopes.push(
      stamp(
        "object.create",
        {
          objectId: id,
          isEmbedded: false,
          ...(parentId === null ? { parentId: null } : { parentId }),
          classIds: [SYSTEM_CLASS_UUIDS[classKey]],
          contentAst: [{ type: "text", text: dateNodeLabel(parts, classKey) }],
        },
        [id],
      ),
    );
  };

  for (const [index, entry] of plan.entries()) {
    if (entry.duplicateOf !== undefined) continue; // same-file duplicate — skipped on apply.
    const objectId =
      entry.action === "create"
        ? uuidv7(physical)
        : entry.nodeId!;
    const affected = [objectId];

    if (entry.action === "create") {
      envelopes.push(
        stamp(
          "object.create",
          {
            objectId,
            isEmbedded: false,
            classIds: [SYSTEM_CLASS_UUIDS[entry.classKey as SystemClassName]],
            contentAst: [{ type: "text", text: entry.item.title }],
          },
          affected,
        ),
      );
    }

    for (const [key, value] of Object.entries(entry.sets)) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[key as keyof typeof SYSTEM_PROPERTY_UUIDS];
      if (schemaId === undefined) {
        throw new Error(`entry #${index}: the RDF field "${key}" has no system property schema`);
      }
      const shape = shapeOf(schemaId);
      if (shape === undefined) {
        throw new Error(
          `entry #${index}: the ${key} schema (${schemaId}) is absent from this workspace — ` +
            "seed/ensure it (a fresh workspace's next open self-heals; the pool converges by " +
            "scripts/migrate-zotero-full-alignment.mts) before importing",
        );
      }
      // A changed multi-value field REPLACES the node's rows (the joined
      // string rides one positional set) — never accumulates beside them.
      // The empty rides AFTER the value is settled (an unparsable datetime
      // skips the whole write — it must not emit an empty alone).
      const replaceMultiRows =
        shape.multi && entry.action !== "create" && hasValueRows(objectId, schemaId);
      let wireValue: unknown = value;
      if (shape.type === "datetime") {
        const parsed = parseRdfDate(value);
        if (parsed === null) {
          unparsedDates.push({ index, key, value });
          continue;
        }
        ensureChainNode(yearNodeId(parsed.iso), null, "year", parsed.iso);
        if (parsed.precision === "month" || parsed.precision === "day") {
          ensureChainNode(monthNodeId(parsed.iso), yearNodeId(parsed.iso), "month", parsed.iso);
        }
        if (parsed.precision === "day") {
          ensureChainNode(
            dayNodeId(parsed.iso),
            monthNodeId(parsed.iso),
            "day",
            parsed.iso,
          );
        }
        wireValue = { nodeId: dateNodeId(parsed.iso, parsed.precision) };
      }
      if (replaceMultiRows) {
        envelopes.push(
          stamp("property.empty", { objectId, propertySchemaId: schemaId }, affected),
        );
      }
      if (shape.multi && typeof wireValue === "string") {
        // The sources contract is ONE NAME PER VALUE: the planner's "; "-
        // joined form splits back into per-name rows at idx 0..n-1 (the
        // parser produced the join — names ride "Family, Given"). The re-run
        // comparison joins the rows with "; " again, so idempotency holds.
        const names = wireValue
          .split(";")
          .map((name) => name.trim())
          .filter((name) => name !== "");
        names.forEach((name, idx) => {
          envelopes.push(
            stamp("property.set", { objectId, propertySchemaId: schemaId, value: name, idx }, affected),
          );
        });
        continue;
      }
      envelopes.push(
        stamp("property.set", { objectId, propertySchemaId: schemaId, value: wireValue, idx: 0 }, affected),
      );
    }
  }

  return { envelopes, unparsedDates };
}

/**
 * The protocol gate: every envelope must satisfy the envelope schema AND its
 * per-op payload schema. Anything invalid aborts BEFORE anything is inserted.
 */
function validateEnvelopes(envelopes: Envelope[]): void {
  const failures: string[] = [];
  for (const envelope of envelopes) {
    const envResult = envelopeSchema.safeParse(envelope);
    if (!envResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: envelope invalid — ${envResult.error.message}`);
      continue;
    }
    const schema = payloadSchemaFor(envelope.opType);
    if (schema === undefined) {
      failures.push(`${envelope.opType} ${envelope.id}: no payload schema registered`);
      continue;
    }
    const payloadResult = schema.safeParse(envelope.payload);
    if (!payloadResult.success) {
      failures.push(`${envelope.opType} ${envelope.id}: payload invalid — ${payloadResult.error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `refusing to insert: ${failures.length} invalid envelope(s):\n  ${failures.join("\n  ")}`,
    );
  }
}

// --- the report -------------------------------------------------------------------

/** Adopts whose Zotero citationKey will NOT land: keepExisting dropped the
 *  write (a genuine old-vs-new pair rides the conflicts), or the node
 *  already carries the key modulo case (the normalizer treats both as equal,
 *  so neither sets nor conflicts carry it). The operator must reconcile
 *  these by hand — the whole point of an adopt is the key. */
function handResolutionsOf(
  plan: ImportPlanEntry[],
  reader: ImportStateReader,
): Array<{ index: number; title: string; nodeCitekey: string; rdfCitekey: string; reason: string }> {
  const out: Array<{ index: number; title: string; nodeCitekey: string; rdfCitekey: string; reason: string }> = [];
  for (const [index, entry] of plan.entries()) {
    if (entry.action !== "adopt") continue;
    const rdfKey = entry.item.citationKey;
    if (rdfKey === undefined || rdfKey === "") continue;
    if (entry.sets.citekey !== undefined) continue; // the write rides the plan.
    const nodeCitekey = reader.nodeValues(entry.nodeId!).citekey ?? "";
    if (nodeCitekey === "") continue; // empty → the fill rides sets (checked above).
    const reason =
      nodeCitekey.toLowerCase() === rdfKey.toLowerCase()
        ? "case-only difference — the node already carries the key"
        : "dropped by --keep-existing";
    out.push({ index, title: entry.item.title, nodeCitekey, rdfCitekey: rdfKey, reason });
  }
  return out;
}

function printReport(
  parsed: ZoteroRdfParseResult,
  plan: ImportPlanEntry[],
  options: CliOptions,
  envelopeCount: number,
  unparsedDates: ImportEnvelopeBuild["unparsedDates"],
  handResolutions: ReturnType<typeof handResolutionsOf>,
): void {
  console.log(
    `import plan — ${parsed.items.length} item(s), ${parsed.attachments} attachment(s), ` +
      `${parsed.collections} collection(s) — ` +
      `${options.apply ? "--apply" : "dry run"}${options.keepExisting ? " --keep-existing" : ""} ` +
      `(${options.server ?? options.dataDir})`,
  );

  let creates = 0;
  let updates = 0;
  let adopts = 0;
  let skipped = 0;
  for (const [index, entry] of plan.entries()) {
    const title = entry.item.title === "" ? "(untitled)" : entry.item.title;
    if (entry.duplicateOf !== undefined) {
      skipped += 1;
      console.log(
        `  [skip]   #${index} ${JSON.stringify(title)} — same-file duplicate of entry #${entry.duplicateOf} (citekey ${entry.item.citationKey ?? ""})`,
      );
      continue;
    }
    const writes = Object.keys(entry.sets).length;
    if (entry.action === "create") {
      creates += 1;
      console.log(
        `  [create] #${index} ${JSON.stringify(title)} → ${entry.classKey} — ` +
          `${writes} field write(s), node minted`,
      );
    } else {
      if (entry.action === "update") updates += 1;
      else adopts += 1;
      console.log(
        `  [${entry.action}]  #${index} ${JSON.stringify(title)} → ${entry.nodeId} — ` +
          `${writes} field write(s)`,
      );
    }
  }

  let conflictCount = 0;
  for (const [index, entry] of plan.entries()) {
    for (const conflict of entry.conflicts) {
      // The same-file duplicate pseudo-conflict is reported on the skip line.
      if (conflict.property === "citationKey" && conflict.nodeValue === "(earlier item in this file)") {
        continue;
      }
      conflictCount += 1;
      console.log(
        `  ! #${index} ${entry.item.title}: ${conflict.property} — node=${JSON.stringify(conflict.nodeValue)} ` +
          `rdf=${JSON.stringify(conflict.rdfValue)} → ${options.keepExisting ? "kept existing" : "RDF wins"}`,
      );
    }
  }
  if (conflictCount === 0) console.log("  conflicts: none — every differing field is listed above when present.");

  for (const hand of handResolutions) {
    console.log(
      `  ~ #${hand.index} ${JSON.stringify(hand.title)} — needs hand-resolution: the adopt's citationKey ` +
        `was not written (node carries ${JSON.stringify(hand.nodeCitekey)}, RDF ${JSON.stringify(hand.rdfCitekey)} ` +
        `— ${hand.reason})`,
    );
  }
  for (const unparsed of unparsedDates) {
    console.log(
      `  ~ #${unparsed.index} ${plan[unparsed.index]!.item.title}: ${unparsed.key} — needs hand-resolution: ` +
        `unparsable date ${JSON.stringify(unparsed.value)} ` +
        `(want YYYY[-MM[-DD]], "Month YYYY", "D Month YYYY", "D-D Month YYYY", ` +
        `"D de mes de YYYY", "Month D YYYY", YYYY Mon [D], DD/MM/YYYY or MM/YYYY)`,
    );
  }

  console.log(
    `  summary: ${creates} create(s), ${updates} update(s), ${adopts} adopt(s), ` +
      `${skipped} skipped duplicate(s), ${conflictCount} conflicted field(s), ` +
      `${handResolutions.length + unparsedDates.length} needing hand-resolution.`,
  );
  console.log(`${envelopeCount} envelope(s) built and protocol-validated.`);
}

// --- verification -----------------------------------------------------------------

/**
 * Post-insert verification, straight from the persisted log: the envelopes
 * THIS run appended (seq > the seq before the ingest — a repeat import must
 * not count the previous run's envelopes) read back (count + protocol
 * validation) and a FRESH scratch store applies the tail INCLUDING them —
 * zero StoreError throws.
 */
function verify(
  relay: RelayStorage,
  workspaceId: string,
  expectedCount: number,
  afterSeq: number,
): void {
  const rows: Envelope[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = relay.catchUp(workspaceId, cursor, 10_000);
    for (const envelope of page.envelopes) {
      if (envelope.deviceId === DEVICE) rows.push(envelope);
    }
    if (!page.hasMore || page.nextAfterSeq === null) break;
    cursor = page.nextAfterSeq;
  }
  if (rows.length !== expectedCount) {
    throw new Error(`read-back mismatch: expected ${expectedCount} new envelopes, found ${rows.length}`);
  }
  for (const envelope of rows) {
    const stored = envelopeSchema.parse(envelope);
    const schema = payloadSchemaFor(stored.opType);
    if (schema === undefined || !schema.safeParse(stored.payload).success) {
      throw new Error(`read-back envelope ${stored.id} (${stored.opType}) fails protocol validation`);
    }
  }
  const fresh = buildScratchStore(relay, workspaceId);
  fresh.close();
  console.log(
    `verify: ${rows.length} new envelope(s) read back and protocol-valid; the tail applies clean through a fresh hydration.`,
  );
}

// --- main ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const xml = readFileSync(options.file, "utf8");
  const parsed = parseZoteroRdf(xml);

  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );
  try {
    console.log(
      `\nworkspace ${options.workspace}: log seq ${relay.latestSeq(options.workspace)} ` +
        `— import ${options.file}`,
    );
    const store = buildScratchStore(relay, options.workspace);
    let reader: ImportStateReader;
    let plan: ImportPlanEntry[];
    let build: ImportEnvelopeBuild;
    let handResolutions: ReturnType<typeof handResolutionsOf>;
    try {
      reader = buildStateReader(store);
      plan = planImport(parsed.items, reader, { keepExisting: options.keepExisting });
      build = buildImportEnvelopes(options.workspace, plan, store);
      validateEnvelopes(build.envelopes);
      handResolutions = handResolutionsOf(plan, reader);
    } finally {
      store.close();
    }

    printReport(parsed, plan, options, build.envelopes.length, build.unparsedDates, handResolutions);

    if (!options.apply) {
      console.log("dry run — re-run with --apply to append these envelopes to the relay log.");
      return;
    }
    if (build.envelopes.length === 0) {
      console.log("nothing to apply — every planned value already converged (idempotent re-run).");
      return;
    }

    if (options.server !== null) {
      let saved = 0;
      let pending = 0;
      for (let at = 0; at < build.envelopes.length; at += SERVER_BATCH) {
        const result = await appendViaServer(
          options,
          options.workspace,
          build.envelopes.slice(at, at + SERVER_BATCH),
        );
        saved += result.savedIds.length;
        pending = result.pending;
      }
      console.log(
        `applied ${saved} envelope(s) through ${options.server} in ` +
          `${Math.ceil(build.envelopes.length / SERVER_BATCH)} batch(es) (pending skips: ${pending}). ` +
          "The server's derived stores converged before the response — no restart needed.",
      );
      return;
    }

    const seqBefore = relay.latestSeq(options.workspace);
    const { savedIds } = relay.ingest(build.envelopes);
    if (savedIds.length !== build.envelopes.length) {
      throw new Error(`ingest saved ${savedIds.length}/${build.envelopes.length} envelopes (duplicate ids?)`);
    }
    console.log(`ingested ${savedIds.length} envelope(s) into the relay log.`);
    verify(relay, options.workspace, build.envelopes.length, seqBefore);
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
