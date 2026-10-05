/**
 * XLSX view export specs (issue #9): the hand-rolled SpreadsheetML package —
 * part inventory, the uuid-first header, XML metacharacter escaping, typed
 * number cells vs display strings, and a round-trip through the package's
 * own reader (table-import.ts), unzipped with fflate the same way the docx
 * suite does (packages/export/test/docx.test.ts).
 */

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  columnRef,
  escapeXmlText,
  parseXlsxTable,
  renderXlsx,
  resolveXlsxExportOptions,
} from "../src/index.js";

function sheetXmlOf(bytes: Uint8Array): string {
  const parts = unzipSync(bytes);
  const raw = parts["xl/worksheets/sheet1.xml"];
  if (raw === undefined) throw new Error("sheet1.xml missing");
  return new TextDecoder().decode(raw);
}

describe("renderXlsx package shape", () => {
  const bytes = renderXlsx(["uuid", "Name"], [["0192a000-0000-7000-8000-000000000001", "Alpha"]]);

  it("zips the five SpreadsheetML parts", () => {
    const paths = Object.keys(unzipSync(bytes)).sort();
    expect(paths).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("declares the sheet main + worksheet content types", () => {
    const types = new TextDecoder().decode(unzipSync(bytes)["[Content_Types].xml"]!);
    expect(types).toContain('PartName="/xl/workbook.xml"');
    expect(types).toContain("spreadsheetml.sheet.main+xml");
    expect(types).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(types).toContain("spreadsheetml.worksheet+xml");
  });

  it("wires the workbook rel to sheet1 and names the tab", () => {
    const parts = unzipSync(bytes);
    const rels = new TextDecoder().decode(parts["xl/_rels/workbook.xml.rels"]!);
    expect(rels).toContain('Target="worksheets/sheet1.xml"');
    const workbook = new TextDecoder().decode(parts["xl/workbook.xml"]!);
    expect(workbook).toContain('sheet name="Table"');
    const named = renderXlsx(["A"], [], { sheetName: "Books & More" });
    expect(new TextDecoder().decode(unzipSync(named)["xl/workbook.xml"]!)).toContain(
      'sheet name="Books &amp; More"',
    );
  });
});

describe("worksheet cells", () => {
  it("always carries the uuid column first, then the view's labels", () => {
    const xml = sheetXmlOf(renderXlsx(["uuid", "Name", "Pages"], []));
    expect(xml).toContain(
      '<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">uuid</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t xml:space="preserve">Pages</t></is></c></row>',
    );
  });

  it("escapes every XML metacharacter in strings", () => {
    const xml = sheetXmlOf(renderXlsx(["uuid", "Note"], [["id-1", '<b & "quotes" \'apos\'>']]));
    expect(xml).not.toContain("<b &");
    expect(xml).toContain("&lt;b &amp; &quot;quotes&quot; &apos;apos&apos;&gt;");
    // Well-formed: parses back through the reader untouched.
    expect(parseXlsxTable(renderXlsx(["uuid", "Note"], [["id-1", '<b & "quotes" \'apos\'>']]))).toEqual([
      ["uuid", "Note"],
      ["id-1", '<b & "quotes" \'apos\'>'],
    ]);
  });

  it("renders number cells as typed <v> values", () => {
    const xml = sheetXmlOf(renderXlsx(["uuid", "Pages"], [["id-1", 42]]));
    expect(xml).toContain('<c r="B2"><v>42</v></c>');
  });

  it("keeps non-finite numbers as display strings", () => {
    const xml = sheetXmlOf(renderXlsx(["uuid", "Pages"], [["id-1", Number.POSITIVE_INFINITY]]));
    expect(xml).toContain(">Infinity</t>");
    expect(xml).toContain('r="B2" t="inlineStr"');
  });

  it("renders null cells as empty inline strings so positions survive", () => {
    const xml = sheetXmlOf(renderXlsx(["uuid", "A", "B"], [["id-1", null, "x"]]));
    expect(xml).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve"></t></is></c>');
    expect(xml).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">x</t></is></c>');
  });

  it("preserves leading/trailing whitespace (xml:space=preserve)", () => {
    const round = parseXlsxTable(renderXlsx(["uuid", "Note"], [["id-1", " padded "]]));
    expect(round[1]![1]).toBe(" padded ");
  });
});

describe("escapeXmlText / columnRef / options", () => {
  it("escapes the five predefined entities in order", () => {
    expect(escapeXmlText(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });

  it("generates SpreadsheetML column letters", () => {
    expect(columnRef(0)).toBe("A");
    expect(columnRef(25)).toBe("Z");
    expect(columnRef(26)).toBe("AA");
    expect(columnRef(27)).toBe("AB");
    expect(columnRef(51)).toBe("AZ");
    expect(columnRef(52)).toBe("BA");
  });

  it("resolves defaults: the tab is named Table", () => {
    expect(resolveXlsxExportOptions()).toEqual({ sheetName: "Table" });
    expect(resolveXlsxExportOptions({ sheetName: "Rows" })).toEqual({ sheetName: "Rows" });
  });
});

describe("round-trip through parseXlsxTable", () => {
  it("reads back exactly what renderXlsx wrote (uuid first, mixed types)", () => {
    const header = ["uuid", "Name", "Pages", "Note", "Empty"];
    const rows: (string | number | null)[][] = [
      ["0192a000-0000-7000-8000-000000000001", "Alpha", 12, 'comma, "quoted" & <tag>', null],
      ["0192a000-0000-7000-8000-000000000002", "Beta", 0, "line\nbreak", ""],
    ];
    // The reader returns display strings: typed numbers come back as their
    // verbatim <v> text — coercion per schema type is the modal's job.
    expect(parseXlsxTable(renderXlsx(header, rows))).toEqual([
      header,
      ...rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))),
    ]);
  });

  it("round-trips a header-only sheet", () => {
    expect(parseXlsxTable(renderXlsx(["uuid", "Name"], []))).toEqual([["uuid", "Name"]]);
  });

  it("keeps unicode and emoji intact", () => {
    const rows = [["0192a000-0000-7000-8000-000000000001", "héllo ✓ 🚀"]];
    expect(parseXlsxTable(renderXlsx(["uuid", "Note"], rows))).toEqual([["uuid", "Note"], ...rows]);
  });
});
