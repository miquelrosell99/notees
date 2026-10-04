/**
 * Plugins settings tab tests (§34.59, jsdom): the Workspace Settings
 * Plugins tab lists the server's inert plugin registry (name, version,
 * capability summary, enable toggle), toggles and uninstalls through the
 * admin routes, and the "Install manifest" affordance validates pasted JSON
 * client-side against the protocol grammar (invalid JSON and schema
 * violations never reach the network) before POSTing an install.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { WorkspaceSettingsModal } from "../src/ui/components/modals/WorkspaceSettingsModal.js";
import type { PluginListEntry } from "../src/ui/components/modals/pluginsApi.js";

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
  vi.unstubAllGlobals();
});

const BIBTEX: PluginListEntry = {
  id: "com.example.bibtex",
  version: "1.2.3",
  name: "BibTeX bridge",
  description: "BibTeX in and out.",
  author: null,
  manifest: {
    manifestVersion: 1,
    id: "com.example.bibtex",
    name: "BibTeX bridge",
    version: "1.2.3",
    capabilities: {
      exportFormats: [{ id: "bibtex", label: "BibTeX", mime: "application/x-bibtex" }],
      importers: [{ id: "bibtex", label: "BibTeX file", mime: "application/x-bibtex", mode: "file" }],
      commands: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
  },
  enabled: false,
  installedAt: 1727200000000,
};

const TOOL: PluginListEntry = {
  id: "dev.local.tool",
  version: "0.1.0",
  name: "Local tool",
  description: null,
  author: null,
  manifest: {
    manifestVersion: 1,
    id: "dev.local.tool",
    name: "Local tool",
    version: "0.1.0",
    capabilities: {},
  },
  enabled: true,
  installedAt: 1727200001000,
};

function openPluginsTab() {
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
  fireEvent.click(screen.getByRole("tab", { name: "Plugins" }));
}

/** fetch stub over the /api/plugins surface; `plugins` is the live list. */
function stubPluginsSurface(initial: PluginListEntry[]) {
  let plugins = [...initial];
  const calls: { url: string; method: string; body: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: (init?.body as string) ?? null });
      if (url.endsWith("/api/plugins") && method === "GET") {
        return Response.json({ plugins });
      }
      if (url.endsWith("/api/plugins") && method === "POST") {
        const manifest = JSON.parse(init!.body as string) as PluginListEntry["manifest"];
        const entry = {
          id: manifest.id,
          version: manifest.version,
          name: manifest.name,
          description: manifest.description ?? null,
          author: manifest.author ?? null,
          manifest,
          enabled: false,
          installedAt: 1727200002000,
        };
        plugins = [...plugins.filter((p) => p.id !== entry.id), entry];
        return Response.json({ plugin: entry, alreadyInstalled: false }, { status: 201 });
      }
      const enabledMatch = /\/api\/plugins\/([^/]+)\/enabled$/.exec(url);
      if (enabledMatch && method === "POST") {
        const { enabled } = JSON.parse(init!.body as string) as { enabled: boolean };
        plugins = plugins.map((p) =>
          p.id === decodeURIComponent(enabledMatch[1]!) ? { ...p, enabled } : p,
        );
        return Response.json({ plugins: plugins.filter((p) => p.id === decodeURIComponent(enabledMatch[1]!)) });
      }
      const deleteMatch = /\/api\/plugins\/([^/]+)$/.exec(url);
      if (deleteMatch && method === "DELETE") {
        plugins = plugins.filter((p) => p.id !== decodeURIComponent(deleteMatch[1]!));
        return Response.json({ ok: true });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
  return calls;
}

describe("Workspace Settings → Plugins tab", () => {
  it("lists installed plugins with version, capability summary, and toggle state", async () => {
    stubPluginsSurface([BIBTEX, TOOL]);
    openPluginsTab();

    expect(await screen.findByText("BibTeX bridge")).toBeInTheDocument();
    expect(screen.getByText("Local tool")).toBeInTheDocument();
    // Capability summary from the manifest grammar helper.
    expect(screen.getByText(/1 export format · 1 importer · 2 commands/)).toBeInTheDocument();
    expect(screen.getByText(/no capabilities declared/)).toBeInTheDocument();
    // ToggleSwitch names itself from its Off/On labels (kit behavior), so
    // the two rows' switches are distinguished by order and checked state.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches[0]).toHaveAttribute("aria-checked", "false");
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
  });

  it("toggles a plugin via POST /plugins/:id/enabled and refreshes", async () => {
    const calls = stubPluginsSurface([BIBTEX]);
    openPluginsTab();
    await screen.findByText("BibTeX bridge");

    fireEvent.click(screen.getAllByRole("switch")[0]!);
    await waitFor(() =>
      expect(screen.getAllByRole("switch")[0]).toHaveAttribute("aria-checked", "true"),
    );
    const toggle = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/plugins/com.example.bibtex/enabled"),
    );
    expect(toggle).toBeDefined();
    expect(JSON.parse(toggle!.body!)).toEqual({ enabled: true });
  });

  it("uninstalls after inline confirmation via DELETE /plugins/:id", async () => {
    const calls = stubPluginsSurface([BIBTEX, TOOL]);
    openPluginsTab();
    await screen.findByText("BibTeX bridge");

    fireEvent.click(screen.getAllByRole("button", { name: /^uninstall$/i })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByText("BibTeX bridge")).toBeNull());
    expect(screen.getByText("Local tool")).toBeInTheDocument();
    expect(
      calls.some(
        (c) => c.method === "DELETE" && c.url.endsWith("/api/plugins/com.example.bibtex"),
      ),
    ).toBe(true);
  });

  it("rejects non-JSON paste without calling the server", async () => {
    const calls = stubPluginsSurface([]);
    openPluginsTab();
    await screen.findByText("No plugins installed");

    fireEvent.change(screen.getByLabelText("Plugin manifest JSON"), {
      target: { value: "{not json" },
    });
    fireEvent.click(screen.getByRole("button", { name: /install manifest$/i }));

    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("rejects a schema-invalid manifest with the validation issue shown, no POST", async () => {
    const calls = stubPluginsSurface([]);
    openPluginsTab();
    await screen.findByText("No plugins installed");

    const invalid = {
      manifestVersion: 1,
      id: "BibTeX",
      name: "Bad id plugin",
      version: "1.2.3",
      capabilities: {},
    };
    fireEvent.change(screen.getByLabelText("Plugin manifest JSON"), {
      target: { value: JSON.stringify(invalid) },
    });
    fireEvent.click(screen.getByRole("button", { name: /install manifest$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/id/i);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("installs a valid manifest via POST and refreshes the list", async () => {
    const calls = stubPluginsSurface([]);
    openPluginsTab();
    await screen.findByText("No plugins installed");

    const manifest = {
      manifestVersion: 1,
      id: "com.example.bibtex",
      name: "BibTeX bridge",
      version: "1.2.3",
      capabilities: {
        importers: [{ id: "bibtex", label: "BibTeX", mime: "application/x-bibtex", mode: "file" }],
      },
    };
    fireEvent.change(screen.getByLabelText("Plugin manifest JSON"), {
      target: { value: JSON.stringify(manifest, null, 2) },
    });
    fireEvent.click(screen.getByRole("button", { name: /install manifest$/i }));

    expect(await screen.findByText(/installed "BibTeX bridge" 1\.2\.3/i)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/plugins"));
    expect(JSON.parse(post!.body!)).toEqual(manifest);
    // The list refreshed: the plugin row is there and the paste cleared.
    expect(await screen.findByText("BibTeX bridge")).toBeInTheDocument();
    expect(screen.getByLabelText("Plugin manifest JSON")).toHaveValue("");
  });

  it("surfaces a server-side install failure (e.g. 409 version conflict)", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/api/plugins") && method === "GET") {
          return Response.json({ plugins: [BIBTEX] });
        }
        if (url.endsWith("/api/plugins") && method === "POST") {
          return Response.json(
            {
              error: {
                code: "conflict",
                message:
                  'plugin "com.example.bibtex" is already installed at another version; versioned updates ship with the plugin runtime (parked, §34.33 AG7)',
                status: 409,
              },
            },
            { status: 409 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }),
    );
    openPluginsTab();
    await screen.findByText("BibTeX bridge");

    const manifest = { ...BIBTEX.manifest, version: "2.0.0" };
    fireEvent.change(screen.getByLabelText("Plugin manifest JSON"), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole("button", { name: /install manifest$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already installed at another version/i);
  });
});
