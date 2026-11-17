import { useCallback, useState, type FormEvent } from "react";
import type { Bridge, BridgeResult } from "../bridge/types";
import { citeErrorMessage, citeResult, type InsertCitationFn } from "../citation/cite";
import { insertCitationField } from "../word/document";
import { useSearch, type SearchError } from "./use-search";

export interface SearchPanelProps {
  bridge: Bridge;
  styleId: string;
  /** Injectable for tests — defaults to the real Word-host insert. */
  insertCitation?: InsertCitationFn;
  /**
   * Caller-owned citationId minting: a fresh id per insert, injected so tests
   * can pin it (duplicate citationIds would silently corrupt cite/refresh
   * pairing).
   */
  newCitationId?: () => string;
}

function subtitle(r: BridgeResult): string | null {
  const who = r.authors !== undefined && r.authors.length > 0 ? r.authors.join(", ") : null;
  const when = r.year !== undefined ? `(${String(r.year)})` : null;
  const text = [who, when].filter((p): p is string => p !== null).join(" ");
  return text === "" ? null : text;
}

function searchErrorMessage(error: SearchError): string {
  switch (error.kind) {
    case "offline":
      return "Bridge offline — is notees serve running?";
    case "shape":
      return `Bridge returned an unexpected payload: ${error.message}`;
    case "bridge":
      return `Search failed (${error.code}): ${error.message}`;
  }
}

export function SearchPanel({
  bridge,
  styleId,
  insertCitation = insertCitationField,
  newCitationId = () => crypto.randomUUID(),
}: SearchPanelProps) {
  // Stable per bridge: identity changes ONLY on a genuine re-pair. An inline
  // arrow here would be a new closure every render, defeating the engine's
  // same-identity check and cancelling the debounce on each keystroke.
  const searchFn = useCallback((q: string) => bridge.search(q), [bridge]);
  const search = useSearch(searchFn);
  const [citingId, setCitingId] = useState<string | null>(null);
  const [locator, setLocator] = useState("");
  const [citeError, setCiteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function startCite(r: BridgeResult) {
    setCitingId(r.objectId);
    setLocator("");
    setCiteError(null);
  }

  function cancelCite() {
    if (busy) return;
    setCitingId(null);
    setCiteError(null);
  }

  async function confirmCite(r: BridgeResult) {
    if (busy) return;
    setBusy(true);
    setCiteError(null);
    const outcome = await citeResult(
      {
        renderCitation: (objectIds, styleId, locator) =>
          bridge.renderCitation(objectIds, styleId, locator),
        insertCitation,
        newCitationId,
      },
      { objectId: r.objectId, styleId, locator },
    );
    if (outcome.ok) {
      setCitingId(null);
      setLocator("");
    } else {
      setCiteError(citeErrorMessage(outcome.error));
    }
    setBusy(false);
  }

  return (
    <section className="search-panel" aria-label="Search and cite">
      <input
        type="search"
        aria-label="Search your library"
        placeholder="Search your library…"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
      />
      {search.state === "loading" && <p className="pane-placeholder">Searching…</p>}
      {search.state === "error" && search.error !== null && (
        <p className="form-error" role="alert">{searchErrorMessage(search.error)}</p>
      )}
      {citeError !== null && (
        <p className="form-error" role="alert">{citeError}</p>
      )}
      {search.state === "results" && search.results.length === 0 && (
        <p className="pane-placeholder">No results.</p>
      )}
      {search.state === "results" && search.results.length > 0 && (
        <ul className="result-list">
          {search.results.map((r) => {
            const sub = subtitle(r);
            return (
              <li className="result-row" key={r.objectId}>
                <div className="result-main">
                  <span className="result-title">{r.title}</span>
                  {sub !== null && <span className="result-sub">{sub}</span>}
                  {r.citekey !== undefined && <code>{r.citekey}</code>}
                </div>
                {citingId === r.objectId ? (
                  <form
                    className="cite-form"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void confirmCite(r);
                    }}
                  >
                    <input
                      aria-label="Locator"
                      placeholder="locator, e.g. p. 12"
                      value={locator}
                      onChange={(e) => setLocator(e.target.value)}
                      disabled={busy}
                    />
                    <button type="submit" className="primary" disabled={busy}>
                      {busy ? "Inserting…" : "Insert"}
                    </button>
                    <button type="button" className="secondary" onClick={cancelCite} disabled={busy}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button type="button" className="cite-button" onClick={() => startCite(r)}>
                    Cite
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
