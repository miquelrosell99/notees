/**
 * Sources hub shell tests (task 1 — route, shell, sidebar entry):
 *
 * - Routing (law 9 — /sources owns its URL AND its tab title): the path
 *   maps to the "sources" nav key, the nav key round-trips through
 *   /sources, the popstate handler lands the hub, and the tab-title
 *   register names it "Sources - Notees".
 * - The URL-state helpers (sourcesQuery.ts): ?type=<classKey>&q=<search>&
 *   sort=<field>:<dir> parses and serializes both ways, with invalid
 *   sorts rejected outright.
 * - The sidebar entry: a "Sources" row with the bookshelf icon, placed
 *   between Tasks and Assets in the navigation order.
 * - The shell: three honest empty-state panes — facets "No source types",
 *   the table's Add-your-first-source hint + Add-source button, and the
 *   detail pane's "Select a source".
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { Sidebar } from "../src/ui/app/Sidebar.js";
import { navFromPath, pathForNav, popStateNavHandler, tabTitle } from "../src/ui/app/routing.js";
import {
  DEFAULT_SOURCES_QUERY,
  parseSourcesQuery,
  sourcesPathFor,
} from "../src/features/sources/sourcesQuery.js";
import { SourcesHub } from "../src/features/sources/SourcesHub.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

describe("the /sources route (law 9 — the hub owns its URL)", () => {
  it("maps /sources to the sources nav key and round-trips", () => {
    expect(navFromPath("/sources")).toBe("sources");
    expect(navFromPath("/sources/")).toBe("sources");
    expect(navFromPath(pathForNav("sources"))).toBe("sources");
  });

  it("the popstate handler lands the hub: nav set, selection cleared", () => {
    const setNav = vi.fn();
    const setNode = vi.fn();
    const closeManager = vi.fn();
    const onNavigated = vi.fn();
    const handler = popStateNavHandler({
      openManager: () => {},
      closeManager,
      setNav,
      setNode,
      setSettingsSection: () => {},
      onNavigated,
    });
    window.history.pushState({}, "", "/sources?type=book&q=smith&sort=year:desc");
    handler();
    expect(closeManager).toHaveBeenCalled();
    expect(setNav).toHaveBeenCalledWith("sources");
    expect(setNode).toHaveBeenCalledWith(null);
    // The query string survives the navigation (the hub parses it itself).
    expect(onNavigated).toHaveBeenCalledWith("/sources?type=book&q=smith&sort=year:desc");
  });

  it("names the tab 'Sources - Notees' through the title register", () => {
    expect(
      tabTitle({
        clientPresent: true,
        selectedPageId: null,
        settingsSection: null,
        searchOpen: false,
        activeNav: "sources",
        nodeName: "",
      }),
    ).toBe("Sources - Notees");
  });
});

describe("sourcesQuery — the /sources URL state", () => {
  it("parses the bare path to the defaults", () => {
    expect(parseSourcesQuery("")).toEqual(DEFAULT_SOURCES_QUERY);
    expect(parseSourcesQuery("?")).toEqual(DEFAULT_SOURCES_QUERY);
    // Unknown params are not ours — ignored.
    expect(parseSourcesQuery("?foo=bar")).toEqual(DEFAULT_SOURCES_QUERY);
  });

  it("parses type, q, and sort together", () => {
    expect(parseSourcesQuery("?type=journal_article&q=smith&sort=year:desc")).toEqual({
      type: "journal_article",
      q: "smith",
      sort: { field: "year", direction: "desc" },
    });
  });

  it("accepts every sortable field, both directions", () => {
    for (const field of ["title", "authors", "year", "venue", "citekey"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        expect(parseSourcesQuery(`?sort=${field}:${direction}`).sort).toEqual({
          field,
          direction,
        });
      }
    }
  });

  it("rejects invalid sorts outright (unknown field, bad direction, malformed)", () => {
    expect(parseSourcesQuery("?sort=bogus:asc").sort).toBeNull();
    expect(parseSourcesQuery("?sort=year:sideways").sort).toBeNull();
    expect(parseSourcesQuery("?sort=year").sort).toBeNull();
    expect(parseSourcesQuery("?sort=").sort).toBeNull();
  });

  it("treats an empty type as absent", () => {
    expect(parseSourcesQuery("?type=").type).toBeNull();
  });

  it("serializes the defaults to the bare path", () => {
    expect(sourcesPathFor(DEFAULT_SOURCES_QUERY)).toBe("/sources");
    expect(sourcesPathFor({ type: null, q: "", sort: null })).toBe("/sources");
  });

  it("round-trips through parse → serialize → parse", () => {
    const search = "?type=book_section&q=smith+%26+wesson&sort=venue:asc";
    expect(sourcesPathFor(parseSourcesQuery(search))).toBe(`/sources${search}`);
    expect(parseSourcesQuery(sourcesPathFor(parseSourcesQuery(search)))).toEqual({
      type: "book_section",
      q: "smith & wesson",
      sort: { field: "venue", direction: "asc" },
    });
  });
});

describe("sidebar — the Sources entry", () => {
  it("renders the row with the bookshelf icon, between Tasks and Assets", async () => {
    const client = await seedClient();
    const { container } = render(
      <Sidebar
        client={client}
        user={null}
        offline={false}
        showSettings={false}
        onOpenSettings={() => {}}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onSignOut={() => {}}
        onOpenInSidebar={vi.fn()}
      />,
    );
    const row = screen.getByRole("button", { name: "Sources" });
    expect(row).not.toBeNull();
    // The bookshelf icon rides the row (the shared MDI sprite sheet).
    expect(
      row.querySelector('use[href="/mdi-sprite.svg#mdi-bookshelf"]'),
    ).not.toBeNull();
    void container;

    // The navigation order: Tasks → Sources → Assets.
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>(".nt-side-item-label"),
    ).map((el) => el.textContent);
    const tasks = labels.indexOf("Tasks");
    const sources = labels.indexOf("Sources");
    const assets = labels.indexOf("Assets");
    expect(tasks).toBeGreaterThanOrEqual(0);
    expect(sources).toBeGreaterThan(tasks);
    expect(assets).toBeGreaterThan(sources);
  });
});

describe("SourcesHub — the shell's honest empty states", () => {
  it("renders the three panes with their empty states and the top bar", () => {
    // A deep link with the full query string — the shell boots on it.
    window.history.pushState({}, "", "/sources?type=book&q=smith&sort=year:desc");
    render(<SourcesHub />);

    // The top bar names the surface.
    expect(screen.getByRole("heading", { name: "Sources" })).not.toBeNull();

    // The facets pane…
    const facets = screen.getByRole("complementary", { name: "Source types" });
    expect(withinText(facets, "No source types")).toBe(true);
    // …the table pane, with the Add-your-first-source hint + its button…
    const table = document.querySelector(".nt-sources-hub__table");
    expect(table).not.toBeNull();
    expect(
      screen.getByText(/Add your first source — paste a DOI, ISBN, arXiv link or a URL/),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add source" })).not.toBeNull();
    // …and the detail pane.
    const detail = screen.getByRole("complementary", { name: "Source details" });
    expect(withinText(detail, "Select a source")).toBe(true);
  });
});

function withinText(root: HTMLElement, text: string): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>("h3, p, span, div")).some(
    (el) => el.textContent === text || (el.textContent ?? "").includes(text),
  );
}
