/**
 * Table import parsers — issue #9's read side: the table toolbar's
 * "Import table…" accepts .csv (RFC-4180, mirroring csv.ts's conventions:
 * UTF-8 BOM strip, quoted fields with doubled quotes, embedded commas/CR/LF,
 * CRLF records) and .xlsx (the minimal SpreadsheetML renderXlsx produces —
 * one worksheet, sharedStrings or inlineStr cells, refs carrying position).
 *
 * Placement: beside csv.ts/xlsx.ts in @notees/export, not in the web app.
 * The export package already owns the view-shaped table-serialization
 * conventions these parsers must mirror exactly (round-trip fidelity lives
 * in ONE package with ONE test suite), fflate is already its dependency, and
 * the web modal stays a thin mapping/write layer over a plain string-matrix
 * input. Both parsers are dependency-free string-matrix readers: coercion to
 * typed property values is the caller's job (the modal owns schema knowledge
 * and fails loud per cell).
 *
 * The XLSX reader walks whatever worksheet the workbook's rId1 rel points at
 * (sheet1 for renderXlsx output, the common real-Excel case too); it reads
 * sharedStrings, inlineStr, str, and boolean cells, and returns `<v>` number
 * text verbatim (the caller coerces per schema type).
 */

import { strFromU8, unzipSync } from "fflate";

import { columnRef } from "./xlsx.js";

export type TableMatrix = string[][];

// --- CSV -------------------------------------------------------------------

/**
 * Minimal RFC-4180 reader, mirroring escapeCsvCell's contract: a leading
 * UTF-8 BOM is stripped, quoted fields may embed commas/CR/LF and double
 * their quotes, CRLF (or LF) terminates a record, and a lone CR inside an
 * unquoted field rides the field.
 */
export function parseCsvTable(text: string): TableMatrix {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: TableMatrix = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else if (char === "\r") {
      if (input[i + 1] !== "\n") field += char;
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

// --- XLSX ------------------------------------------------------------------

/** Reverse escapeXmlText: the five predefined entities back to characters. */
export function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** "AB" → 27 (0-based column index); mirrors {@link columnRef}. */
export function columnIndexOf(ref: string): number {
  let n = 0;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break; // digits end the letter run
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function attrOf(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match?.[1] ?? null;
}

function decodeTextRuns(fragment: string): string {
  let text = "";
  const runPattern = /<t\b(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  for (const match of fragment.matchAll(runPattern)) {
    text += match[1] === undefined ? "" : unescapeXmlText(match[1]);
  }
  return text;
}

function sharedStringsOf(parts: Record<string, Uint8Array>): string[] {
  const raw = parts["xl/sharedStrings.xml"];
  if (raw === undefined) return [];
  const xml = strFromU8(raw);
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    strings.push(decodeTextRuns(match[1]!));
  }
  return strings;
}

function worksheetPathOf(parts: Record<string, Uint8Array>): string {
  // Missing workbook/rels (never true for a real package) just fall through
  // to the first-worksheet fallback below.
  const workbook = strFromU8(parts["xl/workbook.xml"] ?? new Uint8Array());
  const rels = strFromU8(parts["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
  // The workbook's first sheet rel → its worksheet part (rId1 → sheet1.xml
  // for renderXlsx output). Missing rels fall back to the first worksheet.
  const sheetRel = /<sheet\b[^>]*\br:id\s*=\s*"([^"]+)"/.exec(workbook)?.[1];
  if (sheetRel !== undefined) {
    const target = new RegExp(
      `<Relationship\\b[^>]*\\bId\\s*=\\s*"${sheetRel}"[^>]*\\bTarget\\s*=\\s*"([^"]+)"`,
    ).exec(rels)?.[1];
    if (target !== undefined) {
      const path = `xl/${target.replace(/^\//, "")}`;
      if (parts[path] !== undefined) return path;
    }
  }
  const fallback = Object.keys(parts)
    .filter((path) => /^xl\/worksheets\/sheet[^/]*\.xml$/.test(path))
    .sort();
  if (fallback.length === 0) {
    throw new Error("parseXlsxTable: no xl/worksheets/sheet*.xml part in the package");
  }
  return fallback[0]!;
}

/**
 * Read one .xlsx worksheet into a string matrix: sharedStrings + inlineStr
 * + str/boolean cells decode to text, numeric `<v>` cells pass their text
 * through verbatim (the caller coerces per schema), sparse refs position
 * cells by their column letters, and missing trailing cells come back "".
 */
export function parseXlsxTable(bytes: Uint8Array): TableMatrix {
  const parts: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(unzipSync(bytes))) {
    parts[path] = data;
  }
  const shared = sharedStringsOf(parts);
  const xml = strFromU8(parts[worksheetPathOf(parts)]!);
  const matrix: TableMatrix = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? "";
      const ref = attrOf(attrs, "r");
      const colIndex = ref !== null ? columnIndexOf(ref) : cells.length;
      const type = attrOf(attrs, "t");
      let value: string;
      if (type === "inlineStr") {
        value = decodeTextRuns(body);
      } else if (type === "s") {
        const index = Number(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
        value = shared[index] ?? "";
      } else if (type === "b") {
        value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] === "1" ? "TRUE" : "FALSE";
      } else {
        value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
      }
      while (cells.length < colIndex) cells.push("");
      cells[colIndex] = value;
    }
    matrix.push(cells);
  }
  return matrix;
}
