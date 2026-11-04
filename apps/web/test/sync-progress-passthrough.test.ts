// @vitest-environment node
/**
 * Sync-progress pass-through (client-sync): the SyncEngine's onPullProgress
 * callback ({applied, total} per catch-up page) reaches the client's
 * onSyncProgress option through ClientContext — the wiring behind the
 * connecting screen's progress bar + percentage.
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

describe("onSyncProgress pass-through", () => {
  it("catch-up progress reaches the client option with honest applied/total", async () => {
    // A relay holding five envelopes so catch-up pages report real progress.
    const relay = new MemoryRelay();
    const envelopes = Array.from({ length: 5 }, (_, i) =>
      newEnvelope({
        workspaceId: WS,
        actorId: ACTOR,
        deviceId: "seed-device",
        hlc: { physical: 1_727_200_000_000 + i, logical: 0 },
        opType: "object.create",
        payload: {
          objectId: `0192a000-0000-7000-8000-0000000000a${i}`,
          contentAst: [{ type: "text", text: `Progress page ${i}` }],
          isEmbedded: false,
        },
        timestamp: "2026-09-24T12:00:00.000Z",
      }),
    );
    await relay.ingest(envelopes);

    const payloads: Array<{ applied: number; total: number }> = [];
    const client = await WorkspaceClient.create({
      transport: new MemoryTransport(relay),
      actorId: ACTOR,
      sqlJs: sqlModule,
      onSyncProgress: (applied, total) => payloads.push({ applied, total }),
    });
    clients.push(client);
    await client.bootstrapWorkspace(WS);

    // Progress rides the option per catch-up page: a positive denominator,
    // applied never past total, and the final payload covers the whole page
    // (totalRemaining 0 → total === applied).
    expect(payloads.length).toBeGreaterThan(0);
    for (const { applied, total } of payloads) {
      expect(total).toBeGreaterThan(0);
      expect(applied).toBeGreaterThan(0);
      expect(applied).toBeLessThanOrEqual(total);
    }
    expect(payloads.at(-1)).toEqual({ applied: 5, total: 5 });
  });
});
