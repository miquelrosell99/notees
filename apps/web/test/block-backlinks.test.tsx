/**
 * Block-level backlink gutter tests (SCHEMA.md:117): a block
 * with backlinks shows a right-gutter toggle carrying the materialized
 * node_stats count (renders unconditionally, exempt from the lazy-loading
 * contract); toggling expands the linked-references system query scoped to
 * the block, rendered inline beneath the row — the query runs on first
 * toggle and caches until an invalidating notification. jsdom over the
 * in-process WorkspaceClient.
 *
 * The laziness assertions scope the query spy to the BLOCK's id: the
 * page-level backlinks strip (owner 2026-10-06) loads the PAGE's references
 * on mount, so a bare call-count would include the strip's mount query.
 *
 * Every write kicks a floating engine push whose ack notifies later
 * (microtasks), so each test flushes the queue after seeding — the late
 * acks are legitimate invalidations, not fixture noise.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

describe("block-level backlink gutter", () => {
  it("shows the materialized count and runs the linked-references query lazily on first toggle", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Host Page" });
    const targetBlockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Target block" }],
    });
    // Two blocks on other pages mention the target — the materialized count
    // is 2 before any section query runs.
    const sourceA = await client.createObject({ presentAsMain: true, name: "Source A" });
    await client.createObject({
      parentId: sourceA,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: targetBlockId, text: "Target block" },
      ],
    });
    const sourceB = await client.createObject({ presentAsMain: true, name: "Source B" });
    await client.createObject({
      parentId: sourceB,
      contentAst: [
        { type: "text", text: "also " },
        { type: "mention", targetNodeId: targetBlockId, text: "Target block" },
      ],
    });
    expect(client.getBacklinkCount(targetBlockId)).toBe(2);
    await flushSync();

    const refsSpy = vi.spyOn(client, "getLinkedReferences");
    render(<PageView client={client} pageId={pageId} />);
    // PageView's first mount idempotently writes the cover-property schema
    // (self-heal) and kicks pushes — settle those notifications so the
    // collapsed panel (which executes nothing) sees a quiet client. (The
    // page-level backlinks strip's mount load may call the same query for
    // the PAGE id — the assertions below scope the spy to the block.)
    await flushSync();
    const blockQueries = () =>
      refsSpy.mock.calls.filter((args) => args[0] === targetBlockId).length;

    // The badge reads the materialized count; the block's query has not run
    // and no panel is rendered.
    const toggle = screen.getByRole("button", { name: "2 linked references" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(blockQueries()).toBe(0);
    expect(document.querySelector(".nt-block-backlink-refs")).toBeNull();

    // First toggle: the query runs once and the references render beneath
    // the block row.
    fireEvent.click(toggle);
    await waitFor(() => expect(blockQueries()).toBe(1));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.querySelector(".nt-block-backlink-refs") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText("see")).not.toBeNull();
    expect(within(panel).getByText("also")).not.toBeNull();

    // Collapse and re-expand: cached — no new query (no write has landed).
    fireEvent.click(toggle);
    expect(document.querySelector(".nt-block-backlink-refs")).toBeNull();
    fireEvent.click(toggle);
    expect(document.querySelector(".nt-block-backlink-refs")).not.toBeNull();
    expect(blockQueries()).toBe(1);
  });

  it("hides the gutter when the block has no backlinks", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Quiet" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Unmentioned block" }],
    });
    await flushSync();

    const refsSpy = vi.spyOn(client, "getLinkedReferences");
    render(<PageView client={client} pageId={pageId} />);

    expect(screen.queryByRole("button", { name: /linked references?/ })).toBeNull();
    // The block's query stays lazy (the page-level strip's mount load may
    // call the same query for the PAGE id — scope the assertion).
    expect(refsSpy.mock.calls.filter((args) => args[0] === blockId)).toHaveLength(0);
  });

  it("re-runs the expanded query when an invalidating notification lands", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Live" });
    const targetBlockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Live target" }],
    });
    const sourceA = await client.createObject({ presentAsMain: true, name: "Source A" });
    await client.createObject({
      parentId: sourceA,
      contentAst: [{ type: "mention", targetNodeId: targetBlockId, text: "Live target" }],
    });
    await flushSync();

    const refsSpy = vi.spyOn(client, "getLinkedReferences");
    render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    const blockQueries = () =>
      refsSpy.mock.calls.filter((args) => args[0] === targetBlockId).length;
    fireEvent.click(screen.getByRole("button", { name: "1 linked reference" }));
    await waitFor(() => expect(blockQueries()).toBe(1));

    // A new mention arrives from another page: the expanded panel re-queries
    // on the invalidating notification and the badge updates to the new
    // materialized count.
    const sourceB = await client.createObject({ presentAsMain: true, name: "Source B" });
    await client.createObject({
      parentId: sourceB,
      contentAst: [{ type: "mention", targetNodeId: targetBlockId, text: "Live target" }],
    });
    await flushSync();

    await screen.findByRole("button", { name: "2 linked references" });
    const panel = document.querySelector(".nt-block-backlink-refs") as HTMLElement;
    expect(within(panel).getByText("Source B")).not.toBeNull();
    expect(blockQueries()).toBeGreaterThanOrEqual(2);
  });
});
