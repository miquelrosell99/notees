/**
 * The block query builder end to end (jsdom over the in-process
 * WorkspaceClient + MemoryRelay): the FilterBar's structured panel is the
 * v1 builder ported over the query AST — conditions append from the add
 * menu and filter live (the "N of M rows match" line updates on every
 * change), nested Match ALL/ANY groups and NOT wrappers compose, the
 * reorder chevrons swap rows within the parent, deletes and Clear filter
 * restore the set. The section-level contract (post-resolution counts,
 * per-tab isolation) lives in filter-layer.test.tsx; the pure data prune
 * in filter-query.test.ts.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";

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

/** WORKAROUND(store applier): class.create's contentAst never lands — seed
 * the title through object.update instead. */
async function seedClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

/** The classed-nodes table's rendered row count. */
function tableRowCount(): number {
  return screen.getAllByRole("table")[0]!.querySelectorAll(".nt-table-name-label").length;
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
  fireEvent.click(within(menu).getByRole("button", { name: label }));
}

/** The values of every content-condition input, in row order. */
function contentValues(scope: HTMLElement): string[] {
  return within(scope)
    .getAllByLabelText("Content")
    .map((input) => (input as HTMLInputElement).value);
}

describe("the block query builder", () => {
  async function seedMembers(client: WorkspaceClient): Promise<string> {
    const classId = await seedClass(client, "project");
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const member = await client.createObject({ presentAsMain: true, name });
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
    // The empty group's honest line, then a content condition…
    expect(within(panel).getByText("No conditions in this group")).not.toBeNull();
    addCondition(panel, /^Content/);
    expect(within(panel).getByText("1 condition")).not.toBeNull();
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });

    // …filters live: the table, the bar count and the panel's result line.
    expect(tableRowCount()).toBe(1);
    expect(within(section).getByText("1 of 3")).not.toBeNull();
    expect(within(panel).getByText("1 of 3 rows match")).not.toBeNull();

    // A second condition ANDs: nothing is both Alpha and Beta — the table
    // empties (the empty state replaces it) and the panel names 0 of 3.
    addCondition(panel, /^Content/);
    const inputs = within(panel).getAllByLabelText("Content");
    fireEvent.change(inputs[1]!, { target: { value: "Beta" } });
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();
    expect(within(panel).getByText("0 of 3 rows match")).not.toBeNull();
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
    expect(within(panel).getByText("2 of 3 rows match")).not.toBeNull();
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
    const firstRow = within(panel).getByDisplayValue("Alpha").closest(".nt-fb-condition") as HTMLElement;
    expect(within(firstRow).getByRole("button", { name: "Move up" })).toHaveProperty("disabled", true);
    fireEvent.click(within(firstRow).getByRole("button", { name: "Move down" }));
    expect(contentValues(panel)).toEqual(["Beta", "Alpha"]);

    // And back: the second row's Move up swaps it ahead.
    const alphaRow = within(panel).getByDisplayValue("Alpha").closest(".nt-fb-condition") as HTMLElement;
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
    expect(within(panel).getByText("No conditions in this group")).not.toBeNull();
    expect(tableRowCount()).toBe(3);
    // The whole query went inactive — the bar row's count is gone (the
    // panel's "3 of 3 rows match" preview line stays while the panel is open).
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
    fireEvent.change(within(panel).getByLabelText("Class"), { target: { value: otherId } });
    expect(tableRowCount()).toBe(1); // AND of one: only the double-classed Gamma.

    addCondition(panel, /^Content/);
    fireEvent.change(within(panel).getByLabelText("Content"), { target: { value: "Alpha" } });
    expect(within(section).getByText("No classed nodes.")).not.toBeNull();

    // Flip the root group to Match ANY: Alpha (the content hit) joins Gamma.
    fireEvent.click(within(panel).getByRole("radio", { name: "Match ANY condition" }));
    expect(tableRowCount()).toBe(2);
    expect(within(panel).getByText("2 of 3 rows match")).not.toBeNull();
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Alpha")).not.toBeNull();
    expect(within(table).getByText("Gamma")).not.toBeNull();
    expect(within(table).queryByText("Beta")).toBeNull();
    await act(async () => {});
  });
});
