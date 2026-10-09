/**
 * ActivityLog section tests (owner 2026-10-09 contract): the feed is scoped
 * to the ACTIVE NODE — its own Created stamp plus an Edited stamp when the
 * node was touched after creation. No query exists at all (two node-column
 * reads), so the lazy contract holds trivially: collapsed renders nothing
 * and runQueryAst stays silent forever; expanding lists the node's own
 * events, never the workspace's; and relativeTime keeps the original
 * convention.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { relativeTime } from "../src/ui/components/ActivityLogSection.js";

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

/** The Activity section header button + its section wrapper. */
function activitySection(): HTMLElement {
  const header = screen.getByRole("button", { name: /^activity$/i });
  const section = header.closest("section");
  if (section === null) throw new Error("activity section wrapper missing");
  return section;
}

describe("relativeTime", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");

  it("formats the original convention", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("", now)).toBe("");
    expect(relativeTime("not-a-date", now)).toBe("");
    expect(relativeTime("2026-10-04T11:59:40Z", now)).toBe("Just now");
    expect(relativeTime("2026-10-04T11:58:00Z", now)).toBe("2m ago");
    expect(relativeTime("2026-10-04T11:00:00Z", now)).toBe("1h ago");
    expect(relativeTime("2026-10-01T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("2026-09-20T12:00:00Z", now)).toBe(
      new Date("2026-09-20T12:00:00Z").toLocaleDateString(),
    );
  });

  it("clamps future timestamps to Just now", () => {
    expect(relativeTime("2026-10-04T12:05:00Z", now)).toBe("Just now");
  });
});

describe("ActivityLogSection", () => {
  it("renders collapsed, never executes a query, and lists the node's own events on expand", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const spy = vi.spyOn(client, "runQueryAst");
    render(<PageView client={client} pageId={host} />);

    const header = screen.getByRole("button", { name: /^activity$/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const section = activitySection();
    expect(within(section).queryByText("Created")).toBeNull();
    // The per-node feed runs NO query at all — collapsed or expanded.
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(within(section).getByRole("button", { name: /^activity$/i }));
    expect(await within(section).findByText("Created")).not.toBeNull();
    // Still silent: the feed reads node columns, it never queries.
    expect(spy).not.toHaveBeenCalled();
    // The node's creation stamp rides the Created row.
    const hostNode = client.getNode(host)!;
    expect(
      within(section).getByText(relativeTime(hostNode.createdAt)),
    ).not.toBeNull();
  });

  it("an edit after creation adds an Edited row; other nodes' activity never appears", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const other = await client.createObject({ presentAsMain: true, name: "Other page" });
    await client.updateObject(other, { contentAst: [{ type: "text", text: "Other page v2" }] });

    render(<PageView client={client} pageId={host} />);
    const section = activitySection();
    fireEvent.click(within(section).getByRole("button", { name: /^activity$/i }));

    // No edit yet on the host: only Created.
    await within(section).findByText("Created");
    expect(within(section).queryByText("Edited")).toBeNull();
    // The OTHER node's edit is not this node's activity.
    expect(within(section).queryByText(/other page v2/i)).toBeNull();

    await act(async () => {
      await client.updateObject(host, { contentAst: [{ type: "text", text: "Host v2" }] });
    });

    // The host's own edit lands as an Edited row (the section re-derives per
    // render — plain column reads, no query machinery involved).
    await within(section).findByText("Edited");
    expect(within(section).queryByText(/other page v2/i)).toBeNull();
  });
});
