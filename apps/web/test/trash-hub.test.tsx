/**
 * TrashHub tests — the Trash hub behind the sidebar's Trash entry: lists
 * soft-trashed subtree roots (newest first), restores via the object.restore
 * op (the web surface the CLI's `object restore` already had), and deletes
 * permanently behind the confirmation modal. Data path: object.delete → the
 * derived `trash` table; every normal read filters is_active — this hub is
 * the one surface reading the other side.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { TrashHub } from "../src/ui/components/TrashHub.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

describe("TrashHub", () => {
  it("lists trashed subtrees with their deletion stamp; an empty trash says so", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Kept page" });

    const { container, unmount } = render(
      <TrashHub client={client} onOpenNode={() => {}} />,
    );
    expect(screen.getByText("Trash is empty.")).not.toBeNull();
    unmount();

    await client.createObject({ presentAsMain: true, name: "Trashed page" });
    const victim = await client.createObject({ presentAsMain: true, name: "Gone" });
    await client.deleteObject(victim);
    await flushWrites();

    render(<TrashHub client={client} onOpenNode={() => {}} />);
    const hub = container.ownerDocument ?? document;
    void hub;
    const rows = screen.getAllByText(/Gone|Trashed page/);
    // Only the trashed node is listed — live pages stay out.
    expect(rows.some((row) => row.textContent === "Gone")).toBe(true);
    expect(rows.some((row) => row.textContent === "Trashed page")).toBe(false);
    // The deletion stamp rides the row.
    expect(screen.getByText(/ago|Just now|^\d{1,2}\/\d{1,2}\/\d{4}$/)).not.toBeNull();
  });

  it("restore revives the subtree and opens the node", async () => {
    const client = await seedClient();
    const victim = await client.createObject({ presentAsMain: true, name: "Revive me" });
    await client.deleteObject(victim);
    await flushWrites();
    expect(client.getNode(victim)).toBeUndefined();
    expect(client.listTrashed().map((entry) => entry.node.id)).toContain(victim);

    const onOpenNode = vi.fn();
    render(<TrashHub client={client} onOpenNode={onOpenNode} />);
    await flushWrites();

    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    await flushWrites();

    expect(client.getNode(victim)).not.toBeUndefined();
    expect(client.listTrashed()).toHaveLength(0);
    expect(onOpenNode).toHaveBeenCalledWith(victim);
  });

  it("delete permanently is confirmed and erases the subtree for good", async () => {
    const client = await seedClient();
    const victim = await client.createObject({ presentAsMain: true, name: "Burn it" });
    await client.deleteObject(victim);
    await flushWrites();

    render(<TrashHub client={client} onOpenNode={() => {}} />);
    await flushWrites();

    fireEvent.click(screen.getByRole("button", { name: /Delete permanently/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete permanently?")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await flushWrites();

    expect(client.listTrashed()).toHaveLength(0);
    expect(client.getNodeRaw(victim)).toBeUndefined();
  });

  it("the confirmation modal cancels without deleting", async () => {
    const client = await seedClient();
    const victim = await client.createObject({ presentAsMain: true, name: "Spare me" });
    await client.deleteObject(victim);
    await flushWrites();

    render(<TrashHub client={client} onOpenNode={() => {}} />);
    await flushWrites();

    fireEvent.click(screen.getByRole("button", { name: /Delete permanently/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flushWrites();

    expect(client.listTrashed().map((entry) => entry.node.id)).toContain(victim);
  });
});
