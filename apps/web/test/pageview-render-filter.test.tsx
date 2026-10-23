/**
 * PageView notification pre-filter (op-lag slice 4): a scoped change
 * notification that does not name the open page must not re-render the
 * view NOR any of its block rows. The payload the client notifies with is
 * ancestor-expanded, so an edit landing inside the page's subtree already
 * carries the page id — the containment check is a set-membership test,
 * not a tree walk. Scoped changes touching the page (its own content or a
 * descendant block) and structural (listing-affecting) changes re-render
 * as before. Render counting probes the PageView's per-render call of
 * pageVariantOf and the BlockRow module export (no production
 * instrumentation).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
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

/** Flush the microtasks an async write/notify runs on. */
async function flush(): Promise<void> {
  await act(async () => {});
  await act(async () => {});
}

/** Wait until the outbox is pushed dry (a structural ack's notify would
 *  otherwise land inside the render-count window). */
async function settle(client: WorkspaceClient): Promise<void> {
  await flush();
  await vi.waitFor(() => {
    expect(client.status().pending).toBe(0);
  });
  await flush();
}

interface RenderProbes {
  /** PageView's own re-renders since the baseline. */
  pageRenders: () => number;
  /** BlockRow renders since the baseline (rows across the whole tree). */
  blockRowRenders: () => number;
}

/**
 * Mount the page with render probes: PageView re-renders ride its
 * per-render pageVariantOf call; row renders ride a spy on the BlockRow
 * module export (the vitest ESM transform routes the import through the
 * module namespace, so the spy intercepts every render).
 */
async function mountPage(client: WorkspaceClient, pageId: string): Promise<RenderProbes> {
  const variantSpy = vi.spyOn(
    await import("../src/features/page-sections/pageVariant.js"),
    "pageVariantOf",
  );
  const rowSpy = vi.spyOn(await import("../src/ui/BlockRow.js"), "BlockRow");
  render(<PageView client={client} pageId={pageId} />);
  // Settle the mount-time ensures (the alias-schema self-heal is a write on
  // first view) and its push before capturing the baselines.
  await settle(client);
  const pageBaseline = variantSpy.mock.calls.length;
  const rowBaseline = rowSpy.mock.calls.length;
  return {
    pageRenders: () => variantSpy.mock.calls.length - pageBaseline,
    blockRowRenders: () => rowSpy.mock.calls.length - rowBaseline,
  };
}

/** A page with three body blocks, plus an unrelated second page. */
async function seedTwoPages(client: WorkspaceClient): Promise<{ pageId: string; otherId: string }> {
  const pageId = await client.createObject({
    isEmbedded: false,
    contentAst: [{ type: "text", text: "Host" }],
  });
  for (const text of ["one", "two", "three"]) {
    await client.createObject({
      isEmbedded: true,
      parentId: pageId,
      contentAst: [{ type: "text", text }],
    });
  }
  const otherId = await client.createObject({
    isEmbedded: false,
    contentAst: [{ type: "text", text: "Somewhere else" }],
  });
  return { pageId, otherId };
}

describe("PageView notification pre-filter (slice 4)", () => {
  it("a scoped change that does not name the page re-renders neither the view nor any row", async () => {
    const client = await seedClient();
    const { pageId, otherId } = await seedTwoPages(client);
    await settle(client);
    const probes = await mountPage(client, pageId);

    await act(async () => {
      await client.updateObject(otherId, {
        contentAst: [{ type: "text", text: "edited elsewhere" }],
      });
    });
    await settle(client);

    expect(probes.pageRenders()).toBe(0);
    expect(probes.blockRowRenders()).toBe(0);
  });

  it("a scoped change touching the page re-renders it", async () => {
    const client = await seedClient();
    const { pageId } = await seedTwoPages(client);
    await settle(client);
    const probes = await mountPage(client, pageId);

    await act(async () => {
      await client.updateObject(pageId, {
        contentAst: [{ type: "text", text: "Renamed host" }],
      });
    });
    await settle(client);

    expect(probes.pageRenders()).toBeGreaterThan(0);
  });

  it("an edit inside the page's subtree (a block) re-renders it — ancestor expansion carries the page id", async () => {
    const client = await seedClient();
    const { pageId } = await seedTwoPages(client);
    const blockId = client.getChildren(pageId)[0]!.id;
    await settle(client);
    const probes = await mountPage(client, pageId);

    await act(async () => {
      await client.updateObject(blockId, {
        contentAst: [{ type: "text", text: "one, edited" }],
      });
    });
    await settle(client);

    expect(probes.pageRenders()).toBeGreaterThan(0);
  });

  it("a structural (listing-affecting) change re-renders even off-page", async () => {
    const client = await seedClient();
    const { pageId } = await seedTwoPages(client);
    await settle(client);
    const probes = await mountPage(client, pageId);

    await act(async () => {
      await client.createObject({
        isEmbedded: false,
        contentAst: [{ type: "text", text: "A whole new page" }],
      });
    });
    await settle(client);

    expect(probes.pageRenders()).toBeGreaterThan(0);
  });
});
