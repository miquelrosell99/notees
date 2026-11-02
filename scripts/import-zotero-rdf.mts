/**
 * The Zotero RDF bulk importer — PLANNER portion.
 *
 * Pure matching: parsed RDF items (zotero-rdf-parser.mts) against the
 * workspace's existing source state, producing the write plan Task 7's CLI
 * half consumes verbatim. Nothing here touches argv, the filesystem, or a
 * Store — the CLI wires the reader adapter (its nodeValues half reads the
 * matched node's current pool values from the scratch projection;
 * multi-value properties ride as "; "-joined strings, the
 * sourcesQuery.ts authorsText convention).
 *
 * Match order per item (the duplicates.ts / citekeyTrack.ts semantics):
 *  1. citationKey exact hit → `update`;
 *  2. else DOI hit (case-insensitive) → `adopt` — the Zotero citationKey
 *     rides into `sets` under the citekey key;
 *  3. else ISBN hit (digit/X-normalized) → `adopt`, same;
 *  4. else `create` (also: nothing to match on — no citationKey AND no
 *     doi/isbn — still plans as a create).
 * A doi/isbn match on a node carrying a DIFFERENT citekey reports the
 * old-vs-new pair in `conflicts` — never silently merged (Review Focus 3).
 *
 * Value comparison: whitespace collapsed on both sides before equality;
 * DOI case-insensitive, ISBN stripped to digits+X (uppercase) — the
 * identifier precedents; creators/editors compare as their "; "-joined
 * strings. Equal values are removed from `sets` (log-growth hygiene — a
 * re-run plans empty sets); differing values become `conflicts` entries —
 * `keepExisting: true` drops them from `sets` (only empty fields fill),
 * `false` keeps them (RDF wins).
 *
 * Same-file duplicate citationKeys: Zotero guarantees unique keys, a
 * hand-edited file may not. Every occurrence after the first is flagged
 * `duplicateOf` (the plan index of the first entry) plus a conflict entry —
 * the plan never silently double-creates; the CLI skips flagged entries
 * on apply.
 */

import {
  ZOTERO_ITEM_TYPE_TO_CLASS,
  type ZoteroItemType,
} from "../packages/domain/src/index.ts";

import type { ZoteroRdfItem } from "./zotero-rdf-parser.mts";

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
        if (normalizeFor(key, nodeValue) === normalizeFor(key, rdfValue)) continue;
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
