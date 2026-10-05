/**
 * Settings modals tests (jsdom): the recovered workspace/user/system
 * settings modals render their ported chrome; the workspace rename talks to
 * the real PATCH /workspaces/:id endpoint; appearance choices apply to
 * <html> data-* attributes and persist under `notees.settings.*`; the API
 * keys manager (ApiKeysSection) works inside the user settings modal against
 * a mocked /api-keys surface; controls with no v2 backend render honestly
 * inert with a "not available in this build" note; the workspace switcher
 * offers create-from-query and opens Manage Workspaces; the Manage
 * Workspaces modal lists, renames, creates, switches, exports, and deletes
 * workspaces via the per-card actions menu.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WorkspaceSettingsModal } from "../src/ui/components/modals/WorkspaceSettingsModal.js";
import { UserSettingsModal } from "../src/ui/components/modals/UserSettingsModal.js";
import { SystemSettingsModal } from "../src/ui/components/modals/SystemSettingsModal.js";
import { WorkspacesView } from "../src/ui/components/WorkspacesView.js";
import { Sidebar, type AnyClient } from "../src/ui/components/Sidebar.js";
import { WorkspaceSwitcher } from "../src/ui/components/WorkspaceSwitcher.js";
import type { AccountUser, WorkspaceEntry } from "../src/core/auth-api.js";

beforeAll(() => {
  // jsdom lacks ResizeObserver; Tabs.List uses it for the active indicator.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.oled = "false";
  delete document.documentElement.dataset.accent;
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
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
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
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        workspaceRole="editor"
      />,
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByText(/only the workspace owner can rename/i)).toBeInTheDocument();
  });

  it("persists sidebar visibility toggles device-locally", () => {
    render(
      <WorkspaceSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        workspaceRole="owner"
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /journals/i }));
    expect(localStorage.getItem("notees.settings.sidebarShowJournals")).toBe("false");
    expect(screen.getByRole("switch", { name: /inbox/i })).toBeChecked();
  });

  it("renders retention and citekey controls honestly inert", () => {
    render(
      <WorkspaceSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        workspaceRole="owner"
      />,
    );
    expect(screen.getAllByText("Not available in this build.").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByLabelText("Citekey pattern")).toBeDisabled();
    expect(screen.getByRole("button", { name: /30 days/i })).toBeDisabled();
  });

  it("lists the shell shortcuts in the Shortcuts tab", () => {
    render(
      <WorkspaceSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        credential="session-token"
        workspaceId="ws1"
        workspaceName="Garden"
        workspaceRole="owner"
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(screen.getByText("Open command palette")).toBeInTheDocument();
    expect(screen.getByText("Quick add note")).toBeInTheDocument();
    expect(screen.getByText("Bold")).toBeInTheDocument();
  });
});

describe("UserSettingsModal", () => {
  it("applies the theme choice to <html> and persists it device-locally", () => {
    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("notees.settings.theme")).toBe('"light"');
  });

  it("applies the UI font choice to <html> and persists it device-locally", () => {
    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "System stack" }));
    expect(document.documentElement.dataset.font).toBe("system");
    expect(localStorage.getItem("notees.settings.uiFont")).toBe('"system"');
    fireEvent.click(screen.getByRole("radio", { name: "Bundled (Inter)" }));
    expect(document.documentElement.dataset.font).toBe("bundled");
    expect(localStorage.getItem("notees.settings.uiFont")).toBe('"bundled"');
  });

  it("applies the accent color choice to <html>", () => {
    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sage" }));
    expect(document.documentElement.dataset.accent).toBe("sage");
    expect(localStorage.getItem("notees.settings.accentColor")).toBe('"sage"');
  });

  it("manages API keys against the real endpoints inside the Account tab", async () => {
    interface Key {
      id: string;
      name: string;
      revokedAt: null;
    }
    let keys: Key[] = [{ id: "k1", name: "laptop CLI", revokedAt: null }];
    const envelope = (k: Key) => ({
      id: k.id,
      userId: "u1",
      name: k.name,
      prefix: "nk_ab",
      createdAt: 0,
      lastUsedAt: null,
      revokedAt: k.revokedAt,
    });
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/api/api-keys") && method === "GET") {
          return Response.json({ apiKeys: keys.map(envelope) });
        }
        if (url.endsWith("/api/api-keys") && method === "POST") {
          const created: Key = { id: "k2", name: "desktop CLI", revokedAt: null };
          keys = [...keys, created];
          return Response.json({ apiKey: envelope(created), token: "nk_full_secret" });
        }
        if (url.endsWith("/api/api-keys/k1") && method === "DELETE") {
          keys = keys.filter((k) => k.id !== "k1");
          return Response.json({ ok: true });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));

    // Existing key listed.
    expect(await screen.findByText("laptop CLI")).toBeInTheDocument();

    // Create a new key: POST /api-keys, secret shown once.
    fireEvent.change(screen.getByPlaceholderText(/key name/i), {
      target: { value: "desktop CLI" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByText(/copy it now/i)).toBeInTheDocument();
    expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/api/api-keys")),
    ).toBe(true);

    // Revoke the first key: inline confirmation, then DELETE.
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.queryByText("laptop CLI")).not.toBeInTheDocument());
    expect(
      calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/api-keys/k1")),
    ).toBe(true);
  });

  it("signs out from the Account tab", () => {
    stubFetch({});
    const onSignOut = vi.fn();
    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={onSignOut}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("marks profile, password, and security features as unavailable", () => {
    stubFetch({});
    render(
      <UserSettingsModal
        isOpen
        onClose={() => {}}
        serverUrl="https://notees.example.com"
        token="session-token"
        user={USER}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Account" }));
    expect(
      screen.getByText(/editing your profile is not available in this build/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/changing your password is not available in this build/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Security" }));
    expect(
      screen.getByText(/two-factor authentication is not available in this build/i),
    ).toBeInTheDocument();
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
    listPages: () => [],
    // §34.55: the sidebar nav reads the feature surface for the Tasks hub.
    isFeatureEnabled: () => true,
  } as unknown as AnyClient;

  it("account menu gains a Settings item opening the app settings", () => {
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        client={client}
        workspaceName="Garden"
        workspaceId="ws1"
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={USER}
        offline={false}
        showSettings
        onOpenSettings={onOpenSettings}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onRequestSearch={() => {}}
        onSwitchWorkspace={() => {}}
        onManageWorkspaces={() => {}}
        onSignOut={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("sidebar honors the device-local journal/inbox visibility toggles", () => {
    localStorage.setItem("notees.settings.sidebarShowJournals", "false");
    render(
      <Sidebar
        client={client}
        workspaceName="Garden"
        workspaceId="ws1"
        serverUrl="https://notees.example.com"
        credential="session-token"
        user={USER}
        offline={false}
        showSettings
        onOpenSettings={() => {}}
        selectedPageId={null}
        activeNav="pages"
        onSelectNav={() => {}}
        onOpenPage={() => {}}
        onRequestSearch={() => {}}
        onSwitchWorkspace={() => {}}
        onManageWorkspaces={() => {}}
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
    expect(JSON.parse(post!.body!)).toEqual({ name: "Orchard" });
    // The popup closed after the create+switch.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("footer opens Manage workspaces instead of signing out", async () => {
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
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /export/i })).toBeEnabled();
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
    expect(JSON.parse(post!.body!)).toEqual({ name: "New plots" });
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

  it("opens the export modal from the actions menu and downloads the zip with assets included", async () => {
    const calls: { url: string; method: string }[] = [];
    let resolveExport: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.endsWith("/api/workspaces")) {
          return Response.json({ workspaces: [WS] });
        }
        if (url.includes("/api/workspaces/ws1/export.zip")) {
          // Hold the zip in flight so the modal's busy state is observable.
          return new Promise<Response>((resolve) => {
            resolveExport = resolve;
          });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    let capturedBlob: Blob | null = null;
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        capturedBlob = blob;
        return "blob:mock";
      }),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    let captured: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = this;
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
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));

    // The E6 options modal: format note + include-assets toggle (default off).
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/one zip archive/i)).toBeInTheDocument();
    const includeAssets = screen.getByRole("checkbox", { name: /include asset files/i });
    expect(includeAssets).not.toBeChecked();

    fireEvent.click(includeAssets);
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    // Busy state while the zip builds: the request carries the toggle and
    // the footer buttons are dead until the blob lands.
    const exportCall = calls.find((c) => c.url.includes("export.zip"));
    expect(exportCall?.url).toContain("includeAssets=1");
    expect(screen.getByRole("button", { name: /exporting/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeDisabled();

    resolveExport!(
      new Response("zip-bytes", {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": 'attachment; filename="garden.zip"',
        },
      }),
    );

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.getAttribute("download")).toBe("garden.zip");
    expect(capturedBlob!.type).toBe("application/zip");
    // Success closes the modal again.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    click.mockRestore();
  });

  it("requests the workspace zip without assets by default", async () => {
    const calls = stubFetch({
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
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await waitFor(() => {
      const exportCall = calls.find((c) => c.url.includes("export.zip"));
      expect(exportCall?.url).toContain("includeAssets=0");
    });
  });

  it("surfaces an export failure in the modal without closing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/workspaces")) {
          return Response.json({ workspaces: [WS] });
        }
        if (url.includes("/api/workspaces/ws1/export.zip")) {
          return Response.json({ error: { message: "zip build failed" } }, { status: 500 });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
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
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/zip build failed/i);
    // The modal stays open, ready to retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^export$/i })).toBeEnabled();
  });
});
