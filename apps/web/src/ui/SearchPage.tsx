/**
 * SearchPage — the full-page search surface (the Capacities "Extended
 * Search" parity slice) at the /search route. Where the command palette's
 * Content group is an eight-row teaser, this page is the whole answer:
 * the cursor-paginated ranked FTS stream (client.searchPage), one
 * NodeResultItem row per hit — icon, name, class pills, the
 * containing-page breadcrumb (the NodeSelector helpers) — plus a
 * match-context excerpt line under each row (client.getSearchSnippet,
 * the palette's mark rendering over the shared nt-search-* styles).
 *
 * Filters: scope Tabs (All / Main / Blocks) narrow the display by render
 * state (classes ride Main — the NodeSelector scope-tab ruling), and a
 * kit Dropdown populated from client.listClasses() narrows it to one
 * class's members. Both filter the accumulated stream client-side; the
 * "Show more results" button keeps paginating the underlying query with
 * the returned cursor until it reads null.
 *
 * Query modes (the ranked search's own grammar, surfaced in the empty
 * state): "…" quotes switch to the exact phrase, ^ prefixes to
 * starts-with. Row clicks open the node through the host's navigation
 * funnel (the App-level openPage).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { rendersAsInlineBlock, rendersWithDocumentChrome } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, SearchSnippetData, WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameForSettings } from "./dateDisplay.js";
import { NodeResultItem } from "./components/pickers/NodeResultItem.js";
import { Button } from "./components/ui/Button.js";
import { Dropdown } from "./components/ui/Dropdown.js";
import { SearchField } from "./components/ui/SearchField.js";
import { Tabs } from "./components/ui/Tabs.js";
import "./SearchPage.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Results per searchPage page (the load-more slice size). */
const PAGE_SIZE = 25;
/** Input debounce — the CommandPalette Content group's cadence. */
const DEBOUNCE_MS = 150;

type Scope = "all" | "main" | "blocks";

/** Snippet excerpt with the match spans highlighted (the shared nt-search-* styles). */
function SnippetText({ snippet }: { snippet: SearchSnippetData }) {
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

export function SearchPage({
  client,
  onOpenNode,
  initialQuery = "",
}: {
  client: AnyClient;
  /** The App-level open funnel (alias resolution + URL + recents). */
  onOpenNode: (nodeId: string) => void;
  /** Pre-filled query (the palette's "Search all for …" handoff, via ?q=). */
  initialQuery?: string;
}) {
  const [input, setInput] = useState(initialQuery);
  /** Debounced query the stream actually answers. */
  const [query, setQuery] = useState(initialQuery);
  /** The accumulated hit stream (unfiltered — the filters are display-side). */
  const [hits, setHits] = useState<ClientNode[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  /** Class filter: null = any class (the dropdown's "Any class" row). */
  const [classFilter, setClassFilter] = useState<string | null>(null);
  /** Stale-page guard: only the latest debounced fetch may commit. */
  const generation = useRef(0);

  // Debounce the input onto the query the stream answers (the palette cadence).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // (Re)run the stream whenever the answered query changes: page one
  // replaces the accumulated list; a generation counter drops responses
  // whose query has already been superseded.
  useEffect(() => {
    const mine = ++generation.current;
    if (query === "") {
      setHits([]);
      setNextCursor(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.resolve(client.searchPage(query, { limit: PAGE_SIZE }))
      .then((page) => {
        if (generation.current !== mine) return;
        setHits(page.nodes);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        if (generation.current === mine) setHits([]);
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  }, [query, client]);

  const showMore = (): void => {
    if (nextCursor === null || loading) return;
    const mine = generation.current;
    setLoading(true);
    Promise.resolve(client.searchPage(query, { limit: PAGE_SIZE, cursor: nextCursor }))
      .then((page) => {
        if (generation.current !== mine) return;
        setHits((prev) => [...prev, ...page.nodes]);
        setNextCursor(page.nextCursor);
      })
      .finally(() => {
        if (generation.current === mine) setLoading(false);
      });
  };

  // Display filters over the accumulated stream. Scope: classes count as
  // Main (the render-state model's is_class branch); Blocks keeps only
  // parented non-class children with the render bit unset.
  const visible = useMemo(
    () =>
      hits.filter((node) => {
        if (scope === "main" && !(node.isClass || rendersWithDocumentChrome(node))) return false;
        if (scope === "blocks" && !rendersAsInlineBlock(node)) return false;
        if (classFilter !== null && !node.classIds.includes(classFilter)) return false;
        return true;
      }),
    [hits, scope, classFilter],
  );

  /**
   * The load-more button: rendered whenever the stream cursor reads
   * non-null — including when the display filters emptied the current
   * page (the next page may still carry matches; the filters are
   * display-side, the cursor paginates the raw query).
   */
  const showMoreButton =
    nextCursor !== null ? (
      <Button
        variant="ghost"
        className="search-page__show-more"
        disabled={loading}
        onClick={showMore}
      >
        Show more results
      </Button>
    ) : null;

  const classOptions = useMemo(() => {
    const classes = client.listClasses().map((cls) => ({
      value: cls.id,
      label: displayNameForSettings(cls) || "Untitled class",
    }));
    return [{ value: "", label: "Any class" }, ...classes];
  }, [client]);

  // Build parent page path (e.g. "Root / Parent /") for a document-chrome
  // node — the NodeSelector breadcrumb helper, verbatim.
  const buildParentPath = (node: ClientNode): string => {
    if (node.parentId === null) return "";
    const segments: string[] = [];
    let currentId: string | null = node.parentId;
    let guard = 0;
    while (currentId !== null && guard < 64) {
      const parent: ClientNode | undefined = client.getNode(currentId);
      if (!parent || !rendersWithDocumentChrome(parent)) break;
      segments.unshift(displayNameForSettings(parent) || "Untitled");
      currentId = parent.parentId;
      guard += 1;
    }
    if (segments.length === 0) return "";
    const fullPath = segments.join(" / ") + " /";
    if (fullPath.length <= 36) return fullPath;
    const parts = [...segments];
    while (parts.length > 1) {
      parts.shift();
      const candidate = ".../ " + parts.join(" / ") + " /";
      if (candidate.length <= 36) return candidate;
    }
    const last = parts[0]!;
    return ".../ " + (last.length > 26 ? last.slice(0, 23) + "..." : last) + " /";
  };

  // Containing-page breadcrumb for a block hit: the nearest
  // document-chrome ancestor's path plus the page itself.
  const buildContainingPagePath = (node: ClientNode): string => {
    let currentId = node.parentId;
    let guard = 0;
    while (currentId !== null && guard < 64) {
      const parent = client.getNode(currentId);
      if (parent === undefined) break;
      if (rendersWithDocumentChrome(parent)) {
        const ancestors = buildParentPath(parent);
        const name = displayNameForSettings(parent) || "Untitled";
        return ancestors !== "" ? `${ancestors} ${name}` : name;
      }
      currentId = parent.parentId;
      guard += 1;
    }
    return "";
  };

  // Get display classes for a node (class names as small pills).
  const getDisplayClasses = (node: ClientNode): Array<{ nodeUuid: string; name: string }> => {
    if (node.classIds.length === 0) return [];
    return node.classIds
      .map((classUuid) => {
        const classNode = client.getNode(classUuid);
        if (!classNode) return null;
        const name = displayNameForSettings(classNode);
        if (!name) return null;
        return { nodeUuid: classUuid, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
  };

  return (
    <div className="nt-hub search-page">
      <header className="nt-hub-header">
        <h1 className="nt-hub-title">Search</h1>
      </header>
      <SearchField
        autoFocus
        value={input}
        placeholder="Search everything… (“…” exact, ^ prefix)"
        aria-label="Search everything"
        onChange={(event) => setInput(event.target.value)}
        onClear={() => setInput("")}
      />
      <div className="search-page__filters">
        <Tabs
          value={scope}
          onChange={(next) => setScope(next as Scope)}
          className="search-page__scope-tabs"
        >
          <Tabs.List variant="ghost" className="search-page__scope-tablist">
            <Tabs.Tab value="all">All</Tabs.Tab>
            <Tabs.Tab value="main">Main</Tabs.Tab>
            <Tabs.Tab value="blocks">Blocks</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value={scope}>
            <div className="search-page__results" aria-label="Search results">
              {query === "" ? (
                <div className="search-page__hint">
                  Type to search the whole workspace. Query modes: "…" quotes match the exact
                  phrase; a ^ prefix matches titles that start with the rest.
                </div>
              ) : visible.length === 0 && !loading ? (
                <>
                  <div className="search-page__empty">No matches found</div>
                  {showMoreButton}
                </>
              ) : (
                <>
                  {visible.map((node) => {
                    const snippet =
                      query === "" ? null : client.getSearchSnippet(node.id, query);
                    return (
                      <div className="search-page__result" key={node.id}>
                        <NodeResultItem
                          node={node}
                          parentPath={
                            rendersWithDocumentChrome(node)
                              ? buildParentPath(node)
                              : buildContainingPagePath(node)
                          }
                          displayClasses={getDisplayClasses(node)}
                          onClick={() => onOpenNode(node.id)}
                        />
                        {snippet !== null && (
                          <div className="search-page__snippet">
                            <SnippetText snippet={snippet} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {showMoreButton}
                </>
              )}
              {query !== "" && loading && (
                <div className="search-page__loading">Searching…</div>
              )}
            </div>
          </Tabs.Panel>
        </Tabs>
        <Dropdown
          className="search-page__class-filter"
          ariaLabel="Filter by class"
          options={classOptions}
          value={classFilter ?? ""}
          onChange={(value) => setClassFilter(value === "" ? null : value)}
        />
      </div>
    </div>
  );
}
