/**
 * Search & command palette wave (§34.30 M4/M6/M7/M8 + §34.28 #12) — jsdom
 * over the in-process WorkspaceClient:
 *
 *  - CommandPalette sections (M6): Recent (device-local recents, empty query
 *    only), Date Pages (§34.28 #12), Pages, Classes, Content (M4), Commands
 *    (the action registry, with the query-scoped typed create);
 *  - the Content group debounces the ranked FTS, renders M3 snippets, and
 *    labels block hits with their containing page;
 *  - the `is_daily:` prefix scopes the palette to the Date Pages section,
 *    and formatted-date keywords ("feb 14") map onto the deterministic date
 *    chain (create-on-pick via ensureDateChain);
 *  - NodeSelector (M7): a leading `class:<name>` prefix refines candidates
 *    to that class's members, and the create row answers the rest of the
 *    query carrying the refined class;
 *  - NodeSelector (M8): searchMode="blocks" lists only inline blocks, each
 *    labeled with its containing-page path.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { chainNodeIds, deriveDisplayName } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
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
  } = {},
) {
  const opened: string[] = [];
  const created: Array<string | undefined> = [];
  render(
    <CommandPalette
      client={client}
      open
      onRequestOpen={() => {}}
      onClose={() => {}}
      onOpenNode={handlers.onOpenNode ?? ((id) => opened.push(id))}
      onNewPage={handlers.onNewPage ?? ((title) => created.push(title))}
      onSignOut={() => {}}
      cacheVersion={0}
    />,
  );
  return { opened, created };
}

const typeInPalette = (text: string): void => {
  fireEvent.change(screen.getByLabelText("Command palette search"), { target: { value: text } });
};

describe("CommandPalette sections (M6 + §34.28 #12)", () => {
  it("empty query shows the device-local Recent section and the Commands registry", async () => {
    const { client, garden } = await seedPaletteWorld();
    localStorage.setItem("notees.recents", JSON.stringify([garden]));
    renderPalette(client);

    expect(await screen.findByText("Recent")).not.toBeNull();
    expect(screen.getByText("Garden")).not.toBeNull();
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
    expect(screen.getByText("Garden")).not.toBeNull();
  });

  it("typed creation: the Commands registry offers 'Create page \"<query>\"'", async () => {
    const { client } = await seedPaletteWorld();
    const { created } = renderPalette(client);
    typeInPalette("Shopping List");
    const row = await screen.findByText('Create page "Shopping List"');
    fireEvent.click(row);
    expect(created).toEqual(["Shopping List"]);
  });
});

describe("CommandPalette Content group (M4)", () => {
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

describe("CommandPalette date affordances (§34.28 #12)", () => {
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

describe("NodeSelector class refine (M7)", () => {
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

describe("NodeSelector block mode (M8)", () => {
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
    // The containing-page label (the M8 breadcrumb).
    const crumbs = container.querySelector(".node-result-item__crumbs");
    expect(crumbs?.textContent).toBe("Notes");
  });
});
