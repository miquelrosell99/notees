/**
 * Citekey pattern language (owner 2026-10-24, source-library slice 3 task 5):
 * the feature-scoped vocabulary the Sources settings' "Citekey pattern"
 * input compiles and renders, shared with the task-6 generation surface
 * (the import/integration citekey fill rides the SAME module — one
 * grammar, two consumers).
 *
 * Grammar: tokens in square brackets + literal text between them.
 *
 *  - `[auth]` — the family of the FIRST `authors` element (the text before
 *    its first comma, trimmed; an author without a comma contributes the
 *    whole string).
 *  - `[auth:lower]` — the family, lowercased + ASCII-folded (NFD, diacritics
 *    stripped) so "Müller" folds to "muller".
 *  - `[year]` — the entry's year; an unknown year renders EMPTY (the token
 *    is not an error — the caller may legitimately lack one).
 *  - `[title]` — every title word, joined without separators; punctuation
 *    inside a word is dropped (a citekey is a citation key, not prose).
 *  - `[title:lower]` — the same, lowercased + ASCII-folded.
 *  - `[title:lower:N]` / `[title:N]` — the FIRST N words only.
 *
 * Anything outside `[...]` passes through as a literal. An unrecognized
 * token name, an unknown modifier, a malformed `:N` (not a positive
 * integer), or an unbalanced bracket FAILS THE COMPILE — the pattern
 * compiles or it doesn't (the settings input shows the error and refuses
 * the write client-side; nothing half-valid ships).
 *
 * Collision suffixing (-a, -b, …) is deliberately NOT here — that is
 * task 6's generation concern; this module ships compile + render only.
 */

/** The bibliographic entry the pattern renders from. */
export interface CitekeyEntry {
  /** Author strings, "Family, Given" shape expected (not enforced). */
  authors: string[];
  /** The publication year; null = unknown (renders empty). */
  year: number | string | null;
  title: string;
}

/** The workspace default until the user writes their own (the settings seed). */
export const DEFAULT_CITEKEY_PATTERN = "[auth:lower][year][title:lower:3]";

/**
 * The live-preview sample (owner ruling): first author "Lovelace, Ada",
 * year 1843, title "Notes on the Analytical Engine" — the default pattern
 * renders `lovelace1843notesonthe`.
 */
export const CITEKEY_SAMPLE_ENTRY: CitekeyEntry = {
  authors: ["Lovelace, Ada"],
  year: 1843,
  title: "Notes on the Analytical Engine",
};

export type CompiledCitekeyPattern =
  | { ok: true; render: (entry: CitekeyEntry) => string }
  | { ok: false; error: string };

/** Lowercase + ASCII-fold (NFD + diacritic strip) — the :lower modifier. */
function foldLower(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
}

/** The family of an author string: the text before the first comma. */
function familyOf(author: string): string {
  const comma = author.indexOf(",");
  return (comma === -1 ? author : author.slice(0, comma)).trim();
}

/**
 * Title words: split on whitespace, drop punctuation from each word (a
 * citekey token is alphanumeric text). "Notes on the Analytical Engine"
 * → ["Notes", "on", "the", "Analytical", "Engine"].
 */
function titleWords(title: string): string[] {
  return title
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
}

interface Token {
  render: (entry: CitekeyEntry) => string;
}

/** One compiled step: a literal character or a token renderer. */
type PatternPart = string | ((entry: CitekeyEntry) => string);

const TOKEN_PATTERN = /\[([^\]]*)\]/y;

/**
 * Compile one pattern. Returns `{ok: true, render}` or `{ok: false, error}`
 * — the error names the offending token so the input's inline error can
 * point at it.
 */
export function compileCitekeyPattern(pattern: string): CompiledCitekeyPattern {
  const tokens: PatternPart[] = [];
  let cursor = 0;
  while (cursor < pattern.length) {
    if (pattern[cursor] === "[") {
      TOKEN_PATTERN.lastIndex = cursor;
      const match = TOKEN_PATTERN.exec(pattern);
      if (match === null) {
        return { ok: false, error: `Unbalanced "[" at position ${cursor + 1}` };
      }
      const token = compileToken(match[1]!);
      if (!token.ok) return token;
      tokens.push(token.render);
      cursor = TOKEN_PATTERN.lastIndex;
    } else if (pattern[cursor] === "]") {
      return { ok: false, error: `Unbalanced "]" at position ${cursor + 1}` };
    } else {
      tokens.push(pattern[cursor]!);
      cursor += 1;
    }
  }
  return {
    ok: true,
    render: (entry) => tokens.map((part) => (typeof part === "string" ? part : part(entry))).join(""),
  };
}

/** Compile the inside of one `[...]` token. */
function compileToken(spec: string): { ok: true; render: Token["render"] } | { ok: false; error: string } {
  const parts = spec.split(":");
  const name = parts[0]!;
  const modifier = parts[1];
  const limit = parts[2];
  if (parts.length > 3 || name === "") {
    return { ok: false, error: `Invalid token "[${spec}]"` };
  }
  if (name !== "auth" && name !== "year" && name !== "title") {
    return { ok: false, error: `Unknown token "[${spec}]" — use [auth], [year] or [title]` };
  }

  let lower = false;
  let wordLimit: number | undefined;
  if (modifier !== undefined) {
    if (modifier === "lower") lower = true;
    else if (/^\d+$/.test(modifier)) wordLimit = Number(modifier);
    else return { ok: false, error: `Unknown modifier in "[${spec}]" — use :lower or :N` };
  }
  if (limit !== undefined) {
    if (modifier !== "lower" || !/^\d+$/.test(limit)) {
      return { ok: false, error: `Invalid modifier in "[${spec}]" — :N follows :lower` };
    }
    wordLimit = Number(limit);
  }
  if (name !== "title" && wordLimit !== undefined) {
    return { ok: false, error: `Token "[${spec}]" does not take a word count` };
  }
  if (wordLimit !== undefined && wordLimit <= 0) {
    return { ok: false, error: `Token "[${spec}]" needs a word count of at least 1` };
  }

  if (name === "year") {
    if (modifier !== undefined) {
      return { ok: false, error: `Token "[${spec}]" does not take a modifier` };
    }
    return { ok: true, render: (entry) => (entry.year === null ? "" : String(entry.year)) };
  }
  if (name === "auth") {
    if (modifier !== undefined && modifier !== "lower") {
      return { ok: false, error: `Unknown modifier in "[${spec}]" — auth takes :lower only` };
    }
    return {
      ok: true,
      render: (entry) => {
        const family = entry.authors.length > 0 ? familyOf(entry.authors[0]!) : "";
        return lower ? foldLower(family) : family.replace(/\s+/g, "");
      },
    };
  }
  // title
  return {
    ok: true,
    render: (entry) => {
      let words = titleWords(entry.title);
      if (wordLimit !== undefined) words = words.slice(0, wordLimit);
      const joined = words.join("");
      return lower ? foldLower(joined) : joined;
    },
  };
}

/** Render `entry` through `pattern` — null when the pattern does not compile. */
export function renderCitekeyPattern(pattern: string, entry: CitekeyEntry): string | null {
  const compiled = compileCitekeyPattern(pattern);
  return compiled.ok ? compiled.render(entry) : null;
}
