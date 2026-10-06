/**
 * XLSX view export — the table toolbar's "Export Excel" (issue #9): the same
 * view-shaped input as csv.ts (visible columns × current result rows), with a
 * leading "uuid" column so the sheet round-trips through the table import
 * (update-by-uuid). The module follows csv.ts's precedent deliberately:
 * dependency-free serialization (fflate's zipSync is the only byte-level
 * dependency, already in the tree for the docx specs), NOT in the IR-based
 * EXPORT_FORMATS registry (the registry consumes per-node-subtree
 * ExportDocuments; this input is view-shaped), and the same options-bag
 * discipline.
 *
 * The produced file is a minimal-but-valid SpreadsheetML zip, hand-rolled:
 * [Content_Types].xml, the top-level _rels, xl/workbook.xml (+ its rels) and
 * ONE worksheet of flat rows. Cells are inlineStr (no sharedStrings table,
 * no styles — a flat table has nothing to format); number columns ride typed
 * `<v>` cells where the caller's value is already a number (the caller knows
 * its schema types — "typed where unambiguous, display strings otherwise").
 * Every XML metacharacter is escaped (escapeXmlText) and the whole package is
 * zipped with fflate's zipSync, the same unzip-in-specs pattern the docx
 * suite uses in reverse (packages/export/test/docx.test.ts).
 */

import { strToU8, zipSync } from "fflate";

/** Options accepted by {@link renderXlsx}. All optional. */
export interface XlsxExportOptions {
  /** The one worksheet's name (Excel tab). Default `"Table"`. */
  sheetName?: string | undefined;
}

/** The bag with every default resolved. */
export interface ResolvedXlsxExportOptions {
  sheetName: string;
}

export function resolveXlsxExportOptions(options?: XlsxExportOptions): ResolvedXlsxExportOptions {
  return {
    sheetName: options?.sheetName ?? "Table",
  };
}

/**
 * One worksheet cell: a display string, an already-typed number (the caller
 * coerces only where the schema type makes it unambiguous), or null/undefined
 * for an empty cell (rendered as an empty inline string so the cell still
 * occupies its ref — round-trips stay position-stable).
 */
export type XlsxCell = string | number | null | undefined;

/** OOXML text-node escaping: & < > stay well-formed; " and ' ride text too. */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** SpreadsheetML column letters: 0 → A, 25 → Z, 26 → AA, … */
export function columnRef(index: number): string {
  let n = index + 1;
  let ref = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    ref = String.fromCharCode(65 + rem) + ref;
    n = Math.floor((n - 1) / 26);
  }
  return ref;
}

function cellXml(rowIndex: number, colIndex: number, cell: XlsxCell): string {
  const ref = `${columnRef(colIndex)}${rowIndex + 1}`;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) {
      // Infinity/NaN have no OOXML representation — degrade to display text.
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXmlText(String(cell))}</t></is></c>`;
    }
    return `<c r="${ref}"><v>${cell}</v></c>`;
  }
  const text = cell === null || cell === undefined ? "" : cell;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

function sheetXml(
  header: readonly string[],
  rows: readonly (readonly XlsxCell[])[],
): string {
  const records = [header, ...rows];
  const body = records
    .map(
      (record, rowIndex) =>
        `<row r="${rowIndex + 1}">${record
          .map((cell, colIndex) => cellXml(rowIndex, colIndex, cell))
          .join("")}</row>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

/** The five package parts, byte-encoded. `sheetName` goes in workbook.xml. */
function packageParts(sheetName: string): Record<string, Uint8Array> {
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;
  return {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRels),
  };
}

/**
 * Serialize one XLSX document: the header record first, then every row, as
 * one worksheet zipped into a self-contained .xlsx byte array. Like csv.ts,
 * cell values are expected pre-rendered (strings) or pre-typed (numbers the
 * caller's schema knowledge vouches for).
 */
export function renderXlsx(
  header: readonly string[],
  rows: readonly (readonly XlsxCell[])[],
  options?: XlsxExportOptions,
): Uint8Array {
  const resolved = resolveXlsxExportOptions(options);
  return zipSync({
    ...packageParts(resolved.sheetName),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(header, rows)),
  });
}
