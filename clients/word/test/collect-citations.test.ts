import { describe, expect, it } from "vitest";
import { collectCitationNodeIds } from "../src/citation/collect";
import type { CitationEmbed } from "../src/citation/embed";
import { scanDocumentXml, type ScannedField } from "../src/citation/ooxml";
import {
  CapabilityError,
  insertCitationFieldWith,
  type WordRuntime,
} from "../src/word/document";

const embed = (nodeIds: string[], citationId = "c-1"): CitationEmbed => ({
  citationId,
  nodeIds,
  styleId: "apa",
});

function citationField(embedValue: CitationEmbed, display: string): string {
  return `<w:fldSimple w:instr=" ADDIN notees.Citation ${JSON.stringify(embedValue).replace(/&/g, "&amp;").replace(/"/g, "&quot;")} "><w:r><w:t xml:space="preserve">${display}</w:t></w:r></w:fldSimple>`;
}

describe("collectCitationNodeIds", () => {
  it("returns an empty list for an empty document", () => {
    expect(
      collectCitationNodeIds(
        scanDocumentXml(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`,
        ),
      ),
    ).toEqual([]);
  });

  it("flattens, dedupes across fields, and keeps document order of first appearance", () => {
    const fields = scanDocumentXml(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        `<w:p>${citationField(embed(["n1", "n2"]), "(Doe, 2024)")}</w:p>` +
        `<w:p>${citationField(embed(["n2", "n3"], "c-2"), "(Doe, 2024, p. 3)")}</w:p>` +
        `<w:p>${citationField(embed(["n1", "n4"], "c-3"), "(Roe, 2023)")}</w:p>` +
        `</w:body></w:document>`,
    );
    expect(collectCitationNodeIds(fields)).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("skips citation embeds with empty nodeIds without disturbing order", () => {
    const fields = scanDocumentXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${citationField(
        embed([], "c-empty"),
        "()",
      )}</w:p><w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${citationField(
        embed(["n9"]),
        "(Doe, 2024)",
      )}</w:p>`,
    );
    // parseCitationCode rejects empty nodeIds, so the empty field scans as foreign.
    expect(collectCitationNodeIds(fields)).toEqual(["n9"]);
  });

  it("excludes bibliography fields", () => {
    const fields = scanDocumentXml(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr=" ADDIN notees.Bibliography {&quot;styleId&quot;:&quot;apa&quot;} "><w:r><w:t>Bibliography</w:t></w:r></w:fldSimple></w:p>` +
        `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${citationField(embed(["n5"]), "(Doe, 2024)")}</w:p>`,
    );
    expect(fields.some((f) => f.kind === "bibliography")).toBe(true);
    expect(collectCitationNodeIds(fields)).toEqual(["n5"]);
  });

  it("excludes foreign fields", () => {
    const fields: ScannedField[] = [
      { code: "PAGE", displayText: "1", kind: "foreign", embed: null },
      { code: " ADDIN notees.Citation bad-json ", displayText: "x", kind: "foreign", embed: null },
      { code: "ADDIN notees.Citation ", displayText: "x", kind: "foreign", embed: null },
    ];
    expect(collectCitationNodeIds(fields)).toEqual([]);
  });
});

describe("insertCitationFieldWith (fake WordRuntime)", () => {
  const supported: WordRuntime = {
    isSetSupported: () => true,
    insertOoxmlAtSelection: () => Promise.resolve(),
  };

  it("wraps the field in a w:p with the namespace declared and replaces the selection", async () => {
    let received: string | null = null;
    const runtime: WordRuntime = {
      isSetSupported: (set, version) => set === "WordApi" && version === "1.5",
      insertOoxmlAtSelection: (xml) => {
        received = xml;
        return Promise.resolve();
      },
    };
    await insertCitationFieldWith(runtime, embed(["n1"], "c-9"), "(Doe, 2024)");
    expect(received).toBe(
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:fldSimple w:instr=" ADDIN notees.Citation {&quot;citationId&quot;:&quot;c-9&quot;,&quot;nodeIds&quot;:[&quot;n1&quot;],&quot;styleId&quot;:&quot;apa&quot;} ">` +
        `<w:r><w:t xml:space="preserve">(Doe, 2024)</w:t></w:r></w:fldSimple></w:p>`,
    );
    expect(received).not.toContain("<w:r><w:fldSimple");
  });

  it("throws CapabilityError when the host does not support WordApi 1.5", async () => {
    const runtime: WordRuntime = { ...supported, isSetSupported: () => false };
    await expect(insertCitationFieldWith(runtime, embed(["n1"]), "x")).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(insertCitationFieldWith(runtime, embed(["n1"]), "x")).rejects.toMatchObject({
      capability: "insert-ooxml",
    });
  });

  it("wraps host rejections from insertOoxml into CapabilityError", async () => {
    const runtime: WordRuntime = {
      ...supported,
      insertOoxmlAtSelection: () => Promise.reject(new Error("RichApi.UnknownHost")),
    };
    await expect(insertCitationFieldWith(runtime, embed(["n1"]), "x")).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  it("rejects empty nodeIds before touching the runtime", async () => {
    let touched = false;
    const runtime: WordRuntime = {
      ...supported,
      insertOoxmlAtSelection: () => {
        touched = true;
        return Promise.resolve();
      },
    };
    await expect(insertCitationFieldWith(runtime, embed([]), "x")).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(touched).toBe(false);
  });
});
