// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractInPage, normalizeDoi } from "../../src/capture/extract-in-page";

describe("normalizeDoi", () => {
  it.each([
    ["10.1234/foo.bar", "10.1234/foo.bar"],
    ["doi:10.1234/foo.bar", "10.1234/foo.bar"],
    ["https://doi.org/10.1234/foo.bar", "10.1234/foo.bar"],
    ["http://dx.doi.org/10.1234/foo.bar.", "10.1234/foo.bar"],
  ])("%s → %s", (raw, expected) => expect(normalizeDoi(raw)).toBe(expected));
  it.each([["9780123456789"], ["urn:isbn:9780123456789"], ["not-a-doi"]])("%s → null", (raw) =>
    expect(normalizeDoi(raw)).toBeNull(),
  );
});

describe("extractInPage", () => {
  it("reads citation_doi", () => {
    document.head.innerHTML = `<meta name="citation_doi" content="doi:10.1234/foo">`;
    expect(extractInPage()).toEqual({ doi: "10.1234/foo" });
  });
  it("falls back to dc.identifier when citation_doi is absent", () => {
    document.head.innerHTML = `<meta name="dc.identifier" content="https://doi.org/10.5555/abc">`;
    expect(extractInPage()).toEqual({ doi: "10.5555/abc" });
  });
  it("ignores non-DOI, non-ISBN dc.identifier values and collects citation_isbn", () => {
    document.head.innerHTML = `
      <meta name="dc.identifier" content="pmid:12345678">
      <meta name="citation_isbn" content="9780123456786">`;
    expect(extractInPage()).toEqual({ isbn: "9780123456786" });
  });
  it.each([
    ["urn:isbn:9780123456789", "9780123456789"],
    ["9780123456789", "9780123456789"],
    ["0-13-468599-7", "0134685997"],
  ])("harvests ISBN-typed dc.identifier %s", (raw, expected) => {
    document.head.innerHTML = `<meta name="dc.identifier" content="${raw}">`;
    expect(extractInPage()).toEqual({ isbn: expected });
  });
  it("returns {} when no meta tags exist", () => {
    document.head.innerHTML = "";
    expect(extractInPage()).toEqual({});
  });
  // Pin the executeScript contract: this function is stringified into a page
  // via `(${extractInPage.toString()})()` — it must not reference module scope.
  // The DOI regex is deliberately duplicated inside extractInPage (it may not
  // call normalizeDoi, which lives in module scope); keep that duplication.
  it("is self-contained when stringified (no imports/closures)", () => {
    const src = extractInPage.toString();
    expect(src).not.toMatch(/\bimport\b|\brequire\b|\bexport\b|__vite/);
  });
  it("evaluates standalone in a fresh jsdom when stringified", () => {
    document.head.innerHTML = `<meta name="citation_doi" content="doi:10.9999/x">`;
    const fn = new Function(`return (${extractInPage.toString()})()`)() as unknown;
    expect(fn).toEqual({ doi: "10.9999/x" });
  });
});
