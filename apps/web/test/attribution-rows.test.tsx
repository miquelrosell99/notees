/**
 * AttributionRows tests — the metadata panel's Created / Last edited pair:
 *
 *  - both rows render with the node's attribution (date + actor);
 *  - an unregistered actor falls back to the actorId uuid prefix;
 *  - a primed registry (GET /api/actors) resolves the actor to a human and
 *    the rows re-render when it lands (useSyncExternalStore);
 *  - the registry fetch failing leaves the fallback standing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import {
  __resetActorRegistryForTests,
  primeActorRegistry,
} from "../src/core/actor-registry.js";
import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { AttributionRows } from "../src/features/metadata/AttributionRows.js";

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

beforeEach(() => {
  __resetActorRegistryForTests();
  vi.unstubAllGlobals();
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

describe("AttributionRows", () => {
  it("renders Created and Last edited with the actor's uuid prefix before any registry", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false });

    const { container } = render(<AttributionRows client={client} nodeId={pageId} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Created");
    expect(text).toContain("Last edited");
    // The unregistered actor reads as the uuid prefix (the history-modal
    // precedent), and the create timestamp rides the row.
    expect(text).toContain(`${ACTOR.slice(0, 8)}…`);
  });

  it("resolves actors through the primed registry and re-renders when it lands", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          actors: [
            { actorId: ACTOR, userId: "u1", email: "miquel@example.com", displayName: "Miquel" },
          ],
        }),
      })),
    );

    const { container } = render(<AttributionRows client={client} nodeId={pageId} />);
    expect(container.textContent).toContain(`${ACTOR.slice(0, 8)}…`);

    primeActorRegistry("http://notees.test", "nk-test-key");
    await waitFor(() => {
      expect(container.textContent).toContain("Miquel");
    });
    expect(container.textContent).not.toContain(`${ACTOR.slice(0, 8)}…`);
  });

  it("keeps the fallback when the registry fetch fails", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));

    const { container } = render(<AttributionRows client={client} nodeId={pageId} />);
    primeActorRegistry("http://notees.test", "nk-test-key");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toContain(`${ACTOR.slice(0, 8)}…`);
  });
});
