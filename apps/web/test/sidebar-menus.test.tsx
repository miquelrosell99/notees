/**
 * Sidebar row context menus (Favorites + Recents): right-click a row →
 * Open / Open in sidebar / Copy link / favorites toggle / Remove from
 * recents (Recents only) / Delete (danger, confirmed). Lists update live.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { Sidebar, recordRecent } from "../src/ui/components/Sidebar.js";
import type { AnyClient } from "../src/ui/components/Sidebar.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
});

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

function renderSidebar(client: AnyClient, extras: Record<string, unknown> = {}) {
  return render(
    <Sidebar
      client={client}
      user={null}
      offline={false}
      showSettings={false}
      onOpenSettings={() => {}}
      selectedPageId={null}
      activeNav="pages"
      onSelectNav={() => {}}
      onOpenPage={() => {}}
      onSignOut={() => {}}
      onOpenInSidebar={vi.fn()}
      {...extras}
    />,
  );
}

const rowMenu = () => document.body.querySelector<HTMLElement>(".context-menu");

function openRowMenu(container: HTMLElement, rowLabel: string): HTMLElement {
  // A node can appear in both Favorites and Recents — the first row wins.
  const row = screen.getAllByRole("button", { name: rowLabel })[0]?.closest("li");
  if (row === null || row === undefined) throw new Error(`no row for ${rowLabel}`);
  fireEvent.contextMenu(row, { clientX: 8, clientY: 8 });
  const menu = rowMenu();
  if (menu === null) throw new Error("row context menu did not open");
  return menu;
}

describe("sidebar row context menus", () => {
  it("favorites row: menu offers open/sidebar/copy/unfavorite/delete", async () => {
    const client = await seedClient();
    await client.createObject({ presentAsMain: true, name: "Alpha" });
    localStorage.setItem("notees.favorites", JSON.stringify([client.listPages()[0]!.id]));
    const { container } = renderSidebar(client);

    const menu = openRowMenu(container, "Alpha");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "Open page",
      "Open in sidebar",
      "Copy link",
      "Remove from Favorites",
      "Delete",
    ]);
  });

  it("recents row: menu offers Remove from recents (and Add to Favorites when not starred)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Beta" });
    recordRecent(pageId);
    const { container } = renderSidebar(client);

    const menu = openRowMenu(container, "Beta");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "Open page",
      "Open in sidebar",
      "Copy link",
      "Add to Favorites",
      "Remove from recents",
      "Delete",
    ]);
  });

  it("Remove from Favorites unstars the row live", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Gamma" });
    localStorage.setItem("notees.favorites", JSON.stringify([pageId]));
    const { container } = renderSidebar(client);
    expect(screen.getByRole("button", { name: "Gamma" })).not.toBeNull();

    const menu = openRowMenu(container, "Gamma");
    fireEvent.click(within(menu).getByText("Remove from Favorites"));

    expect(JSON.parse(localStorage.getItem("notees.favorites") ?? "[]")).toEqual([]);
  });

  it("Remove from recents drops the row from the Recents section", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Delta" });
    recordRecent(pageId);
    const { container } = renderSidebar(client);
    expect(screen.getByRole("button", { name: "Delta" })).not.toBeNull();

    const menu = openRowMenu(container, "Delta");
    fireEvent.click(within(menu).getByText("Remove from recents"));

    expect(JSON.parse(localStorage.getItem("notees.recents") ?? "[]")).toEqual([]);
  });

  it("Delete asks for confirmation, then deletes the node", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Epsilon" });
    recordRecent(pageId);
    localStorage.setItem("notees.favorites", JSON.stringify([pageId]));
    const { container } = renderSidebar(client);

    const menu = openRowMenu(container, "Epsilon");
    fireEvent.click(within(menu).getByText("Delete"));

    const confirm = screen.getByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await act(async () => {});

    expect(client.getNode(pageId)).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("notees.favorites") ?? "[]")).toEqual([]);
    expect(JSON.parse(localStorage.getItem("notees.recents") ?? "[]")).toEqual([]);
  });

  it("Open in sidebar calls the host callback", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Zeta" });
    localStorage.setItem("notees.favorites", JSON.stringify([pageId]));
    const onOpenInSidebar = vi.fn();
    const { container } = renderSidebar(client, { onOpenInSidebar });

    const menu = openRowMenu(container, "Zeta");
    fireEvent.click(within(menu).getByText("Open in sidebar"));
    expect(onOpenInSidebar).toHaveBeenCalledWith(pageId);
  });
});
