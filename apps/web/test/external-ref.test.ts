// @vitest-environment node
/**
 * External-id mapping client tests (importer/sync plugins): the
 * WorkspaceClient write/read surface (setExternalRef / removeExternalRef /
 * resolveExternalRef / externalRefsOf) over a shared MemoryRelay — a write
 * on client A converges to client B's local store, a re-set moves the
 * mapping, a delete tombstones it, malformed writes fail loud, and the undo
 * journal inverts the writes through the normal write path.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const REF_GCAL = "gcal:event:abc123@google.com";
const REF_OUTLOOK = "outlook:event:AA1B2C3D";
const REF_READWISE = "readwise:highlight:12345";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function createClient(relay: MemoryRelay): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  return client;
}

describe("WorkspaceClient external-id mappings", () => {
  it("setExternalRef resolves locally and converges to a second client; many refs ride one node", async () => {
    const relay = new MemoryRelay();
    const clientA = await createClient(relay);
    const clientB = await createClient(relay);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    const nodeId = await clientA.createObject({ isEmbedded: false, name: "Imported event" });
    await clientA.setExternalRef(REF_GCAL, nodeId);
    await clientA.setExternalRef(REF_OUTLOOK, nodeId);

    // Optimistic local state.
    expect(clientA.resolveExternalRef(REF_GCAL)).toBe(nodeId);
    expect(clientA.externalRefsOf(nodeId)).toEqual([REF_GCAL, REF_OUTLOOK].sort());

    // Sync: B sees the mappings.
    await clientA.sync();
    await clientB.sync();
    expect(clientB.resolveExternalRef(REF_GCAL)).toBe(nodeId);
    expect(clientB.resolveExternalRef(REF_OUTLOOK)).toBe(nodeId);
    expect(clientB.externalRefsOf(nodeId)).toEqual([REF_GCAL, REF_OUTLOOK].sort());
    expect(clientB.resolveExternalRef(REF_READWISE)).toBeNull();
    expect(clientB.externalRefsOf("0192a000-0000-7000-8000-000000000099")).toEqual([]);
  });

  it("a re-set moves the mapping; removeExternalRef tombstones it; both converge", async () => {
    const relay = new MemoryRelay();
    const clientA = await createClient(relay);
    const clientB = await createClient(relay);
    await clientA.bootstrapWorkspace(WS);
    await clientB.bootstrapWorkspace(WS);

    const first = await clientA.createObject({ isEmbedded: false, name: "First" });
    const second = await clientA.createObject({ isEmbedded: false, name: "Second" });
    await clientA.setExternalRef(REF_GCAL, first);

    // Re-set: the move.
    await clientA.setExternalRef(REF_GCAL, second);
    expect(clientA.resolveExternalRef(REF_GCAL)).toBe(second);
    expect(clientA.externalRefsOf(first)).toEqual([]);
    expect(clientA.externalRefsOf(second)).toEqual([REF_GCAL]);

    await clientA.sync();
    await clientB.sync();
    expect(clientB.resolveExternalRef(REF_GCAL)).toBe(second);

    // Remove: tombstoned (unmapped).
    await clientA.removeExternalRef(REF_GCAL);
    expect(clientA.resolveExternalRef(REF_GCAL)).toBeNull();
    expect(clientA.externalRefsOf(second)).toEqual([]);

    await clientA.sync();
    await clientB.sync();
    expect(clientB.resolveExternalRef(REF_GCAL)).toBeNull();
    expect(clientB.externalRefsOf(second)).toEqual([]);
  });

  it("undo inverts the writes through the normal write path", async () => {
    const relay = new MemoryRelay();
    const client = await createClient(relay);
    await client.bootstrapWorkspace(WS);

    const first = await client.createObject({ isEmbedded: false, name: "First" });
    const second = await client.createObject({ isEmbedded: false, name: "Second" });

    // A fresh set undoes to a delete.
    await client.setExternalRef(REF_GCAL, first);
    expect(client.resolveExternalRef(REF_GCAL)).toBe(first);
    await client.undo();
    expect(client.resolveExternalRef(REF_GCAL)).toBeNull();

    // A move undoes to the previous carrier; the delete undoes back.
    await client.setExternalRef(REF_GCAL, first);
    await client.setExternalRef(REF_GCAL, second);
    expect(client.resolveExternalRef(REF_GCAL)).toBe(second);
    await client.undo();
    expect(client.resolveExternalRef(REF_GCAL)).toBe(first);
    await client.undo();
    expect(client.resolveExternalRef(REF_GCAL)).toBeNull();
  });

  it("malformed writes fail loud at the write boundary", async () => {
    const relay = new MemoryRelay();
    const client = await createClient(relay);
    await client.bootstrapWorkspace(WS);
    const nodeId = await client.createObject({ isEmbedded: false, name: "Target" });

    await expect(client.setExternalRef("", nodeId)).rejects.toThrow(/payload/i);
    await expect(client.setExternalRef("x".repeat(513), nodeId)).rejects.toThrow(/payload/i);
    await expect(
      client.setExternalRef(REF_GCAL, "not-a-uuid"),
    ).rejects.toThrow(/payload|uuid/i);
    await expect(client.removeExternalRef("")).rejects.toThrow(/payload/i);

    // Nothing landed.
    expect(client.resolveExternalRef(REF_GCAL)).toBeNull();
    expect(client.externalRefsOf(nodeId)).toEqual([]);
  });
});
