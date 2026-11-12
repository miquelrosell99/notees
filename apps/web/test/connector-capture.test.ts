import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, parseDateNodeId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { captureWebPage } from "../src/features/connector/captureWebPage.js";

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

function urlOf(client: WorkspaceClient, id: string): string | undefined {
  const row = client
    .getEffectiveProperties(id)
    .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
  return row?.value as string | undefined;
}

describe("captureWebPage", () => {
  it("source mode: creates a web_page node with title, url, and accessDate", async () => {
    const client = await seedClient();
    const id = await captureWebPage(
      client,
      { url: "https://example.com/essay", title: "An Essay", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const node = client.getNode(id);
    expect(node).toBeDefined();
    expect(node!.classIds).toContain(SYSTEM_CLASS_UUIDS.web_page);
    expect(urlOf(client, id)).toBe("https://example.com/essay");
    const access = client
      .getEffectiveProperties(id)
      .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.accessDate);
    expect(access).toBeDefined();
    // The DATE value is a date-chain node reference ({nodeId}) stamping the
    // LOCAL day of the capture moment (the journal-day law) — a real day node.
    const moment = new Date("2026-11-08T10:00:00Z");
    const dayId = (access!.value as { nodeId: string }).nodeId;
    expect(client.getNode(dayId)).toBeDefined();
    expect(parseDateNodeId(dayId)).toMatchObject({
      year: moment.getFullYear(),
      month: moment.getMonth() + 1,
      day: moment.getDate(),
    });
  });

  it("duplicate URL re-capture returns the existing node; only one web_page exists", async () => {
    const client = await seedClient();
    const first = await captureWebPage(
      client,
      { url: "https://example.com/dup", title: "Dup", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const second = await captureWebPage(
      client,
      { url: "https://example.com/dup", title: "Dup, re-captured", mode: "source" },
      new Date("2026-11-08T11:00:00Z"),
    );
    expect(second).toBe(first);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)).toHaveLength(1);
  });

  it("readlater mode: auto-creates ONE 'Read later' collection and adds the node", async () => {
    const client = await seedClient();
    const id = await captureWebPage(
      client,
      { url: "https://example.com/later", title: "Later", mode: "readlater" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const collections = client.getClassMembers(SYSTEM_CLASS_UUIDS.collection);
    expect(collections).toHaveLength(1);
    // A second readlater capture reuses the collection (find-or-create).
    await captureWebPage(
      client,
      { url: "https://example.com/later2", title: "Later 2", mode: "readlater" },
      new Date("2026-11-08T10:05:00Z"),
    );
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.collection)).toHaveLength(1);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)).toHaveLength(2);
    expect(id).toBeDefined();
  });

  it("a note becomes the node's first child block; an absent note writes no child", async () => {
    const client = await seedClient();
    const withNote = await captureWebPage(
      client,
      { url: "https://example.com/noted", title: "Noted", mode: "source", note: "check §3" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const children = client.getChildren(withNote);
    expect(children).toHaveLength(1);
    const plain = await captureWebPage(
      client,
      { url: "https://example.com/plain", title: "Plain", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    expect(client.getChildren(plain)).toHaveLength(0);
  });
});
