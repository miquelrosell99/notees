// @vitest-environment node
/**
 * Notification payload shapes (the render-scoping slice):
 *
 *  A listing-affecting batch (object.create and friends) used to collapse
 *  to the scope-less `{ structural: true }` payload, which forced EVERY
 *  mounted BlockRow to re-render on every block creation. The payload now
 *  KEEPS the ancestor-expanded affected set alongside `structural: true`
 *  (bounded by CHANGE_AFFECT_CAP), so row-level subscribers can scope
 *  re-renders to rows naming one of those ids. Cache invalidation stays
 *  full on structural (see worker-client.test.ts); this file pins the
 *  payload shapes through the real client seam.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { ChangeNotification } from "../src/core/workspace-client/types.js";

const WS = "0192a000-0000-7000-8000-0000000000d1";
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

describe("notification payload shapes", () => {
  it("a block create carries the ancestor-expanded affected set with structural: true", async () => {
    const client = await seedClient();
    const payloads: ChangeNotification[] = [];
    client.subscribe((change) => payloads.push(change));
    const baseline = payloads.length;

    const pageId = await client.createObject({
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Host" }],
    });
    const blockId = await client.createObject({
      isEmbedded: true,
      parentId: pageId,
      contentAst: [{ type: "text", text: "body" }],
    });

    const batch = payloads.slice(baseline);
    const createPayload = batch[batch.length - 1]!;
    expect(createPayload.structural).toBe(true);
    // Both the created node and its ancestor chain ride along — rows scope
    // their re-renders against exactly these ids.
    expect(createPayload.affectedNodeIds).toContain(blockId);
    expect(createPayload.affectedNodeIds).toContain(pageId);
  });

  it("a content edit stays scoped with structural: false", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      isEmbedded: false,
      contentAst: [{ type: "text", text: "Host" }],
    });
    const blockId = await client.createObject({
      isEmbedded: true,
      parentId: pageId,
      contentAst: [{ type: "text", text: "body" }],
    });
    const payloads: ChangeNotification[] = [];
    client.subscribe((change) => payloads.push(change));

    await client.updateObject(blockId, {
      contentAst: [{ type: "text", text: "body, edited" }],
    });

    const editPayload = payloads[payloads.length - 1]!;
    expect(editPayload.structural).toBe(false);
    expect(editPayload.affectedNodeIds).toContain(blockId);
    expect(editPayload.affectedNodeIds).toContain(pageId);
  });
});
