/**
 * ActivityLog section tests: the workspace activity feed
 * renders as a collapsed system section, hides on an empty workspace (the
 * cheap active-node proxy gate), executes NO query while collapsed (the
 * normative lazy contract — runQueryAst stays silent until the first
 * expand), expands into Recently created (the workspace-wide createdAt-desc
 * query — blocks included, newest first) + Recently edited (pages/classes
 * updated after creation, with the honest coverage note), re-derives on
 * notification while expanded, and relativeTime formats the original convention.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { ActivityLogSection, relativeTime } from "../src/ui/components/ActivityLogSection.js";

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
  it("hides entirely on an empty workspace", async () => {
    const client = await seedClient();
    // Nothing exists yet — not even a host page: the direct render must
    // produce no section at all (the active-node proxy gate).
    const { container } = render(<ActivityLogSection client={client} />);
    expect(container.querySelector("section")).toBeNull();
  });

  it("renders collapsed and executes no query until the first expand", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const spy = vi.spyOn(client, "runQueryAst");
    render(<PageView client={client} pageId={host} />);

    const header = screen.getByRole("button", { name: /^activity$/i });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const section = activitySection();
    expect(within(section).queryByText("Recently created")).toBeNull();
    // The lazy contract: zero queries while collapsed.
    expect(spy).not.toHaveBeenCalled();
  });

  it("lists recent creations newest-first, blocks included, after expanding", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    await client.createObject({ presentAsMain: true, name: "Older page" });
    await client.createObject({ presentAsMain: true, name: "Newer page" });
    // A block (inline body child) — the pages-only lists never see it.
    await client.createObject({ parentId: host, contentAst: [{ type: "text", text: "a block note" }] });

    render(<PageView client={client} pageId={host} />);
    const section = activitySection();
    fireEvent.click(within(section).getByRole("button", { name: /^activity$/i }));
    const created = await within(section).findByText("Recently created");
    expect(created).not.toBeNull();
    const rows = within(section).getAllByRole("button", { name: /page|block note/i });
    const labels = rows.map((row) => row.textContent ?? "");
    const blockIndex = labels.findIndex((label) => label.includes("block note"));
    expect(blockIndex).toBeGreaterThanOrEqual(0);
    // Newest first: the block (created last) leads the feed.
    expect(blockIndex).toBe(0);
  });

  it("shows Recently edited for pages touched after creation, with the coverage note", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    const edited = await client.createObject({ presentAsMain: true, name: "Edited page" });
    await client.updateObject(edited, { contentAst: [{ type: "text", text: "Edited page v2" }] });

    render(<PageView client={client} pageId={host} />);
    const section = activitySection();
    fireEvent.click(within(section).getByRole("button", { name: /^activity$/i }));

    expect(await within(section).findByText("Recently edited")).not.toBeNull();
    expect(
      within(section).getByText(/edits are shown for pages and classes/i),
    ).not.toBeNull();
    // The edited group lists the page (it also leads the created feed —
    // the two timelines are independent).
    const editedGroup = within(section)
      .getByText("Recently edited")
      .closest(".activity-log__group")!;
    expect(
      within(editedGroup as HTMLElement).getByRole("button", { name: /edited page v2/i }),
    ).not.toBeNull();
  });

  it("re-derives the created feed when a notification lands while expanded", async () => {
    const client = await seedClient();
    const host = await client.createObject({ presentAsMain: true, name: "Host" });
    render(<PageView client={client} pageId={host} />);
    const section = activitySection();
    fireEvent.click(within(section).getByRole("button", { name: /^activity$/i }));
    await within(section).findByText("Recently created");

    await act(async () => {
      await client.createObject({ presentAsMain: true, name: "Fresh page" });
      // One trailing notification delivers the async query's rows (the
      // Section contract: expanded sections re-run per notification).
      await client.sync();
    });
    expect(
      await within(section).findByRole("button", { name: /fresh page/i }),
    ).not.toBeNull();
  });
});
