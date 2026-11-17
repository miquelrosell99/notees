import { describe, expect, it, vi } from "vitest";
import type { Bridge, BridgeResponse } from "../src/bridge/types";
import {
  buildCitationCode,
  parseCitationCode,
  withStyle,
  type CitationEmbed,
} from "../src/citation/embed";
import { reconcileStyleId, isKnownStyleId, type CitationStyle } from "../src/ui/connection";
import {
  describeRestyleOutcome,
  refreshCitations,
  restyleAllCitations,
  rewriteCitationStyles,
  type WordFieldAccess,
} from "../src/word/refresh";

type RenderResponse = BridgeResponse<{ citation: string }>;

const ZOTERO_CODE = 'ADDIN ZOTERO_ITEM {"id":123} CSL_CITATION {}';
const CORRUPTED_CODE = 'ADDIN notees.Citation {"citationId":"c9","nodeIds":["n1"],"styleId'; // truncated JSON — user-tampered
const BIBLIOGRAPHY_CODE = 'ADDIN notees.Bibliography {"styleId":"apa"}';

/** The styles the bridge lists in these tests. */
const KNOWN_STYLE_IDS = ["apa", "chicago", "mla"];

const EMBED_APA: CitationEmbed = { citationId: "c1", nodeIds: ["n1"], styleId: "apa", locator: "p. 12" };
const EMBED_CHICAGO: CitationEmbed = {
  citationId: "c2",
  nodeIds: ["n2", "n3"],
  styleId: "chicago",
};

/** An in-memory WordFieldAccess: fields are raw codes + mutable result text. */
function makeFieldsAccess(initial: { code: string; resultText: string }[]) {
  const fields = initial.map((f) => ({ ...f }));
  const codeUpdates: Array<{ index: number; code: string }> = [];
  const access: WordFieldAccess = {
    listFields: () => Promise.resolve(fields.map((f) => ({ code: f.code, resultText: f.resultText }))),
    updateResultText: (index, text) => {
      fields[index].resultText = text;
      return Promise.resolve();
    },
    updateCode: (index, code) => {
      codeUpdates.push({ index, code });
      fields[index].code = code;
      return Promise.resolve();
    },
  };
  return { access, fields, codeUpdates };
}

/** A Bridge stub whose renderCitation echoes the styleId it was asked for. */
function stubBridge(): Bridge {
  return {
    search: () => Promise.reject(new Error("unused in style-merge tests")),
    renderCitation: (objectIds, styleId, locator) =>
      Promise.resolve({
        ok: true,
        citation: `rendered:${styleId}:${objectIds.join(",")}:${locator ?? ""}`,
      }),
    renderBibliography: () => Promise.reject(new Error("unused in style-merge tests")),
    listStyles: () => Promise.reject(new Error("unused in style-merge tests")),
  };
}

describe("withStyle (pure)", () => {
  it("swaps styleId, preserves citationId/nodeIds/locator", () => {
    const restyled = withStyle(EMBED_APA, "chicago");
    expect(restyled.styleId).toBe("chicago");
    expect(restyled.citationId).toBe(EMBED_APA.citationId);
    expect(restyled.nodeIds).toEqual(EMBED_APA.nodeIds);
    expect(restyled.locator).toBe("p. 12");
    // The source embed is not mutated.
    expect(EMBED_APA.styleId).toBe("apa");
  });

  it("preserves forward-compatible extra keys through the clone", () => {
    const withExtra = { ...EMBED_APA, zoteroKey: "ABC123" } as CitationEmbed;
    expect(withStyle(withExtra, "mla")).toEqual({ ...withExtra, styleId: "mla" });
  });

  it("round-trips through the field-code codec", () => {
    const code = buildCitationCode(withStyle(EMBED_APA, "chicago"));
    expect(parseCitationCode(code)).toEqual({ ...EMBED_APA, styleId: "chicago" });
    expect(parseCitationCode(buildCitationCode(withStyle(EMBED_CHICAGO, "apa")))).toEqual({
      ...EMBED_CHICAGO,
      styleId: "apa",
    });
  });
});

describe("reconcileStyleId (pure)", () => {
  const styles: CitationStyle[] = [
    { id: "chicago", label: "Chicago" },
    { id: "apa", label: "APA" },
  ];

  it("keeps the current selection when the reload still lists it", () => {
    expect(reconcileStyleId("apa", styles)).toBe("apa");
  });

  it("falls back to the first listed style when the reload drops the selection", () => {
    expect(reconcileStyleId("mla", styles)).toBe("chicago");
  });

  it("falls back to apa when the reload comes back empty", () => {
    expect(reconcileStyleId("chicago", [])).toBe("apa");
  });
});

describe("rewriteCitationStyles (fake WordFieldAccess)", () => {
  it("rewrites every citation field's embed to the picked style, skips foreign + corrupt untouched", async () => {
    const { access, fields, codeUpdates } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "old-1" },
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
      { code: CORRUPTED_CODE, resultText: "user-typed text" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "old-2" },
    ]);

    const outcome = await rewriteCitationStyles(access, "mla");

    expect(outcome).toEqual({ rewritten: 2, skipped: 2, failed: 0 });
    expect(codeUpdates.map((u) => u.index)).toEqual([0, 3]);
    expect(parseCitationCode(fields[0].code)).toEqual({ ...EMBED_APA, styleId: "mla" });
    expect(parseCitationCode(fields[3].code)).toEqual({ ...EMBED_CHICAGO, styleId: "mla" });
    // skip-not-corrupt: foreign and hand-corrupted codes byte-identical.
    expect(fields[1].code).toBe(ZOTERO_CODE);
    expect(fields[2]).toEqual({ code: CORRUPTED_CODE, resultText: "user-typed text" });
    // Display text is untouched by the rewrite itself.
    expect(fields[0].resultText).toBe("old-1");
  });

  it("drops the locator-free and locator-carrying shapes correctly through the codec", async () => {
    const { access, fields } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "x" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "y" },
    ]);
    await rewriteCitationStyles(access, "chicago");
    expect(parseCitationCode(fields[0].code)).toEqual({ ...EMBED_APA, styleId: "chicago" });
    expect(parseCitationCode(fields[1].code)).toEqual({ ...EMBED_CHICAGO, styleId: "chicago" });
  });

  it("a rejected updateCode counts as failed, keeps the old code, never aborts the rest", async () => {
    const { access, fields } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "old-1" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "old-2" },
    ]);
    access.updateCode = (index, code) => {
      if (index === 0) return Promise.reject(new Error("host rejected code update"));
      fields[index].code = code;
      return Promise.resolve();
    };

    const outcome = await rewriteCitationStyles(access, "mla");

    expect(outcome).toEqual({ rewritten: 1, skipped: 0, failed: 1 });
    expect(parseCitationCode(fields[0].code)).toEqual(EMBED_APA); // old code preserved
    expect(parseCitationCode(fields[1].code)).toEqual({ ...EMBED_CHICAGO, styleId: "mla" });
  });

  it("a bibliography field is not a citation: left untouched and not counted as skipped", async () => {
    const { access, fields, codeUpdates } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "old-1" },
      { code: BIBLIOGRAPHY_CODE, resultText: "References…" },
    ]);

    const outcome = await rewriteCitationStyles(access, "mla");

    expect(outcome).toEqual({ rewritten: 1, skipped: 0, failed: 0 });
    expect(codeUpdates.map((u) => u.index)).toEqual([0]);
    expect(fields[1]).toEqual({ code: BIBLIOGRAPHY_CODE, resultText: "References…" });
  });

  it("never throws: a listFields failure reports a zero outcome", async () => {
    const access: WordFieldAccess = {
      listFields: () => Promise.reject(new Error("getOoxml rejected by host")),
      updateResultText: () => Promise.resolve(),
      updateCode: () => Promise.resolve(),
    };
    const updateCode = vi.fn(() => Promise.resolve());
    await expect(rewriteCitationStyles(access, "mla")).resolves.toEqual({
      rewritten: 0,
      skipped: 0,
      failed: 0,
    });
    expect(updateCode).not.toHaveBeenCalled();
  });
});

describe("restyleAllCitations (rewrite embeds → refresh)", () => {
  it("re-uses refreshCitations' render path: every citation re-renders with the picked style", async () => {
    const { access, fields } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "(Doe, 2024, p. 12)" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "(Doe & Roe, 2024)" },
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
    ]);

    const outcome = await restyleAllCitations(stubBridge(), access, "mla", KNOWN_STYLE_IDS);

    expect(outcome).toEqual({
      status: "restyled",
      rewritten: 2,
      skipped: 1,
      failed: 0,
      refresh: { refreshed: 2, skipped: 1, failed: 0 },
    });
    // Both display texts were re-rendered from the NEW styleId in the embed.
    expect(fields[0].resultText).toBe("rendered:mla:n1:p. 12");
    expect(fields[1].resultText).toBe("rendered:mla:n2,n3:");
    expect(fields[2].resultText).toBe("(Smith, 2020)");
    // The embeds now carry the picked style for every future refresh.
    expect(parseCitationCode(fields[0].code)?.styleId).toBe("mla");
    expect(parseCitationCode(fields[1].code)?.styleId).toBe("mla");
  });

  it("a plain refresh afterwards keeps the restyled embeds (no re-rewrite needed)", async () => {
    const { access } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "old" },
    ]);
    await restyleAllCitations(stubBridge(), access, "chicago", KNOWN_STYLE_IDS);
    const outcome = await refreshCitations(stubBridge(), access);
    expect(outcome).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
  });

  it("an unknown styleId rewrites nothing: no embeds touched, no renders, distinct outcome", async () => {
    const { access, fields, codeUpdates } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "(Doe, 2024, p. 12)" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "(Doe & Roe, 2024)" },
    ]);
    const render = vi.fn(stubBridge().renderCitation);

    const outcome = await restyleAllCitations(
      { ...stubBridge(), renderCitation: render },
      access,
      "ghost-style", // persisted pick the current bridge no longer lists
      KNOWN_STYLE_IDS,
    );

    expect(outcome).toEqual({
      status: "unknown-style",
      rewritten: 0,
      skipped: 0,
      failed: 0,
      refresh: { refreshed: 0, skipped: 0, failed: 0 },
    });
    expect(render).not.toHaveBeenCalled(); // the refresh half never runs either
    expect(codeUpdates).toEqual([]); // never-corrupts: embeds stay as they were
    expect(fields[0]).toEqual({ code: buildCitationCode(EMBED_APA), resultText: "(Doe, 2024, p. 12)" });
    expect(fields[1]).toEqual({ code: buildCitationCode(EMBED_CHICAGO), resultText: "(Doe & Roe, 2024)" });
  });

  it("a healthy 2-citation + 1-bibliography document reports 0 skipped through the whole restyle", async () => {
    const { access } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_APA), resultText: "(Doe, 2024, p. 12)" },
      { code: buildCitationCode(EMBED_CHICAGO), resultText: "(Doe & Roe, 2024)" },
      { code: BIBLIOGRAPHY_CODE, resultText: "References…" },
    ]);

    const outcome = await restyleAllCitations(stubBridge(), access, "mla", KNOWN_STYLE_IDS);

    expect(outcome).toEqual({
      status: "restyled",
      rewritten: 2,
      skipped: 0,
      failed: 0,
      refresh: { refreshed: 2, skipped: 0, failed: 0 },
    });
  });
});

describe("describeRestyleOutcome", () => {
  it("formats the pane summary", () => {
    expect(
      describeRestyleOutcome({
        status: "restyled",
        rewritten: 3,
        skipped: 1,
        failed: 0,
        refresh: { refreshed: 3, skipped: 1, failed: 2 },
      }),
    ).toBe("3 restyled · 3 refreshed · 2 skipped (foreign/corrupted) · 2 failed");
  });

  it("an unknown-style run says nothing was rewritten and how to recover", () => {
    expect(
      describeRestyleOutcome({
        status: "unknown-style",
        rewritten: 0,
        skipped: 0,
        failed: 0,
        refresh: { refreshed: 0, skipped: 0, failed: 0 },
      }),
    ).toContain("nothing was rewritten");
  });
});

describe("isKnownStyleId (pure) — the UI gate for restyling", () => {
  const styles: CitationStyle[] = [
    { id: "chicago", label: "Chicago" },
    { id: "apa", label: "APA" },
  ];

  it("accepts a pick the bridge still lists", () => {
    expect(isKnownStyleId("apa", styles)).toBe(true);
  });

  it("rejects a stale pick the list dropped (style removed, re-paired workspace)", () => {
    expect(isKnownStyleId("mla", styles)).toBe(false);
  });

  it("rejects everything when the list is empty (reload needed)", () => {
    expect(isKnownStyleId("apa", [])).toBe(false);
  });
});
