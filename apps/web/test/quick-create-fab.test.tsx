/**
 * Mobile quick-create + drawer dismissal tests: the QuickCreateFab
 * component (a floating action button opening the
 * existing QuickAddModal) and the drawerDismissHandler predicate from
 * App.tsx (narrow-viewport taps outside the drawer/topbar close it; desktop
 * and no-matchMedia environments never dismiss). The FAB's narrow-width
 * visibility is CSS — pinned by mobile-layout.test.ts's responsive-block
 * contract; this file covers the component behavior + the dismissal logic.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { QuickCreateFab } from "../src/ui/components/QuickCreateFab.js";
import { drawerDismissHandler } from "../src/ui/App.js";

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
  vi.unstubAllGlobals();
  localStorage.clear();
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

describe("QuickCreateFab", () => {
  it("renders the FAB button and opens the QuickAddModal on tap", async () => {
    const client = await seedClient();
    render(<QuickCreateFab client={client} />);

    const fab = screen.getByRole("button", { name: "Quick add" });
    expect(document.querySelector(".nt-quick-fab")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(fab);
    expect(screen.getByRole("dialog", { name: "Quick Add" })).not.toBeNull();

    // The modal closes via its own close path.
    fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The FAB itself stays mounted for the next tap.
    expect(screen.getByRole("button", { name: "Quick add" })).not.toBeNull();
  });
});

describe("drawerDismissHandler (tap-outside drawer dismissal)", () => {
  function stubMatchMedia(matches: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches, media: "", addEventListener: () => {}, removeEventListener: () => {} })),
    );
  }

  /** A minimal element tree: topbar + sidebar + page body. */
  function mountShell(): { sidebar: HTMLElement; topbar: HTMLElement; body: HTMLElement } {
    document.body.innerHTML = "";
    const topbar = document.createElement("header");
    topbar.className = "nt-topbar";
    const sidebar = document.createElement("nav");
    sidebar.className = "nt-sidebar";
    const body = document.createElement("div");
    body.className = "nt-body";
    document.body.append(topbar, sidebar, body);
    return { sidebar, topbar, body };
  }

  /** Dispatch a real pointerdown on the element THROUGH the handler (so the
      event's target resolves exactly where the tap landed). */
  function tap(handler: (event: PointerEvent) => void, target: Element): void {
    document.addEventListener("pointerdown", handler);
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    document.removeEventListener("pointerdown", handler);
  }

  it("a narrow-viewport tap on the page body closes the drawer", () => {
    stubMatchMedia(true);
    mountShell();
    const closeSidebar = vi.fn();
    tap(drawerDismissHandler({ isSidebarOpen: () => true, closeSidebar }), document.body);
    expect(closeSidebar).toHaveBeenCalledTimes(1);
  });

  it("taps INSIDE the drawer or the topbar keep it open", () => {
    stubMatchMedia(true);
    const { sidebar, topbar } = mountShell();
    const closeSidebar = vi.fn();
    const handler = drawerDismissHandler({ isSidebarOpen: () => true, closeSidebar });

    const insideDrawer = document.createElement("button");
    sidebar.appendChild(insideDrawer);
    tap(handler, insideDrawer);
    expect(closeSidebar).not.toHaveBeenCalled();

    const hamburger = document.createElement("button");
    topbar.appendChild(hamburger);
    tap(handler, hamburger);
    expect(closeSidebar).not.toHaveBeenCalled();
  });

  it("desktop widths and closed drawers never dismiss", () => {
    stubMatchMedia(false); // desktop width
    mountShell();
    const closeSidebar = vi.fn();
    tap(drawerDismissHandler({ isSidebarOpen: () => true, closeSidebar }), document.body);
    expect(closeSidebar).not.toHaveBeenCalled();

    stubMatchMedia(true); // narrow, but the drawer is closed
    tap(drawerDismissHandler({ isSidebarOpen: () => false, closeSidebar }), document.body);
    expect(closeSidebar).not.toHaveBeenCalled();
  });

  it("no-matchMedia environments (jsdom default) never dismiss", () => {
    mountShell();
    const closeSidebar = vi.fn();
    tap(drawerDismissHandler({ isSidebarOpen: () => true, closeSidebar }), document.body);
    expect(closeSidebar).not.toHaveBeenCalled();
  });
});
