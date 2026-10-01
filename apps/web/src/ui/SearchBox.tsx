/**
 * SearchBox — the workspace search field (sidebar).
 *
 * Two paths, one input:
 *  - plain text → client.search (FTS), as before;
 *  - query-language syntax (class:, prop:, type:, text:, linked:, "phrases",
 *    AND/OR/NOT — see looksLikeQueryLanguage) → parsed with name resolvers
 *    over the local store (classes / property schemas / node names) and run
 *    through the live-query bridge (client.runQueryAst).
 *
 * DSL parse/resolution errors surface inline (fail loud — never silently
 * degraded to a text search). A "?" toggle shows the grammar cheatsheet.
 */

import { useEffect, useRef, useState } from "react";

import { looksLikeQueryLanguage, parseQueryLanguage } from "@notees/query";

import type { ClientNode, QueryRunResult, WorkspaceClient } from "@/core/workspace-client.js";
import { displayNameForSettings } from "./dateDisplay.js";
import type { WorkerClient } from "@/core/worker-client.js";

type AnyClient = WorkspaceClient | WorkerClient;

interface Hit {
  id: string;
  name: string | null;
  nodeType: string;
}

type SearchState =
  | { kind: "idle" }
  | { kind: "ready"; hits: Hit[] }
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
      // Pages and classes first (exact display names), then an FTS pass for
      // blocks and any node the lists do not cover.
      const fromLists = byName(name, [...client.listPages(), ...client.listClasses()]);
      return fromLists ?? byName(name, client.search(name));
    },
  };
}

function toHitsFromText(nodes: ClientNode[]): Hit[] {
  return nodes.map((node) => ({
    id: node.id,
    name: displayNameForSettings(node) || "Untitled",
    nodeType: node.nodeType,
  }));
}

function toHitsFromQuery(rows: QueryRunResult["rows"]): Hit[] {
  return rows.map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType }));
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
  /** Monotonic counter: the newest keystroke wins the async runQueryAst race. */
  const generation = useRef(0);

  useEffect(() => {
    const text = input.trim();
    if (text === "") {
      setState({ kind: "idle" });
      return;
    }
    if (!looksLikeQueryLanguage(text)) {
      setState({ kind: "ready", hits: toHitsFromText(client.search(text)) });
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
        if (generation.current === mine) setState({ kind: "ready", hits: toHitsFromQuery(result.rows) });
      })
      .catch((error: unknown) => {
        if (generation.current === mine) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    // cacheVersion: cached reads resolve asynchronously after their seed;
    // re-run when the cache refreshes so results never freeze at the seed.
  }, [input, client, cacheVersion]);

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
          <code>class:Name</code> · <code>type:page|block|class</code> · <code>prop:name:op value</code> (
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
          {state.hits.map((hit) => (
            <li key={hit.id}>
              <button type="button" className="nt-search-hit" onClick={() => onOpenNode(hit.id)}>
                <span className="nt-query-item-name">{hit.name ?? "Untitled"}</span>
                <span className="nt-query-chip">{hit.nodeType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
