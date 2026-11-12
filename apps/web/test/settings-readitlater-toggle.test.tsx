import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ReadItLaterFeatureRow } from "../src/features/workspaces/ReadItLaterFeatureRow.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const KNOWN = (WORKSPACE_FEATURES as readonly string[]).includes("readItLater");

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

describe("ReadItLaterFeatureRow", () => {
  it("renders nothing while the vendored feature id is absent (pre-bump tolerance)", () => {
    if (KNOWN) return; // post-bump run: the second test covers this
    const { container } = render(<ReadItLaterFeatureRow client={null as never} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("toggles through setFeatureEnabled and reflects isFeatureEnabled (post-bump)", async () => {
    if (!KNOWN) return;
    const client = await seedClient();
    render(<ReadItLaterFeatureRow client={client} />);
    const toggle = screen.getByRole("switch", { name: "Read later feature" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // absent row = enabled
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(client.isFeatureEnabled("readItLater" as never)).toBe(false));
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(client.isFeatureEnabled("readItLater" as never)).toBe(true));
  });
});
