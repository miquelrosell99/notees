/**
 * Settings modals tests (jsdom): the recovered workspace/system settings
 * modals render their ported chrome; the workspace rename talks to the
 * real PATCH /workspaces/:id endpoint; the appearance controls (theme /
 * accent — the quick-tweaks modal retired) apply choices
 * to <html> data-* attributes and persist them under `notees.settings.*`
 * (focus mode rides the shared top-bar toggle helper); the full settings
 * page specs (sections, API keys, sync, routing) live in
 * settings-page.test.tsx; the workspace switcher offers create-from-query
 * and opens Manage Workspaces; the Manage Workspaces modal lists, renames,
 * creates, switches, exports, and deletes workspaces via the per-card
 * actions menu.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createKdfRecord, generateMasterKey } from "@notees/protocol";

import { clearCryptoCustody, deriveMasterKey } from "../src/core/crypto-custody.js";

import { WorkspaceSettingsModal } from "../src/features/workspaces/WorkspaceSettingsModal.js";
import { SystemSettingsModal } from "../src/features/settings/SystemSettingsModal.js";
import { toggleFocusMode } from "../src/features/settings/deviceSettings.js";
import { AccentColorPicker, ThemeModeControl } from "../src/features/settings/SettingsPage.js";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.js";
import { Sidebar, type AnyClient } from "../src/ui/app/Sidebar.js";
import { WorkspaceSwitcher } from "../src/features/workspaces/WorkspaceSwitcher.js";
import type { AccountUser, WorkspaceEntry } from "../src/core/auth-api.js";

beforeAll(() => {
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  // jsdom has no PointerEvent either: a minimal polyfill so the popup
  // dismissal layer's pointerdown listeners see first-class pointer events.
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
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
});

afterEach(() => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.oled = "false";
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.focus;
  clearCryptoCustody();
});

const USER: AccountUser = {
  id: "u1",
  email: "ada@example.com",
  displayName: "Ada",
  name: "Ada",
  surnames: null,
  avatarUrl: null,
  isAdmin: false,
};

const WS = { id: "ws1", name: "Garden", role: "owner", createdAt: 1727200000000, envelopeCount: 3, latestSeq: 2 };
const WS2: WorkspaceEntry = {
  id: "ws2",
  name: "Backyard",
  role: "editor",
  createdAt: 1727200001000,
  envelopeCount: 0,
  latestSeq: 0,
};

/** Creation is keyed unconditionally: creation tests seed the master key. */
async function seedMasterKey(): Promise<void> {
  const master = await generateMasterKey();
  await deriveMasterKey("correct horse battery staple", await createKdfRecord(master, "correct horse battery staple"));
}

/** fetch stub: routes by URL suffix, recording calls for assertions. */
function stubFetch(routes: Record<string, () => unknown>) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: (init?.body as string) ?? null });
      for (const suffix of Object.keys(routes)) {
        if (url.endsWith(suffix)) return Response.json(routes[suffix]!());
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

describe("WorkspaceSettingsModal", () => {
  it("renames the workspace via PATCH /workspaces/:id", async () => {
    const calls = stubFetch({
      "/api/workspaces/ws1": () => ({ id: "ws1", name: "Orchard" }),
    });
    const onRenamed = vi.fn();
    render(
      <WorkspaceSettingsModal
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        isOpen
        onClose={() => {}}
        workspaceRole="owner"
        onRenamed={onRenamed}
      />,
    );

    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "Orchard" } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Orchard"));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://notees.example.com/api/workspaces/ws1");
    expect(JSON.parse(patch!.body!)).toEqual({ name: "Orchard" });
    expect(await screen.findByText("Workspace renamed.")).toBeInTheDocument();
  });

  it("disables rename for non-owners with an explanatory note", () => {
    render(
      <WorkspaceSettingsModal
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        isOpen
        onClose={() => {}}
        workspaceRole="editor"
      />,
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByText(/only the workspace owner can rename/i)).toBeInTheDocument();
  });

  it("persists sidebar visibility toggles device-locally", () => {
    render(
      <WorkspaceSettingsModal
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        isOpen
        onClose={() => {}}
        workspaceRole="owner"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /journals/i }));
    expect(localStorage.getItem("notees.settings.sidebarShowJournals")).toBe("false");
    expect(screen.getByRole("switch", { name: /inbox/i })).toBeChecked();
  });

  it("renders retention controls honestly inert (the citekey pattern moved to Features → Sources)", () => {
    render(
      <WorkspaceSettingsModal
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        isOpen
        onClose={() => {}}
        workspaceRole="owner"
      />,
    );
    expect(screen.getAllByText("Not available in this build.").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByLabelText("Citekey pattern")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /30 days/i })).toBeDisabled();
  });

  it("lists the shell shortcuts in the Shortcuts tab", () => {
    render(
      <WorkspaceSettingsModal
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        isOpen
        onClose={() => {}}
        workspaceRole="owner"
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
    expect(screen.getByText("Quick add note")).toBeInTheDocument();
    expect(screen.getByText("Bold")).toBeInTheDocument();
  });
});

describe("appearance controls (the quick-tweaks modal's survivors)", () => {
  it("applies the Light theme choice to <html> and persists it device-locally", () => {
    render(<ThemeModeControl id="user-theme" />);
    fireEvent.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.oled).toBe("false");
    expect(localStorage.getItem("notees.settings.theme")).toBe('"light"');
    expect(localStorage.getItem("notees.settings.oledMode")).toBe("false");
  });

  it("maps the four theme modes onto the theme + oled keys", () => {
    render(<ThemeModeControl id="user-theme" />);
    const pick = (name: string) =>
      fireEvent.click(screen.getByRole("radio", { name }));

    pick("Dark theme");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.oled).toBe("false");
    expect(localStorage.getItem("notees.settings.theme")).toBe('"dark"');
    expect(localStorage.getItem("notees.settings.oledMode")).toBe("false");

    pick("OLED theme");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.oled).toBe("true");
    expect(localStorage.getItem("notees.settings.theme")).toBe('"dark"');
    expect(localStorage.getItem("notees.settings.oledMode")).toBe("true");

    // Auto → theme:system, oled:false. jsdom has no matchMedia, so the
    // resolved dataset value is the light default; the stored pref is system.
    pick("Auto theme");
    expect(localStorage.getItem("notees.settings.theme")).toBe('"system"');
    expect(localStorage.getItem("notees.settings.oledMode")).toBe("false");
    expect(document.documentElement.dataset.oled).toBe("false");
  });

  it("applies the focus mode toggle to <html> and persists it device-locally", () => {
    // Focus mode lives on the top bar's crop-free button now; the write path is the shared toggleFocusMode helper it rides.
    toggleFocusMode();
    expect(document.documentElement.dataset.focus).toBe("true");
    expect(localStorage.getItem("notees.settings.focusMode")).toBe("true");
    toggleFocusMode();
    expect(document.documentElement.dataset.focus).toBe("false");
    expect(localStorage.getItem("notees.settings.focusMode")).toBe("false");
  });

  it("applies an accent preset to <html> and persists it device-locally", () => {
    render(<AccentColorPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Teal" }));
    expect(document.documentElement.dataset.accent).toBe("teal");
    expect(localStorage.getItem("notees.settings.accentColor")).toBe('"teal"');
  });

  it("offers exactly the five curated presets — no custom swatch", () => {
    render(<AccentColorPicker />);
    const group = screen.getByRole("group", { name: "Accent Color" });
    const swatches = within(group).getAllByRole("button");
    expect(swatches).toHaveLength(5);
    for (const label of ["Advance Green", "Monochrome", "Brown", "Teal", "Blue"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(within(group).queryByRole("button", { name: /custom/i })).toBeNull();
  });
});

describe("SystemSettingsModal", () => {
  it("renders both tabs with honest unavailability notes", () => {
    render(<SystemSettingsModal isOpen onClose={() => {}} />);
    expect(screen.getByText(/user management is not available in this build/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Metrics" }));
    expect(screen.getByText(/system metrics are not available in this build/i)).toBeInTheDocument();
  });
});

describe("entry points", () => {
  const client = {
    listClasses: () => [],
    classIcons: () => new Map(),
    effectiveClassIcons: () => new Map(),
    listPages: () => [],
    listPageSummaries: () => [],
    // The sidebar nav reads the feature surface for the Tasks hub.
    isFeatureEnabled: () => true,
    subscribe: () => () => {},
  } as unknown as AnyClient;

  it("account popup's Settings entry opens the app settings", () => {
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        client={client}
        user={USER}
        offline={false}
        showSettings
        onOpenSettings={onOpenSettings}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onSignOut={() => {}}
      />,
    );
    // The gear left the sidebar foot with the account-popup redesign
    // — and came back a day later: the owner doesn't
    // want a shortcut as the settings door.
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("the settings gear rides the sidebar foot again — one click, no popup", () => {
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        client={client}
        user={USER}
        offline={false}
        showSettings
        onOpenSettings={onOpenSettings}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("sidebar honors the device-local journal/inbox visibility toggles", () => {
    localStorage.setItem("notees.settings.sidebarShowJournals", "false");
    render(
      <Sidebar
        client={client}
        user={USER}
        offline={false}
        showSettings
        onOpenSettings={() => {}}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^journal$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^inbox$/i })).toBeInTheDocument();
  });

  it("workspace rows expose a settings gear that opens the workspace modal", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    render(
      <WorkspaceSwitcher
        serverUrl="https://notees.example.com"
        credential="session-token"
        activeWorkspaceId="ws1"
        activeName="Garden"
        onSwitch={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /garden/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Garden settings" }));
    expect(await screen.findByRole("heading", { name: "Workspace Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Garden");
  });

  it("offers creating a workspace when the search matches nothing", async () => {
    await seedMasterKey();
    const calls: { url: string; method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: (init?.body as string) ?? null });
        if (url.endsWith("/api/workspaces") && method === "GET") {
          return Response.json({ workspaces: [WS] });
        }
        if (url.endsWith("/api/workspaces") && method === "POST") {
          return Response.json({ id: "ws9" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    const onSwitch = vi.fn();
    render(
      <WorkspaceSwitcher
        serverUrl="https://notees.example.com"
        credential="session-token"
        activeWorkspaceId="ws1"
        activeName="Garden"
        onSwitch={onSwitch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /garden/i }));
    await screen.findByText("Garden");
    fireEvent.change(screen.getByPlaceholderText(/search workspaces/i), {
      target: { value: "Orchard" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create workspace “orchard”/i }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("ws9", "Orchard"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://notees.example.com/api/workspaces");
    expect(JSON.parse(post!.body!)).toEqual(
      expect.objectContaining({ name: "Orchard", wrappedKey: expect.any(String) }),
    );
    // The popup closed after the create+switch.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("search-row manage icon opens Manage workspaces instead of signing out", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    const onManageWorkspaces = vi.fn();
    render(
      <WorkspaceSwitcher
        serverUrl="https://notees.example.com"
        credential="session-token"
        activeWorkspaceId="ws1"
        activeName="Garden"
        onSwitch={() => {}}
        onManageWorkspaces={onManageWorkspaces}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /garden/i }));
    fireEvent.click(await screen.findByRole("button", { name: /manage workspaces/i }));
    expect(onManageWorkspaces).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("the workspace popup closes on an outside pointer-down and on Escape", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    render(
      <WorkspaceSwitcher
        serverUrl="https://notees.example.com"
        credential="session-token"
        activeWorkspaceId="ws1"
        activeName="Garden"
        onSwitch={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: /garden/i });
    fireEvent.click(trigger);
    const popup = await screen.findByRole("listbox");

    // A press inside the popup (the search field) never dismisses.
    fireEvent.pointerDown(within(popup).getByPlaceholderText(/search workspaces/i));
    expect(screen.getByRole("listbox")).not.toBeNull();
    // A press on the trigger is an anchor press, not an outside press.
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole("listbox")).not.toBeNull();
    // Escape originating inside the popup (the field holds focus) closes it.
    fireEvent.keyDown(within(popup).getByPlaceholderText(/search workspaces/i), {
      key: "Escape",
    });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    await screen.findByRole("listbox");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ManageWorkspacesModal", () => {
  it("lists workspaces with an active badge and switches on row click", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS, WS2] }),
    });
    const onSwitch = vi.fn();
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        onEnter={onSwitch}
      />,
    );
    expect(await screen.findByText("Garden")).toBeInTheDocument();
    expect(screen.getByText("Backyard")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open backyard/i }));
    expect(onSwitch).toHaveBeenCalledWith("ws2", "Backyard");
  });

  it("marks encrypted workspaces with a lock badge; the row still opens via onEnter", async () => {
    stubFetch({
      "/api/workspaces": () => ({
        workspaces: [{ ...WS, encrypted: true }, WS2],
      }),
    });
    const onEnter = vi.fn();
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId={null}
        onEnter={onEnter}
      />,
    );
    // The encrypted card carries the lock badge; the plaintext one doesn't.
    expect(await screen.findByTitle("Encrypted — opening asks for your password")).toBeInTheDocument();
    expect(screen.getAllByTitle("Encrypted — opening asks for your password")).toHaveLength(1);
    // The click goes through the normal enter path — the connect flow decides
    // whether the unlock re-prompt takes over (fail-loud ruling).
    fireEvent.click(screen.getByRole("button", { name: "Open Garden" }));
    expect(onEnter).toHaveBeenCalledWith("ws1", "Garden");
  });

  it("renames a workspace via the card actions menu → PATCH /workspaces/:id", async () => {
    const calls = stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS, WS2] }),
      "/api/workspaces/ws1": () => ({ id: "ws1", name: "Orchard" }),
    });
    const onRenamed = vi.fn();
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws2"
        onEnter={() => {}}
        onRenamed={onRenamed}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    fireEvent.change(screen.getByLabelText("Workspace Name"), { target: { value: "Orchard" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename Workspace" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("ws1", "Orchard"));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://notees.example.com/api/workspaces/ws1");
    expect(JSON.parse(patch!.body!)).toEqual({ name: "Orchard" });
    expect(await screen.findByText("Orchard")).toBeInTheDocument();
  });

  it("disables rename and delete for non-owner workspaces", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS2] }),
    });
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        onEnter={() => {}}
        activeWorkspaceId="ws2"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Backyard" }));
    // Radix menuitems carry the disabled state via aria-disabled (the
    // correct ARIA for menu rows — they are not native form controls).
    expect(screen.getByRole("menuitem", { name: /rename/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /delete/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /export/i })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("deletes a workspace after confirmation and refreshes the list", async () => {
    let deleted = false;
    const calls: { url: string; method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: (init?.body as string) ?? null });
        if (url.endsWith("/api/workspaces") && method === "GET") {
          return Response.json({ workspaces: deleted ? [WS2] : [WS, WS2] });
        }
        if (url.endsWith("/api/workspaces/ws1") && method === "DELETE") {
          deleted = true;
          return Response.json({ ok: true });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        onEnter={() => {}}
        activeWorkspaceId="ws2"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
    await waitFor(() => expect(screen.queryByText("Garden")).toBeNull());
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://notees.example.com/api/workspaces/ws1");
    expect(screen.getByText("Backyard")).toBeInTheDocument();
  });

  it("omits actions with no backend (share, duplicate, import)", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        onEnter={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /share|duplicate|import/i })).toBeNull();
  });

  it("creates a workspace and switches to it", async () => {
    await seedMasterKey();
    const calls: { url: string; method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: (init?.body as string) ?? null });
        if (url.endsWith("/api/workspaces") && method === "GET") {
          return Response.json({ workspaces: [WS] });
        }
        if (url.endsWith("/api/workspaces") && method === "POST") {
          return Response.json({ id: "ws9" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    const onSwitch = vi.fn();
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        onEnter={onSwitch}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /create workspace/i }));
    fireEvent.change(screen.getByLabelText("Workspace Name"), { target: { value: "New plots" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("ws9", "New plots"));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://notees.example.com/api/workspaces");
    expect(JSON.parse(post!.body!)).toEqual(
      expect.objectContaining({ name: "New plots", wrappedKey: expect.any(String) }),
    );
  });

  it("omits actions with no backend (share, duplicate, import)", async () => {
    stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        onEnter={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /share|duplicate|import/i })).toBeNull();
  });

  it("opens the export modal and downloads the locally-built zip (assets toggle on)", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/api/workspaces")) {
          return Response.json({ workspaces: [WS] });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    let captured: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = this;
      });
    // Plan-07: the zip builds locally from the CONNECTED workspace's store —
    // the server export.zip route is retired. An empty-root stub store is
    // enough (the bundle is just the manifest for an empty workspace).
    const activeClient = { roots: () => [] } as unknown as import("../src/ui/app/clients.js").AnyClient;

    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        activeClient={activeClient}
        onEnter={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));

    // The options modal: format note + include-assets toggle (default off).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const includeAssets = screen.getByRole("checkbox", { name: /include asset files/i });
    expect(includeAssets).not.toBeChecked();

    fireEvent.click(includeAssets);
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    // Built locally — no export.zip request ever leaves the client.
    await waitFor(() => expect(captured).not.toBeNull());
    expect(calls.some((c) => c.url.includes("export.zip"))).toBe(false);
    expect(captured!.getAttribute("download")).toMatch(/Garden-\d{4}-\d{2}-\d{2}\.zip/);
    // Success closes the modal again.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    click.mockRestore();
  });

  it("builds the local zip without assets by default", async () => {
    const calls = stubFetch({
      "/api/workspaces": () => ({ workspaces: [WS] }),
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const activeClient = { roots: () => [] } as unknown as import("../src/ui/app/clients.js").AnyClient;

    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        activeClient={activeClient}
        onEnter={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.url.includes("export.zip"))).toBe(false);
  });

  it("surfaces a local export failure in the modal without closing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces")) {
          return Response.json({ workspaces: [WS] });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    const activeClient = {
      roots: () => {
        throw new Error("local store unavailable");
      },
    } as unknown as import("../src/ui/app/clients.js").AnyClient;
    render(
      <WorkspacesView
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={null}
        activeWorkspaceId="ws1"
        activeClient={activeClient}
        onEnter={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/local store unavailable/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

});
