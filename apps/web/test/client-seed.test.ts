// @vitest-environment node
/**
 * Client-side seeding of empty KEYED workspaces (plan-02 Task 8): the server
 * shim skips keyed workspaces (they are client-seeded), so the first keyed
 * device stamps the system seeds itself — applied local-first via enqueue
 * and pushed as $e envelopes. A non-empty store is never reseeded; a keyless
 * store is the server shim's job, not the client's. Two devices seeding
 * concurrently converge (fixed seed node ids; create-on-existing is a no-op).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS } from "@notees/domain";
import { isEncryptedPayload } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const KEY = new Uint8Array(32).fill(0x42);
const INBOX = SYSTEM_PAGE_UUIDS.inbox;
const SOURCE = SYSTEM_CLASS_UUIDS.source;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function createClient(relay: MemoryRelay, workspaceKey?: Uint8Array): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
    ...(workspaceKey !== undefined ? { workspaceKey } : {}),
  });
  clients.push(client);
  return client;
}

describe("client-side seeding of empty keyed workspaces", () => {
  it("an empty keyed workspace is seeded: inbox page + system classes exist; the wire sees only $e", async () => {
    const relay = new MemoryRelay();
    const client = await createClient(relay, KEY);
    await client.bootstrapWorkspace(WS);

    expect(client.getNode(INBOX)).toBeDefined();
    expect(client.getNode(SOURCE)).toBeDefined();

    await client.push();
    const wire = relay.envelopes();
    expect(wire.length).toBeGreaterThan(0);
    for (const envelope of wire) {
      expect(isEncryptedPayload(envelope.payload)).toBe(true);
    }
  });

  it("a non-empty keyed workspace is NOT reseeded", async () => {
    const relay = new MemoryRelay();
    // A keyless primer puts plaintext content on the relay (the server shim's
    // world): the keyed bootstrap pulls it, the store is non-empty, and the
    // client-seed gate must stay off.
    const primer = await createClient(relay);
    await primer.bootstrapWorkspace(WS);
    const pageId = await primer.createObject({ name: "Pre-existing page" });
    await primer.push();

    const keyed = await createClient(relay, KEY);
    await keyed.bootstrapWorkspace(WS);
    expect(keyed.getNode(pageId)).toBeDefined(); // the pull landed (non-empty)
    expect(keyed.getNode(INBOX)).toBeUndefined(); // …and no reseed

    // The keyed client is still sealing its own writes (proves crypto is on).
    await keyed.createObject({ name: "Keyed page" });
    await keyed.push();
    const sealed = relay.envelopes().filter((envelope) => isEncryptedPayload(envelope.payload));
    expect(sealed.length).toBeGreaterThan(0);
  });

  it("an empty KEYLESS workspace is NOT client-seeded (the server shim's job)", async () => {
    const relay = new MemoryRelay();
    const client = await createClient(relay);
    await client.bootstrapWorkspace(WS);

    expect(client.getNode(INBOX)).toBeUndefined();
  });

  it("two keyed devices seeding concurrently converge", async () => {
    const relay = new MemoryRelay();
    // Both bootstrap empty local stores before either pushes: each seeds its
    // own copy (separate envelope ids, fixed node ids).
    const a = await createClient(relay, KEY);
    const b = await createClient(relay, KEY);
    await a.bootstrapWorkspace(WS);
    await b.bootstrapWorkspace(WS);
    expect(a.getNode(INBOX)).toBeDefined();
    expect(b.getNode(INBOX)).toBeDefined();

    // Both push (sealed) and pull each other's seeds: creates no-op on the
    // existing ids, envelopes dedupe by id — both stores converge.
    await a.push();
    await b.push();
    await a.pull();
    await b.pull();

    expect(a.getNode(INBOX)).toBeDefined();
    expect(b.getNode(INBOX)).toBeDefined();
    expect(a.getNode(SOURCE)).toBeDefined();
    expect(b.getNode(SOURCE)).toBeDefined();
    // No pull errors surfaced and the stores agree on the seeded content.
    const inboxA = a.getNode(INBOX);
    const inboxB = b.getNode(INBOX);
    expect(JSON.stringify(inboxB)).toBe(JSON.stringify(inboxA));
  });
});
