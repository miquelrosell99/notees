// @vitest-environment node
/**
 * Sync-phase pass-through (client-sync): the SyncEngine's onSyncPhase
 * callback (bootstrap/pull progress — "Fetching latest snapshot…",
 * "Catching up… N operations", "Synced") reaches the client's onSyncPhase
 * option through ClientContext — the wiring the connecting screen renders.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { newEnvelope } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

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

describe("onSyncPhase pass-through", () => {
  it("bootstrap phases reach the client option verbatim", async () => {
    // A relay holding one envelope so catch-up has work to report.
    const relay = new MemoryRelay();
    const seed = newEnvelope({
      workspaceId: WS,
      actorId: ACTOR,
      deviceId: "seed-device",
      hlc: { physical: 1_727_200_000_000, logical: 0 },
      opType: "object.create",
      payload: {
        objectId: "0192a000-0000-7000-8000-0000000000a1",
        contentAst: [{ type: "text", text: "Progress page" }],
        isEmbedded: false,
      },
      timestamp: "2026-09-24T12:00:00.000Z",
    });
    await relay.ingest([seed]);

    const phases: Array<[string, string]> = [];
    const client = await WorkspaceClient.create({
      transport: new MemoryTransport(relay),
      actorId: ACTOR,
      sqlJs: sqlModule,
      onSyncPhase: (phase, message) => phases.push([phase, message]),
    });
    clients.push(client);
    await client.bootstrapWorkspace(WS);

    // The engine's user-readable phases ride the option, in order.
    const names = phases.map(([phase]) => phase);
    expect(names[0]).toBe("fetching-snapshot");
    expect(names).toContain("catching-up");
    expect(names.at(-1)).toBe("synced");
    expect(phases.some(([, message]) => message.includes("Catching up…"))).toBe(true);
    expect(phases.at(-1)![1]).toBe("Synced");
  });
});
