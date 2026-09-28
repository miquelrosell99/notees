/**
 * Tolerant BibTeX parser + serializer (bibliography round-trip, the
 * `@notees/export` home for citation IO — pure and IO-free like the rest of
 * the package).
 *
 * Parser tolerance decisions (deliberate, M1):
 *  - `@entry{key, field = value, ...}` with arbitrary whitespace/newlines.
 *  - Braced values `{...}` nest; one nesting level is DROPPED in output (the
 *    outer braces delimit, inner groups concatenate) — matching common
 *    BibTeX tooling. `journal = {J. {Pure} Appl. Math.}` parses to
 *    `J. Pure Appl. Math.`.
 *  - Double-quoted values `"..."` and bare scalars (`year = 1962`) are
 *    accepted; bare scalars read to the next top-level comma/close brace.
 *  - `@comment{...}`, `%` line comments, `@string`, `@preamble`, and
 *    `@i`/`@include` are skipped (string macros are not expanded — values
 *    referencing a macro keep the raw macro name).
 *  - Duplicate field names keep the LAST occurrence (LWW-ish).
 *  - Unterminated entries/values clamp at EOF instead of throwing.
 *
 * Serializer: stable field order (the canonical list below, then unknown
 * fields in insertion order), braced values with minimal escaping
 * (`{`/`}` backslash-escaped, newlines folded to spaces).
 */

export interface BibEntry {
  /** Lowercased entry type without `@` (`book`, `article`, …). */
  entryType: string;
  citeKey: string;
  /** Lowercased field names, insertion order (last duplicate wins). */
  fields: Record<string, string>;
}

const SKIP_TYPES = new Set(["comment", "string", "preamble", "i", "include"]);

function isNameStart(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_\-]/.test(ch);
}

/** Skip `%` line comments and whitespace; returns the next content index. */
function skipNoise(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
    if ((text[i] ?? "") === "%") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    return i;
  }
}

function readName(text: string, i: number): { name: string; next: number } {
  const start = i;
  while (i < text.length && isNameChar(text[i] ?? "")) i += 1;
  return { name: text.slice(start, i), next: i };
}

/** Read one value: braced (nesting-aware), quoted, or bare scalar. */
function readValue(text: string, i: number): { value: string; next: number } {
  i = skipNoise(text, i);
  const open = text[i];
  if (open === "{") {
    i += 1; // consume the outer opening brace
    let depth = 1;
    let out = "";
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return { value: out, next: i + 1 };
      } else if (depth >= 1) {
        out += ch;
      }
      i += 1;
    }
    // Unterminated: clamp at EOF with whatever was captured.
    return { value: out, next: i };
  }
  if (open === '"') {
    let out = "";
    i += 1;
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === '"') return { value: out, next: i + 1 };
      out += ch;
      i += 1;
    }
    return { value: out, next: i };
  }
  // Bare scalar: to the next top-level comma or closing brace.
  const start = i;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === "," && depth === 0) break;
    i += 1;
  }
  return { value: text.slice(start, i).trim(), next: i };
}

/**
 * Parse BibTeX text into entries. Never throws on malformed input — broken
 * constructs are skipped or clamped (see tolerance notes above).
 */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  let i = 0;
  while (i < text.length) {
    i = skipNoise(text, i);
    if (i >= text.length) break;
    if (text[i] !== "@") {
      // Stray text between entries (often a comment block) — skip to the
      // next `@` rather than aborting the whole parse.
      const next = text.indexOf("@", i);
      i = next === -1 ? text.length : next;
      continue;
    }
    i += 1;
    const typeRead = readName(text, i);
    if (typeRead.name.length === 0) {
      i += 1;
      continue;
    }
    i = skipNoise(text, typeRead.next);
    const entryType = typeRead.name.toLowerCase();
    if (SKIP_TYPES.has(entryType)) {
      // Skip a braced/quoted body if present, else to end of line.
      if ((text[i] ?? "") === "{") {
        let depth = 0;
        while (i < text.length) {
          const ch = text[i] ?? "";
          if (ch === "{") depth += 1;
          else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              break;
            }
          }
          i += 1;
        }
      } else if ((text[i] ?? "") === '"') {
        i += 1;
        while (i < text.length && text[i] !== '"') i += 1;
        i += 1;
      } else {
        while (i < text.length && text[i] !== "\n") i += 1;
      }
      continue;
    }
    if ((text[i] ?? "") !== "{") {
      // Not an entry body (e.g. `@article` mentioned in prose) — skip name.
      continue;
    }
    i += 1; // consume '{'
    i = skipNoise(text, i);
    const keyRead = readName(text, i);
    const citeKey = keyRead.name;
    i = skipNoise(text, keyRead.next);
    const fields: Record<string, string> = {};
    const fieldOrder: string[] = [];
    if ((text[i] ?? "") === ",") i += 1;
    // Parse `name = value` pairs until the closing brace.
    for (;;) {
      i = skipNoise(text, i);
      if (i >= text.length) break;
      if ((text[i] ?? "") === "}") {
        i += 1;
        break;
      }
      if (!isNameStart(text[i] ?? "")) {
        i += 1; // stray character inside the body — skip it.
        continue;
      }
      const fieldRead = readName(text, i);
      i = skipNoise(text, fieldRead.next);
      if ((text[i] ?? "") !== "=") {
        // Not a field (garbled body) — skip to the next comma.
        while (i < text.length && text[i] !== "," && text[i] !== "}") i += 1;
        if ((text[i] ?? "") === ",") i += 1;
        continue;
      }
      i += 1; // consume '='
      const valueRead = readValue(text, i);
      i = skipNoise(text, valueRead.next);
      const fieldName = fieldRead.name.toLowerCase();
      if (!(fieldName in fields)) fieldOrder.push(fieldName);
      fields[fieldName] = valueRead.value;
      if ((text[i] ?? "") === ",") i += 1;
      else if ((text[i] ?? "") === "}") {
        i += 1;
        break;
      }
    }
    entries.push({ entryType, citeKey, fields });
  }
  return entries;
}

// --- serializer ----------------------------------------------------------------

/** Canonical field emission order; unknown fields follow in insertion order. */
const FIELD_ORDER = [
  "author",
  "editor",
  "title",
  "journal",
  "booktitle",
  "publisher",
  "school",
  "institution",
  "year",
  "date",
  "volume",
  "number",
  "pages",
  "edition",
  "chapter",
  "series",
  "doi",
  "isbn",
  "issn",
  "url",
  "note",
  "keywords",
  "abstract",
];

function escapeFieldValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([{}])/g, "\\$1");
}

/** Serialize one entry as `@type{key, ...}` with the stable field order. */
export function serializeBibEntry(entry: BibEntry): string {
  const known = FIELD_ORDER.filter((name) => entry.fields[name] !== undefined);
  const unknown = Object.keys(entry.fields).filter((name) => !FIELD_ORDER.includes(name));
  const lines: string[] = [`@${entry.entryType}{${entry.citeKey},`];
  for (const name of [...known, ...unknown]) {
    const value = entry.fields[name];
    if (value === undefined) continue;
    lines.push(`  ${name} = {${escapeFieldValue(value)}},`);
  }
  // Replace the trailing comma on the last field line for canonical output.
  if (lines.length > 1) {
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,$/, "");
  }
  lines.push("}");
  return lines.join("\n");
}

/** Serialize a list of entries into one `.bib` document. */
export function serializeBibtex(entries: readonly BibEntry[]): string {
  return entries.map((entry) => serializeBibEntry(entry)).join("\n\n") + (entries.length > 0 ? "\n" : "");
}
