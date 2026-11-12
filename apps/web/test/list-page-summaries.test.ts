// @vitest-environment node
/**
 * listPageSummaries tests (the lean page-listing read):
 *
 *  - WorkspaceClient shape: summaries carry id/title (pre-flattened from
 *    the content — a page named "X" reads title "X"), classIds, parentId —
 *    and NEVER the fat-node fields (contentAst/name/description/cover…).
 *  - The read-delta contract: a repeated multiRead answers READ_UNCHANGED
 *    for the listPageSummaries key (WorkerCore over the real sql.js
 *    backend).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { isReadUnchanged } from "../src/core/workspace-client/read-revisions.js";
import { WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";

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

async function createClient(): Promise<WorkspaceClient> {
  const transport = new MemoryTransport(new MemoryRelay());
  const client = await WorkspaceClient.create({
    transport,
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  return client;
}

describe("WorkspaceClient.listPageSummaries", () => {
  it("carries id/derived title/classIds/parentId and no contentAst", async () => {
    const client = await createClient();
    await client.bootstrapWorkspace(WS);

    const pageId = await client.createObject({ isEmbedded: false, name: "X" });
    const subId = await client.createObject({
      isEmbedded: false,
      parentId: pageId,
      name: "Sub",
    });
    // An inline block under the page: not a page, never in the listing.
    await client.createObject({ parentId: pageId, name: "inline block" });

    const summaries = client.listPageSummaries();
    const ids = summaries.map((s) => s.id);
    expect(ids).toContain(pageId);
    expect(ids).toContain(subId);
    expect(ids).toHaveLength(client.listPages().length);

    const x = summaries.find((s) => s.id === pageId)!;
    // Title-is-content: the summary's title IS the flattened content.
    expect(x.title).toBe("X");
    expect(x.parentId).toBeNull();
    expect(x.isClass).toBe(false);
    expect(Array.isArray(x.classIds)).toBe(true);
    expect(Array.isArray(x.tagIds)).toBe(true);

    const sub = summaries.find((s) => s.id === subId)!;
    expect(sub.parentId).toBe(pageId);

    // The wire-shape contract: no fat-node fields on a summary.
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("contentAst");
      expect(summary).not.toHaveProperty("name");
      expect(summary).not.toHaveProperty("description");
      expect(summary).not.toHaveProperty("coverAssetId");
      expect(summary).not.toHaveProperty("bannerAssetId");
      expect(summary).not.toHaveProperty("listStyle");
    }
  });

  it("tracks the listing: a new page appears, a rename lands in title", async () => {
    const client = await createClient();
    await client.bootstrapWorkspace(WS);

    const pageId = await client.createObject({ isEmbedded: false, name: "Before" });
    expect(client.listPageSummaries().find((s) => s.id === pageId)?.title).toBe("Before");

    await client.updateObject(pageId, { contentAst: [{ type: "text", text: "After" }] });
    expect(client.listPageSummaries().find((s) => s.id === pageId)?.title).toBe("After");
  });
});

// --- read-delta integration (WorkerCore over the real sql.js backend) -------

const cores: WorkerCore[] = [];

afterEach(async () => {
  while (cores.length > 0) await cores.pop()!.close();
});

function createMemoryOpfs(): OpfsStore {
  const files = new Map<string, Uint8Array>();
  return {
    loadFile: async (name) => files.get(name) ?? null,
    saveFile: async (name, bytes) => {
      files.set(name, new Uint8Array(bytes));
    },
  };
}

async function createCore(): Promise<WorkerCore> {
  const core = await WorkerCore.create({
    SQL: sqlModule,
    opfs: createMemoryOpfs(),
    fileName: `${WS}.db`,
    workspaceId: WS,
    transport: new MemoryTransport(new MemoryRelay()),
  });
  cores.push(core);
  return core;
}

describe("listPageSummaries read-delta (WorkerCore over sql.js)", () => {
  it("answers READ_UNCHANGED on a repeat multiRead", async () => {
    const core = await createCore();
    const pageId = await core.createObject({ isEmbedded: false, name: "P" });

    const key = (m: string, ...args: unknown[]) => JSON.stringify([m, args]);
    const keys = [key("listPageSummaries")];

    const first = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(first.every((v) => !isReadUnchanged(v))).toBe(true);
    const served = first[0] as Array<{ id: string; title: string }>;
    expect(served.some((s) => s.id === pageId && s.title === "P")).toBe(true);

    // Nothing changed: the repeat is delta'd away.
    const second = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(second.every((v) => isReadUnchanged(v))).toBe(true);

    // A pure content edit does NOT re-serve the listing (the listPages
    // contract: content is not listing; title freshness rides the
    // scope-classed per-node reads).
    await core.updateObject(pageId, { contentAst: [{ type: "text", text: "P2" }] });
    const third = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(third[0])).toBe(true);

    // A listing-affecting gesture (a create) re-serves.
    await core.createObject({ isEmbedded: false, name: "Q" });
    const fourth = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(fourth[0])).toBe(false);
    expect((fourth[0] as Array<{ id: string }>).some((s) => s.id === pageId)).toBe(true);
  });
});
