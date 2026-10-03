/**
 * SearchBox — the workspace search field (sidebar).
 *
 * Two paths, one input:
 *  - plain text → ranked FTS (client.search first page, cursor-paginated
 *    "Load more" via client.searchPage — §34.30 C5); each hit renders the
 *    M3 match-context snippet (client.getSearchSnippet) with highlighted
 *    spans;
 *  - query-language syntax (class:, prop:, isClass:/presentAsMain:, text:,
 *    linked:, "phrases", AND/OR/NOT — see looksLikeQueryLanguage) → parsed
 *    with name resolvers over the local store (classes / property schemas /
 *    node names) and run through the live-query bridge (client.runQueryAst).
 *
 * DSL parse/resolution errors surface inline (fail loud — never silently
 * degraded to a text search). A "?" toggle shows the grammar cheatsheet.
 * Result clicks navigate via onOpenNode.
 */

import { useEffect, useRef, useState } from "react";

import { looksLikeQueryLanguage, parseQueryLanguage } from "@notees/query";

import type {
  ClientNode,
  QueryRunResult,
  SearchSnippetData,
  WorkspaceClient,
} from "@/core/workspace-client.js";
import { displayNameForSettings } from "./dateDisplay.js";
import { renderStateLabel } from "./renderStateLabel.js";
import type { WorkerClient } from "@/core/worker-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** First-page size for the plain-text path (the store's default limit). */
const SEARCH_PAGE_SIZE = 50;

interface Hit {
  id: string;
  name: string | null;
  /** Revision-11 render-state booleans — the chip derives Page/Block/Class. */
  isClass: boolean;
  presentAsMain: boolean;
  parentId: string | null;
}

type SearchState =
  | { kind: "idle" }
  | { kind: "ready"; query: string; hits: Hit[]; nextCursor: string | null }
  | { kind: "error"; message: string };

/** Name resolvers over the local store (both client classes satisfy this surface). */
function makeResolvers(client: AnyClient) {
  // Title-is-content: match against the derived display name (the node's
  // content), never the retired name column.
  const byName = (name: string, pool: ClientNode[]) => {
    const wanted = name.toLowerCase();
    return pool.find((node) => displayNameForSettings(node).toLowerCase() === wanted)?.id;
  };
  return {
    resolveClass: (name: string) => byName(name, client.listClasses()),
    resolvePropertySchema: (name: string) =>
      client.listPropertySchemas().find((schema) => schema.name.toLowerCase() === name.toLowerCase())?.id,
    resolveNode: (name: string) => {
      // Pages and classes first (exact display names), then the ranked FTS
      // pass for blocks and any node the lists do not cover (§34.30 C6).
      const fromLists = byName(name, [...client.listPages(), ...client.listClasses()]);
      return fromLists ?? client.resolveNodeByName(name) ?? undefined;
    },
  };
}

function toHitsFromText(nodes: ClientNode[]): Hit[] {
  return nodes.map((node) => ({
    id: node.id,
    name: displayNameForSettings(node) || "Untitled",
    isClass: node.isClass,
    presentAsMain: node.presentAsMain,
    parentId: node.parentId,
  }));
}

function toHitsFromQuery(rows: QueryRunResult["rows"]): Hit[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isClass: row.isClass,
    presentAsMain: row.presentAsMain,
    parentId: row.parentId,
  }));
}

/** Snippet excerpt with the match spans highlighted. */
function SnippetLine({ snippet }: { snippet: SearchSnippetData }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  snippet.matches.forEach((match, index) => {
    if (match.start > cursor) parts.push(snippet.text.slice(cursor, match.start));
    parts.push(
      <mark key={index} className="nt-search-mark">
        {snippet.text.slice(match.start, match.start + match.length)}
      </mark>,
    );
    cursor = match.start + match.length;
  });
  if (cursor < snippet.text.length) parts.push(snippet.text.slice(cursor));
  return <span className="nt-search-snippet">{parts}</span>;
}

export function SearchBox({
  client,
  onOpenNode,
  cacheVersion,
}: {
  client: AnyClient;
  onOpenNode: (nodeId: string) => void;
  /**
   * Bumped by the App on every client notification. Cached reads (search
   * included) resolve asynchronously after the seed value, so the effect must
   * re-run when the cache refreshes — otherwise a search typed before the
   * worker answers stays at its seeded "No results." forever.
   */
  cacheVersion: number;
}) {
  const [input, setInput] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [showSyntax, setShowSyntax] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Monotonic counter: the newest keystroke wins the async runQueryAst race. */
  const generation = useRef(0);

  useEffect(() => {
    const text = input.trim();
    if (text === "") {
      setState({ kind: "idle" });
      return;
    }
    if (!looksLikeQueryLanguage(text)) {
      const hits = toHitsFromText(client.search(text, SEARCH_PAGE_SIZE));
      // A full first page means there MAY be more (the sync read carries no
      // cursor); the load-more click resolves the real nextCursor, and one
      // possibly-empty trailing page is the honest cost of that ambiguity.
      setState({
        kind: "ready",
        query: text,
        hits,
        nextCursor: hits.length >= SEARCH_PAGE_SIZE ? String(SEARCH_PAGE_SIZE) : null,
      });
      return;
    }
    const mine = ++generation.current;
    let ast;
    try {
      ast = parseQueryLanguage(text, { resolvers: makeResolvers(client) });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    Promise.resolve(client.runQueryAst(ast))
      .then((result) => {
        if (generation.current === mine) {
          setState({ kind: "ready", query: text, hits: toHitsFromQuery(result.rows), nextCursor: null });
        }
      })
      .catch((error: unknown) => {
        if (generation.current === mine) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    // cacheVersion: cached reads resolve asynchronously after their seed;
    // re-run when the cache refreshes so results never freeze at the seed.
  }, [input, client, cacheVersion]);

  const loadMore = () => {
    if (state.kind !== "ready" || state.nextCursor === null) return;
    const text = state.query;
    const cursor = state.nextCursor;
    setLoadingMore(true);
    Promise.resolve(client.searchPage(text, { limit: SEARCH_PAGE_SIZE, cursor }))
      .then((page) => {
        // Drop a stale page when the query changed while the fetch flew.
        setState((current) =>
          current.kind === "ready" && current.query === text
            ? {
                kind: "ready",
                query: text,
                hits: [...current.hits, ...toHitsFromText(page.nodes)],
                nextCursor: page.nextCursor,
              }
            : current,
        );
      })
      .catch(() => {
        // Keep the current page; the next keystroke/refresh retries.
      })
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="nt-search">
      <div className="nt-search-row">
        <input
          className="nt-search-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search… (class:, prop:, text:)"
          aria-label="Search"
        />
        <button
          type="button"
          className="nt-search-syntax"
          aria-label="Search syntax"
          aria-expanded={showSyntax}
          onClick={() => setShowSyntax((visible) => !visible)}
        >
          ?
        </button>
      </div>
      {showSyntax && (
        <div className="nt-search-help">
          <code>class:Name</code> · <code>isClass:true|false</code> · <code>presentAsMain:true|false</code> ·{" "}
          <code>prop:name:op value</code> (
          <code>:=</code> <code>!=</code> <code>:&gt;</code> <code>:&gt;=</code> <code>:&lt;</code> <code>:&lt;=</code>;
          bare <code>:</code> contains; no value = exists) · <code>year:&gt;2010</code> (bare schema) ·{" "}
          <code>text:term</code> · <code>&quot;quoted phrase&quot;</code> · <code>linked:Name</code> ·{" "}
          <code>AND OR NOT</code> and <code>( )</code>
        </div>
      )}
      {state.kind === "error" && (
        <p className="nt-search-error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && (
        <ul className="nt-search-results">
          {state.hits.length === 0 && <li className="nt-search-empty">No results.</li>}
          {state.hits.map((hit) => {
            // Snippet: plain-text path only (the DSL runs through the query
            // bridge, which has no single snippet-able search string). The
            // worker client seeds null and converges on cacheVersion.
            const snippet =
              !looksLikeQueryLanguage(state.query) && state.query.trim() !== ""
                ? client.getSearchSnippet(hit.id, state.query)
                : null;
            return (
              <li key={hit.id}>
                <button type="button" className="nt-search-hit" onClick={() => onOpenNode(hit.id)}>
                  <span className="nt-search-hit-top">
                    <span className="nt-query-item-name">{hit.name ?? "Untitled"}</span>
                    <span className="nt-query-chip">{renderStateLabel(hit)}</span>
                  </span>
                  {snippet !== null && <SnippetLine snippet={snippet} />}
                </button>
              </li>
            );
          })}
          {state.nextCursor !== null && (
            <li>
              <button
                type="button"
                className="nt-search-more"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? "Loading…" : "Load more results"}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
