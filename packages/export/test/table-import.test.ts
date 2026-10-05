/**
 * Table import parser specs (issue #9's read side): the RFC-4180 CSV reader
 * (mirroring csv.ts's escape conventions) and the minimal XLSX reader (built
 * in-test through the package's own renderXlsx, plus a hand-seeded
 * sharedStrings package for the real-Excel cell flavor renderXlsx never
 * emits). Parsers return plain string matrices; coercion is the modal's job.
 */

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  columnIndexOf,
  parseCsvTable,
  parseXlsxTable,
  renderCsv,
  renderXlsx,
  unescapeXmlText,
} from "../src/index.js";

describe("parseCsvTable", () => {
  it("splits records on CRLF and strips a UTF-8 BOM", () => {
    expect(parseCsvTable("﻿uuid,Name\r\nid-1,Alpha\r\nid-2,Beta\r\n")).toEqual([
      ["uuid", "Name"],
      ["id-1", "Alpha"],
      ["id-2", "Beta"],
    ]);
  });

  it("accepts LF-only files without a BOM", () => {
    expect(parseCsvTable("uuid,Name\nid-1,Alpha")).toEqual([
      ["uuid", "Name"],
      ["id-1", "Alpha"],
    ]);
  });

  it("reads quoted fields with embedded commas, quotes, and line breaks", () => {
    const text = 'uuid,Note\r\nid-1,"comma, inside"\r\nid-2,"he said ""hi"""\r\nid-3,"a\nb"\r\n';
    expect(parseCsvTable(text)).toEqual([
      ["uuid", "Note"],
      ["id-1", "comma, inside"],
      ["id-2", 'he said "hi"'],
      ["id-3", "a\nb"],
    ]);
  });

  it("round-trips adversarial cell content through renderCsv", () => {
    // Generate the corpus with the package's own serializer (csv.test.ts
    // uses the same shape): the parser mirrors the RFC-4180 contract from
    // the other side.
    const header = ["Name", "Note", "Quote", "Lines"];
    const rows = [
      ['leading "quote', "comma, inside", 'he said "hi"', "a\nb\nc"],
      ["plain", 'ends with quote"', ",starts with comma", "trail\r\n"],
    ];
    const text = renderCsv(header, rows);
    expect(parseCsvTable(text)).toEqual([header, ...rows]);
  });

  it("keeps empty trailing fields and ignores nothing", () => {
    expect(parseCsvTable("uuid,A,B\r\nid-1,,\r\n")).toEqual([
      ["uuid", "A", "B"],
      ["id-1", "", ""],
    ]);
  });
});

describe("parseXlsxTable", () => {
  it("round-trips a sheet built by the package's own writer", () => {
    const rows = [
      ["uuid", "Name", "Pages"],
      ["id-1", "Alpha", "3"],
      ["id-2", "Beta", "0"],
    ];
    expect(parseXlsxTable(renderXlsx(rows[0]!, rows.slice(1)))).toEqual(rows);
  });

  it("reads the workbook's sheet rel instead of assuming sheet1.xml", () => {
    const bytes = zipSync({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "_rels/.rels": strToU8("<?xml version=\"1.0\"?><Relationships/>"),
      "xl/workbook.xml": strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Data" sheetId="1" r:id="rId9"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId9" Type="…/worksheet" Target="worksheets/data.xml"/>' +
          '<Relationship Id="rId2" Type="…/worksheet" Target="worksheets/other.xml"/></Relationships>',
      ),
      "xl/worksheets/data.xml": strToU8(
        '<?xml version="1.0"?><worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="inlineStr"><is><t>uuid</t></is></c></row>' +
          "</sheetData></worksheet>",
      ),
      "xl/worksheets/other.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong</t></is></c></row></sheetData></worksheet>',
      ),
    });
    expect(parseXlsxTable(bytes)).toEqual([["uuid"]]);
  });

  it("reads sharedStrings cells (real-Excel flavor) with entity unescaping", () => {
    const bytes = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8("<Relationships/>"),
      "xl/sharedStrings.xml": strToU8(
        '<sst><si><t xml:space="preserve"> uuid </t></si>' +
          "<si><r><t>Bread &amp; Butter</t></r><r><t> — fresh</t></r></si>" +
          "<si><t/></si></sst>",
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        "<worksheet><sheetData>" +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c></row>' +
          "</sheetData></worksheet>",
      ),
    });
    expect(parseXlsxTable(bytes)).toEqual([
      [" uuid ", "Bread & Butter — fresh"],
      [""],
    ]);
  });

  it("positions sparse cells by their refs and keeps <v> numbers verbatim", () => {
    const bytes = zipSync({
      "xl/worksheets/sheet1.xml": strToU8(
        "<worksheet><sheetData>" +
          '<row r="1"><c r="A1" t="inlineStr"><is><t>uuid</t></is></c><c r="C1" t="inlineStr"><is><t>Pages</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>id-1</t></is></c><c r="C2"><v>42.5</v></c></row>' +
          '<row r="3"><c r="B3" t="b"><v>1</v></c></row>' +
          "</sheetData></worksheet>",
      ),
    });
    expect(parseXlsxTable(bytes)).toEqual([
      ["uuid", "", "Pages"],
      ["id-1", "", "42.5"],
      ["", "TRUE"],
    ]);
  });

  it("fails loud when no worksheet part exists", () => {
    expect(() => parseXlsxTable(zipSync({ "xl/workbook.xml": strToU8("<workbook/>") }))).toThrow(
      /no xl\/worksheets\/sheet\*\.xml/,
    );
  });
});

describe("unescapeXmlText / columnIndexOf", () => {
  it("rests the five predefined entities", () => {
    expect(unescapeXmlText("&lt;&amp;&gt;&quot;&apos;")).toBe(`<&>"'`);
  });

  it("maps column letters to 0-based indexes (mirrors columnRef)", () => {
    expect(columnIndexOf("A")).toBe(0);
    expect(columnIndexOf("Z")).toBe(25);
    expect(columnIndexOf("AA")).toBe(26);
    expect(columnIndexOf("AB")).toBe(27);
    expect(columnIndexOf("B12")).toBe(1); // digits end the letter run
  });
});
