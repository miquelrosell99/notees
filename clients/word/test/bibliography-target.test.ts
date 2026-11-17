import { describe, expect, it, vi } from "vitest";
import { BridgeOfflineError } from "../src/bridge/client";
import type { Bridge, BridgeResponse } from "../src/bridge/types";
import { buildBibliographyCode, buildCitationCode, type CitationEmbed } from "../src/citation/embed";
import type { ScannedField } from "../src/citation/ooxml";
import {
  bibliographyTarget,
  describeBibliographyOutcome,
  insertOrReplaceBibliography,
  type BibliographyOutcome,
  type BibliographyWriter,
} from "../src/word/bibliography";
import type { WordFieldAccess } from "../src/word/refresh";

const ZOTERO_CODE = 'ADDIN ZOTERO_ITEM {"id":123} CSL_CITATION {}';

const CITATION_1: CitationEmbed = { citationId: "c1", nodeIds: ["n1"], styleId: "apa" };
const CITATION_2: CitationEmbed = { citationId: "c2", nodeIds: ["n2", "n3"], styleId: "apa" };

function citationField(embed: CitationEmbed, displayText: string): ScannedField {
  return { code: buildCitationCode(embed), displayText, kind: "citation", embed };
}

function bibliographyField(styleId: string, displayText: string): ScannedField {
  return { code: buildBibliographyCode({ styleId }), displayText, kind: "bibliography", embed: { styleId } };
}

function foreignField(code: string, displayText: string): ScannedField {
  return { code, displayText, kind: "foreign", embed: null };
}

describe("bibliographyTarget (pure)", () => {
  it("replaces the first bibliography field when one exists", () => {
    const fields: ScannedField[] = [
      citationField(CITATION_1, "(Doe, 2024)"),
      bibliographyField("apa", "old bibliography"),
      citationField(CITATION_2, "(Doe & Roe, 2024)"),
    ];
    expect(bibliographyTarget(fields)).toEqual({ kind: "replace", index: 1 });
  });

  it("appends when none exists", () => {
    const fields: ScannedField[] = [citationField(CITATION_1, "(Doe, 2024)")];
    expect(bibliographyTarget(fields)).toEqual({ kind: "append" });
  });

  it("ignores Zotero (foreign) fields", () => {
    const fields: ScannedField[] = [foreignField(ZOTERO_CODE, "(Smith, 2020)")];
    expect(bibliographyTarget(fields)).toEqual({ kind: "append" });
  });

  it("targets the FIRST bibliography when the user duplicated one", () => {
    const fields: ScannedField[] = [
      bibliographyField("apa", "bib-a"),
      foreignField(ZOTERO_CODE, "(Smith, 2020)"),
      bibliographyField("apa", "bib-b"),
    ];
    expect(bibliographyTarget(fields)).toEqual({ kind: "replace", index: 0 });
  });
});

type RenderBibliographyResponse = BridgeResponse<{ bibliography: string }>;

/** An in-memory WordFieldAccess: raw codes + result text. */
function makeFieldsAccess(initial: { code: string; resultText: string }[]) {
  const fields = initial.map((f) => ({ ...f }));
  const access: WordFieldAccess = {
    listFields: () => Promise.resolve(fields.map((f) => ({ code: f.code, resultText: f.resultText }))),
    updateResultText: (index, text) => {
      fields[index].resultText = text;
      return Promise.resolve();
    },
    updateCode: (index, code) => {
      fields[index].code = code;
      return Promise.resolve();
    },
  };
  return { access, fields };
}

/** A recording BibliographyWriter. */
function makeWriter() {
  const appended: string[] = [];
  const replaced: Array<{ fieldIndex: number; xml: string }> = [];
  const writer: BibliographyWriter = {
    appendParagraph: (xml) => {
      appended.push(xml);
      return Promise.resolve();
    },
    replaceParagraphAtField: (fieldIndex, xml) => {
      replaced.push({ fieldIndex, xml });
      return Promise.resolve();
    },
  };
  return { writer, appended, replaced };
}

/** A Bridge stub whose renderBibliography is scripted per test. */
function stubBridge(renderBibliography: () => Promise<RenderBibliographyResponse>): Bridge {
  return {
    search: () => Promise.reject(new Error("unused in bibliography tests")),
    renderCitation: () => Promise.reject(new Error("unused in bibliography tests")),
    renderBibliography,
    listStyles: () => Promise.reject(new Error("unused in bibliography tests")),
  };
}

describe("insertOrReplaceBibliography (fake seams)", () => {
  it("inserts at the body end when no bibliography field exists", async () => {
    const { access } = makeFieldsAccess([
      { code: buildCitationCode(CITATION_1), resultText: "(Doe, 2024)" },
      { code: buildCitationCode(CITATION_2), resultText: "(Doe & Roe, 2024)" },
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
    ]);
    const { writer, appended, replaced } = makeWriter();
    let rendered: { objectIds: string[]; styleId: string } | null = null;
    const bridge = stubBridge(() => {
      rendered = { objectIds: ["n1", "n2", "n3"], styleId: "apa" };
      return Promise.resolve({ ok: true, bibliography: "References…" });
    });

    const outcome = await insertOrReplaceBibliography(bridge, "apa", access, writer);

    expect(outcome).toEqual({ status: "inserted", nodeCount: 3 });
    expect(rendered).toEqual({ objectIds: ["n1", "n2", "n3"], styleId: "apa" });
    expect(replaced).toEqual([]);
    expect(appended).toEqual([
      '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr=" ADDIN notees.Bibliography {&quot;styleId&quot;:&quot;apa&quot;} "><w:r><w:t xml:space="preserve">References…</w:t></w:r></w:fldSimple></w:p>',
    ]);
  });

  it("replaces the existing bibliography field in place (second insert never leaves two)", async () => {
    const { access } = makeFieldsAccess([
      { code: buildCitationCode(CITATION_1), resultText: "(Doe, 2024)" },
      { code: buildBibliographyCode({ styleId: "old-style" }), resultText: "stale bibliography" },
    ]);
    const { writer, appended, replaced } = makeWriter();
    const bridge = stubBridge(() => Promise.resolve({ ok: true, bibliography: "fresh bibliography" }));

    const outcome = await insertOrReplaceBibliography(bridge, "apa", access, writer);

    expect(outcome).toEqual({ status: "replaced", nodeCount: 1, extra: 0 });
    expect(appended).toEqual([]); // no second paragraph — the field is replaced in place
    expect(replaced).toHaveLength(1);
    expect(replaced[0].fieldIndex).toBe(1);
    expect(replaced[0].xml).toContain('ADDIN notees.Bibliography {&quot;styleId&quot;:&quot;apa&quot;}');
    expect(replaced[0].xml).toContain("fresh bibliography");
  });

  it("duplicated bibliographies: replaces the FIRST and reports the extra count", async () => {
    const { access } = makeFieldsAccess([
      { code: buildBibliographyCode({ styleId: "apa" }), resultText: "bib-a" },
      { code: buildCitationCode(CITATION_1), resultText: "(Doe, 2024)" },
      { code: buildBibliographyCode({ styleId: "apa" }), resultText: "bib-b" },
    ]);
    const { writer, appended, replaced } = makeWriter();
    const bridge = stubBridge(() => Promise.resolve({ ok: true, bibliography: "one bibliography" }));

    const outcome = await insertOrReplaceBibliography(bridge, "apa", access, writer);

    expect(outcome).toEqual({ status: "replaced", nodeCount: 1, extra: 1 });
    expect(replaced.map((r) => r.fieldIndex)).toEqual([0]);
    expect(appended).toEqual([]);
  });

  it("zero citations → no-citations outcome, no render, nothing written", async () => {
    const { access } = makeFieldsAccess([
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
      { code: "plain text field", resultText: "not a notees field" },
    ]);
    const { writer, appended, replaced } = makeWriter();
    const render = vi.fn((): Promise<RenderBibliographyResponse> => Promise.resolve({ ok: true, bibliography: "x" }));
    const bridge = stubBridge(render);

    const outcome = await insertOrReplaceBibliography(bridge, "apa", access, writer);

    expect(outcome).toEqual({ status: "no-citations" });
    expect(render).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(replaced).toEqual([]);
  });

  it("bridge offline is classified distinctly from a render failure", async () => {
    const { access } = makeFieldsAccess([{ code: buildCitationCode(CITATION_1), resultText: "(Doe, 2024)" }]);
    const { writer, appended } = makeWriter();
    const offline = stubBridge(() => Promise.reject(new BridgeOfflineError(new Error("ECONNREFUSED"))));
    const failed = stubBridge(() =>
      Promise.resolve({ ok: false, error: { code: "unknown_style", message: "no such style" } }),
    );

    expect(await insertOrReplaceBibliography(offline, "apa", access, writer)).toEqual({ status: "offline" });
    expect(await insertOrReplaceBibliography(failed, "apa", access, writer)).toEqual({
      status: "render-failed",
      code: "unknown_style",
      message: "no such style",
    });
    expect(appended).toEqual([]); // neither failure wrote anything
  });

  it("a writer rejection reports write-failed; a scan failure reports scan-failed — never throws", async () => {
    const { access } = makeFieldsAccess([{ code: buildCitationCode(CITATION_1), resultText: "(Doe, 2024)" }]);
    const rejectingWriter: BibliographyWriter = {
      appendParagraph: () => Promise.reject(new Error("host rejected OOXML insert")),
      replaceParagraphAtField: () => Promise.reject(new Error("host rejected OOXML insert")),
    };
    const bridge = stubBridge(() => Promise.resolve({ ok: true, bibliography: "x" }));
    expect(await insertOrReplaceBibliography(bridge, "apa", access, rejectingWriter)).toEqual({
      status: "write-failed",
      message: "host rejected OOXML insert",
    });

    const brokenAccess: WordFieldAccess = {
      listFields: () => Promise.reject(new Error("getOoxml rejected by host")),
      updateResultText: () => Promise.resolve(),
      updateCode: () => Promise.resolve(),
    };
    expect(await insertOrReplaceBibliography(bridge, "apa", brokenAccess, rejectingWriter)).toEqual({
      status: "scan-failed",
    });
  });
});

describe("describeBibliographyOutcome", () => {
  it("formats the pane summary per outcome kind", () => {
    const cases: Array<[BibliographyOutcome, string]> = [
      [{ status: "inserted", nodeCount: 12 }, "bibliography inserted (12 sources)"],
      [{ status: "replaced", nodeCount: 12, extra: 0 }, "bibliography replaced (12 sources)"],
      [
        { status: "replaced", nodeCount: 12, extra: 1 },
        "bibliography replaced (12 sources) · 1 extra bibliography field left in the document",
      ],
      [{ status: "no-citations" }, "no Notees citations in this document yet"],
      [{ status: "offline" }, "Notees bridge unreachable — the bibliography was not written"],
      [
        { status: "render-failed", code: "unknown_style", message: "no such style" },
        "bibliography render failed (unknown_style): no such style",
      ],
      [{ status: "scan-failed" }, "could not scan the document fields — nothing was written"],
      [{ status: "write-failed", message: "host rejected" }, "host rejected"],
    ];
    for (const [outcome, expected] of cases) {
      expect(describeBibliographyOutcome(outcome)).toBe(expected);
    }
  });
});
