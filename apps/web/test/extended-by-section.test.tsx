/**
 * ExtendedBySection tests (jsdom): the "Extended by" system section on a
 * class page — hidden while no class extends this one, a tree of the
 * extenders once any do, each level nesting under its DIRECT parent only
 * (a grandchild renders as its parent's child, never as a top-level row
 * under the ancestor).
 *
 * The hide-when-empty early return sat BEFORE the useMemo — a
 * rules-of-hooks violation in the historical title-editor crash class.
 * Empirically React 19 does NOT crash on this instance's 0↔1-hook flip
 * (a fiber that rendered zero hooks is re-mounted, not updated), so this
 * is behavior coverage plus hygiene, not a red-checked crash regression:
 * the day a hook lands above the return, the same shape WOULD crash (the
 * old bespoke title editor did — its early-return branch still called
 * four hooks).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";

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
 * the title through object.update (same helper as class-view.test.tsx). */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const classId = await client.createClass(title);
  await client.updateObject(classId, { contentAst: [{ type: "text", text: title }] });
  return classId;
}

describe("ExtendedBySection", () => {
  it("stays hidden while empty and appears when the first extends edge arrives on the same instance", async () => {
    const client = await seedClient();
    const parentId = await createTitledClass(client, "source");
    const childId = await createTitledClass(client, "episode");
    const view = render(<NodeView client={client} nodeId={parentId} onOpenNode={() => {}} />);
    // Hidden while empty — no section chrome at all.
    expect(screen.queryByText("Extended by")).toBeNull();
    // The first extends edge lands (sync-equivalent write) and the SAME
    // The NodeView/section instance re-renders (see the file header for why
    // this is behavior coverage, not a red-checked crash regression).
    await client.setClassExtends(childId, [parentId]);
    view.rerender(<NodeView client={client} nodeId={parentId} onOpenNode={() => {}} />);
    expect(screen.getByText("Extended by")).not.toBeNull();
  });

  it("nests each extender under its DIRECT parent only", async () => {
    const client = await seedClient();
    const parentId = await createTitledClass(client, "work");
    const midId = await createTitledClass(client, "tv series");
    const leafId = await createTitledClass(client, "episode");
    await client.setClassExtends(midId, [parentId]);
    await client.setClassExtends(leafId, [midId]);
    const view = render(<NodeView client={client} nodeId={parentId} onOpenNode={() => {}} />);
    const header = screen.getByText("Extended by");
    const section = header.closest(".nt-section");
    expect(section).not.toBeNull();
    const midRow = section!.querySelector(`[data-block-id="${midId}"]`);
    const leafRow = section!.querySelector(`[data-block-id="${leafId}"]`);
    // Both render — the leaf as a CHILD of the mid row (nested under its
    // direct parent), never as its own top-level row under the grandparent.
    expect(midRow).not.toBeNull();
    expect(leafRow).not.toBeNull();
    // (closest() includes the element itself — step out of the leaf row
    // before walking up to the containing block.)
    expect(leafRow!.parentElement!.closest("[data-block-id]")).toBe(midRow);
    // Exactly the two family rows render in the section — the leaf has no
    // top-level duplicate under the ancestor.
    expect(section!.querySelectorAll("[data-block-id]")).toHaveLength(2);
    // The direct extender is a top-level tree row.
    expect(midRow!.parentElement!.classList.contains("nt-block-tree")).toBe(true);
    // The badge counts the DIRECT extenders only.
    expect(section!.textContent).toContain("Extended by1");
    // Sanity: the leaf renders under its direct parent's own section too.
    view.rerender(<NodeView client={client} nodeId={midId} onOpenNode={() => {}} />);
    const midSection = screen.getByText("Extended by").closest(".nt-section");
    expect(midSection!.querySelector(`[data-block-id="${leafId}"]`)).not.toBeNull();
  });

  it("hides the backlink count flag on the rows (owner 2026-10-13)", async () => {
    const client = await seedClient();
    const parentId = await createTitledClass(client, "work");
    const midId = await createTitledClass(client, "tv series");
    await client.setClassExtends(midId, [parentId]);
    // A page mentioning the mid class gives it a materialized backlink count.
    const pageId = await client.createObject({});
    await client.updateObject(pageId, {
      contentAst: [{ type: "mention", targetNodeId: midId, text: "tv series" }],
    });
    expect(client.getBacklinkCount(midId)).toBeGreaterThan(0);
    render(<NodeView client={client} nodeId={parentId} onOpenNode={() => {}} />);
    const section = screen.getByText("Extended by").closest(".nt-section");
    expect(section).not.toBeNull();
    // The count is real but the gutter toggle stays out of the list.
    expect(section!.querySelector(".nt-block-backlink-toggle")).toBeNull();
    expect(section!.querySelector(".nt-block-backlink-refs")).toBeNull();
  });
});
