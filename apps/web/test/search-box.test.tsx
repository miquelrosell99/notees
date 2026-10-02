/**
 * SearchBox tests (jsdom): the sidebar search field over a seeded
 * WorkspaceClient — plain text routes to client.search (FTS), query-language
 * syntax compiles with local-store name resolvers and runs through
 * client.runQueryAst, parse/resolution errors surface inline (fail loud), the
 * syntax hint toggles the cheatsheet, and result clicks navigate.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { SearchBox } from "../src/ui/SearchBox.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

interface World {
  client: WorkspaceClient;
  paperClassId: string;
  oldPaper: string;
  modernPaper: string;
  notes: string;
}

async function seedWorld(): Promise<World> {
  const client = await seedClient();
  const paperClassId = await client.createClass("paper");
  const year = await client.createPropertySchema({ name: "year", type: "number" });
  const oldPaper = await client.createObject({ presentAsMain: true, name: "Old Paper", classIds: [paperClassId] });
  await client.setProperty(oldPaper, year, 1901);
  const modernPaper = await client.createObject({ presentAsMain: true, name: "Modern Paper", classIds: [paperClassId] });
  await client.setProperty(modernPaper, year, 2015);
  await client.createObject({ presentAsMain: true, name: "Cooking Notes" });
  const notes = await client.createObject({
    presentAsMain: true,
    name: "Reading Notes",
  });
  // Title-is-content: the mention link lives in a child BLOCK; the page's
  // own content is its title text.
  await client.createObject({
    parentId: notes,
    contentAst: [{ type: "mention", targetNodeId: modernPaper, text: "Modern Paper" }],
  });
  return { client, paperClassId, oldPaper, modernPaper, notes };
}

function typeQuery(text: string): void {
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: text } });
}

describe("SearchBox", () => {
  it("re-runs the search when cacheVersion bumps (async cache refresh lands)", async () => {
    const { client } = await seedWorld();
    // Model the WorkerClient read cache: search() seeds [] and only converges
    // after a notification (cacheVersion bump), like the real boot.
    let converged = false;
    const cached = {
      ...client,
      search: (q: string) => (converged ? client.search(q) : []),
    };
    const { rerender } = render(
      <SearchBox client={cached as WorkspaceClient} onOpenNode={() => {}} cacheVersion={0} />,
    );
    typeQuery("cooking");
    expect(await screen.findByText("No results.")).not.toBeNull();
    converged = true;
    rerender(<SearchBox client={cached as WorkspaceClient} onOpenNode={() => {}} cacheVersion={1} />);
    expect(await screen.findByText("Cooking Notes")).not.toBeNull();
  });

  it("plain text falls back to FTS search", async () => {
    const { client } = await seedWorld();
    const opened: string[] = [];
    render(<SearchBox client={client} onOpenNode={(id) => opened.push(id)} cacheVersion={0} />);

    typeQuery("cooking");
    const hit = await screen.findByText("Cooking Notes");
    expect(screen.queryByText("Old Paper")).toBeNull();

    fireEvent.click(hit);
    expect(opened).toHaveLength(1);
  });

  it("query-language input runs through runQueryAst with name resolvers", async () => {
    const { client } = await seedWorld();
    render(<SearchBox client={client} onOpenNode={() => {}} cacheVersion={0} />);

    typeQuery("class:paper AND year:>2010");
    expect(await screen.findByText("Modern Paper")).not.toBeNull();
    expect(screen.queryByText("Old Paper")).toBeNull();
    // Each hit carries its render-state chip.
    expect(screen.getByText("Page")).not.toBeNull();
  });

  it("resolves linked: node names and prop: schema names", async () => {
    const { client } = await seedWorld();
    render(<SearchBox client={client} onOpenNode={() => {}} cacheVersion={0} />);

    // Title-is-content: the mention lives on a child BLOCK of Reading Notes,
    // so linked: returns the linking block (its excerpt is the mention text).
    typeQuery('linked:"Modern Paper"');
    await screen.findAllByRole("button", { name: /Modern Paper/ });
    expect(screen.queryByText("Cooking Notes")).toBeNull();

    typeQuery("prop:year:<1950");
    expect(await screen.findByText("Old Paper")).not.toBeNull();
    expect(screen.queryByText("Modern Paper")).toBeNull();
  });

  it("DSL errors surface inline and never fall back to text search", async () => {
    const { client } = await seedWorld();
    render(<SearchBox client={client} onOpenNode={() => {}} cacheVersion={0} />);

    typeQuery("class:nosuchclass");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("unknown class 'nosuchclass'");
    expect(screen.queryByText("Old Paper")).toBeNull();
  });

  it("the syntax hint toggles the grammar cheatsheet", async () => {
    const { client } = await seedWorld();
    render(<SearchBox client={client} onOpenNode={() => {}} cacheVersion={0} />);

    expect(screen.queryByText(/quoted phrase/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Search syntax"));
    expect(screen.getByText(/quoted phrase/)).not.toBeNull();
    expect(screen.getByText(/AND OR NOT/)).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Search syntax"));
    expect(screen.queryByText(/quoted phrase/)).toBeNull();
  });

  it("empty input shows no results", async () => {
    const { client } = await seedWorld();
    const { container } = render(<SearchBox client={client} onOpenNode={() => {}} cacheVersion={0} />);

    typeQuery("paper");
    await screen.findByText("Old Paper");
    typeQuery("");
    expect(container.querySelector(".nt-search-results")).toBeNull();
  });
});
