/**
 * The Capacities header action row (owner 2026-10-09): quiet ghost actions
 * ABOVE the title — "Add icon" (the shared icon+color picker, anchored at the
 * row button when no icon element exists), "Add description" (the subtitle
 * editor; the `description` wire node field), "Add aliases" (the shared
 * backward-write alias picker).
 *
 * Hide-when-none: the header icon element renders ONLY when an icon is
 * DEFINED (own or a class-contributed one — no generic-default fallback, no
 * hover placeholder); the description subtitle renders only when non-empty.
 *
 * jsdom over the in-process WorkspaceClient, like node-aliases.test.tsx.
 * Every write kicks a floating engine push whose ack notifies later
 * (microtasks), so each test flushes the queue after acting.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { dayNodeId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

describe("the header action row", () => {
  it("renders the three quiet actions above the title on the main surface", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Probe" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    const row = container.querySelector(".page-header-actions");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: /Add icon/ })).not.toBeNull();
    expect(
      within(row as HTMLElement).getByRole("button", { name: /Add description/ }),
    ).not.toBeNull();
    expect(within(row as HTMLElement).getByRole("button", { name: /Add aliases/ })).not.toBeNull();
  });

  it("stays off the embedded and preview surfaces", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Probe" });

    const embedded = render(
      <PageView client={client} pageId={pageId} embedded onOpenPage={() => {}} />,
    );
    await flushSync();
    expect(embedded.container.querySelector(".page-header-actions")).toBeNull();
    embedded.unmount();

    const preview = render(<PageView client={client} pageId={pageId} preview />);
    await flushSync();
    expect(preview.container.querySelector(".page-header-actions")).toBeNull();
  });

  it("hides the row (and subtitle) on day pages", async () => {
    const client = await seedClient();
    // A day-precision id renders the DayPageHeader contract — the action row
    // and the subtitle ride non-day pages only.
    const dayId = dayNodeId("2026-10-09");
    await client.createObject({ presentAsMain: true, name: "20261009", id: dayId });
    const { container } = render(<PageView client={client} pageId={dayId} />);
    await flushSync();
    expect(container.querySelector(".page-header-actions")).toBeNull();
  });
});

describe("the header icon element (hide-when-none)", () => {
  it("renders no icon element for a classless page with no icon — the row button is the affordance", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    expect(container.querySelector(".page-icon-btn")).toBeNull();
    expect(container.querySelector(".page-icon-placeholder")).toBeNull();

    // "Add icon" opens the shared picker anchored at the row button.
    fireEvent.click(screen.getByRole("button", { name: /Add icon/ }));
    const dialog = screen.getByRole("dialog", { name: "Icon picker" });
    expect(dialog).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "😀" }));
    await flushSync();

    // The defined icon makes the element appear; the generic default never
    // does — and the "Add icon" action retires (the icon element is the
    // picker entry now).
    expect(client.getNode(pageId)?.icon).toBe("😀");
    expect(container.querySelector(".page-icon-btn")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Add icon/ })).toBeNull();
  });

  it("an icon defined by a class shows the element; clearing the last definition hides it", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Member" });
    const classId = await client.createClass("Person");
    await client.updateObject(classId, { icon: "🧑" });
    await client.assignClass(pageId, classId);
    await flushSync();
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    // Class-contributed icon: the element renders…
    expect(container.querySelector(".page-icon-btn")).not.toBeNull();

    // …until the class unassigns — no own icon, no class icon, element gone
    // and the "Add icon" action back.
    await client.unassignClass(pageId, classId);
    await flushSync();
    expect(container.querySelector(".page-icon-btn")).toBeNull();
    expect(screen.getByRole("button", { name: /Add icon/ })).not.toBeNull();
  });
});

describe("the description subtitle (the description wire node field)", () => {
  it("add → render → click-edit → clear round-trips through object.update", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Described" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();

    // Hide-when-none: no subtitle, the row offers the add action.
    expect(container.querySelector(".page-header-description")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add description/ }));

    // The editor swaps in; Enter commits.
    const input = screen.getByLabelText("Page description");
    fireEvent.change(input, { target: { value: "A quiet subtitle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flushSync();

    expect(client.getNode(pageId)?.description).toBe("A quiet subtitle");
    expect(container.querySelector(".page-header-description")?.textContent).toBe(
      "A quiet subtitle",
    );
    // The add action retires once a subtitle exists.
    expect(screen.queryByRole("button", { name: /Add description/ })).toBeNull();

    // Click-edit: the subtitle itself is the edit surface.
    fireEvent.click(container.querySelector(".page-header-description")!);
    const edit = screen.getByLabelText("Page description");
    expect((edit as HTMLInputElement).value).toBe("A quiet subtitle");
    fireEvent.change(edit, { target: { value: "" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    await flushSync();

    // An empty commit clears the field; the subtitle hides, the action returns.
    expect(client.getNode(pageId)?.description).toBeNull();
    expect(container.querySelector(".page-header-description")).toBeNull();
    expect(screen.getByRole("button", { name: /Add description/ })).not.toBeNull();
  });
});

describe("the header alias action (the shared backward write)", () => {
  it("Add aliases picks a page and writes the picked node's aliasedNodeId", async () => {
    const client = await seedClient();
    const mainId = await client.createObject({ presentAsMain: true, name: "Main" });
    const dogId = await client.createObject({ presentAsMain: true, name: "Dog" });
    render(<PageView client={client} pageId={mainId} />);
    await flushSync();

    fireEvent.click(screen.getByRole("button", { name: /Add aliases/ }));
    const searchInput = screen.getByLabelText("Search pages…");
    const picker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(searchInput, { target: { value: "Dog" } });
    fireEvent.click(within(picker).getByText("Dog").closest("button")!);
    await flushSync();

    // THE backward write: the picked node aliases the main (never the reverse)…
    expect(client.getNode(dogId)?.aliasedNodeId).toBe(mainId);
    expect(client.getNode(mainId)?.aliasedNodeId).toBeNull();
    // …and the "Add aliases" action retires — the metadata panel's row is
    // the entry from here.
    expect(screen.queryByRole("button", { name: /Add aliases/ })).toBeNull();
  });

  it("the whole row disappears once every gap is filled", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Complete" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await flushSync();
    expect(container.querySelector(".page-header-actions")).not.toBeNull();

    await client.updateObject(pageId, { icon: "😀", description: "Done" });
    const aliasId = await client.createObject({ presentAsMain: true, name: "Also" });
    await client.updateObject(aliasId, { aliasedNodeId: pageId });
    await flushSync();

    expect(container.querySelector(".page-header-actions")).toBeNull();
    // The chrome itself is all present: icon element + subtitle.
    expect(container.querySelector(".page-icon-btn")).not.toBeNull();
    expect(container.querySelector(".page-header-description")?.textContent).toBe("Done");
  });
});
