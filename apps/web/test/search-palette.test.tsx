/**
 * Search & command palette wave — jsdom
 * over the in-process WorkspaceClient:
 *
 *  - CommandPalette sections: Recent (device-local recents, empty query
 *    only), Date Pages, Pages, Classes, Properties, Content, Commands
 *    (the action registry, with the query-scoped typed create); search
 *    results rank Classes → Properties → Pages → Content, then Date Pages
 *    and Commands; the empty-query home keeps Recent → Random → Commands;
 *  - the Content group debounces the ranked FTS, renders match snippets, and
 *    labels block hits with their containing page;
 *  - the `is_daily:` prefix scopes the palette to the Date Pages section,
 *    and formatted-date keywords ("feb 14") map onto the deterministic date
 *    chain (create-on-pick via ensureDateChain);
 *  - NodeSelector: a leading `class:<name>` prefix refines candidates
 *    to that class's members, and the create row answers the rest of the
 *    query carrying the refined class;
 *  - NodeSelector: searchMode="blocks" lists only inline blocks, each
 *    labeled with its containing-page path.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { chainNodeIds, deriveDisplayName } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE, type UndoUiState } from "../src/core/undo-journal.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";
import { NodeSelector } from "../src/ui/components/pickers/NodeSelector.js";

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
  vi.restoreAllMocks();
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

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * titles through object.update; remove once the applier is fixed. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createClass(title);
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

interface PaletteWorld {
  client: WorkspaceClient;
  garden: string;
  catalog: string;
  notes: string;
}

async function seedPaletteWorld(): Promise<PaletteWorld> {
  const client = await seedClient();
  const garden = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: "Garden" }],
  });
  // Title match for "tulip": belongs to Pages, deduped out of Content.
  const catalog = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: "Tulip Catalog" }],
  });
  const notes = await client.createObject({
    presentAsMain: true,
    contentAst: [{ type: "text", text: "Notes" }],
  });
  await client.createObject({
    presentAsMain: false,
    parentId: notes,
    contentAst: [{ type: "text", text: "tulip bulbs go in the border" }],
  });
  return { client, garden, catalog, notes };
}

function renderPalette(
  client: WorkspaceClient,
  handlers: {
    onOpenNode?: (id: string) => void;
    onNewPage?: (title?: string) => void;
    onOpenProperty?: (id: string) => void;
    undoState?: UndoUiState;
  } = {},
) {
  const opened: string[] = [];
  const created: Array<string | undefined> = [];
  const openedProperties: string[] = [];
  const undoCalls: string[] = [];
  render(
    <CommandPalette
      client={client}
      open
      onRequestOpen={() => {}}
      onClose={() => {}}
      onOpenNode={handlers.onOpenNode ?? ((id) => opened.push(id))}
      onNewPage={handlers.onNewPage ?? ((title) => created.push(title))}
      onOpenProperty={handlers.onOpenProperty ?? ((id) => openedProperties.push(id))}
      onSignOut={() => {}}
      undoState={handlers.undoState ?? EMPTY_UNDO_STATE}
      onUndo={() => undoCalls.push("undo")}
      onRedo={() => undoCalls.push("redo")}
      cacheVersion={0}
    />,
  );
  return { opened, created, openedProperties, undoCalls };
}

const typeInPalette = (text: string): void => {
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
};

describe("CommandPalette sections", () => {
  it("empty query shows the device-local Recent section and the Commands registry", async () => {
    const { client, garden } = await seedPaletteWorld();
    localStorage.setItem("notees.recents", JSON.stringify([garden]));
    renderPalette(client);

    expect(await screen.findByText("Recent")).not.toBeNull();
    // Garden is both a recent and (this run's) random pick — the Random
    // section is exempt from the cross-group dedupe by design (#8).
    expect(screen.getAllByText("Garden").length).toBeGreaterThan(0);
    expect(screen.getByText("Commands")).not.toBeNull();
    expect(screen.getByText("New page")).not.toBeNull();
    expect(screen.getByText("Sign out")).not.toBeNull();
    // No query: the fuzzy title sections stay quiet.
    expect(screen.queryByText("Pages")).toBeNull();
  });

  it("recents refresh live on the notees:recents broadcast", async () => {
    const { client, garden } = await seedPaletteWorld();
    renderPalette(client);
    expect(screen.queryByText("Recent")).toBeNull();
    localStorage.setItem("notees.recents", JSON.stringify([garden]));
    window.dispatchEvent(new Event("notees:recents"));
    expect(await screen.findByText("Recent")).not.toBeNull();
    expect(screen.getAllByText("Garden").length).toBeGreaterThan(0);
  });

  it("typed creation: the Commands registry offers 'Create page \"<query>\"'", async () => {
    const { client } = await seedPaletteWorld();
    const { created } = renderPalette(client);
    typeInPalette("Shopping List");
    const row = await screen.findByText('Create page "Shopping List"');
    fireEvent.click(row);
    expect(created).toEqual(["Shopping List"]);
  });

  it("a shell re-render with fresh callback identities does not wipe the typed query", async () => {
    const { client } = await seedPaletteWorld();
    // App hands the palette fresh inline arrows every render; during a
    // background catch-up the shell re-renders constantly. The open-reset
    // effect must not re-run on callback identity churn — the query and its
    // results survive (the post-fix smoke caught the wipe live).
    const props = {
      client,
      open: true,
      onRequestOpen: () => {},
      onClose: () => {},
      onOpenNode: () => {},
      onNewPage: () => {},
      onSignOut: () => {},
      undoState: EMPTY_UNDO_STATE,
      onUndo: () => {},
      onRedo: () => {},
      cacheVersion: 0,
    };
    const view = render(<CommandPalette {...props} />);
    typeInPalette("Garden");
    expect((await screen.findAllByText("Garden")).length).toBeGreaterThan(0);
    // App-style re-render: every callback a brand-new arrow identity.
    view.rerender(
      <CommandPalette
        {...props}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText("Command palette search") as HTMLInputElement).value).toBe("Garden");
    expect(screen.getAllByText("Garden").length).toBeGreaterThan(0);
  });
});

describe("CommandPalette Random section (#8)", () => {
  /** A workspace of `count` plain pages, all eligible for the section. */
  async function seedRandomWorld(count: number): Promise<WorkspaceClient> {
    const client = await seedClient();
    for (let i = 0; i < count; i += 1) {
      await client.createObject({
        presentAsMain: true,
        contentAst: [{ type: "text", text: `Page ${i + 1}` }],
      });
    }
    return client;
  }

  /** The first five palette row labels (the Random rows precede Commands). */
  const firstLabels = (): Array<string | null> =>
    [...document.querySelectorAll(".nt-palette-item-label")].map((el) => el.textContent).slice(0, 5);

  it("the empty query shows the Random section with five rows and a refresh button", async () => {
    const client = await seedRandomWorld(8);
    renderPalette(client);

    expect(await screen.findByText("Random")).not.toBeNull();
    expect(screen.getByLabelText("Refresh random pages")).not.toBeNull();
    // Five random rows precede the Commands group (the command count is a
    // moving registry — assert the section's five, not the total).
    expect(firstLabels()).toHaveLength(5);
    expect(firstLabels().every((label) => /^Page \d$/.test(label ?? ""))).toBe(true);
    expect(screen.getByText("Commands")).not.toBeNull();
  });

  it("the Random section answers no query (empty-query only, like Recent)", async () => {
    const client = await seedRandomWorld(8);
    renderPalette(client);
    await screen.findByText("Random");
    typeInPalette("Page 1");
    expect(screen.queryByText("Random")).toBeNull();
    // The fuzzy Pages section owns the query instead.
    expect(await screen.findByText("Pages")).not.toBeNull();
  });

  it("refresh re-picks via a seeded Math.random, opening a different five", async () => {
    const client = await seedRandomWorld(8);
    // Math.random() === 0 drives Fisher–Yates on [Page 1..8] to
    // [2,3,4,5,6,7,8,1] (every swap pulls index 0 forward).
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    renderPalette(client);
    await screen.findByText("Random");
    expect(firstLabels()).toEqual(["Page 2", "Page 3", "Page 4", "Page 5", "Page 6"]);

    // Math.random() === 0.99 makes every swap a no-op (identity order).
    randomSpy.mockReturnValue(0.99);
    fireEvent.click(screen.getByLabelText("Refresh random pages"));
    expect(firstLabels()).toEqual(["Page 1", "Page 2", "Page 3", "Page 4", "Page 5"]);
  });

  it("refresh does NOT re-query the worker (the same cached pool re-shuffles)", async () => {
    const client = await seedRandomWorld(8);
    const listSpy = vi.spyOn(client, "listPages");
    renderPalette(client);
    await screen.findByText("Random");
    const callsAfterOpen = listSpy.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText("Refresh random pages"));
    expect(listSpy.mock.calls.length).toBe(callsAfterOpen);
  });
});

describe("CommandPalette Content group", () => {
  it("debounced ranked FTS with snippets, block hits labeled by containing page", async () => {
    const { client } = await seedPaletteWorld();
    const { opened } = renderPalette(client);
    typeInPalette("tulip");
    // The Content group surfaces the block whose text matches.
    expect(await screen.findByText("Content")).not.toBeNull();
    const row = await screen.findByText("tulip bulbs go in the border");
    expect(row).not.toBeNull();
    // The block hit is labeled with its containing page (Notes).
    expect(screen.getByText("Notes", { selector: ".nt-palette-item-meta" })).not.toBeNull();
    // The snippet marks the matched token.
    const mark = screen.getByText("tulip", { selector: ".nt-search-mark" });
    expect(mark.closest(".nt-search-snippet")).not.toBeNull();
    fireEvent.click(row);
    expect(opened).toHaveLength(1);
    expect(client.getNode(opened[0]!)?.parentId).not.toBeNull();
    // The title-matched page lands in Pages, deduped out of Content: the
    // Content group holds exactly the one block row.
    expect(screen.getByText("Pages")).not.toBeNull();
    expect(screen.getByText("Tulip Catalog")).not.toBeNull();
    expect(document.querySelectorAll(".nt-palette-snippet")).toHaveLength(1);
  });
});

describe("CommandPalette Properties section", () => {
  it("lists property schemas and opens the picked one via onOpenProperty", async () => {
    const { client } = await seedPaletteWorld();
    const schemaId = await client.createPropertySchema({ name: "Genre", type: "select" });
    const { openedProperties } = renderPalette(client);
    typeInPalette("genre");
    expect(await screen.findByText("Properties")).not.toBeNull();
    const row = screen.getByText("Genre");
    fireEvent.click(row);
    expect(openedProperties).toEqual([schemaId]);
  });

  it("matches property schemas by type keyword", async () => {
    const { client } = await seedPaletteWorld();
    await client.createPropertySchema({ name: "First read", type: "datetime" });
    renderPalette(client);
    typeInPalette("date");
    expect(await screen.findByText("Properties")).not.toBeNull();
    expect(screen.getByText("First read")).not.toBeNull();
  });

  it("stays quiet on the empty query and under is_daily:", async () => {
    const { client } = await seedPaletteWorld();
    await client.createPropertySchema({ name: "Genre", type: "select" });
    // A date page must exist for the is_daily: scoping to list the section.
    await client.ensureDateChain("2026-03-05");
    renderPalette(client);
    expect(screen.queryByText("Properties")).toBeNull();
    typeInPalette("is_daily:");
    expect(await screen.findByText("Date Pages")).not.toBeNull();
    expect(screen.queryByText("Properties")).toBeNull();
  });

  it("search sections rank Classes, Properties, Pages, Content", async () => {
    const { client } = await seedPaletteWorld();
    await createTitledClass(client, "Tulip");
    await client.createPropertySchema({ name: "Tulip rating", type: "number" });
    renderPalette(client);
    typeInPalette("tulip");
    // Content is debounced — wait for the last of the four groups.
    expect(await screen.findByText("Content")).not.toBeNull();
    const labels = [...document.querySelectorAll(".nt-palette-group-label")].map(
      (el) => el.textContent,
    );
    const rankOf = (label: string) => labels.indexOf(label);
    expect(rankOf("Classes")).toBeGreaterThanOrEqual(0);
    expect(rankOf("Properties")).toBeGreaterThan(rankOf("Classes"));
    expect(rankOf("Pages")).toBeGreaterThan(rankOf("Properties"));
    expect(rankOf("Content")).toBeGreaterThan(rankOf("Pages"));
  });
});

describe("CommandPalette date affordances", () => {
  it("formatted-date keywords offer the parsed date page (created on pick)", async () => {
    const { client } = await seedPaletteWorld();
    const { opened } = renderPalette(client);
    typeInPalette("feb 14");
    const row = await screen.findByText(/^Create date page: February 14, \d{4}$/);
    fireEvent.click(row);
    const dayId = chainNodeIds(`${new Date().getFullYear()}-02-14`).day;
    // ensureDateChain creates the year/month/day chain; the day page opens.
    await waitFor(() => expect(client.getNode(dayId)).not.toBeUndefined());
    expect(opened).toEqual([dayId]);
  });

  it("existing date pages match by raw compact keyword in the Date Pages section", async () => {
    const { client } = await seedPaletteWorld();
    await client.ensureDateChain("2026-03-05");
    renderPalette(client);
    typeInPalette("20260305");
    expect(await screen.findByText("Date Pages")).not.toBeNull();
    // The formatted display label renders (user dateFormat default YYYY-MM-DD).
    expect(await screen.findByText("2026-03-05")).not.toBeNull();
  });

  it("the is_daily: prefix scopes the palette to date pages", async () => {
    const { client } = await seedPaletteWorld();
    await client.ensureDateChain("2026-03-05");
    renderPalette(client);
    typeInPalette("is_daily:");
    expect(await screen.findByText("Date Pages")).not.toBeNull();
    // The date page lists; the ordinary pages and classes stay out.
    expect(screen.getByText("2026-03-05")).not.toBeNull();
    expect(screen.queryByText("Garden")).toBeNull();
    expect(screen.queryByText("Tulip Catalog")).toBeNull();
    expect(screen.queryByText("Pages")).toBeNull();
    expect(screen.queryByText("Classes")).toBeNull();
  });
});

describe("NodeSelector class refine", () => {
  it("a class: prefix narrows candidates to the class's members", async () => {
    const client = await seedClient();
    const fictionId = await createTitledClass(client, "Fiction");
    await client.createObject({ presentAsMain: true, name: "Dune", classIds: [fictionId] });
    await client.createObject({ presentAsMain: true, name: "Gardening Annual" });
    render(<NodeSelector client={client} trigger="inline" searchMode="all" onAdd={() => {}} />);

    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "class:Fiction " } });
    expect(await screen.findByText("Dune")).not.toBeNull();
    expect(screen.queryByText("Gardening Annual")).toBeNull();
    // Empty effective query: the create row waits for the rest of the query.
    expect(screen.queryByText(/^Create "/)).toBeNull();
  });

  it("spaced class names resolve greedily; the create row carries the refined class", async () => {
    const client = await seedClient();
    const myClassId = await createTitledClass(client, "My Class");
    await client.createObject({ presentAsMain: true, name: "Ada Lovelace", classIds: [myClassId] });
    render(<NodeSelector client={client} trigger="inline" searchMode="all" onAdd={() => {}} />);

    // The greedy name parse takes "My Class" (not "My"), leaving "lovelace".
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "class:My Class lovelace" } });
    expect(await screen.findByText("Ada Lovelace")).not.toBeNull();
    // The create row answers the REST of the query, not the raw prefix.
    const createRow = await screen.findByText('Create "lovelace"');
    fireEvent.click(createRow);
    // The picker clears its query on create; assert the created node through
    // the client once the async create lands.
    await waitFor(() => {
      const created = client.listPages().find((n) => deriveDisplayName(n) === "lovelace");
      expect(created).not.toBeUndefined();
      expect(created!.classIds).toContain(myClassId);
    });
  });
});

describe("NodeSelector block mode", () => {
  it("blocks mode lists only inline blocks, labeled by their containing page", async () => {
    const client = await seedClient();
    const notes = await client.createObject({ presentAsMain: true, name: "Notes" });
    await client.createObject({
      presentAsMain: false,
      parentId: notes,
      contentAst: [{ type: "text", text: "quixotic block text" }],
    });
    await client.createObject({ presentAsMain: true, name: "Quixotic Page" });
    const { container } = render(
      <NodeSelector client={client} trigger="inline" searchMode="blocks" onAdd={() => {}} />,
    );

    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "quixotic" } });
    // The block renders; the page with the matching TITLE stays out.
    expect(await screen.findByText("quixotic block text")).not.toBeNull();
    expect(screen.queryByText("Quixotic Page")).toBeNull();
    // The containing-page breadcrumb.
    const crumbs = container.querySelector(".node-result-item__crumbs");
    expect(crumbs?.textContent).toBe("Notes");
  });
});
