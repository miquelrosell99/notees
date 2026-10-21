/**
 * The block query builder end to end (jsdom over the in-process
 * WorkspaceClient + MemoryRelay): the FilterBar's structured panel is the
 * v1 builder ported over the query AST — conditions append from the add
 * menu and filter live (the "N of M nodes match" line updates on every
 * change), nested Match ALL/ANY groups and NOT wrappers compose, the
 * reorder chevrons swap rows within the parent, deletes and Clear filter
 * restore the set. The section-level contract (post-resolution counts,
 * per-tab isolation) lives in filter-layer.test.tsx; the pure data prune
 * in filter-query.test.ts.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/App.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
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

/**
 * A client with REST credentials — the section-view writes ("Save as tab")
 * ride the views REST channel. The fetch stub answers the views endpoints
 * (in-memory server rows, the create call recorded for the assertion).
 */
const SERVER = "https://notees.example.com";
const CREDENTIAL = "nt_testsession";
let serverViews: Array<Record<string, unknown>>;
let restCalls: Array<{ method: string; url: string; body?: unknown }>;

function stubViewsFetch(): void {
  serverViews = [];
  restCalls = [];
  const viewsPath = /\/api\/me\/nodes\/([^/]+)\/sections\/([^/]+)\/views(?:\/([^/]+)|\/order)?$/;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const match = viewsPath.exec(url);
      if (match === null) return new Response("not found", { status: 404 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      restCalls.push({ method, url, body });
      const scoped = () =>
        serverViews.filter(
          (view) => `${view.nodeId}|${view.sectionKey}` === `${match[1]}|${match[2]}`,
        );
      if (method === "GET" && match[3] === undefined) {
        return Response.json({
          views: [...scoped()].sort((a, b) => Number(a.sequence) - Number(b.sequence)),
        });
      }
      if (method === "POST" && match[3] === undefined) {
        const input = body as { name: string; queryAst: unknown; viewMode?: string | null };
        const existing = scoped();
        if (existing.some((view) => view.name === input.name)) {
          return Response.json({ error: { code: "conflict" } }, { status: 409 });
        }
        const view = {
          id: crypto.randomUUID(),
          nodeId: match[1]!,
          sectionKey: match[2]!,
          name: input.name,
          sequence: existing.reduce((max, entry) => Math.max(max, Number(entry.sequence)), -1) + 1,
          queryAst: input.queryAst,
          viewMode: input.viewMode ?? null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        serverViews.push(view);
        return Response.json({ view }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

async function seedRestClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    serverUrl: SERVER,
    apiKey: CREDENTIAL,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * the title through object.update instead. */
async function seedClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** The classed-nodes table's rendered row count. */
function tableRowCount(): number {
  return screen.getAllByRole("table")[0]!.querySelectorAll("td.nt-table-name").length;
}

/** The classed-nodes section wrapper. */
function classedNodesSection(): HTMLElement {
  const header = screen.getByRole("button", { name: /classed nodes/i });
  const section = header.closest("section");
  if (section === null) throw new Error("no classed-nodes section");
  return section as HTMLElement;
}

/** The open structured-facet panel of the visible FilterBar. */
function structuredPanel(): HTMLElement {
  const panel = document.querySelector(".nt-filter-bar__panel");
  if (panel === null) throw new Error("no structured filter panel open");
  return panel as HTMLElement;
}

/** Open the builder's structured panel. */
function openPanel(section: HTMLElement): HTMLElement {
  fireEvent.click(within(section).getByRole("button", { name: "Structured filters" }));
  return structuredPanel();
}

/** The panel's (or nested group's) add menu → pick one entry by label. The
 * menu portals to document.body (never clipped by the group card), so the
 * entry is queried inside the open menu panel, not the builder scope. */
function addCondition(scope: HTMLElement, label: RegExp): void {
  fireEvent.click(within(scope).getByRole("button", { name: "Add condition" }));
  const menu = document.querySelector(".btn-panel") as HTMLElement;
  fireEvent.click(within(menu).getByRole("menuitem", { name: label }));
}

/** The values of every content-condition input, in row order. */
function contentValues(scope: HTMLElement): string[] {
  return within(scope)
    .getAllByLabelText("Content")
    .map((input) => (input as HTMLInputElement).value);
}

/** Drive a kit Dropdown (the condition rows' selection columns): open the
 * trigger by aria-label, pick the menu item by name. `index` disambiguates
 * same-labelled triggers inside the scope (several rows). The menu portals
 * to document.body. */
function pickOption(scope: HTMLElement, label: string, option: string | RegExp, index = 0): void {
  fireEvent.click(within(scope).getAllByLabelText(label)[index]!);
  const menu = document.querySelector(".dropdown-menu--portal") as HTMLElement;
  fireEvent.click(within(menu).getByRole("option", { name: option }));
}

/** Drive the pill-cluster picker (the multi-value static pick): open the
 * "+ Add" pill by its accessible name, search, pick the first real result. */
function addNodeViaPicker(scope: HTMLElement, addLabel: string, query: string): void {
  fireEvent.click(within(scope).getByRole("button", { name: addLabel }));
  fireEvent.change(screen.getByLabelText("Search..."), { target: { value: query } });
  fireEvent.click(
    document.querySelector(
      ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
    )!,
  );
}

describe("the block query builder", () => {
  async function seedMembers(client: WorkspaceClient): Promise<string> {
    const classId = await seedClass(client, "project");
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const member = await client.createObject({ isEmbedded: false, name });
      await client.assignClass(member, classId);
    }
    return classId;
  }

  it("appends conditions from the add menu and filters live, naming the match in the panel", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(3);

    const panel = openPanel(section);
    // The root is NOT a group: no empty placeholder, no
    // count label — just the logic toggle and the add affordance.
    expect(within(panel).queryByText("No conditions in this group")).toBeNull();
    expect(within(panel).queryByText(/^\d+ conditions?$/)).toBeNull();
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });

    // …filters live: the table, the bar count and the panel's result line.
    expect(tableRowCount()).toBe(1);
    expect(within(section).getByText("1 of 3")).not.toBeNull();
    expect(within(panel).getByText("1 of 3 nodes match")).not.toBeNull();
    // The head-row logic control is the TEXT register: visible ALL/ANY segments, not the look-alike icons.
    expect(within(panel).getByText("ALL")).not.toBeNull();
    expect(within(panel).getByText("ANY")).not.toBeNull();
    expect(within(panel).getByText("Blocks")).not.toBeNull();
    expect(within(panel).getByText("Raw")).not.toBeNull();

    // A second condition ANDs: nothing is both Alpha and Beta — the table
    // empties (the empty state replaces it) and the panel names 0 of 3.
    addCondition(panel, /^Content/);
    const inputs = within(panel).getAllByLabelText("Content");
    fireEvent.change(inputs[1]!, { target: { value: "Beta" } });
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    expect(within(panel).getByText("0 of 3 nodes match")).not.toBeNull();
  });

  it("nested Match ANY groups OR their children", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    const panel = openPanel(section);
    addCondition(panel, /^Any of \(OR\)/);
    const nested = panel.querySelector(".nt-fb-group--nested") as HTMLElement;
    expect(nested).not.toBeNull();
    expect(within(nested).getByText("No conditions in this group")).not.toBeNull();

    addCondition(nested, /^Content/);
    fireEvent.change(within(nested).getByLabelText("Content"), { target: { value: "Alpha" } });
    addCondition(nested, /^Content/);
    fireEvent.change(within(nested).getAllByLabelText("Content")[1]!, { target: { value: "Beta" } });

    // Alpha OR Beta — Gamma drops.
    expect(tableRowCount()).toBe(2);
    expect(within(panel).getByText("2 of 3 nodes match")).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Alpha")).not.toBeNull();
    expect(within(table).getByText("Beta")).not.toBeNull();
    expect(within(table).queryByText("Gamma")).toBeNull();

    // The nested group's header delete removes the whole group.
    fireEvent.click(within(nested).getByRole("button", { name: "Remove group" }));
    expect(tableRowCount()).toBe(3);
  });

  it("a NOT wrapper excludes its child", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    const panel = openPanel(section);
    addCondition(panel, /^Exclude \(NOT\)/);
    const notWrapper = panel.querySelector(".nt-fb-not") as HTMLElement;
    expect(notWrapper).not.toBeNull();
    expect(within(notWrapper).getByText("NOT")).not.toBeNull();

    // An empty NOT prunes away entirely — no filtering happens.
    expect(tableRowCount()).toBe(3);

    addCondition(notWrapper, /^Content/);
    fireEvent.change(within(notWrapper).getByLabelText("Content"), { target: { value: "Alpha" } });

    // Everything but Alpha survives.
    expect(tableRowCount()).toBe(2);
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).queryByText("Alpha")).toBeNull();
    expect(within(table).getByText("Gamma")).not.toBeNull();
  });

  it("the reorder chevrons swap rows within the parent group", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    const panel = openPanel(section);
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getAllByLabelText("Content")[1]!, { target: { value: "Beta" } });
    expect(contentValues(panel)).toEqual(["Alpha", "Beta"]);

    // First row: Move down swaps; Move up is disabled at the top.
    const firstRow = within(panel).getByDisplayValue("Alpha").closest(".nt-fb-block") as HTMLElement;
    expect(within(firstRow).getByRole("button", { name: "Move up" })).toHaveProperty("disabled", true);
    fireEvent.click(within(firstRow).getByRole("button", { name: "Move down" }));
    expect(contentValues(panel)).toEqual(["Beta", "Alpha"]);

    // And back: the second row's Move up swaps it ahead.
    const alphaRow = within(panel).getByDisplayValue("Alpha").closest(".nt-fb-block") as HTMLElement;
    fireEvent.click(within(alphaRow).getByRole("button", { name: "Move up" }));
    expect(contentValues(panel)).toEqual(["Alpha", "Beta"]);
  });

  it("deleting a row and clearing the bar restore the full set", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    const panel = openPanel(section);
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
    expect(tableRowCount()).toBe(1);

    fireEvent.click(within(panel).getByRole("button", { name: "Remove Content condition" }));
    expect(within(panel).queryByText("No conditions in this group")).toBeNull();
    expect(tableRowCount()).toBe(3);
    // The whole query went inactive — the bar row's count is gone (the
    // panel's "3 of 3 nodes match" preview line stays while the panel is open).
    expect(within(section).queryByText("3 of 3")).toBeNull();

    // …and through the bar's Clear filter after a fresh condition.
    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Gamma" } });
    expect(tableRowCount()).toBe(1);
    fireEvent.click(within(section).getByRole("button", { name: "Clear filter" }));
    expect(tableRowCount()).toBe(3);
    // The panel closed with the clear (the bar's resting state).
    expect(structuredPanel).toThrow();
  });

  it("a class condition and the group logic toggle compose (Match ANY at the root)", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    const otherId = await seedClass(client, "client");
    // Gamma is classed in both — the AND/OR difference has a witness.
    const gammaId = client.getClassMembers(classId)[2]!.id;
    await client.assignClass(gammaId, otherId);

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(3);

    const panel = openPanel(section);
    addCondition(panel, /^Class/);
    // Gamma rides [project, client], so the membership reading ("contains"
    // — also the row's default since) is the AND-of-one
    // intent here; exact {client} would miss it. The default Class row
    // binds the LIST — the picked class rides a pill.
    addNodeViaPicker(panel, "Add class", "client");
    expect(tableRowCount()).toBe(1); // AND of one: only the double-classed Gamma.

    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();

    // Flip the root group to Match ANY: Alpha (the content hit) joins Gamma.
    fireEvent.click(within(panel).getByRole("radio", { name: "Match ANY condition" }));
    expect(tableRowCount()).toBe(2);
    expect(within(panel).getByText("2 of 3 nodes match")).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Alpha")).not.toBeNull();
    expect(within(table).getByText("Gamma")).not.toBeNull();
    expect(within(table).queryByText("Beta")).toBeNull();
    await act(async () => {});
  });

  it("a Child-path condition keeps only rows anywhere inside the chosen node's tree (v1's CHILD PATH)", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    const hub = await client.createObject({ isEmbedded: false, name: "Hub" });
    const inTree = await client.createObject({
      isEmbedded: false,
      name: "InTree",
      classIds: [classId],
      parentId: hub,
    });
    await client.createObject({
      isEmbedded: false,
      name: "Deep",
      classIds: [classId],
      parentId: inTree,
    });
    await client.createObject({ isEmbedded: false, name: "Outside", classIds: [classId] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(3);

    const panel = openPanel(section);
    addCondition(panel, /^Child path/);
    fireEvent.click(within(panel).getByRole("button", { name: "Add node" }));
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Hub" } });
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );

    // The direct child AND the grandchild ride the subtree; the
    // unparented row is out. Sync evaluation — no probe round.
    expect(tableRowCount()).toBe(2);
    expect(within(section).getByText("2 of 3")).not.toBeNull();
    // The sync arm: rows filter on the same render — no probe round happens
    // for the subtree condition (the Links-to test owns the probe arm).
  });

  it("dynamic Links: the target set is a nested query — links to a node matching class + property", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    // The TARGET family: a person class with an age property.
    const personId = await seedClass(client, "person");
    const ageId = await client.createPropertySchema({ name: "age", type: "number" });
    await client.setClassProperty(personId, ageId, {});
    const elder = await client.createObject({ isEmbedded: false, name: "Elder", classIds: [personId] });
    await client.setProperty(elder, ageId, 60, 0);
    // The row side: Linker (classed, links to Elder) and Plain (classed, no link).
    const linker = await client.createObject({ isEmbedded: false, name: "Linker", classIds: [classId] });
    await client.createObject({
      parentId: linker,
      contentAst: [{ type: "mention", targetNodeId: elder, text: "Elder" }],
    });
    await client.createObject({ isEmbedded: false, name: "Plain", classIds: [classId] });
    const probe = vi.spyOn(client, "runQueryAst").mockResolvedValue({ ids: [linker], rows: [] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(2);

    const panel = openPanel(section);
    addCondition(panel, /^Links /);
    // Switch the block to DYNAMIC mode — the nested query builder appears
    // inside a card.
    fireEvent.click(within(panel).getByRole("radio", { name: "Dynamic — a nested query" }));
    const nested = panel.querySelector(".nt-fb-block__nested") as HTMLElement;
    expect(nested).not.toBeNull();
    expect(nested.querySelector(".nt-fb-card")).not.toBeNull();
    // The nested group: person class + age > 50 (the owner's example shape).
    addCondition(nested, /^Class /);
    addNodeViaPicker(nested, "Add class", "person");
    addCondition(nested, /^Property/);
    pickOption(nested, "Property", "age");
    // Two blocks ride in the nested group — the Class row's operator dropdown
    // matches the same label; the Property row's is the second.
    pickOption(nested, "Operator", ">", 1);
    fireEvent.change(within(nested).getByLabelText("Value"), { target: { value: "50" } });

    await act(async () => {});
    await waitFor(() => expect(tableRowCount()).toBe(1));
    // The probe ran with the DYNAMIC condition carrying the nested group verbatim
    // (it fires per edit — the last call carries the complete nested query).
    const ast = probe.mock.calls.at(-1)![0] as { root: { children: Array<{ type: string; root?: unknown }> } };
    const dynamic = ast.root.children.find((child) => child.type === "linkedToQuery");
    expect(dynamic).toBeDefined();
    const nestedGroup = (dynamic as { root: { children: Array<{ type: string }> } }).root;
    // The nested Class row rides the multi-value default (classAny — the
    // membership register).
    expect(nestedGroup.children.map((child) => child.type)).toEqual(["classAny", "property"]);
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Linker")).not.toBeNull();
    expect(within(table).queryByText("Plain")).toBeNull();
    await act(async () => {});
  });

  it("Class flips to Dynamic — the nested query rides in a card and the probe carries classAnyQuery", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    await seedClass(client, "client");
    const probe = vi.spyOn(client, "runQueryAst").mockResolvedValue({ ids: [], rows: [] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    const panel = openPanel(section);
    addCondition(panel, /^Class/);
    // Flip the CLASS block to DYNAMIC mode: the
    // nested subgroup renders inside a card.
    fireEvent.click(within(panel).getByRole("radio", { name: "Dynamic — a nested query" }));
    const nested = panel.querySelector(".nt-fb-block__nested") as HTMLElement;
    expect(nested).not.toBeNull();
    expect(nested.querySelector(".nt-fb-card")).not.toBeNull();

    // A surviving nested condition makes the dynamic class ride the probe —
    // the wire carries the classAnyQuery condition verbatim.
    addCondition(nested, /^Class /);
    addNodeViaPicker(nested, "Add class", "client");
    await act(async () => {});
    expect(probe).toHaveBeenCalled();
    const ast = probe.mock.calls.at(-1)![0] as { root: { children: Array<{ type: string }> } };
    expect(ast.root.children.map((child) => child.type)).toContain("classAnyQuery");
  });

  it("a dynamic row inside a dynamic subgroup nests again (infinite dynamic nesting)", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    const probe = vi.spyOn(client, "runQueryAst").mockResolvedValue({ ids: [], rows: [] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    const panel = openPanel(section);
    addCondition(panel, /^Class/);
    fireEvent.click(within(panel).getByRole("radio", { name: "Dynamic — a nested query" }));
    const nested = panel.querySelector(".nt-fb-block__nested") as HTMLElement;
    expect(nested).not.toBeNull();

    // Inside the card, a Links row flips to Dynamic too — a SECOND-level
    // nested card renders (the empty inner subgroup prunes at compose time,
    // so no probe leaf fires).
    addCondition(nested, /^Links /);
    fireEvent.click(within(nested).getByRole("radio", { name: "Dynamic — a nested query" }));
    expect(panel.querySelectorAll(".nt-fb-block__nested")).toHaveLength(2);
    expect(panel.querySelectorAll(".nt-fb-block__nested .nt-fb-card")).toHaveLength(2);
    expect(probe).not.toHaveBeenCalled();
  });

  it("the value column rides the row's remaining width (operator → value, side to side)", async () => {
    const client = await seedClient();
    const classId = await seedMembers(client);
    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();

    const panel = openPanel(section);
    addCondition(panel, /^Content/);
    // jsdom has no layout — the width contract pins the DOM register: the
    // operator column precedes the value control on the row (the CSS spacer
    // is zero-width so the flex VALUE column absorbs the free space).
    const row = within(panel).getByLabelText("Content").closest(".nt-fb-block__row") as HTMLElement;
    const operator = within(row).getByLabelText("Operator");
    const value = within(row).getByLabelText("Content");
    expect(operator.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a Links-to condition rides the runQueryAst probe and intersects with the base rows", async () => {
    const client = await seedClient();
    const classId = await seedClass(client, "project");
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    const linker = await client.createObject({ isEmbedded: false, name: "Linker", classIds: [classId] });
    await client.createObject({
      parentId: linker,
      contentAst: [{ type: "mention", targetNodeId: target, text: "Target" }],
    });
    await client.createObject({ isEmbedded: false, name: "Plain", classIds: [classId] });
    // The probe channel is stubbed (the real SQL path is the query package's
    // contract); the hook's job is the intersect-with-base-rows wiring.
    const probe = vi.spyOn(client, "runQueryAst").mockResolvedValue({ ids: [linker], rows: [] });

    render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
    const section = classedNodesSection();
    expect(tableRowCount()).toBe(2);

    const panel = openPanel(section);
    addCondition(panel, /^Links /);
    // The default Links row binds the LIST — the target rides a pill via
    // the "+ Add node" picker.
    addNodeViaPicker(panel, "Add node", "Target");

    await waitFor(() => expect(tableRowCount()).toBe(1));
    expect(probe).toHaveBeenCalled();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Linker")).not.toBeNull();
    expect(within(table).queryByText("Plain")).toBeNull();
    await act(async () => {});
  });

  describe("the Odoo operator set + the classed-container families", () => {
    /**
     * The container world: InDay is an embedded project BLOCK under a
     * journal-classed page (Dayish); InPlain an embedded project block under
     * the unclassed Plain; Dual is a standalone page classed in BOTH project
     * and client under Plain (the exact-vs-membership witness).
     */
    async function seedContainerWorld(client: WorkspaceClient) {
      const projectId = await seedClass(client, "project");
      const journalId = await seedClass(client, "journal");
      const clientId = await seedClass(client, "client");
      const dayish = await client.createObject({ isEmbedded: false, name: "Dayish", classIds: [journalId] });
      const plain = await client.createObject({ isEmbedded: false, name: "Plain" });
      await client.createObject({ name: "InDay", classIds: [projectId], parentId: dayish });
      await client.createObject({ name: "InPlain", classIds: [projectId], parentId: plain });
      await client.createObject({
        isEmbedded: false,
        name: "Dual",
        classIds: [projectId, clientId],
        parentId: plain,
      });
      return { projectId, journalId, clientId, dayish, plain };
    }

    it("Class is and contains both read extends-inheriting closure membership", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();
      expect(tableRowCount()).toBe(3);

      const panel = openPanel(section);
      addCondition(panel, /^Class/);
      // Default operator "contains" = the LIST form: closure-aware ANY-of
      // over the picked classes — the class among others, so Dual riding
      // [project, client] stays.
      addNodeViaPicker(panel, "Add class", "project");
      expect(tableRowCount()).toBe(3);

      // "is" = the SINGLE-PILL form of the SAME closure membership ("is fuente" matches a node classed book when
      // book extends fuente; the exact-set register is legacy-wire-only):
      // the picked id carries across the morph, Dual still rides.
      pickOption(panel, "Operator", "is");
      expect(tableRowCount()).toBe(3);
      expect(within(section).getByText("Dual")).not.toBeNull();
      // The single-slot register: the "+ Add class" pill hides while the
      // slot is filled (clear via the pill's × first).
      expect(within(panel).queryByRole("button", { name: "Add class" })).toBeNull();
    });

    it("contains matches ANY picked class (the multi pill pick); does not contain negates", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Class/);
      // The default Class row binds the LIST — the pills accumulate through
      // the class picker, one ANY-of member at a time.
      addNodeViaPicker(panel, "Add class", "project");
      addNodeViaPicker(panel, "Add class", "client");
      expect(tableRowCount()).toBe(3);

      pickOption(panel, "Operator", "does not contain");
      expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    });

    it("is set / is not set test the class set's emptiness", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Class/);
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(3);
      pickOption(panel, "Operator", "is not set");
      expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    });

    it("Page: static — the containing page is a single picked node (v1's Page block, single-value register)", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Page\b/);
      pickOption(panel, "Operator", "is");
      addNodeViaPicker(panel, "Add page", "Dayish");
      // Single-slot: the AddPill disappears once the slot is filled.
      expect(within(panel).queryByRole("button", { name: "Add page" })).toBeNull();
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("InDay")).not.toBeNull();

      pickOption(panel, "Operator", "is not");
      expect(tableRowCount()).toBe(2);
      expect(within(section).queryByText("InDay")).toBeNull();
    });

    it("Page: dynamic — the subquery informs the node set (v1's nested-query mode)", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Page\b/);
      // Flip the target mode to dynamic — the nested builder appears inside
      // a card beneath the row; the subquery's matches BECOME the page set.
      fireEvent.click(within(panel).getByRole("radio", { name: "Dynamic — a nested query" }));
      const nested = panel.querySelector(".nt-fb-block__nested") as HTMLElement;
      expect(nested).not.toBeNull();
      expect(nested.querySelector(".nt-fb-card")).not.toBeNull();
      addCondition(nested, /^Class /);
      // Membership ("contains") is the intent — the Class row's default
      // operator since.
      addNodeViaPicker(nested, "Add class", "journal");
      // The dynamic container rides the probe path — the membership set
      // lands one beat after the pick.
      await waitFor(() => expect(tableRowCount()).toBe(1));
      expect(within(section).getByText("InDay")).not.toBeNull();
    });

    it("Page: is set — the row lives inside a page", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Page\b/);
      pickOption(panel, "Operator", "is set");
      // InDay/InPlain are embedded blocks; Dual is its own page.
      expect(tableRowCount()).toBe(2);
      expect(within(section).queryByText("Dual")).toBeNull();
    });

    it("Parent path: includes any of the picked nodes (static) + the set bit", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Parent path/);
      addNodeViaPicker(panel, "Add ancestor", "Dayish");
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("InDay")).not.toBeNull();

      // is set = has an ancestor at all (every member is parented).
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(3);
    });

    it("Root: the workspace-root ancestor is a single picked node (single-value register)", async () => {
      const client = await seedClient();
      const { projectId } = await seedContainerWorld(client);
      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Root/);
      pickOption(panel, "Operator", "is");
      addNodeViaPicker(panel, "Add root", "Dayish");
      // Single-slot: the AddPill disappears once the slot is filled.
      expect(within(panel).queryByRole("button", { name: "Add root" })).toBeNull();
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("InDay")).not.toBeNull();

      pickOption(panel, "Operator", "is not");
      expect(tableRowCount()).toBe(2);
    });

    it("Parent (v1's direct parent): is a single picked node + the set bit", async () => {
      const client = await seedClient();
      const projectId = await seedClass(client, "project");
      const p = await client.createObject({ isEmbedded: false, name: "P" });
      const q = await client.createObject({ isEmbedded: false, name: "Q" });
      await client.createObject({ name: "ChildOfP", classIds: [projectId], parentId: p });
      await client.createObject({ name: "ChildOfQ", classIds: [projectId], parentId: q });
      await client.createObject({ isEmbedded: false, name: "RootMember", classIds: [projectId] });

      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();
      expect(tableRowCount()).toBe(3);

      const panel = openPanel(section);
      addCondition(panel, /^Parent The/);
      pickOption(panel, "Operator", "is");
      addNodeViaPicker(panel, "Add parent", "P");
      // Single-slot: the AddPill disappears once the slot is filled.
      expect(within(panel).queryByRole("button", { name: "Add parent" })).toBeNull();
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("ChildOfP")).not.toBeNull();

      // is set = has a parent at all (the root member drops out).
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(2);
      expect(within(section).queryByText("RootMember")).toBeNull();
    });

    it("Child (v1's direct child): contains any of the picked nodes + the set bit", async () => {
      const client = await seedClient();
      const projectId = await seedClass(client, "project");
      const withKid = await client.createObject({ isEmbedded: false, name: "WithKid", classIds: [projectId] });
      await client.createObject({ isEmbedded: false, name: "Kid", parentId: withKid });
      await client.createObject({ isEmbedded: false, name: "NoKid", classIds: [projectId] });

      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Child Contains/);
      addNodeViaPicker(panel, "Add child", "Kid");
      pickOption(panel, "Operator", "contains any of");
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("WithKid")).not.toBeNull();

      // is set = has a direct child at all (NoKid drops out).
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(1);
    });

    it("Reference path (v1's rollup): the node or its ancestors reference the targets — or sit inside them", async () => {
      const client = await seedClient();
      const projectId = await seedClass(client, "project");
      const target = await client.createObject({ isEmbedded: false, name: "Target" });
      // Edge arm: Linker (a BLOCK — create-as-page stringifies rich content,
      // so the mention must ride a block's own content) mentions Target.
      const holder = await client.createObject({ isEmbedded: false, name: "Holder" });
      await client.createObject({
        name: "Linker",
        classIds: [projectId],
        parentId: holder,
        contentAst: [{ type: "mention", targetNodeId: target, text: "Target" }],
      });
      // Containment arm: InsideT sits inside Target.
      await client.createObject({ isEmbedded: false, name: "InsideT", classIds: [projectId], parentId: target });
      await client.createObject({ isEmbedded: false, name: "Plain", classIds: [projectId] });
      const probe = vi.spyOn(client, "runQueryAst");

      render(<NodeView client={client} nodeId={projectId} onOpenNode={() => {}} />);
      const section = classedNodesSection();
      expect(tableRowCount()).toBe(3);

      const panel = openPanel(section);
      addCondition(panel, /^Reference path/);
      addNodeViaPicker(panel, "Add target", "Target");
      // The rollup rides the probe path — the membership set lands a beat
      // later. (Linker's title IS its mention text — "Target" — so the count
      // and InsideT's presence stand in for it.)
      await waitFor(() => expect(tableRowCount()).toBe(2));
      expect(within(section).getByText("InsideT")).not.toBeNull();
      expect(within(section).queryByText("Plain")).toBeNull();
      expect(probe).toHaveBeenCalled();
    });

    it("content: the text operators (is / starts with / is set)", async () => {
      const client = await seedClient();
      const classId = await seedMembers(client);
      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Content/);
      pickOption(panel, "Operator", "is");
      fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
      expect(tableRowCount()).toBe(1);

      fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alph" } });
      expect(within(section).getByText("No classed nodes.")).not.toBeNull();

      pickOption(panel, "Operator", "starts with");
      fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alph" } });
      expect(tableRowCount()).toBe(1);

      // The emptiness bit: every member carries a title.
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(3);
    });

    it("tags: is set / is (multi ANY-of) / is not over the OR-set tag membership", async () => {
      const client = await seedClient();
      const classId = await seedMembers(client);
      const tagUrgent = await client.createObject({ isEmbedded: false, name: "Urgent" });
      const tagLater = await client.createObject({ isEmbedded: false, name: "Later" });
      const [alpha, beta] = client.getClassMembers(classId).map((member) => member.id);
      await client.assignTag(alpha!, tagUrgent);
      await client.assignTag(beta!, tagUrgent);
      await client.assignTag(beta!, tagLater);

      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Tags/);
      // The default "is" binds the LIST: the pills
      // accumulate through the picker — ANY-of [Urgent, Later] keeps Alpha
      // AND Beta.
      addNodeViaPicker(panel, "Add tag", "Urgent");
      addNodeViaPicker(panel, "Add tag", "Later");
      expect(tableRowCount()).toBe(2);

      // The negative register: "is not" keeps only the untagged Gamma.
      pickOption(panel, "Operator", "is not");
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("Gamma")).not.toBeNull();

      // The emptiness bit: the two tagged members survive "is set".
      pickOption(panel, "Operator", "is set");
      expect(tableRowCount()).toBe(2);
    });

    it("dates: is between (two bounds) and is within (relative period)", async () => {
      const client = await seedClient();
      const classId = await seedMembers(client);
      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Created/);
      pickOption(panel, "Operator", "is between");
      fireEvent.change(within(panel).getByLabelText("From"), { target: { value: "{today}" } });
      fireEvent.change(within(panel).getByLabelText("To"), { target: { value: "{today}" } });
      expect(tableRowCount()).toBe(3);

      // An impossible range (future floor) matches nothing.
      fireEvent.change(within(panel).getByLabelText("From"), { target: { value: "2999-01-01" } });
      expect(within(section).getByText("No classed nodes.")).not.toBeNull();

      // The relative period rides the same run clock as the placeholders.
      pickOption(panel, "Operator", "is within");
      pickOption(panel, "Period", "Today");
      expect(tableRowCount()).toBe(3);
      pickOption(panel, "Period", "This year");
      expect(tableRowCount()).toBe(3);
    });

    it("property: is between on a number property + the type-aware option pick", async () => {
      const client = await seedClient();
      const classId = await seedClass(client, "task");
      const schemaId = await client.createPropertySchema({ name: "impact", type: "number" });
      await client.setClassProperty(classId, schemaId, {});
      const low = await client.createObject({ isEmbedded: false, name: "Low impact" });
      await client.assignClass(low, classId);
      await client.setProperty(low, schemaId, 1, 0);
      const high = await client.createObject({ isEmbedded: false, name: "High impact" });
      await client.assignClass(high, classId);
      await client.setProperty(high, schemaId, 9, 0);

      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Property/);
      pickOption(panel, "Property", "impact");
      pickOption(panel, "Operator", "is between");
      fireEvent.change(within(panel).getByLabelText("From"), { target: { value: "5" } });
      fireEvent.change(within(panel).getByLabelText("To"), { target: { value: "10" } });
      expect(tableRowCount()).toBe(1);
      expect(within(section).getByText("High impact")).not.toBeNull();
    });
  });

  describe("the escapes from transience", () => {
    it("the blocks ⇄ raw AST toggle: the composed query round-trips through JSON", async () => {
      const client = await seedClient();
      const classId = await seedMembers(client);
      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Class/);
      addNodeViaPicker(panel, "Add class", "project");

      // Switch to the raw register: the COMPOSED draft serializes into the
      // textarea (the pruned group — half-typed rows drop by design).
      fireEvent.click(within(panel).getByRole("radio", { name: "Raw AST" }));
      const raw = within(panel).getByLabelText("Query AST (JSON)") as HTMLTextAreaElement;
      expect(raw.value).toContain('"type": "classAny"');

      // Paste an edited query — a second condition joins — and apply.
      fireEvent.change(raw, {
        target: {
          value: JSON.stringify({
            type: "group",
            logic: "and",
            children: [
              { type: "classAny", classIds: [classId] },
              { type: "content", op: "contains", value: "Alpha" },
            ],
          }),
        },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
      // The apply landed: the normalized JSON re-serialized into the textarea.
      expect(
        (within(panel).getByLabelText("Query AST (JSON)") as HTMLTextAreaElement).value,
      ).toContain('"value": "Alpha"');
      // …and the blocks reflect it.
      fireEvent.click(within(panel).getByRole("radio", { name: "Blocks" }));
      expect((within(panel).getByLabelText("Content") as HTMLInputElement).value).toBe("Alpha");
      expect(tableRowCount()).toBe(1);

      // Invalid JSON: the error line names the issue, the draft stays.
      fireEvent.click(within(panel).getByRole("radio", { name: "Raw AST" }));
      fireEvent.change(within(panel).getByLabelText("Query AST (JSON)"), {
        target: { value: "{ not json" },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
      expect(within(panel).getByRole("alert").textContent).toContain("Invalid JSON");

      // Schema-valid JSON that is not a query group: rejected too.
      fireEvent.change(within(panel).getByLabelText("Query AST (JSON)"), {
        target: {
          value: JSON.stringify({
            type: "group",
            logic: "and",
            children: [{ type: "classAny", classIds: [] }],
          }),
        },
      });
      fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
      expect(within(panel).getByRole("alert").textContent).toContain("Not a query group");

      // The draft never moved: back in blocks the Content row still reads.
      fireEvent.click(within(panel).getByRole("radio", { name: "Blocks" }));
      expect((within(panel).getByLabelText("Content") as HTMLInputElement).value).toBe("Alpha");
      expect(tableRowCount()).toBe(1);
    });

    it("Save as tab persists the composed draft as a new section view and selects it", async () => {
      stubViewsFetch();
      const client = await seedRestClient();
      const classId = await seedMembers(client);
      render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);
      const section = classedNodesSection();

      const panel = openPanel(section);
      addCondition(panel, /^Class/);
      addNodeViaPicker(panel, "Add class", "project");
      addCondition(panel, /^Content/);
      fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
      expect(tableRowCount()).toBe(1);
      expect(within(panel).getByText("1 of 3 nodes match")).not.toBeNull();
      // The count line rides the builder's FOOT row.
      expect(panel.querySelector(".nt-fb__foot")?.textContent).toContain("1 of 3 nodes match");
      // Let the section's initial views load land before the write — a late
      // GET resolution would otherwise overwrite the optimistic row.
      await act(async () => {});

      fireEvent.click(within(panel).getByRole("button", { name: "Save as tab" }));

      // The tab strip gained an auto-named tab, SELECTED, and it owns the
      // query now — the refined row set renders and the transient filter
      // (panel + bar count) cleared. The save lands a tick after the click
      // (the create round-trips the REST channel); the tab re-queries inside
      // the wait — the optimistic row unmounts when the server row replaces
      // it (a fresh DOM node).
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "View 1" }).getAttribute("aria-selected")).toBe("true");
      });
      expect(tableRowCount()).toBe(1);
      expect(within(section).queryByText("1 of 3 nodes match")).toBeNull();
      expect(within(section).queryByText("1 of 3")).toBeNull();

      // The persisted envelope: the composed group rides a full QueryAst
      // (version + scope + root) under the auto label.
      const create = restCalls.find((call) => call.method === "POST");
      expect(create).toBeDefined();
      expect(new URL(create!.url).pathname).toBe(
        `/api/me/nodes/${classId}/sections/classed-nodes/views`,
      );
      expect(create!.body).toEqual({
        name: "View 1",
        queryAst: {
          version: 1,
          scope: { type: "entire_workspace" },
          root: {
            type: "group",
            logic: "and",
            children: [
              { type: "classAny", classIds: [classId] },
              { type: "content", op: "contains", value: "Alpha" },
            ],
          },
        },
      });
    });
  });
});
