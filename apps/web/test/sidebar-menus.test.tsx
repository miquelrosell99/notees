/**
 * Sidebar row context menus (Favorites + Recents): right-click a row →
 * Open / Open in sidebar / Copy link / favorites toggle / Remove from
 * recents (Recents only) / Delete (danger, confirmed). Lists update live.
 *
 * Also: the account popup + the row menu close on the shared dismissal
 * layer (outside pointer-down + Escape, never on an inside press); row
 * labels are PLAIN TEXT (owner ruling 2026-10-21) — a link-rich title
 * flattens to its words, so the row is one click target and a right-click
 * anywhere on it opens the row menu.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { ClientNode } from "../src/core/workspace-client/index.js";
import { Sidebar } from "../src/ui/app/Sidebar.js";
import { recordRecent } from "../src/features/sidebar/recentPages.js";
import type { AnyClient } from "../src/ui/app/Sidebar.js";
import { resetNodePrefsForTests } from "../src/features/settings/nodePrefs.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

// jsdom has no PointerEvent: a minimal polyfill so the dismissal layer's
// pointerdown listeners see first-class pointer events.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(async () => {
  sqlModule = await initSqlJs();
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
  resetNodePrefsForTests();
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
    await client.createObject({ isEmbedded: false, name: "Alpha" });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Beta" });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Gamma" });
    localStorage.setItem("notees.favorites", JSON.stringify([pageId]));
    const { container } = renderSidebar(client);
    expect(screen.getByRole("button", { name: "Gamma" })).not.toBeNull();

    const menu = openRowMenu(container, "Gamma");
    fireEvent.click(within(menu).getByText("Remove from Favorites"));

    expect(JSON.parse(localStorage.getItem("notees.favorites") ?? "[]")).toEqual([]);
  });

  it("Remove from recents drops the row from the Recents section", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Delta" });
    recordRecent(pageId);
    const { container } = renderSidebar(client);
    expect(screen.getByRole("button", { name: "Delta" })).not.toBeNull();

    const menu = openRowMenu(container, "Delta");
    fireEvent.click(within(menu).getByText("Remove from recents"));

    expect(JSON.parse(localStorage.getItem("notees.recents") ?? "[]")).toEqual([]);
  });

  it("renaming a recents node re-renders the row with the new name (live label)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Old Name" });
    recordRecent(pageId);
    renderSidebar(client);
    expect(screen.getByRole("button", { name: "Old Name" })).not.toBeNull();

    await act(async () => {
      await client.updateObject(pageId, {
        contentAst: [{ type: "text", text: "New Name" }],
      });
    });

    expect(screen.getByRole("button", { name: "New Name" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Old Name" })).toBeNull();
  });

  it("Delete asks for confirmation, then deletes the node", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Epsilon" });
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
    const pageId = await client.createObject({ isEmbedded: false, name: "Zeta" });
    localStorage.setItem("notees.favorites", JSON.stringify([pageId]));
    const onOpenInSidebar = vi.fn();
    const { container } = renderSidebar(client, { onOpenInSidebar });

    const menu = openRowMenu(container, "Zeta");
    fireEvent.click(within(menu).getByText("Open in sidebar"));
    expect(onOpenInSidebar).toHaveBeenCalledWith(pageId);
  });

  it("closes on an outside press and on Escape", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Eta" });
    localStorage.setItem("notees.favorites", JSON.stringify([client.listPages()[0]!.id]));
    const { container } = renderSidebar(client);

    openRowMenu(container, "Eta");
    // Radix dismisses on pointer-down outside (its document listener
    // registers on a macrotask after mount).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(document.body);
    expect(rowMenu()).toBeNull();

    openRowMenu(container, "Eta");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(rowMenu()).toBeNull();
  });
});

describe("account menu dismissal", () => {
  const accountTrigger = () => screen.getByRole("button", { name: "Account" });

  it("closes on a pointer-down outside and on Escape", async () => {
    const client = await seedClient();
    renderSidebar(client);

    fireEvent.click(accountTrigger());
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(accountTrigger());
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("never closes on a press inside the popup; the trigger press is an anchor, not a dismissal", async () => {
    const client = await seedClient();
    renderSidebar(client);

    fireEvent.click(accountTrigger());
    const menu = screen.getByRole("menu");
    // A pointer-down on menu content is not an outside press.
    fireEvent.pointerDown(within(menu).getByText("Sign out"));
    expect(screen.getByRole("menu")).not.toBeNull();
    // Escape that originates inside the popup still closes it (the popup
    // root owns its own interior).
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(accountTrigger());
    expect(screen.getByRole("menu")).not.toBeNull();
    // The trigger is a declared anchor: pressing it does not dismiss; the
    // click that follows toggles the menu shut.
    fireEvent.pointerDown(accountTrigger());
    expect(screen.getByRole("menu")).not.toBeNull();
    fireEvent.click(accountTrigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("account popup — the user menu (owner 2026-10-19)", () => {
  const accountTrigger = () => screen.getByRole("button", { name: "Account" });
  const user = {
    id: "u1",
    email: "miquel@example.com",
    displayName: "Miquel",
    name: "Miquel",
    surnames: "Rosell",
    avatarUrl: null,
    isAdmin: true,
  };
  const syncStatus = {
    status: "idle" as const,
    error: null,
    pending: 0,
    failed: 0,
    quarantined: 0,
    parked: 0,
    realtime: true,
    cursorSeq: 7,
  };

  it("carries the identity header and the full entry list", async () => {
    const client = await seedClient();
    renderSidebar(client, {
      user,
      showSettings: true,
      syncStatus,
      onOpenSyncDetails: () => {},
      onOpenAdminSettings: () => {},
    });

    fireEvent.click(accountTrigger());
    const menu = screen.getByRole("menu");
    // Identity header: derived display name + email.
    expect(within(menu).getByText("Miquel Rosell")).not.toBeNull();
    expect(within(menu).getByText("miquel@example.com")).not.toBeNull();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((el) => el.textContent),
    ).toEqual([
      "Syncup to date",
      "Shares",
      "Trash",
      "Archived",
      "Settings",
      "Admin settings",
      "Sign out",
    ]);
  });

  it("entries close the popup and call their host: sync / trash / shares / settings / admin / sign out", async () => {
    const client = await seedClient();
    const onOpenSyncDetails = vi.fn();
    const onSelectNav = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenAdminSettings = vi.fn();
    const onSignOut = vi.fn();
    renderSidebar(client, {
      user,
      showSettings: true,
      syncStatus,
      onOpenSyncDetails,
      onSelectNav,
      onOpenSettings,
      onOpenAdminSettings,
      onSignOut,
    });

    const clickEntry = (label: string) => {
      fireEvent.click(accountTrigger());
      fireEvent.click(within(screen.getByRole("menu")).getByText(label));
      expect(screen.queryByRole("menu")).toBeNull();
    };
    clickEntry("Sync");
    expect(onOpenSyncDetails).toHaveBeenCalledTimes(1);
    clickEntry("Trash");
    expect(onSelectNav).toHaveBeenCalledWith("trash");
    clickEntry("Shares");
    expect(onSelectNav).toHaveBeenCalledWith("shares");
    clickEntry("Settings");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    clickEntry("Admin settings");
    expect(onOpenAdminSettings).toHaveBeenCalledTimes(1);
    clickEntry("Sign out");
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("gates entries: no Sync row without a snapshot+handler, no Shares offline, no Settings/Admin without the flags", async () => {
    const client = await seedClient();
    renderSidebar(client, { user, offline: true });
    fireEvent.click(accountTrigger());
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("Sync")).toBeNull();
    expect(within(menu).queryByText("Shares")).toBeNull();
    expect(within(menu).queryByText("Settings")).toBeNull();
    expect(within(menu).queryByText("Admin settings")).toBeNull();
    // Trash + Sign out stay in every mode.
    expect(within(menu).getByText("Trash")).not.toBeNull();
    expect(within(menu).getByText("Sign out")).not.toBeNull();
  });

  it("sync badge rides the profile avatar's corner; absent without a snapshot", async () => {
    const client = await seedClient();
    const { container, unmount } = renderSidebar(client, {
      user,
      syncStatus: { ...syncStatus, status: "error" as const, error: "relay down" },
    });
    expect(container.querySelector(".nt-profile-sync--error")).not.toBeNull();
    // The badge anchors inside the avatar span (not the row).
    expect(container.querySelector(".nt-profile-avatar .nt-profile-sync")).not.toBeNull();
    unmount();

    const { container: bare } = renderSidebar(client, { user });
    expect(bare.querySelector(".nt-profile-sync")).toBeNull();
  });

  it("the bottom row wears the identity at rest: avatar + name + email, no popup needed", async () => {
    const client = await seedClient();
    const { container } = renderSidebar(client, { user });
    const bottom = container.querySelector(".nt-sidebar-bottom")!;
    expect(within(bottom as HTMLElement).getByText("Miquel Rosell")).not.toBeNull();
    expect(within(bottom as HTMLElement).getByText("miquel@example.com")).not.toBeNull();
  });

  it("Trash left the sidebar nav list (the popup owns it now)", async () => {
    const client = await seedClient();
    renderSidebar(client, { user });
    // No nav row…
    expect(screen.queryByRole("button", { name: "Trash" })).toBeNull();
    // …until the popup opens.
    fireEvent.click(accountTrigger());
    expect(within(screen.getByRole("menu")).getByText("Trash")).not.toBeNull();
  });
});

describe("sidebar row labels render as plain text", () => {
  /**
   * The store flattens document-chrome content to text-only at the applier,
   * so no op path can seed a page title with a mention; the component seam
   * is exercised honestly with a hand-rolled client double serving a
   * link-rich content stream (the nodePrefs store explicitly supports
   * doubles without the prefs seam — device lists stand).
   */
  function stubNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
    return {
      workspaceId: WS,
      isClass: false,
      isEmbedded: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [],
      icon: null,
      coverAssetId: null,
      bannerAssetId: null,
      listStyle: null,
      aliasedNodeId: null,
      description: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
      ...partial,
    };
  }

  function stubSidebarClient(nodes: ClientNode[]): AnyClient {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return {
      listClasses: () => [],
      listPages: () => nodes,
      effectiveClassIcons: () => new Map(),
      isFeatureEnabled: () => true,
      getNode: (id: string) => byId.get(id),
      getDisplayName: () => null,
      getEffectiveProperties: () => [],
      listPropertySchemas: () => [],
      effectiveNodeColor: () => null,
      deleteObject: vi.fn(async () => {}),
      subscribe: () => () => {},
    } as unknown as AnyClient;
  }

  const richTitleNode = () =>
    stubNode({
      id: "rich-1",
      contentAst: [
        { type: "text", text: "Notes on " },
        { type: "mention", targetNodeId: "target-1", text: "Target" },
      ],
    });

  function renderRichRow(extras: Record<string, unknown> = {}) {
    const target = stubNode({ id: "target-1", contentAst: [{ type: "text", text: "Target" }] });
    const rich = richTitleNode();
    localStorage.setItem("notees.favorites", JSON.stringify([rich.id]));
    const rendered = renderSidebar(stubSidebarClient([rich, target]), extras);
    // The row body (a real <button>) — the focus target for keyboard nav.
    const row = screen.getAllByRole("button", { name: /notes on target/i })[0] as HTMLElement;
    return { ...rendered, row, rich, target };
  }

  it("flattens a link-rich title to its words — no link UI inside the row", () => {
    const { row } = renderRichRow();
    // The mention folded into its captured text; the label carries no
    // interactive or styled elements at all.
    expect(document.body.querySelector(".nt-link")).toBeNull();
    const label = row.querySelector<HTMLElement>(".nt-side-item-label")!;
    expect(label.textContent).toBe("Notes on Target");
    expect(label.querySelector("button, a")).toBeNull();
  });

  it("a markdown link in the title reduces to its label — the href stays out of the row", () => {
    const linked = stubNode({
      id: "md-1",
      contentAst: [
        { type: "text", text: "Ver [Informe 2024](https://example.com/informe) hoy" },
      ],
    });
    localStorage.setItem("notees.favorites", JSON.stringify([linked.id]));
    renderSidebar(stubSidebarClient([linked]));
    const row = screen.getAllByRole("button", { name: /ver informe 2024 hoy/i })[0] as HTMLElement;
    expect(row.querySelector(".nt-side-item-label")!.textContent).toBe("Ver Informe 2024 hoy");
  });

  it("a long href cannot crowd the label out — the strip lands before the 80-char cap", () => {
    const longHref = `https://example.com/${"x".repeat(120)}`;
    const linked = stubNode({
      id: "md-2",
      contentAst: [{ type: "text", text: `[Corto](${longHref})` }],
    });
    localStorage.setItem("notees.favorites", JSON.stringify([linked.id]));
    renderSidebar(stubSidebarClient([linked]));
    const row = screen.getAllByRole("button", { name: "Corto" })[0] as HTMLElement;
    expect(row.querySelector(".nt-side-item-label")!.textContent).toBe("Corto");
  });

  it("the row is the only clickable surface — clicking it opens the row's page", () => {
    const onOpenPage = vi.fn();
    const { row } = renderRichRow({ onOpenPage });
    // Nothing nested inside the row button competes with the row click.
    expect(row.querySelector("button, a")).toBeNull();
    fireEvent.click(row);
    expect(onOpenPage).toHaveBeenCalledWith("rich-1");
  });

  it("right-click anywhere on the row — the label included — opens the row menu", () => {
    const { row } = renderRichRow();
    const label = row.querySelector(".nt-side-item-label")!;
    fireEvent.contextMenu(label, { clientX: 4, clientY: 4 });
    expect(rowMenu()).not.toBeNull();
    fireEvent.contextMenu(row.closest("li")!, { clientX: 4, clientY: 4 });
    const menu = rowMenu();
    expect(menu).not.toBeNull();
    expect(within(menu!).getByText("Open page")).not.toBeNull();
  });

  it("keeps keyboard navigation and the shift-peek idiom", () => {
    const onOpenPage = vi.fn();
    const onOpenInSidebar = vi.fn();
    const { row } = renderRichRow({ onOpenPage, onOpenInSidebar });
    // The row is a REAL <button>: Enter/Space activation is platform-native
    // (jsdom does not derive a click from keydown, and there is no JS
    // keydown handler anymore) — the contract to assert is the element itself.
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row, { shiftKey: true });
    expect(onOpenInSidebar).toHaveBeenCalledWith("rich-1");
    fireEvent.click(row);
    expect(onOpenPage).toHaveBeenCalledWith("rich-1");
  });
});
