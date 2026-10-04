/**
 * CSV view export — the §34.24 parked register's "CSV view export" row
 * (2026-10-04): the classed-nodes table and query-result tables download
 * their CURRENT view as CSV — columns = the visible table columns, rows =
 * the current result set. The package owns only the record serialization
 * (RFC-4180 quoting, dependency-free): callers flatten their view to
 * display strings (the web table renders cells exactly as on screen) and
 * hand over header + rows.
 *
 * The module follows the export package's options-bag discipline
 * (§34.24 E1): every knob is optional at the surface and resolved by
 * {@link resolveCsvExportOptions}. It deliberately does NOT join the
 * IR-based `EXPORT_FORMATS` registry — that registry's serializers consume
 * the per-node-subtree {@link ExportDocument} IR, while CSV input is
 * view-shaped (visible columns × result rows); the bundleMarkdown engine
 * sets the same precedent (a package-side serializer outside the registry).
 *
 * Excel interop: a UTF-8 BOM prefixes the output by default so Excel
 * detects the encoding; record separators are CRLF per RFC 4180.
 */

/** Options accepted by {@link renderCsv}. All optional. */
export interface CsvExportOptions {
  /**
   * Prefix a UTF-8 BOM (`\uFEFF`) so Excel opens the file as UTF-8 instead
   * of the platform codepage. Default ON.
   */
  bom?: boolean | undefined;
  /** Record separator. Default `"\r\n"` (RFC 4180; Excel's native row end). */
  lineEnding?: "\r\n" | "\n" | undefined;
}

/** The bag with every default resolved. */
export interface ResolvedCsvExportOptions {
  bom: boolean;
  lineEnding: "\r\n" | "\n";
}

export function resolveCsvExportOptions(options?: CsvExportOptions): ResolvedCsvExportOptions {
  return {
    bom: options?.bom ?? true,
    lineEnding: options?.lineEnding ?? "\r\n",
  };
}

/**
 * One CSV field per RFC 4180 §2.6: quote when the value contains a comma,
 * a double quote, or a line break; embedded quotes double. Control
 * characters pass through untouched (the output is UTF-8 text; the BOM +
 * UTF-8 encoding carry non-ASCII).
 */
export function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Serialize one CSV document: the header record first, then every row, each
 * record CRLF-terminated. Cell values are expected pre-rendered display
 * strings (the caller's view semantics — labels, not raw ids).
 */
export function renderCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options?: CsvExportOptions,
): string {
  const resolved = resolveCsvExportOptions(options);
  const lines = [header, ...rows].map((record) => record.map(escapeCsvCell).join(","));
  const body = `${lines.join(resolved.lineEnding)}${resolved.lineEnding}`;
  // The BOM rides the returned string; callers encode the whole thing as
  // UTF-8 (web: TextEncoder inside the Blob; CLI: utf8 write).
  return resolved.bom ? `\uFEFF${body}` : body;
}
