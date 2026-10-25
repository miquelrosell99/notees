/**
 * Sources hub items-table + toolbar tests (task 3):
 *
 * - The library columns render the display projection (type label, title,
 *   authors, year, venue, citekey, the attachments badge).
 * - The toolbar: search ONLY — the count
 *   moved into a badge next to the title, the exports + Add-source +
 *   settings doors retired (creation rides the global New flow).
 * - Sorting: the URL sort deep-links (?sort=year:desc), header clicks push
 *   the App-owned state (asc → desc → clear), and EMPTY values sink last
 *   in BOTH directions (Review Focus 2).
 * - Keyboard nav (the existing keyboard-list conventions): up/down move
 *   the single selection, Enter focuses the detail pane; selection drives
 *   SourcesDetail.
 * - Empty states: an empty library renders the Add-first-source hint;
 *   filters excluding everything render the honest "No sources match".
 *
 * Seeded over the repo's test-client pattern (MemoryRelay + sql.js), the
 * sources-data convention — journal ×2, web_page ×3, archived artwork ×1,
 * the bibliographic bindings on `source`, per-class venue bindings.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
} from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { SourcesHub } from "../src/features/sources/SourcesHub.js";
import {
  DEFAULT_SOURCES_QUERY,
  type SourcesQueryState,
} from "../src/features/sources/sourcesQuery.js";


const WS = "0192a000-0000-7000-8000-00000000a001";
const ACTOR = "0192a000-0000-7000-8000-00000000a002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const ROSTER = ["journal_article", "web_page", "artwork"] as const;
/** Classes beyond the type roster the seed needs. */
const SUPPORT = ["asset"] as const;

export interface LibraryItems {
  a1: string;
  a2: string;
  w1: string;
  w2: string;
  w3: string;
  r1: string;
}

async function seedClient(withItems = true): Promise<{ client: WorkspaceClient; items: LibraryItems }> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);

  for (const name of ["source", ...SUPPORT, ...ROSTER] as const) {
    await client.createClass(SYSTEM_CLASS_DISPLAY_NAMES[name], { id: SYSTEM_CLASS_UUIDS[name] });
  }
  for (const name of ROSTER) {
    await client.setClassExtends(SYSTEM_CLASS_UUIDS[name], [SYSTEM_CLASS_UUIDS.source]);
  }
  const SOURCE = SYSTEM_CLASS_UUIDS.source;
  const P = SYSTEM_PROPERTY_UUIDS;
  const schema = async (
    key: keyof typeof SYSTEM_PROPERTY_UUIDS,
    multi: boolean,
    type: "text" | "datetime" | "asset" = "text",
  ) => {
    await client.createPropertySchema({
      id: P[key],
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type,
      multi,
      scopeClassIds: [SOURCE],
    });
  };
  await schema("authors", true);
  await schema("publicationDate", false, "datetime");
  await schema("citekey", false);
  await schema("attachments", true, "asset");
  await schema("publicationTitle", false);
  await schema("websiteTitle", false);
  for (const key of ["authors", "publicationDate", "citekey", "attachments"] as const) {
    await client.setClassProperty(SOURCE, P[key], {});
  }
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.journal_article, P.publicationTitle, {});
  await client.setClassProperty(SYSTEM_CLASS_UUIDS.web_page, P.websiteTitle, {});
  // artwork rides SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES — archive it (its
  // items still read in the table, the task-2 membership ruling).
  await client.setArchived(SYSTEM_CLASS_UUIDS.artwork, false);

  const items: LibraryItems = { a1: "", a2: "", w1: "", w2: "", w3: "", r1: "" };
  if (withItems) {
    const create = (title: string, classes: readonly SystemClassName[]) =>
      client.createObject({
        isEmbedded: false,
        name: title,
        classIds: classes.map((c) => SYSTEM_CLASS_UUIDS[c]),
      });
    const date = async (id: string, iso: string) => {
      const { year } = await client.ensureDateChain(iso);
      await client.setProperty(id, P.publicationDate, { nodeId: year }, 0);
    };

    items.a1 = await create("On the Analytical Engine", ["journal_article"]);
    await client.setProperty(items.a1, P.authors, "Lovelace, Ada", 0);
    await client.setProperty(items.a1, P.authors, "Turing, Alan", 1);
    await client.setProperty(items.a1, P.publicationTitle, "The Example Journal", 0);
    await client.setProperty(items.a1, P.citekey, "lovelace1843analytical", 0);
    const asset1 = await create("paper.pdf", ["asset"]);
    await date(items.a1, "1843-01-01");
    await client.setProperty(items.a1, P.attachments, { nodeId: asset1 }, 0);

    items.a2 = await create("Computing Machinery", ["journal_article"]);
    await client.setProperty(items.a2, P.authors, "Turing, Alan", 0);
    await client.setProperty(items.a2, P.publicationTitle, "Mind", 0);
    await client.setProperty(items.a2, P.citekey, "turing1950computing", 0);
    await date(items.a2, "1950-01-01");

    items.w1 = await create("A Great Article", ["web_page"]);
    await client.setProperty(items.w1, P.websiteTitle, "Example Blog", 0);
    await client.setProperty(items.w1, P.citekey, "great2021article", 0);

    items.w2 = await create("Another Page", ["web_page"]);
    await client.setProperty(items.w2, P.authors, "Smith, John", 0);
    await client.setProperty(items.w2, P.websiteTitle, "Example Site", 0);
    await client.setProperty(items.w2, P.citekey, "smith2020another", 0);
    await date(items.w2, "2020-01-01");

    items.w3 = await create("Third Page", ["web_page"]);
    await client.setProperty(items.w3, P.authors, "Doe, Jane", 0);
    await client.setProperty(items.w3, P.websiteTitle, "Example Site", 0);
    await client.setProperty(items.w3, P.citekey, "doe2022third", 0);

    items.r1 = await create("Archived Piece", ["artwork"]);
    await client.setProperty(items.r1, P.citekey, "piece1900archived", 0);
    await date(items.r1, "1900-01-01");
  }
  return { client, items };
}

function renderHub(
  client: WorkspaceClient,
  query: SourcesQueryState = DEFAULT_SOURCES_QUERY,
  onQueryChange: ((next: SourcesQueryState, mode: "push" | "replace") => void) | undefined = undefined,
) {
  return render(
    <SourcesHub client={client} query={query} onQueryChange={onQueryChange} />,
  );
}

/** The rendered row order (tbody tr data-node-id sequence). */
function rowOrder(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map((tr) =>
    tr.getAttribute("data-node-id")!,
  );
}

function activeRowId(): string | null {
  return document.querySelector("tbody tr.nt-table-row--active")?.getAttribute("data-node-id") ?? null;
}

async function rowsReady(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
  });
}

describe("SourcesTable — the items table", () => {
  it("renders the library columns from the display projection", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();

    // The seven library columns.
    const headers = Array.from(document.querySelectorAll("th")).map((th) => th.textContent ?? "");
    for (const label of ["Type", "Title", "Authors", "Year", "Venue", "Citekey", "Attachments"]) {
      expect(headers.some((text) => text.startsWith(label))).toBe(true);
    }

    const row = document.querySelector(`tr[data-node-id="${items.a1}"]`)!;
    expect(within(row as HTMLElement).getByText("Journal article")).not.toBeNull();
    expect(within(row as HTMLElement).getByText("On the Analytical Engine")).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Lovelace, Ada; Turing, Alan")).not.toBeNull();
    expect(within(row as HTMLElement).getByText("1843")).not.toBeNull();
    expect(within(row as HTMLElement).getByText("The Example Journal")).not.toBeNull();
    expect(within(row as HTMLElement).getByText("lovelace1843analytical")).not.toBeNull();
    // The attachments badge counts the non-null asset rows.
    expect(within(row as HTMLElement).getByText("1")).not.toBeNull();

    // The toolbar rides the SURFACE TOP BAR; the count is a BADGE next to
    // the title (the "N sources" text retired).
    const topbar = document.querySelector(".surface-topbar") as HTMLElement;
    expect(topbar.querySelector(".badge")?.textContent).toBe("6");
    expect(within(topbar).queryByText(/sources$/)).toBeNull();
    // The middle cell carries no toolbar chrome.
    const middle = document.querySelector(".nt-main-frame__content") as HTMLElement;
    expect(within(middle).queryByRole("textbox", { name: "Search sources" })).toBeNull();
  });

  /** The seed's projection facts, keyed by NODE ID (expectation register). */
  function projection(items: LibraryItems) {
    return {
      year: {
        [items.a1]: 1843,
        [items.r1]: 1900,
        [items.a2]: 1950,
        [items.w2]: 2020,
        [items.w1]: null,
        [items.w3]: null,
      } as Record<string, number | null>,
      authors: {
        [items.w3]: "Doe, Jane",
        [items.a1]: "Lovelace, Ada; Turing, Alan",
        [items.w2]: "Smith, John",
        [items.a2]: "Turing, Alan",
        [items.w1]: "",
        [items.r1]: "",
      } as Record<string, string>,
      venue: {
        [items.a1]: "The Example Journal",
        [items.a2]: "Mind",
        [items.w1]: "Example Blog",
        [items.w2]: "Example Site",
        [items.w3]: "Example Site",
        [items.r1]: "",
      } as Record<string, string>,
    };
  }

  /** The comparator contract under test: empties sink last BOTH ways. */
  function stableSorted(
    base: string[],
    key: (id: string) => string | number | null,
    dir: "asc" | "desc",
  ): string[] {
    const sign = dir === "asc" ? 1 : -1;
    return [...base].sort((x, y) => {
      const a = key(x);
      const b = key(y);
      const emptyA = a === null || a === "";
      const emptyB = b === null || b === "";
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      if (emptyA && emptyB) return 0;
      if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
      return (
        String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }) * sign
      );
    });
  }

  it("the URL sort deep-links: ?sort=year:asc orders the rows and marks the header", async () => {
    const { client, items } = await seedClient();
    const p = projection(items);
    // The unfiltered table order (the AST's natural order — the tie base).
    const first = renderHub(client);
    await rowsReady();
    const base = rowOrder();
    first.unmount();

    renderHub(client, { type: null, q: "", sort: { field: "year", direction: "asc" } });
    await rowsReady();
    await waitFor(() => {
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.year[id] ?? null, "asc"));
    });
    const yearHeader = screen.getAllByRole("button", { name: "Year" })[0]!.closest("th")!;
    expect(yearHeader.getAttribute("aria-sort")).toBe("ascending");
  });

  it("empty values sink last in BOTH directions (Review Focus 2)", async () => {
    const { client, items } = await seedClient();
    const p = projection(items);
    const { rerender } = renderHub(client);
    await rowsReady();
    const base = rowOrder();

    const rerenderWith = (sort: SourcesQueryState["sort"]) =>
      rerender(<SourcesHub client={client} query={{ type: null, q: "", sort }} />);

    rerenderWith({ field: "year", direction: "asc" });
    await waitFor(() =>
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.year[id] ?? null, "asc")),
    );

    rerenderWith({ field: "year", direction: "desc" });
    await waitFor(() =>
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.year[id] ?? null, "desc")),
    );

    rerenderWith({ field: "authors", direction: "asc" });
    await waitFor(() =>
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.authors[id] ?? "", "asc")),
    );

    rerenderWith({ field: "authors", direction: "desc" });
    await waitFor(() =>
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.authors[id] ?? "", "desc")),
    );

    // Venue: the artwork binds no container field — its empty venue sinks
    // last in both directions too.
    rerenderWith({ field: "venue", direction: "desc" });
    await waitFor(() =>
      expect(rowOrder()).toEqual(stableSorted(base, (id) => p.venue[id] ?? "", "desc")),
    );
    expect(rowOrder().at(-1)).toBe(items.r1);
  });

  it("clicking a column header pushes the App-owned sort state (asc → desc → clear)", async () => {
    const { client } = await seedClient();
    const onQueryChange = vi.fn();
    const { rerender } = renderHub(client, DEFAULT_SOURCES_QUERY, onQueryChange);
    await rowsReady();

    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(onQueryChange).toHaveBeenCalledWith(
      { type: null, q: "", sort: { field: "year", direction: "asc" } },
      "push",
    );

    // The App state round-trips (the calendar seam).
    onQueryChange.mockClear();
    rerender(
      <SourcesHub
        client={client}
        query={{ type: null, q: "", sort: { field: "year", direction: "asc" } }}
        onQueryChange={onQueryChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(onQueryChange).toHaveBeenCalledWith(
      { type: null, q: "", sort: { field: "year", direction: "desc" } },
      "push",
    );

    onQueryChange.mockClear();
    rerender(
      <SourcesHub
        client={client}
        query={{ type: null, q: "", sort: { field: "year", direction: "desc" } }}
        onQueryChange={onQueryChange}
      />,
    );
    // The third click clears the sort back to null.
    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(onQueryChange).toHaveBeenCalledWith({ type: null, q: "", sort: null }, "push");
  });

  it("the search box filters live (title/authors/citekey) and replaces the URL, debounced", async () => {
    const { client, items } = await seedClient();
    const onQueryChange = vi.fn();
    renderHub(client, DEFAULT_SOURCES_QUERY, onQueryChange);
    await rowsReady();

    const search = screen.getByRole("textbox", { name: "Search sources" });
    fireEvent.change(search, { target: { value: "turing" } });
    // Live: the rows narrow immediately (both author rows carry "Turing").
    await waitFor(() => {
      expect(rowOrder().sort()).toEqual([items.a1, items.a2].sort());
    });
    // The URL follows, debounced, with replace semantics.
    await waitFor(() => {
      expect(onQueryChange).toHaveBeenCalledWith({ type: null, q: "turing", sort: null }, "replace");
    });
    // The count badge follows the narrow (a badge, not the retired text).
    await waitFor(() => {
      expect(document.querySelector(".surface-topbar .badge")?.textContent).toBe("2");
    });

    // Citekey narrow.
    fireEvent.change(search, { target: { value: "lovelace1843" } });
    await waitFor(() => {
      expect(rowOrder()).toEqual([items.a1]);
    });
    // Clearing restores the library.
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => {
      expect(rowOrder().length).toBe(6);
    });
  });

  it("filters excluding everything render the honest No-sources-match state", async () => {
    const { client } = await seedClient();
    renderHub(client, { type: null, q: "zzzz-no-match", sort: null });
    await waitFor(() => {
      expect(screen.getByText("No sources match")).not.toBeNull();
    });
    // The count badge reads 0 (a badge, not the retired "N sources" text).
    const topbar0 = document.querySelector(".surface-topbar") as HTMLElement;
    expect(topbar0.querySelector(".badge")?.textContent).toBe("0");
    expect(screen.queryByText("0 sources")).toBeNull();
    // The toolbar (and its search box) stays — the filters can be undone.
    // The toolbar (and its search box) stays — the filters can be undone.
    expect(screen.getByRole("textbox", { name: "Search sources" })).not.toBeNull();
  });

  it("an empty library renders the New-flow hint (no direct add-source door)", async () => {
    const { client } = await seedClient(false);
    renderHub(client);
    await waitFor(() => {
      expect(screen.getByText("No sources yet")).not.toBeNull();
    });
    // The hint points at the global New flow…
    expect(screen.getByText(/Press New in the top bar/i)).not.toBeNull();
    // …and the direct Add-source door is gone — creation rides the New flow.
    expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
  });

  it("the empty state clears when the first source is added — no remount (the latch reset)", async () => {
    const { client } = await seedClient(false);
    renderHub(client);
    await waitFor(() => {
      expect(screen.getByText("No sources yet")).not.toBeNull();
    });

    // Add the first source through the client: the subscription re-reads
    // the loaded set in place — the latch must reset and the row render,
    // without unmounting the hub.
    await act(async () => {
      await client.createObject({
        isEmbedded: false,
        name: "The First Source",
        classIds: [SYSTEM_CLASS_UUIDS.journal_article],
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("No sources yet")).toBeNull();
    });
    expect(screen.getByText("The First Source")).not.toBeNull();
    expect(document.querySelectorAll("tbody tr").length).toBe(1);
  });
});

describe("SourcesTable — keyboard navigation + selection", () => {
  it("up/down move the single selection; Enter focuses the detail pane", async () => {
    const { client, items } = await seedClient();
    const titles: Record<string, string> = {
      [items.a1]: "On the Analytical Engine",
      [items.a2]: "Computing Machinery",
      [items.w1]: "A Great Article",
      [items.w2]: "Another Page",
      [items.w3]: "Third Page",
      [items.r1]: "Archived Piece",
    };
    renderHub(client);
    await rowsReady();
    // The AST's natural order drives the arrow walk (no sort picked).
    const order = rowOrder();

    const region = document.querySelector(".nt-sources-table") as HTMLElement;
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(activeRowId()).toBe(order[0]);

    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(activeRowId()).toBe(order[1]);

    // The selection drives the detail pane (title read-only until the
    // detail task; the wiring lives here).
    const detail = screen.getByRole("complementary", { name: "Source details" });
    expect(within(detail).getByText(titles[order[1]!]!)).not.toBeNull();

    fireEvent.keyDown(region, { key: "ArrowUp" });
    expect(activeRowId()).toBe(order[0]);

    fireEvent.keyDown(region, { key: "Enter" });
    expect(document.activeElement?.className).toContain("nt-sources-hub__detail-focus");
  });

  it("arrow keys inside the search box edit the query, not the selection", async () => {
    const { client } = await seedClient();
    renderHub(client);
    await rowsReady();

    const search = screen.getByRole("textbox", { name: "Search sources" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(activeRowId()).toBeNull();
  });

  it("clicking a row selects it and drives the detail pane", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();

    const row = document.querySelector(`tr[data-node-id="${items.w2}"]`) as HTMLElement;
    fireEvent.click(within(row).getByText("Another Page"));
    expect(activeRowId()).toBe(items.w2);
    const detail = screen.getByRole("complementary", { name: "Source details" });
    expect(within(detail).getByText("Another Page")).not.toBeNull();
  });
});

describe("SourcesHub —", () => {
  it("the toolbar is search-only — no exports, no Add-source, no settings shortcut", async () => {
    const { client } = await seedClient();
    renderHub(client);
    await rowsReady();

    const topbar = document.querySelector(".surface-topbar") as HTMLElement;
    expect(within(topbar).getByRole("textbox", { name: "Search sources" })).not.toBeNull();
    for (const name of [/bibtex/i, /csl json/i, "Add source", "Sources settings"] as const) {
      expect(within(topbar).queryByRole("button", { name })).toBeNull();
    }
    // The middle cell carries none of the toolbar chrome.
    const middle = document.querySelector(".nt-main-frame__content") as HTMLElement;
    expect(within(middle).queryByRole("textbox")).toBeNull();
    expect(within(middle).queryByRole("button", { name: /bibtex/i })).toBeNull();
  });

  it("the count badge rides next to the title and updates live", async () => {
    const { client } = await seedClient();
    renderHub(client);
    await rowsReady();

    const topbar = document.querySelector(".surface-topbar") as HTMLElement;
    const badge = topbar.querySelector(".badge") as HTMLElement;
    expect(badge.textContent).toBe("6");
    // The badge sits in the title cluster: right of the heading, left of
    // the spacer/actions.
    const heading = within(topbar).getByRole("heading", { name: "Sources" });
    expect(heading.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Live: the search narrows the set AND the badge.
    fireEvent.change(within(topbar).getByRole("textbox", { name: "Search sources" }), {
      target: { value: "turing" },
    });
    await waitFor(() => expect(topbar.querySelector(".badge")?.textContent).toBe("2"));
  });

  it("the panel toggles lead the bar, left of the title (the general hub convention)", async () => {
    const { client } = await seedClient();
    renderHub(client);
    await rowsReady();

    const topbar = document.querySelector(".surface-topbar") as HTMLElement;
    const heading = within(topbar).getByRole("heading", { name: "Sources" });
    for (const name of ["Hide facets panel", "Hide details panel"] as const) {
      const toggle = within(topbar).getByRole("button", { name });
      expect(
        toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("the detail panel shows iff the toggle is on AND a selection exists", async () => {
    const { client, items } = await seedClient();
    renderHub(client);
    await rowsReady();

    // No selection: no detail pane, the toggle reads unpressed (owner
    // review round 2 — the empty "Select a source" state is gone with it).
    expect(screen.queryByRole("complementary", { name: "Source details" })).toBeNull();
    expect(screen.queryByText("Select a source")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Hide details panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    // A selection opens the pane; the toggle presses.
    const row = document.querySelector(`tr[data-node-id="${items.w2}"]`) as HTMLElement;
    fireEvent.click(within(row).getByText("Another Page"));
    expect(screen.getByRole("complementary", { name: "Source details" })).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    // The toggle still owns the panel once a selection exists.
    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary", { name: "Source details" })).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Device-local session state (never an op) — the deviceSettings register.
    expect(window.localStorage.getItem("notees.settings.sourcesPanel.detail")).toBe("false");
  });

  it("the facets toggle hides and shows the facets panel — device-local, persisted", async () => {
    const { client } = await seedClient();
    renderHub(client);
    await rowsReady();
    expect(screen.getByRole("complementary", { name: "Source types" })).not.toBeNull();
    const toggle = screen.getByRole("button", { name: "Hide facets panel" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);
    expect(screen.queryByRole("complementary", { name: "Source types" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show facets panel" })).not.toBeNull();
    // Device-local session state (never an op) — the deviceSettings register.
    expect(window.localStorage.getItem("notees.settings.sourcesPanel.facets")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Show facets panel" }));
    expect(screen.getByRole("complementary", { name: "Source types" })).not.toBeNull();
    expect(window.localStorage.getItem("notees.settings.sourcesPanel.facets")).toBe("true");
  });

  it("a hidden facets pref survives a remount (the deviceSettings read)", async () => {
    const { client } = await seedClient();
    const first = renderHub(client);
    await rowsReady();
    fireEvent.click(screen.getByRole("button", { name: "Hide facets panel" }));
    first.unmount();

    renderHub(client);
    await rowsReady();
    expect(screen.queryByRole("complementary", { name: "Source types" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show facets panel" })).not.toBeNull();
  });

  it("a hidden detail pref stays hidden across a remount until the toggle returns", async () => {
    const { client } = await seedClient();
    const first = renderHub(client);
    await rowsReady();
    fireEvent.click(screen.getByRole("button", { name: "Hide details panel" }));
    first.unmount();

    renderHub(client);
    await rowsReady();
    expect(screen.queryByRole("complementary", { name: "Source details" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show details panel" })).not.toBeNull();
  });

  it("flattens a markdown link title to its text in the Title column (owner papercut)", async () => {
    const { client } = await seedClient();
    await client.createObject({
      isEmbedded: false,
      name: "[¡Imprime en 3D tu propia...](https://makerworld.com/models/1)",
      classIds: [SYSTEM_CLASS_UUIDS.web_page],
    });
    renderHub(client);
    await rowsReady();

    expect(screen.getByText("¡Imprime en 3D tu propia...")).not.toBeNull();
    // The raw bracket syntax never renders.
    expect(screen.queryByText(/\[¡Imprime/)).toBeNull();
  });
});