import { describe, expect, it, vi } from "vitest";
import { BridgeOfflineError, BridgeShapeError } from "../src/bridge/client";
import type { BridgeResponse } from "../src/bridge/types";
import { citeErrorMessage, citeResult, type CiteDeps, type InsertCitationFn } from "../src/citation/cite";
import type { CitationEmbed } from "../src/citation/embed";

type RenderResponse = BridgeResponse<{ citation: string }>;

function okRender(citation: string): Promise<RenderResponse> {
  return Promise.resolve({ ok: true, citation });
}

/** A deps bag that records every seam call; override per test as needed. */
function makeDeps(overrides: Partial<CiteDeps> = {}) {
  const inserted: Array<{ embed: CitationEmbed; displayText: string }> = [];
  const deps: CiteDeps = {
    renderCitation: () => okRender("(Doe, 2024)"),
    insertCitation: ((embed, displayText) => {
      inserted.push({ embed, displayText });
      return Promise.resolve();
    }) as InsertCitationFn,
    newCitationId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `cite-${String(n)}`;
      };
    })(),
    ...overrides,
  };
  return { deps, inserted };
}

const target = { objectId: "node-1", styleId: "apa" };

describe("citeResult (injected seams)", () => {
  it("renders, mints once, and inserts a citation field with the rendered text", async () => {
    const { deps, inserted } = makeDeps();
    const outcome = await citeResult(deps, { ...target, locator: "p. 12" });
    expect(outcome).toEqual({ ok: true });
    expect(inserted).toEqual([
      {
        embed: { citationId: "cite-1", nodeIds: ["node-1"], styleId: "apa", locator: "p. 12" },
        displayText: "(Doe, 2024)",
      },
    ]);
  });

  it("mints a DIFFERENT citationId for each cite of the same result", async () => {
    const { deps, inserted } = makeDeps();
    await citeResult(deps, target);
    await citeResult(deps, target);
    expect(inserted).toHaveLength(2);
    expect(inserted[0].embed.citationId).not.toBe(inserted[1].embed.citationId);
  });

  it("returns an error outcome (never a silent success) on ok:false render-citation", async () => {
    const { deps, inserted } = makeDeps({
      renderCitation: () => Promise.resolve({ ok: false, error: { code: "unknown_style", message: "no such style" } }),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: "bridge", code: "unknown_style", message: "no such style" },
    });
    expect(inserted).toHaveLength(0);
  });

  it("classifies the synthetic { code: 'shape' } render outcome as a shape error", async () => {
    const { deps } = makeDeps({
      renderCitation: () => Promise.resolve({ ok: false, error: { code: "shape", message: "citation not a string" } }),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome).toEqual({ ok: false, error: { kind: "shape", message: "citation not a string" } });
  });

  it("maps a thrown BridgeOfflineError to the offline error", async () => {
    const { deps, inserted } = makeDeps({
      renderCitation: () => Promise.reject(new BridgeOfflineError(new Error("ECONNREFUSED"))),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome).toEqual({ ok: false, error: { kind: "offline" } });
    expect(inserted).toHaveLength(0);
  });

  it("maps any other thrown render error to a classified error, not a rejection", async () => {
    const { deps } = makeDeps({
      renderCitation: () => Promise.reject(new BridgeShapeError("missing ok flag")),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome).toEqual({ ok: false, error: { kind: "shape", message: "missing ok flag" } });
  });

  it("surfaces a host insert rejection as an insert error", async () => {
    const { deps } = makeDeps({
      insertCitation: () => Promise.reject(new Error("Word host rejected the insert.")),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome).toEqual({ ok: false, error: { kind: "insert", message: "Word host rejected the insert." } });
  });

  it("normalizes a blank locator to undefined and passes a set one through", async () => {
    const { deps, inserted } = makeDeps();
    await citeResult(deps, { ...target, locator: "   " });
    expect(inserted[0].embed.locator).toBeUndefined();

    await citeResult(deps, { ...target, locator: "  p. 7 " });
    expect(inserted[1].embed.locator).toBe("p. 7");
  });

  it("does not mint a citationId when the render fails", async () => {
    const mint = vi.fn(() => "cite-x");
    const { deps, inserted } = makeDeps({
      newCitationId: mint,
      renderCitation: () => Promise.resolve({ ok: false, error: { code: "not_found", message: "gone" } }),
    });
    const outcome = await citeResult(deps, target);
    expect(outcome.ok).toBe(false);
    expect(mint).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });
});

describe("citeErrorMessage", () => {
  it("covers every error kind", () => {
    expect(citeErrorMessage({ kind: "offline" })).toContain("offline");
    expect(citeErrorMessage({ kind: "shape", message: "x" })).toContain("unexpected payload");
    expect(citeErrorMessage({ kind: "bridge", code: "c", message: "m" })).toContain("c");
    expect(citeErrorMessage({ kind: "insert", message: "host said no" })).toBe("host said no");
  });
});
