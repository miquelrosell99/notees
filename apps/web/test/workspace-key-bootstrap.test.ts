// @vitest-environment node
/**
 * Workspace-key threading (plan-02 Task 7): a client bootstrapped with a raw
 * workspace key seals the wire — pushed envelopes carry the $e slot — and a
 * second keyed client decrypts them on pull. Without a key the wire stays
 * plaintext (today's behavior; crypto is opt-in).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { isEncryptedPayload } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const KEY = new Uint8Array(32).fill(0x42);

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

describe("workspace key into the sync engine", () => {
  it("keyed bootstrap seals the wire; a second keyed client reads plaintext; keyless stays plaintext", async () => {
    // Keyed writer.
    const keyedRelay = new MemoryRelay();
    const writer = await createClient(keyedRelay, KEY);
    await writer.bootstrapWorkspace(WS);
    const pageId = await writer.createObject({ name: "Sealed page" });
    await writer.push();

    const sealed = keyedRelay.envelopes();
    expect(sealed.length).toBeGreaterThan(0);
    for (const envelope of sealed) {
      expect(isEncryptedPayload(envelope.payload)).toBe(true);
    }

    // Keyed reader converges on plaintext.
    const reader = await createClient(keyedRelay, KEY);
    await reader.bootstrapWorkspace(WS);
    const row = reader.getNode(pageId);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).toContain("Sealed page");

    // Keyless writer on a fresh relay: plaintext wire (crypto is opt-in).
    const plainRelay = new MemoryRelay();
    const plain = await createClient(plainRelay);
    await plain.bootstrapWorkspace(WS);
    await plain.createObject({ name: "Open page" });
    await plain.push();
    const open = plainRelay.envelopes();
    expect(open.length).toBeGreaterThan(0);
    for (const envelope of open) {
      expect(isEncryptedPayload(envelope.payload)).toBe(false);
    }
  });
});
