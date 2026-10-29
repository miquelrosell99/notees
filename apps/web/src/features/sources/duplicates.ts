/**
 * duplicates — the DETECTION half of the Zotero-like source duplicates
 * feature (task 12). PURE and derived: `groupSourceDuplicates` takes the
 * Sources-hub row projection (the `SourceRow` shape from `sourcesQuery.ts`
 * — feed it straight from `runSourcesQuery`) and returns the duplicate
 * clusters; no client calls, no wire/model/store change. The view + merge
 * modal (task 13) renders these groups and rides the existing merge
 * machinery (`packages/store/src/merge.ts`).
 *
 * Match edges (the quick-create `findSourceByIdentifier` idiom, extended
 * with the fuzzy title key):
 *
 *  - IDENTIFIER equality — DOI (case-insensitive trimmed), ISBN (stripped
 *    to digits+X, uppercase), citekey (case-insensitive trimmed).
 *  - FUZZY key — normalized title (lowercase, diacritic-fold, punctuation
 *    stripped, whitespace collapsed) AND (publication year OR first-author
 *    family token). The first author is the first segment of the row's
 *    authorsText (comma/space/semicolon split — the linkedAuthors agent
 *    derivation is already folded into that text by the row projection, so
 *    an agent's familyName answers here with no second read).
 *
 * Both edge types ride ONE union-find: sources linked transitively (A
 * shares a DOI with B, B shares a title with C) land in ONE group. Only
 * groups with ≥ 2 members surface, ordered deterministically — members
 * sorted by node id, groups sorted by their first (smallest-id) member —
 * so shuffled input yields identical output.
 */

import type { SourceRow } from "./sourcesQuery.js";

export interface SourceDuplicateGroup {
  /** The cluster's rows, sorted by node id (the deterministic order). */
  members: SourceRow[];
}

/** Lowercase + diacritic-fold + punctuation stripped + whitespace collapsed. */
function normalizeTitleText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The fuzzy key's first-author token — the first segment of the authors
 *  text, same normalization as the title so "García" and "garcia!" agree. */
function firstAuthorToken(authorsText: string): string {
  const segment = /[^,;\s]+/.exec(authorsText);
  return segment === null ? "" : normalizeTitleText(segment[0]);
}

interface RowKeys {
  doi: string;
  isbn: string;
  citekey: string;
  title: string;
  year: number | null;
  authorToken: string;
}

function keysOf(row: SourceRow): RowKeys {
  return {
    // The findSourceByIdentifier normalizations, verbatim.
    doi: row.doi.trim().toLowerCase(),
    isbn: row.isbn.trim().replace(/[^0-9x]/gi, "").toUpperCase(),
    citekey: row.citekey.trim().toLowerCase(),
    title: normalizeTitleText(row.title),
    year: row.year,
    authorToken: firstAuthorToken(row.authorsText),
  };
}

/**
 * Group duplicate sources. Returns only ≥2-member groups; every other row
 * is a singleton and stays out of the result. Deterministic: member order
 * and group order never depend on the input order.
 */
export function groupSourceDuplicates(rows: readonly SourceRow[]): SourceDuplicateGroup[] {
  const keys = rows.map(keysOf);

  // Union-find over row indices.
  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== root) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Edge buckets: identical keys union. Fuzzy buckets are keyed
  // title+VALUE so the title alone never links (two "Untitled Draft" rows
  // with neither year nor author in common stay apart), and a null year /
  // empty token never lands in a bucket at all.
  const buckets = new Map<string, number[]>();
  const add = (bucket: string, index: number): void => {
    const members = buckets.get(bucket);
    if (members === undefined) buckets.set(bucket, [index]);
    else members.push(index);
  };
  for (let index = 0; index < rows.length; index++) {
    const key = keys[index]!;
    if (key.doi !== "") add(`doi${key.doi}`, index);
    if (key.isbn !== "") add(`isbn${key.isbn}`, index);
    if (key.citekey !== "") add(`citekey${key.citekey}`, index);
    if (key.title !== "") {
      // \u0000-separated fields: concatenated keys must stay unambiguous
      // ("A"+token "bc" vs title "AB"+token "c" — both spell "…abc"
      // unseparated, and titles ending in digits bleed into the year).
      if (key.year !== null) add(`title-year\u0000${key.title}\u0000${key.year}`, index);
      if (key.authorToken !== "") add(`title-author\u0000${key.title}\u0000${key.authorToken}`, index);
    }
  }
  for (const members of buckets.values()) {
    for (let i = 1; i < members.length; i++) union(members[0]!, members[i]!);
  }

  // Collect groups ≥ 2 members, deterministically ordered.
  const byRoot = new Map<number, number[]>();
  for (let index = 0; index < rows.length; index++) {
    const root = find(index);
    const group = byRoot.get(root);
    if (group === undefined) byRoot.set(root, [index]);
    else group.push(index);
  }
  const groups = [...byRoot.values()]
    .filter((members) => members.length >= 2)
    .map((members) => members.map((index) => rows[index]!));
  for (const members of groups) {
    members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  groups.sort((a, b) => (a[0]!.id < b[0]!.id ? -1 : a[0]!.id > b[0]!.id ? 1 : 0));
  return groups.map((members) => ({ members }));
}
