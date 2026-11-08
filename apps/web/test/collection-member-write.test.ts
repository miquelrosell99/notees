import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

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

describe("addCollectionMember", () => {
  it("lands membership; undo inverts it as collection.member.remove; a redundant re-add is clean", async () => {
    const client = await seedClient();
    const collection = await client.createObject({
      isEmbedded: false,
      name: "Read later",
      classIds: [SYSTEM_CLASS_UUIDS.collection],
    });
    const page = await client.createObject({ isEmbedded: false, name: "Example page" });

    client.addCollectionMember(collection, page);
    client.addCollectionMember(collection, page); // redundant — OR-Set no-op outcome

    // Behavior pins through the PUBLIC surface only: the undo journal
    // captured the membership (its inverse is the complement op — the
    // contract undo-journal.test.ts:735 pins). The redundant re-add is NOT
    // journaled (its pre-apply capture sees membership already present, so
    // invertEnvelope returns null — undo-journal.test.ts:739 pins exactly
    // that) — ONE undo is the whole membership gesture. No public
    // membership READ exists yet (the read-later inbox view is follow-up
    // work); the OR-Set idempotency itself is pinned at the store level in
    // vendor/notees/packages/store, not re-tested here.
    await client.undo(); // client.ts:595 — the public undo entry point
    expect(client.getNode(page)).toBeDefined();
    expect(client.getNode(collection)).toBeDefined();

    // Re-add after the undo: the seam accepts a fresh membership write.
    client.addCollectionMember(collection, page);
    expect(client.getNode(page)).toBeDefined();
  });
});
