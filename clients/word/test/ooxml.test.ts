import { describe, expect, it } from "vitest";
import type { BibliographyEmbed, CitationEmbed } from "../src/citation/embed";
import {
  bibliographyFieldXml,
  citationFieldXml,
  escapeXml,
  scanDocumentXml,
} from "../src/citation/ooxml";

const sample: CitationEmbed = {
  citationId: "c-1",
  nodeIds: ["n1", "n2"],
  styleId: "apa",
};

const bibliography: BibliographyEmbed = { styleId: "apa" };

/** Wrap body XML the way a `body.getOoxml()` dump looks. */
function doc(body: string): string {
  return `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

function para(...runs: string[]): string {
  return `<w:p>${runs.join("")}</w:p>`;
}

function run(xml: string): string {
  return `<w:r>${xml}</w:r>`;
}

describe("escapeXml", () => {
  it("escapes the four XML metacharacters", () => {
    expect(escapeXml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
  });

  it("leaves non-ASCII text untouched", () => {
    expect(escapeXml("café — naïve — 日本語")).toBe("café — naïve — 日本語");
  });
});

describe("citationFieldXml", () => {
  it("emits a fldSimple with leading and trailing spaces in w:instr", () => {
    const xml = citationFieldXml(sample, "(Rosell, 2026)");
    expect(xml).toBe(
      `<w:fldSimple w:instr=" ADDIN notees.Citation {&quot;citationId&quot;:&quot;c-1&quot;,&quot;nodeIds&quot;:[&quot;n1&quot;,&quot;n2&quot;],&quot;styleId&quot;:&quot;apa&quot;} ">` +
        `<w:r><w:t xml:space="preserve">(Rosell, 2026)</w:t></w:r></w:fldSimple>`,
    );
  });
});

describe("scanDocumentXml round-trip", () => {
  it("round-trips a generated citation field, embed and display equal", () => {
    const display = `(Rosell & Ramos, 2026) "quoted" <tag> café`;
    const xml = citationFieldXml({ ...sample, locator: "p. 42" }, display);
    const fields = scanDocumentXml(doc(para(run(xml))));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("citation");
    expect(fields[0].embed).toEqual({ ...sample, locator: "p. 42" });
    expect(fields[0].displayText).toBe(display);
  });

  it("round-trips a generated bibliography field", () => {
    const xml = bibliographyFieldXml(bibliography, "Rosell, M. (2026). …");
    const fields = scanDocumentXml(doc(para(run(xml))));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("bibliography");
    expect(fields[0].embed).toEqual(bibliography);
    expect(fields[0].displayText).toBe("Rosell, M. (2026). …");
  });

  it("scans two citations and a bibliography in document order", () => {
    const first = citationFieldXml({ ...sample, citationId: "c-1" }, "(A, 2020)");
    const bib = bibliographyFieldXml(bibliography, "Bibliography");
    const second = citationFieldXml(
      { citationId: "c-2", nodeIds: ["n3"], styleId: "apa" },
      "(B, 2021)",
    );
    const body = para(run(first)) + para(run(second)) + para(run(bib));
    const fields = scanDocumentXml(doc(body));
    expect(fields.map((f) => f.kind)).toEqual(["citation", "citation", "bibliography"]);
    expect(fields.map((f) => (f.embed as { citationId?: string }).citationId ?? "")).toEqual([
      "c-1",
      "c-2",
      "",
    ]);
    expect(fields.map((f) => f.displayText)).toEqual([
      "(A, 2020)",
      "(B, 2021)",
      "Bibliography",
    ]);
  });
});

describe("scanDocumentXml complex fields", () => {
  function complexField(instr: string, display: string): string {
    return (
      run('<w:fldChar w:fldCharType="begin"/>') +
      run(`<w:instrText xml:space="preserve"> ${escapeXml(instr)} </w:instrText>`) +
      run('<w:fldChar w:fldCharType="separate"/>') +
      run(`<w:t xml:space="preserve">${escapeXml(display)}</w:t>`) +
      run('<w:fldChar w:fldCharType="end"/>')
    );
  }

  it("parses a citation stored as a complex field", () => {
    const instr = `ADDIN notees.Citation ${JSON.stringify(sample)}`;
    const fields = scanDocumentXml(doc(para(complexField(instr, "(Rosell, 2026)"))));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("citation");
    expect(fields[0].embed).toEqual(sample);
    expect(fields[0].displayText).toBe("(Rosell, 2026)");
    expect(fields[0].code).toBe(instr);
  });

  it("reassembles instruction text split across multiple runs", () => {
    const instr = `ADDIN notees.Citation ${JSON.stringify(sample)}`;
    const splitAt = Math.floor(instr.length / 2);
    const xml =
      run('<w:fldChar w:fldCharType="begin"/>') +
      run(`<w:instrText xml:space="preserve"> ${instr.slice(0, splitAt)}</w:instrText>`) +
      run(`<w:instrText xml:space="preserve">${instr.slice(splitAt)} </w:instrText>`) +
      run('<w:fldChar w:fldCharType="separate"/>') +
      run("<w:t>(Rosell, 2026)</w:t>") +
      run('<w:fldChar w:fldCharType="end"/>');
    const fields = scanDocumentXml(doc(para(xml)));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("citation");
    expect(fields[0].code).toBe(instr);
  });

  it("handles nested fields: inner citation scanned, outer foreign", () => {
    const inner = complexField(
      `ADDIN notees.Citation ${JSON.stringify(sample)}`,
      "(Rosell, 2026)",
    );
    const outer =
      run('<w:fldChar w:fldCharType="begin"/>') +
      run('<w:instrText xml:space="preserve"> IF </w:instrText>') +
      run('<w:fldChar w:fldCharType="separate"/>') +
      inner +
      run('<w:fldChar w:fldCharType="end"/>');
    const fields = scanDocumentXml(doc(para(outer)));
    expect(fields.map((f) => f.kind)).toEqual(["citation", "foreign"]);
    expect(fields[0].embed).toEqual(sample);
    expect(fields[1].code).toBe("IF");
  });

  it("classifies a Zotero complex field as foreign with code intact", () => {
    const zoteroCode = 'ADDIN ZOTERO_ITEM {"citationID":"QWERTY123"}';
    const fields = scanDocumentXml(doc(para(complexField(zoteroCode, "(Doe, 2019)"))));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("foreign");
    expect(fields[0].embed).toBeNull();
    expect(fields[0].code).toBe(zoteroCode);
    expect(fields[0].displayText).toBe("(Doe, 2019)");
  });

  it("skips a broken complex field (begin without end) without throwing", () => {
    const broken =
      run('<w:fldChar w:fldCharType="begin"/>') +
      run(`<w:instrText xml:space="preserve"> ADDIN notees.Citation ${JSON.stringify(sample)} </w:instrText>`);
    const ok = citationFieldXml(sample, "(Rosell, 2026)");
    const fields = scanDocumentXml(doc(para(broken) + para(run(ok))));
    expect(fields).toHaveLength(1);
    expect(fields[0].kind).toBe("citation");
  });

  it("never throws on garbage input", () => {
    expect(scanDocumentXml("")).toEqual([]);
    expect(scanDocumentXml("not xml at all <<<")).toEqual([]);
    expect(
      scanDocumentXml('<w:p><w:fldChar w:fldCharType="begin"/><w:instrText> X </w:instrText>'),
    ).toEqual([]);
  });
});
