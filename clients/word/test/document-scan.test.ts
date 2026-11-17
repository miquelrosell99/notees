import { describe, expect, it } from "vitest";
import {
  buildCitationCode,
  buildBibliographyCode,
  type BibliographyEmbed,
  type CitationEmbed,
} from "../src/citation/embed";
import { bibliographyFieldXml, citationFieldXml, scanDocumentXml } from "../src/citation/ooxml";
import { scanDocument } from "../src/word/document";
import type { WordFieldAccess } from "../src/word/refresh";

const citeEmbed: CitationEmbed = { citationId: "c-1", nodeIds: ["n1", "n2"], styleId: "apa" };
const bibEmbed: BibliographyEmbed = { styleId: "apa" };

function fakeAccess(codes: { code: string; resultText: string }[]): WordFieldAccess {
  return {
    listFields: () => Promise.resolve(codes),
    updateResultText: () => Promise.resolve(),
    updateCode: () => Promise.resolve(),
  };
}

describe("scanDocument — the shared scan path", () => {
  it("trims codes and classifies citation / bibliography / foreign", async () => {
    const fields = await scanDocument(
      fakeAccess([
        { code: `  ${buildCitationCode(citeEmbed)}  `, resultText: "(Doe, 2024)" },
        { code: buildBibliographyCode(bibEmbed), resultText: "Bibliography" },
        { code: "TOC \\o", resultText: "1" },
      ]),
    );
    expect(fields.map((f) => f.kind)).toEqual(["citation", "bibliography", "foreign"]);
    expect(fields[0].code).toBe(buildCitationCode(citeEmbed));
    expect(fields[0].displayText).toBe("(Doe, 2024)");
    expect(fields[1].embed).toEqual(bibEmbed);
    expect(fields[2].embed).toBeNull();
  });

  it("agrees with the OOXML scanner on the same document — one classifier", async () => {
    // The same three fields rendered as a body OOXML dump…
    const xml =
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p>${citationFieldXml(citeEmbed, "(Doe, 2024)")}</w:p>` +
      `<w:p>${bibliographyFieldXml(bibEmbed, "Bibliography")}</w:p>` +
      `<w:p><w:fldSimple w:instr=" TOC \\o "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>` +
      `</w:body></w:document>`;
    const viaXml = scanDocumentXml(xml);

    // …and as the fields API would report them. Kinds must match exactly —
    // this is the parity refresh and the badge both rely on.
    const viaAccess = await scanDocument(
      fakeAccess([
        { code: ` ADDIN notees.Citation ${JSON.stringify(citeEmbed)} `, resultText: "(Doe, 2024)" },
        { code: ` ADDIN notees.Bibliography ${JSON.stringify(bibEmbed)} `, resultText: "Bibliography" },
        { code: "TOC \\o", resultText: "1" },
      ]),
    );
    expect(viaAccess.map((f) => f.kind)).toEqual(viaXml.map((f) => f.kind));
    expect(viaAccess.map((f) => f.code)).toEqual(viaXml.map((f) => f.code));
    // Corrupted embeds are foreign on BOTH paths.
    const corrupted = await scanDocument(
      fakeAccess([{ code: "ADDIN notees.Citation {bad json", resultText: "x" }]),
    );
    expect(corrupted[0].kind).toBe("foreign");
  });

  it("propagates a listFields failure (the caller reports the zero outcome)", async () => {
    const broken: WordFieldAccess = {
      ...fakeAccess([]),
      listFields: () => Promise.reject(new Error("RichApi.UnknownHost")),
    };
    await expect(scanDocument(broken)).rejects.toThrow("RichApi.UnknownHost");
  });
});
