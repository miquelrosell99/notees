import { describe, expect, it, vi } from "vitest";
import { BridgeOfflineError } from "../src/bridge/client";
import type { Bridge, BridgeResponse } from "../src/bridge/types";
import { buildCitationCode, type CitationEmbed } from "../src/citation/embed";
import type { ScannedField } from "../src/citation/ooxml";
import { planRefresh } from "../src/citation/refresh-plan";
import {
  describeRefreshOutcome,
  refreshCitations,
  type RefreshOutcome,
  type WordFieldAccess,
} from "../src/word/refresh";

type RenderResponse = BridgeResponse<{ citation: string }>;

const CORRUPTED_CODE = 'ADDIN notees.Citation {"citationId":"c9","nodeIds":["n1"],"styleId":'; // truncated JSON — user-tampered

function citationField(embed: CitationEmbed, displayText: string): ScannedField {
  return { code: buildCitationCode(embed), displayText, kind: "citation", embed };
}

function foreignField(code: string, displayText: string): ScannedField {
  return { code, displayText, kind: "foreign", embed: null };
}

/** An in-memory WordFieldAccess: fields are raw codes + mutable result text. */
function makeFieldsAccess(initial: { code: string; resultText: string }[]) {
  const fields = initial.map((f) => ({ ...f }));
  const updated: Array<{ index: number; text: string }> = [];
  const codeUpdates: Array<{ index: number; code: string }> = [];
  const access: WordFieldAccess = {
    listFields: () => Promise.resolve(fields.map((f) => ({ code: f.code, resultText: f.resultText }))),
    updateResultText: (index, text) => {
      updated.push({ index, text });
      fields[index].resultText = text;
      return Promise.resolve();
    },
    updateCode: (index, code) => {
      codeUpdates.push({ index, code });
      fields[index].code = code;
      return Promise.resolve();
    },
  };
  return { access, fields, updated, codeUpdates };
}

/** A Bridge stub whose renderCitation is scripted per test. */
function stubBridge(render: (args: { objectIds: string[]; styleId: string; locator?: string }) => Promise<RenderResponse>): Bridge {
  return {
    search: () => Promise.reject(new Error("unused in refresh tests")),
    renderCitation: (objectIds, styleId, locator) => render({ objectIds, styleId, locator }),
    renderBibliography: () => Promise.reject(new Error("unused in refresh tests")),
    listStyles: () => Promise.reject(new Error("unused in refresh tests")),
  };
}

const ZOTERO_CODE = 'ADDIN ZOTERO_ITEM {"id":123} CSL_CITATION {}';

const EMBED_1: CitationEmbed = { citationId: "c1", nodeIds: ["n1"], styleId: "apa", locator: "p. 12" };
const EMBED_2: CitationEmbed = { citationId: "c2", nodeIds: ["n2", "n3"], styleId: "chicago" };

describe("planRefresh (pure)", () => {
  it("keeps only citation fields with parseable embeds, preserving field indexes", () => {
    const fields: ScannedField[] = [
      citationField(EMBED_1, "(Doe, 2024, p. 12)"),
      foreignField(ZOTERO_CODE, "(Smith, 2020)"),
      {
        code: 'ADDIN notees.Bibliography {"styleId":"apa"}',
        displayText: "…",
        kind: "bibliography",
        embed: { styleId: "apa" },
      },
      citationField(EMBED_2, "(Doe & Roe, 2024)"),
    ];
    expect(planRefresh(fields)).toEqual([
      { fieldIndex: 0, embed: EMBED_1 },
      { fieldIndex: 3, embed: EMBED_2 },
    ]);
  });

  it("skips corrupted citation codes (prefix + garbage JSON) — never planned", () => {
    const fields: ScannedField[] = [
      citationField(EMBED_1, "(Doe, 2024)"),
      foreignField(CORRUPTED_CODE, "(user-typed text)"),
    ];
    expect(planRefresh(fields)).toEqual([{ fieldIndex: 0, embed: EMBED_1 }]);
  });
});

describe("refreshCitations (fake WordFieldAccess + stub bridge)", () => {
  it("happy path: updates 2 citation fields, skips 1 foreign, reports {refreshed:2, skipped:1, failed:0}", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
      { code: buildCitationCode(EMBED_2), resultText: "old-2" },
    ]);
    const renders: Array<{ objectIds: string[]; styleId: string; locator?: string }> = [];
    const bridge = stubBridge((args) => {
      renders.push(args);
      return Promise.resolve({ ok: true, citation: `rendered:${args.styleId}` });
    });

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 2, skipped: 1, failed: 0 });
    // One render per field, with the styleId + locator from the field's OWN embed.
    expect(renders).toEqual([
      { objectIds: ["n1"], styleId: "apa", locator: "p. 12" },
      { objectIds: ["n2", "n3"], styleId: "chicago", locator: undefined },
    ]);
    expect(updated).toEqual([
      { index: 0, text: "rendered:apa" },
      { index: 2, text: "rendered:chicago" },
    ]);
    expect(fields[0].resultText).toBe("rendered:apa");
    expect(fields[2].resultText).toBe("rendered:chicago");
    expect(fields[1].resultText).toBe("(Smith, 2020)"); // foreign untouched
  });

  it("a hand-corrupted field survives refresh byte-identical (skip-not-corrupt)", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: CORRUPTED_CODE, resultText: "user-typed text" },
      { code: buildCitationCode(EMBED_2), resultText: "old-2" },
    ]);
    const bridge = stubBridge(() => Promise.resolve({ ok: true, citation: "x" }));

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 2, skipped: 1, failed: 0 });
    expect(updated.map((u) => u.index)).toEqual([0, 2]); // index 1 never touched
    expect(fields[1]).toEqual({ code: CORRUPTED_CODE, resultText: "user-typed text" });
  });

  it("a bibliography field is not a 'skipped citation': healthy 2-citation + bibliography doc reports skipped:0", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: 'ADDIN notees.Bibliography {"styleId":"apa"}', resultText: "References…" },
      { code: buildCitationCode(EMBED_2), resultText: "old-2" },
    ]);
    const bridge = stubBridge(() => Promise.resolve({ ok: true, citation: "rendered" }));

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 2, skipped: 0, failed: 0 });
    expect(updated.map((u) => u.index)).toEqual([0, 2]); // the bibliography is never touched
    expect(fields[1].resultText).toBe("References…");
  });

  it("bridge ok:false for one embed reports failed:1, leaves that text unchanged, still refreshes the others", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: ZOTERO_CODE, resultText: "(Smith, 2020)" },
      { code: buildCitationCode(EMBED_2), resultText: "old-2" },
    ]);
    const bridge = stubBridge(({ styleId }) =>
      styleId === "chicago"
        ? Promise.resolve({ ok: false, error: { code: "unknown_style", message: "no such style" } })
        : Promise.resolve({ ok: true, citation: "rendered:apa" }),
    );

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 1, skipped: 1, failed: 1 });
    expect(fields[2].resultText).toBe("old-2"); // failed render: text preserved
    expect(fields[0].resultText).toBe("rendered:apa"); // per-field isolation
    expect(updated).toEqual([{ index: 0, text: "rendered:apa" }]);
  });

  it("bridge offline mid-run aborts remaining fields and reports completed counts", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: buildCitationCode({ ...EMBED_2, citationId: "c3" }), resultText: "old-2" },
      { code: buildCitationCode({ ...EMBED_2, citationId: "c4" }), resultText: "old-3" },
    ]);
    const render = vi.fn(
      ({ styleId }: { objectIds: string[]; styleId: string; locator?: string }): Promise<RenderResponse> =>
        styleId === "apa"
          ? Promise.resolve({ ok: true, citation: "rendered" })
          : Promise.reject(new BridgeOfflineError(new Error("ECONNREFUSED"))),
    );
    const bridge = stubBridge(render);

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 1, skipped: 0, failed: 0 });
    expect(render).toHaveBeenCalledTimes(2); // aborted before the third field
    expect(updated).toEqual([{ index: 0, text: "rendered" }]);
    expect(fields[1].resultText).toBe("old-2"); // unattempted fields untouched
    expect(fields[2].resultText).toBe("old-3");
  });

  it("an updateResultText rejection counts as failed and never aborts the other fields", async () => {
    const { access, fields, updated } = makeFieldsAccess([
      { code: buildCitationCode(EMBED_1), resultText: "old-1" },
      { code: buildCitationCode(EMBED_2), resultText: "old-2" },
    ]);
    const original = access.updateResultText;
    access.updateResultText = (index, text) =>
      index === 0 ? Promise.reject(new Error("host rejected field update")) : original(index, text);
    const bridge = stubBridge(() => Promise.resolve({ ok: true, citation: "rendered" }));

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 1, skipped: 0, failed: 1 });
    expect(fields[0].resultText).toBe("old-1");
    expect(fields[1].resultText).toBe("rendered");
    expect(updated).toEqual([{ index: 1, text: "rendered" }]);
  });

  it("never throws: a listFields failure reports a zero outcome and no renders happen", async () => {
    const access: WordFieldAccess = {
      listFields: () => Promise.reject(new Error("getOoxml rejected by host")),
      updateResultText: () => Promise.resolve(),
      updateCode: () => Promise.resolve(),
    };
    const render = vi.fn((): Promise<RenderResponse> => Promise.resolve({ ok: true, citation: "x" }));
    const bridge = stubBridge(render);

    const outcome = await refreshCitations(bridge, access);

    expect(outcome).toEqual({ refreshed: 0, skipped: 0, failed: 0 });
    expect(render).not.toHaveBeenCalled();
  });
});

describe("describeRefreshOutcome", () => {
  it("formats the pane summary", () => {
    const outcome: RefreshOutcome = { refreshed: 2, skipped: 1, failed: 3 };
    expect(describeRefreshOutcome(outcome)).toBe("2 refreshed · 1 skipped (foreign/corrupted) · 3 failed");
  });
});
