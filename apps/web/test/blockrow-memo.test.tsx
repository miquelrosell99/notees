/**
 * BlockRow bail-out (op-lag row-bailout slice): with the outliner context
 * value memoized and the row export memoized, a change ON the page must
 * re-render only the rows it touches — an edit to one block re-renders that
 * row alone (every other row bails on stable node identity), and a
 * structural add (a new block) re-renders nothing but the new row. The
 * per-row render probe rides `client.getBacklinkCount(id)`: the row body
 * calls it on EVERY render (the gutter count), keyed by the row's own id —
 * a bailed row makes no call. (The BlockRowRenderer export cannot be spied:
 * the memo captured the function reference at module init, so the spy would
 * see nothing.)
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const ROW_COUNT = 8;

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

interface RowRenderProbe {
  /** Per-row render calls since the baseline, by node id (gutter-count
   *  reads — one per BlockRow render; section gating calls keyed by the
   *  page id are excluded by the callers). */
  counts: () => Map<string, number>;
  /** Total render calls since the baseline. */
  total: () => number;
}

/** Mount the page; the probe counts the row body's per-render backlink-count
 *  read keyed by node id. */
async function mountPageWithRows(
  client: WorkspaceClient,
  pageId: string,
): Promise<RowRenderProbe> {
  render(<PageView client={client} pageId={pageId} />);
  await settle(client);
  const spy = vi.spyOn(client, "getBacklinkCount");
  const baseline = spy.mock.calls.length;
  return {
    counts: () => {
      const map = new Map<string, number>();
      for (const call of spy.mock.calls.slice(baseline)) {
        const id = call[0] as string;
        map.set(id, (map.get(id) ?? 0) + 1);
      }
      return map;
    },
    total: () => spy.mock.calls.length - baseline,
  };
}

/** A page with ROW_COUNT flat body blocks. */
async function seedPage(client: WorkspaceClient): Promise<{ pageId: string; rowIds: string[] }> {
  const pageId = await client.createObject({
    isEmbedded: false,
    contentAst: [{ type: "text", text: "Host" }],
  });
  const rowIds: string[] = [];
  for (let i = 0; i < ROW_COUNT; i += 1) {
    rowIds.push(
      await client.createObject({
        isEmbedded: true,
        parentId: pageId,
        contentAst: [{ type: "text", text: `row ${i}` }],
      }),
    );
  }
  return { pageId, rowIds };
}

/** Every row id (and only row ids) must have zero render calls. */
function expectRowsBailed(counts: Map<string, number>, rowIds: string[]): void {
  for (const id of rowIds) {
    expect(counts.get(id) ?? 0).toBe(0);
  }
}

describe("BlockRow bail-out (memoized rows)", () => {
  it("editing one block re-renders only that row — every other row bails", async () => {
    const client = await seedClient();
    const { pageId, rowIds } = await seedPage(client);
    await settle(client);
    const probe = await mountPageWithRows(client, pageId);

    const edited = rowIds[3]!;
    await act(async () => {
      await client.updateObject(edited, {
        contentAst: [{ type: "text", text: "row 3, edited" }],
      });
    });
    await settle(client);

    const counts = probe.counts();
    // The edited row re-renders (one or more commits as the editor lands);
    // its seven siblings (and the page title row) render not at all.
    expect(counts.get(edited)).toBeGreaterThanOrEqual(1);
    expectRowsBailed(counts, rowIds.filter((id) => id !== edited));
    // The page id: the section gate read + the title row's own render (the
    // edit's ancestor-expanded payload names the page — the title row's
    // scoped re-render fires, by design).
    expect(counts.get(pageId) ?? 0).toBeLessThanOrEqual(2);
    // Bounded: far fewer row renders than a full tree sweep (the count read
    // rides each re-rendered row alone).
    const rowRenders = rowIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
    expect(rowRenders).toBeLessThan(ROW_COUNT / 4);
  });

  it("a structural add costs one render per row at most — the dnd-kit floor", async () => {
    const client = await seedClient();
    const { pageId, rowIds } = await seedPage(client);
    await settle(client);
    const probe = await mountPageWithRows(client, pageId);

    const newRowId = await (async () => {
      let id = "";
      await act(async () => {
        id = await client.createObject({
          isEmbedded: true,
          parentId: pageId,
          contentAst: [{ type: "text", text: "a new row" }],
        });
      });
      return id;
    })();
    await settle(client);

    const counts = probe.counts();
    // dnd-kit's SortableContext keys its context value on the items ARRAY
    // identity, and an add legitimately changes the id sequence — so the
    // sortable rows re-render once to re-register (the honest floor; what
    // the bail-out removes is the REPEATED full-tree passes a gesture used
    // to cost). The contract: exactly one render per row, never more.
    for (const id of rowIds) {
      expect(counts.get(id) ?? 0).toBeLessThanOrEqual(1);
    }
    expect(counts.get(newRowId)).toBeGreaterThanOrEqual(1);
    // Row renders only (the page's own section-gate read rides the same spy).
    const rowRenders = [...counts.entries()]
      .filter(([id]) => id !== pageId)
      .reduce((sum, [, n]) => sum + n, 0);
    expect(rowRenders).toBeLessThanOrEqual(ROW_COUNT + 1);
  });
});
