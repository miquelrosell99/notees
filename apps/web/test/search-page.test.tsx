/**
 * SearchPage tests — the full-page search surface at /search (the
 * Capacities "Extended Search" parity slice), jsdom over the in-process
 * WorkspaceClient + MemoryRelay:
 *
 *  - typing a query lists the ranked results with match-context snippets
 *    (the shared nt-search-mark spans) under each NodeResultItem row;
 *  - the scope Tabs (All / Main / Blocks) filter the display by render
 *    state — classes ride Main, parented non-class children are Blocks;
 *  - the class Dropdown narrows the display to one class's members;
 *  - "Show more results" appends the next cursor page of the ranked
 *    stream until the cursor reads null;
 *  - the empty states: no query names the two query modes ("…" exact,
 *    ^ prefix), a no-hit query reads "No matches found";
 *  - the App seams: the palette's "Search all for …" footer row appears
 *    for a non-empty query and hands the query to the host, the
 *    Ctrl/Cmd+Shift+F chord fires outside form fields, and the popstate
 *    handler maps /search back onto the route flag.
 *
 * Row-name assertions scope to `.node-result-item__name`: the snippet
 * excerpt repeats the matched text under the row, so an unscoped text
 * query matches twice.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { popStateNavHandler, searchKeyHandler } from "../src/ui/App.js";
import { SearchPage } from "../src/ui/SearchPage.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * titles through object.update; remove once the applier is fixed. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createClass(title);
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

interface SearchWorld {
  client: WorkspaceClient;
  alpha: string;
  notes: string;
  block: string;
}

async function seedSearchWorld(): Promise<SearchWorld> {
  const client = await seedClient();
  const alpha = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: "Alpha" }],
  });
  const notes = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: "Notes" }],
  });
  const block = await client.createObject({
    presentAsMain: false,
    parentId: notes,
    contentAst: [{ type: "text", text: "alpha bravo charlie" }],
  });
  return { client, alpha, notes, block };
}

function renderSearchPage(
  client: WorkspaceClient,
  handlers: { onOpenNode?: (id: string) => void; initialQuery?: string } = {},
) {
  const opened: string[] = [];
  render(
    <SearchPage
      client={client}
      onOpenNode={handlers.onOpenNode ?? ((id) => opened.push(id))}
      initialQuery={handlers.initialQuery ?? ""}
    />,
  );
  return { opened };
}

const typeQuery = (text: string): void => {
  fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: text } });
};

const rowName = (text: string): HTMLElement =>
  screen.getByText(text, { selector: ".node-result-item__name" });

const resultRows = (): Element[] => [...document.querySelectorAll(".search-page__result")];

describe("SearchPage results", () => {
  it("typing a query lists the ranked hits with snippet marks; a row click opens the node", async () => {
    const { client, alpha } = await seedSearchWorld();
    const { opened } = renderSearchPage(client);

    typeQuery("alpha");
    // Both the title-matched page and the content-matched block render.
    expect(await screen.findByText("Alpha", { selector: ".node-result-item__name" })).not.toBeNull();
    expect(rowName("alpha bravo charlie")).not.toBeNull();
    // The snippet excerpt rides under the block row with the match marked.
    const mark = screen.getByText("alpha", { selector: ".nt-search-mark" });
    expect(mark.closest(".nt-search-snippet")).not.toBeNull();
    // The block hit carries its containing-page breadcrumb.
    expect(screen.getByText("Notes", { selector: ".node-result-item__crumbs" })).not.toBeNull();

    fireEvent.click(rowName("Alpha"));
    expect(opened).toEqual([alpha]);
  });

  it("a query with no results renders the honest empty state", async () => {
    const { client } = await seedSearchWorld();
    renderSearchPage(client);
    typeQuery("quixotic");
    expect(await screen.findByText("No matches found")).not.toBeNull();
  });

  it("no query renders the hint naming the two query modes", async () => {
    const { client } = await seedSearchWorld();
    renderSearchPage(client);
    const hint = screen.getByText(/Type to search the whole workspace/);
    expect(hint.textContent).toContain("exact");
    expect(hint.textContent).toContain("^");
    expect(resultRows()).toHaveLength(0);
  });

  it("the exact and prefix modes answer through the same stream", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Alphabet Soup" });
    await client.createObject({ presentAsMain: true, name: "Beta Alpha" });
    renderSearchPage(client);

    // ^ prefix: only the title that STARTS with the rest.
    typeQuery("^alpha");
    expect(
      await screen.findByText("Alphabet Soup", { selector: ".node-result-item__name" }),
    ).not.toBeNull();
    expect(screen.queryByText("Beta Alpha", { selector: ".node-result-item__name" })).toBeNull();

    // "…" exact: the exact substring only.
    fireEvent.change(screen.getByLabelText("Search everything"), {
      target: { value: '"beta alpha"' },
    });
    expect(await screen.findByText("Beta Alpha", { selector: ".node-result-item__name" })).not.toBeNull();
    expect(screen.queryByText("Alphabet Soup", { selector: ".node-result-item__name" })).toBeNull();
  });
});

describe("SearchPage scope tabs", () => {
  it("All lists pages and blocks; Main keeps document chrome; Blocks keeps inline blocks", async () => {
    const { client } = await seedSearchWorld();
    renderSearchPage(client);
    typeQuery("alpha");
    expect(await screen.findByText("Alpha", { selector: ".node-result-item__name" })).not.toBeNull();
    expect(rowName("alpha bravo charlie")).not.toBeNull();
    expect(resultRows()).toHaveLength(2);

    // Main: the page stays, the block drops out.
    fireEvent.click(screen.getByRole("tab", { name: "Main" }));
    expect(rowName("Alpha")).not.toBeNull();
    expect(screen.queryByText("alpha bravo charlie", { selector: ".node-result-item__name" })).toBeNull();
    expect(resultRows()).toHaveLength(1);

    // Blocks: the inverse.
    fireEvent.click(screen.getByRole("tab", { name: "Blocks" }));
    expect(screen.queryByText("Alpha", { selector: ".node-result-item__name" })).toBeNull();
    expect(rowName("alpha bravo charlie")).not.toBeNull();
    expect(resultRows()).toHaveLength(1);
  });
});

describe("SearchPage class filter", () => {
  it("the dropdown narrows the display to the picked class's members", async () => {
    const client = await seedClient();
    const fictionId = await createTitledClass(client, "Fiction");
    await client.createObject({
      presentAsMain: true,
      name: "Dune",
      classIds: [fictionId],
      contentAst: [{ type: "text", text: "Dune" }],
    });
    await client.createObject({
      presentAsMain: true,
      name: "Gardening Annual",
      contentAst: [{ type: "text", text: "Gardening Annual" }],
    });
    renderSearchPage(client);
    typeQuery("dune gardening");
    expect(await screen.findByText("Dune", { selector: ".node-result-item__name" })).not.toBeNull();
    expect(rowName("Gardening Annual")).not.toBeNull();

    // Filter by Fiction: only Dune stays. The trigger labels itself.
    fireEvent.click(screen.getByRole("button", { name: /Filter by class/ }));
    fireEvent.click(await screen.findByText("Fiction", { selector: ".dropdown-option-label" }));
    expect(rowName("Dune")).not.toBeNull();
    expect(screen.queryByText("Gardening Annual", { selector: ".node-result-item__name" })).toBeNull();
    expect(screen.getByText("Fiction", { selector: ".dropdown-value" })).not.toBeNull();
  });
});

describe("SearchPage pagination", () => {
  it("Show more results appends the next cursor page until exhausted", async () => {
    const client = await seedClient();
    // The host title stays free of the query term: a matching parent would
    // join the hit list through the parent-name tier.
    const host = await client.createObject({ presentAsMain: true, name: "Host Page" });
    for (let i = 0; i < 30; i += 1) {
      await client.createObject({
        presentAsMain: false,
        parentId: host,
        contentAst: [{ type: "text", text: `needle block ${i + 1}` }],
      });
    }
    renderSearchPage(client);
    typeQuery("needle");
    // Page one: 25 of the 30 block hits.
    await screen.findByText("needle block 25", { selector: ".node-result-item__name" });
    expect(resultRows()).toHaveLength(25);
    const more = screen.getByRole("button", { name: "Show more results" });

    fireEvent.click(more);
    // The second page appends the remaining five; the cursor then reads
    // null and the button retires.
    await screen.findByText("needle block 30", { selector: ".node-result-item__name" });
    expect(resultRows()).toHaveLength(30);
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
  });
});

describe("CommandPalette search-all footer", () => {
  function renderPalette(client: WorkspaceClient, onOpenSearch?: (query: string) => void) {
    const closed: string[] = [];
    const searches: string[] = [];
    render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => closed.push("close")}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        cacheVersion={0}
        onOpenSearch={onOpenSearch ?? ((query) => searches.push(query))}
      />,
    );
    return { closed, searches };
  }

  it("the empty query shows no footer row; typing reveals Search all for …", async () => {
    const { client } = await seedSearchWorld();
    renderPalette(client);
    expect(screen.queryByText(/^Search all for/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Command palette search"), {
      target: { value: "alpha" },
    });
    expect(await screen.findByText('Search all for "alpha"')).not.toBeNull();
  });

  it("clicking the row closes the palette and hands the query to the host", async () => {
    const { client } = await seedSearchWorld();
    const { closed, searches } = renderPalette(client);
    fireEvent.change(screen.getByLabelText("Command palette search"), {
      target: { value: "alpha" },
    });
    fireEvent.click(await screen.findByText('Search all for "alpha"'));
    expect(closed).toEqual(["close"]);
    expect(searches).toEqual(["alpha"]);
  });

  it("the row is a contribution point: absent without onOpenSearch", async () => {
    const { client } = await seedSearchWorld();
    render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        cacheVersion={0}
      />,
    );
    fireEvent.change(screen.getByLabelText("Command palette search"), {
      target: { value: "alpha" },
    });
    expect(await screen.findByText("Commands")).not.toBeNull();
    expect(screen.queryByText(/^Search all for/)).toBeNull();
  });
});

describe("search route seams", () => {
  it("Ctrl/Cmd+Shift+F fires the handler outside form fields and yields inside them", () => {
    const fired: string[] = [];
    const handler = searchKeyHandler({ onOpen: () => fired.push("open") });
    const input = document.createElement("input");
    document.body.appendChild(input);

    handler(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(fired).toEqual(["open"]);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true }),
    );
    expect(fired).toHaveLength(1);

    // Alt+Shift+F and plain Ctrl+F are not the chord.
    handler(
      new KeyboardEvent("keydown", { key: "f", altKey: true, shiftKey: true, bubbles: true }),
    );
    handler(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(fired).toHaveLength(1);
    input.remove();
  });

  it("popStateNavHandler maps /search onto the route flag and clears it on other routes", () => {
    const flags: boolean[] = [];
    const handler = popStateNavHandler({
      openManager: () => {},
      closeManager: () => {},
      setNav: () => {},
      setNode: () => {},
      setSettingsSection: () => {},
      setSearch: (open) => flags.push(open),
    });
    window.addEventListener("popstate", handler);

    window.history.pushState({}, "", "/search");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.pushState({}, "", "/search?q=alpha");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.pushState({}, "", "/journal");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(flags).toEqual([true, true, false]);
    window.removeEventListener("popstate", handler);
    window.history.pushState({}, "", "/");
  });
});
