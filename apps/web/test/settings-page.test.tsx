/**
 * SettingsPage tests (jsdom): the full settings surface renders the
 * deep-linked section's content in the content area; the section nav
 * reports the requested section; the /settings/<section> routing helpers
 * map deep links (unknown sections land on appearance); the App's history
 * seam (pushSettingsSection + popStateNavHandler) pushes section changes
 * onto the URL and swaps sections on back/forward; retired accent presets
 * in storage fall back to the default; and the server-dependent sections
 * (API keys, sync, account) work against the mocked endpoints.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  SETTINGS_SECTIONS,
  SettingsPage,
  normalizeSettingsSection,
  pathForSettingsSection,
  settingsSectionFromPath,
  type SettingsPageProps,
  type SettingsSection,
} from "../src/ui/components/SettingsPage.js";
import { popStateNavHandler, pushSettingsSection } from "../src/ui/App.js";
import { applyAppearance } from "../src/ui/components/modals/deviceSettings.js";
import type { AccountUser } from "../src/core/auth-api.js";

beforeAll(() => {
  // jsdom lacks ResizeObserver.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.oled = "false";
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.focus;
  window.history.pushState({}, "", "/");
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

function renderPage(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  const props: SettingsPageProps = {
    section: "appearance",
    onNavigate: () => {},
    serverUrl: "https://notees.example.com",
    token: "session-token",
    user: USER,
    onSignOut: () => {},
    syncConnected: true,
    onForgetServer: () => {},
    onConnectServer: () => {},
    ...overrides,
  };
  render(<SettingsPage {...props} />);
  return props;
}

describe("settings routes", () => {
  it("maps /settings/<section> deep links, defaulting unknown sections to appearance", () => {
    expect(settingsSectionFromPath("/settings/sync")).toBe("sync");
    expect(settingsSectionFromPath("/settings/SYNC")).toBe("sync");
    expect(settingsSectionFromPath("/settings/account/")).toBe("account");
    expect(settingsSectionFromPath("/settings")).toBe("appearance");
    expect(settingsSectionFromPath("/settings/")).toBe("appearance");
    expect(settingsSectionFromPath("/settings/unknown")).toBe("appearance");
    expect(settingsSectionFromPath("/journal")).toBeNull();
    expect(settingsSectionFromPath("/pages")).toBeNull();
    expect(settingsSectionFromPath("/")).toBeNull();
  });

  it("round-trips every section through its canonical path", () => {
    for (const { id } of SETTINGS_SECTIONS) {
      expect(settingsSectionFromPath(pathForSettingsSection(id))).toBe(id);
    }
  });

  it("normalizeSettingsSection accepts only the eight sections", () => {
    expect(normalizeSettingsSection("editor")).toBe("editor");
    expect(normalizeSettingsSection("appearance")).toBe("appearance");
    expect(normalizeSettingsSection("sage")).toBe("appearance");
    expect(normalizeSettingsSection("custom")).toBe("appearance");
    expect(normalizeSettingsSection("")).toBe("appearance");
    expect(normalizeSettingsSection(null)).toBe("appearance");
    expect(normalizeSettingsSection(undefined)).toBe("appearance");
  });

  it("retired accent presets in storage fall back to the default on apply", () => {
    localStorage.setItem("notees.settings.accentColor", JSON.stringify("sage"));
    applyAppearance();
    expect(document.documentElement.dataset.accent).toBe("margin");

    localStorage.setItem("notees.settings.accentColor", JSON.stringify("custom"));
    applyAppearance();
    expect(document.documentElement.dataset.accent).toBe("margin");

    localStorage.setItem("notees.settings.accentColor", JSON.stringify("blue"));
    applyAppearance();
    expect(document.documentElement.dataset.accent).toBe("blue");
  });
});

describe("settings history (pushSettingsSection + popStateNavHandler)", () => {
  function track(): { sections: Array<SettingsSection | null>; cleanup: () => void } {
    const sections: Array<SettingsSection | null> = [];
    const handler = popStateNavHandler({
      openManager: () => {},
      closeManager: () => {},
      setNav: () => {},
      setNode: () => {},
      setSettingsSection: (section) => sections.push(section),
    });
    window.addEventListener("popstate", handler);
    return { sections, cleanup: () => window.removeEventListener("popstate", handler) };
  }

  it("pushState lands on /settings/<section> and the popstate seam maps it back", () => {
    const { sections, cleanup } = track();
    pushSettingsSection("sync");
    expect(window.location.pathname).toBe("/settings/sync");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(sections.at(-1)).toBe("sync");
    cleanup();
    window.history.pushState({}, "", "/");
  });

  it("swaps sections on back/forward and clears the route when leaving it", () => {
    // jsdom does not implement history traversal, so the popstate events
    // back/forward would fire are dispatched against the pushed entries.
    const { sections, cleanup } = track();
    window.history.pushState({}, "", "/journal");
    window.dispatchEvent(new PopStateEvent("popstate"));
    pushSettingsSection("editor");
    window.dispatchEvent(new PopStateEvent("popstate"));
    pushSettingsSection("about");
    window.dispatchEvent(new PopStateEvent("popstate"));
    // Back to the journal hub, then forward to a node path.
    window.history.pushState({}, "", "/journal");
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.pushState({}, "", "/11111111-2222-4333-8444-555555555555");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(sections).toEqual([null, "editor", "about", null, null]);
    cleanup();
    window.history.pushState({}, "", "/");
  });
});

describe("SettingsPage", () => {
  it("renders the deep-linked section's content and marks it active in the nav", () => {
    renderPage({ section: "sync" });
    expect(screen.getByText("https://notees.example.com")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Outdent behavior")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "Sync" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("section nav reports the requested section", () => {
    const onNavigate = vi.fn();
    renderPage({ onNavigate });
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole(
        "button",
        { name: "Editor" },
      ),
    );
    expect(onNavigate).toHaveBeenCalledWith("editor");
  });

  it("lists all eight sections in the nav", () => {
    renderPage();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button")).toHaveLength(8);
  });

  it("applies the UI font choice to <html> and persists it device-locally", () => {
    renderPage();
    fireEvent.click(screen.getByRole("radio", { name: "System stack" }));
    expect(document.documentElement.dataset.font).toBe("system");
    expect(localStorage.getItem("notees.settings.uiFont")).toBe('"system"');
    fireEvent.click(screen.getByRole("radio", { name: "Bundled (Instrument Sans)" }));
    expect(document.documentElement.dataset.font).toBe("bundled");
    expect(localStorage.getItem("notees.settings.uiFont")).toBe('"bundled"');
  });

  it("maps the theme segmented control onto theme + oled", () => {
    renderPage();
    fireEvent.click(screen.getByRole("radio", { name: "OLED theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.oled).toBe("true");
    expect(localStorage.getItem("notees.settings.oledMode")).toBe("true");
  });

  it("shows the configured sync server and its reachability", () => {
    stubFetch({});
    renderPage({ section: "sync" });
    expect(screen.getByText("https://notees.example.com")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("reports the server as unavailable when the parent says so", () => {
    stubFetch({});
    renderPage({ section: "sync", syncConnected: false });
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("disconnects only after the confirmation step", () => {
    stubFetch({});
    const onForgetServer = vi.fn();
    renderPage({ section: "sync", onForgetServer });
    fireEvent.click(screen.getByRole("button", { name: /disconnect & forget this server/i }));
    expect(onForgetServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));
    expect(onForgetServer).toHaveBeenCalledTimes(1);
  });

  it("connects to a different server with the entered URL", () => {
    stubFetch({});
    const onConnectServer = vi.fn();
    renderPage({
      section: "sync",
      serverUrl: "https://old.example.com",
      onConnectServer,
    });
    const field = screen.getByRole("textbox", { name: /server url/i });
    expect(field).toHaveValue("https://old.example.com");
    fireEvent.change(field, { target: { value: "https://new.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    expect(onConnectServer).toHaveBeenCalledWith("https://new.example.com");
  });

  it("manages API keys against the real endpoints in the Account section", async () => {
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

    renderPage({ section: "account" });

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

  it("signs out from the Account section", () => {
    stubFetch({});
    const onSignOut = vi.fn();
    renderPage({ section: "account", onSignOut });
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("marks profile, password, and security features as unavailable", () => {
    stubFetch({});
    renderPage({ section: "account" });
    expect(
      screen.getByText(/editing your profile is not available in this build/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/changing your password is not available in this build/i),
    ).toBeInTheDocument();
    renderPage({ section: "security" });
    expect(
      screen.getByText(/two-factor authentication is not available in this build/i),
    ).toBeInTheDocument();
  });
});

describe("accent swatch group (skill §9)", () => {
  it("the five swatches expose their selection via aria-pressed, exactly one pressed", () => {
    renderPage({ section: "appearance" });
    const swatches = screen.getAllByRole("button", { name: /^(Advance Green|Monochrome|Brown|Teal|Blue)$/ });
    expect(swatches).toHaveLength(5);
    const pressed = swatches.filter((swatch) => swatch.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.getAttribute("aria-label")).toBe("Advance Green");
  });
});
