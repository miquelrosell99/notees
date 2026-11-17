import browser from "webextension-polyfill";
import { CaptureIdentifiers } from "../shared/capture-types";

/**
 * Normalizes "doi:10.1234/foo", "https://doi.org/10.1234/foo",
 * "http://dx.doi.org/10.1234/foo", or a bare "10.1234/foo" to "10.1234/foo".
 * Returns null when the value is not DOI-shaped (e.g. an ISBN in dc.identifier).
 */
export function normalizeDoi(raw: string): string | null {
  const withPrefix = raw.match(/(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\S+)/i);
  if (withPrefix) return withPrefix[1].replace(/[.;,]+$/, "");
  const bare = raw.match(/^(10\.\d{4,9}\/\S+)$/i);
  return bare ? bare[1].replace(/[.;,]+$/, "") : null;
}

/**
 * Self-contained page-side extractor. Runs via executeScript code-string:
 * it must not reference anything outside its own body (no imports, no closures).
 */
export function extractInPage(): { doi?: string; isbn?: string } {
  const contentOf = (names: string[]): string | null => {
    for (const name of names) {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      const content = el?.getAttribute("content")?.trim();
      if (content) return content;
    }
    return null;
  };
  const stripDoi = (raw: string): string | null => {
    const withPrefix = raw.match(/(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\S+)/i);
    if (withPrefix) return withPrefix[1].replace(/[.;,]+$/, "");
    const bare = raw.match(/^(10\.\d{4,9}\/\S+)$/i);
    return bare ? bare[1].replace(/[.;,]+$/, "") : null;
  };
  const out: { doi?: string; isbn?: string } = {};
  const doiRaw = contentOf(["citation_doi", "dc.identifier", "DC.Identifier", "prism.doi"]);
  if (doiRaw) {
    const doi = stripDoi(doiRaw);
    if (doi) out.doi = doi;
  }
  const isbn = contentOf(["citation_isbn"]);
  if (isbn) out.isbn = isbn;
  // dc.identifier can be ISBN-typed ("urn:isbn:…", bare 10/13-digit, hyphenated)
  else if (!out.doi) {
    const dcRaw = contentOf(["dc.identifier", "DC.Identifier"]);
    const compact = dcRaw?.replace(/[- ]/g, "");
    const m = compact?.match(/^(?:urn:isbn:)?(\d{9}[\dXx]|\d{13})$/i);
    if (m) out.isbn = m[1];
  }
  return out;
}

/** Runs the extractor in the tab; any failure (absent meta, restricted page) → {}. */
export async function extractIdentifiers(tabId: number): Promise<CaptureIdentifiers> {
  try {
    const results = (await browser.tabs.executeScript(tabId, {
      code: `(${extractInPage.toString()})()`,
    })) as { doi?: string; isbn?: string }[] | undefined;
    return results?.[0] ?? {};
  } catch {
    return {}; // Review Focus #4: absent DOI must never fail the capture
  }
}
