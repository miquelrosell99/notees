import { describe, expect, it } from "vitest";
import {
  BIBLIOGRAPHY_FIELD_PREFIX,
  CITATION_FIELD_PREFIX,
  buildBibliographyCode,
  buildCitationCode,
  isNoteesCitation,
  parseBibliographyCode,
  parseCitationCode,
  type CitationEmbed,
} from "../src/citation/embed";

const sample: CitationEmbed = {
  citationId: "c-1",
  nodeIds: ["n1", "n2"],
  styleId: "apa",
};

describe("buildCitationCode", () => {
  it("emits the normative prefix followed by compact JSON", () => {
    const code = buildCitationCode(sample);
    expect(code.startsWith(CITATION_FIELD_PREFIX)).toBe(true);
    expect(code).toBe(
      'ADDIN notees.Citation {"citationId":"c-1","nodeIds":["n1","n2"],"styleId":"apa"}',
    );
    expect(code.slice(CITATION_FIELD_PREFIX.length)).not.toContain(" ");
  });

  it("includes locator when present", () => {
    const code = buildCitationCode({ ...sample, locator: "p. 42" });
    expect(code).toContain('"locator":"p. 42"');
  });
});

describe("parseCitationCode", () => {
  it("round-trips build→parse equality", () => {
    expect(parseCitationCode(buildCitationCode(sample))).toEqual(sample);
  });

  it("round-trips with locator present", () => {
    const withLocator = { ...sample, locator: "ch. 3" };
    expect(parseCitationCode(buildCitationCode(withLocator))).toEqual(withLocator);
  });

  it("tolerates trailing spaces on the code", () => {
    expect(parseCitationCode(buildCitationCode(sample) + "   ")).toEqual(sample);
  });

  it("returns null for a foreign ADDIN code", () => {
    expect(parseCitationCode('ADDIN ZOTERO_ITEM {"id":1}')).toBeNull();
  });

  it("returns null for a bibliography code", () => {
    expect(parseCitationCode(buildBibliographyCode({ styleId: "apa" }))).toBeNull();
  });

  it("returns null for truncated JSON", () => {
    expect(parseCitationCode('ADDIN notees.Citation {"citationId":"c-1","nodeIds":["n1"')).toBeNull();
  });

  it("returns null for empty nodeIds", () => {
    expect(
      parseCitationCode(buildCitationCode({ ...sample, nodeIds: [] })),
    ).toBeNull();
  });

  it("returns null when nodeIds is the wrong type", () => {
    expect(
      parseCitationCode('ADDIN notees.Citation {"citationId":"c-1","nodeIds":"n1","styleId":"apa"}'),
    ).toBeNull();
  });

  it("preserves extra unknown keys through build→parse→build", () => {
    const withExtra = { ...sample, zoteroKey: "ABC123" } as CitationEmbed;
    const once = parseCitationCode(buildCitationCode(withExtra));
    expect(once).toEqual(withExtra);
    expect(buildCitationCode(once!)).toBe(buildCitationCode(withExtra));
  });

  it("returns null when locator is the wrong type", () => {
    expect(
      parseCitationCode(
        'ADDIN notees.Citation {"citationId":"c-1","nodeIds":["n1"],"styleId":"apa","locator":42}',
      ),
    ).toBeNull();
  });
});

describe("buildBibliographyCode / parseBibliographyCode", () => {
  it("round-trips build→parse equality", () => {
    const embed = { styleId: "apa" };
    const code = buildBibliographyCode(embed);
    expect(code.startsWith(BIBLIOGRAPHY_FIELD_PREFIX)).toBe(true);
    expect(parseBibliographyCode(code)).toEqual(embed);
  });

  it("returns null for a citation code", () => {
    expect(parseBibliographyCode(buildCitationCode(sample))).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    expect(parseBibliographyCode("ADDIN notees.Bibliography {not json")).toBeNull();
  });
});

describe("isNoteesCitation", () => {
  it("matches only the citation prefix", () => {
    expect(isNoteesCitation(buildCitationCode(sample))).toBe(true);
    expect(isNoteesCitation('ADDIN ZOTERO_ITEM {"id":1}')).toBe(false);
    expect(isNoteesCitation(buildBibliographyCode({ styleId: "apa" }))).toBe(false);
  });
});
