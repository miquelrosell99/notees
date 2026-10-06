/**
 * CSV view export specs (2026-10-04):
 * RFC-4180 quoting/escaping, the UTF-8 BOM default, line-ending options,
 * and a round-trip through a real parser (the parser lives in this spec —
 * the package ships the serializer only, no new dependency).
 */

import { describe, expect, it } from "vitest";

import { escapeCsvCell, renderCsv, resolveCsvExportOptions } from "../src/index.js";

/** Minimal RFC-4180 reader (spec-local): quoted cells, doubled quotes,
 *  embedded commas/CR/LF, BOM strip. Mirrors escapeCsvCell's contract. */
function parseCsv(text: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const records: string[][] = [];
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
      // Swallowed: CRLF is the record separator; a lone CR rides the field.
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

describe("escapeCsvCell", () => {
  it("passes plain values through unquoted", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("with spaces")).toBe("with spaces");
    expect(escapeCsvCell("uni-code ✓")).toBe("uni-code ✓");
    expect(escapeCsvCell("")).toBe("");
  });

  it("quotes values containing commas, quotes, or line breaks", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("two\nlines")).toBe('"two\nlines"');
    expect(escapeCsvCell("crlf\r\n")).toBe('"crlf\r\n"');
  });
});

describe("renderCsv", () => {
  it("emits the header then every row, CRLF-terminated", () => {
    const csv = renderCsv(
      ["Name", "Classes"],
      [
        ["Alpha", "task"],
        ["Beta", "page, misc"],
      ],
      { bom: false },
    );
    expect(csv).toBe('Name,Classes\r\nAlpha,task\r\nBeta,"page, misc"\r\n');
  });

  it("prefixes a UTF-8 BOM by default (Excel encoding detection) and omits it on request", () => {
    const withBom = renderCsv(["A"], [["1"]]);
    expect(withBom.startsWith("﻿")).toBe(true);
    expect(withBom.slice(1)).toBe("A\r\n1\r\n");
    expect(renderCsv(["A"], [["1"]], { bom: false }).startsWith("﻿")).toBe(false);
  });

  it("honours the LF line-ending option", () => {
    expect(renderCsv(["A"], [["1"]], { bom: false, lineEnding: "\n" })).toBe("A\n1\n");
  });

  it("resolves defaults: BOM on, CRLF records", () => {
    expect(resolveCsvExportOptions()).toEqual({ bom: true, lineEnding: "\r\n" });
    expect(resolveCsvExportOptions({ bom: false, lineEnding: "\n" })).toEqual({
      bom: false,
      lineEnding: "\n",
    });
  });

  it("round-trips adversarial cell content through the parser", () => {
    const header = ["Name", "Note", "Quote", "Lines", "Empty"];
    const rows = [
      ['leading "quote', 'comma, inside', 'he said "hi"', "a\nb\nc", ""],
      ["plain", 'ends with quote"', ',starts with comma', "trail\r\n", "x"],
      ["✓ unicode — em dash", "tab\tchar", 'quote"" adjacent', "single\nnewline", ""],
    ];
    const csv = renderCsv(header, rows);
    expect(parseCsv(csv)).toEqual([header, ...rows]);
  });

  it("round-trips an empty-row table (header only)", () => {
    expect(parseCsv(renderCsv(["A", "B"], []))).toEqual([["A", "B"]]);
  });
});
