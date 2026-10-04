/**
 * Protocol batch part 1 — web surface (jsdom): the §34.34 content-token
 * renderers (code_block read-only pre + language badge, the hr rule, the
 * embed_ref card views with the full-embed fallback) and the §34.35
 * Workspace Settings Features tab (live read surface, LOCKSTEP-PENDING
 * inert writes).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InlineTokens } from "../src/ui/InlineTokens.js";
import { WorkspaceSettingsModal } from "../src/ui/components/modals/WorkspaceSettingsModal.js";
import { WORKSPACE_FEATURE_MAP } from "@notees/domain";
import type { AnyClient } from "../src/ui/components/Sidebar.js";

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
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

describe("InlineTokens protocol-batch tokens (§34.34)", () => {
  it("renders a code_block as a read-only mono pre with the language badge", () => {
    const { container } = render(
      <InlineTokens
        tokens={[
          { type: "text", text: "intro" },
          { type: "code_block", language: "python", text: "print('hi')\nprint('bye')" },
        ]}
      />,
    );
    const pre = container.querySelector(".nt-code-block__pre");
    expect(pre?.textContent).toBe("print('hi')\nprint('bye')");
    expect(container.querySelector(".nt-code-block__lang")?.textContent).toBe("python");
    expect(screen.getByText("intro")).toBeInTheDocument();
  });

  it("renders a language-less code_block without a badge", () => {
    const { container } = render(
      <InlineTokens tokens={[{ type: "code_block", text: "plain snippet" }]} />,
    );
    expect(container.querySelector(".nt-code-block__pre")?.textContent).toBe("plain snippet");
    expect(container.querySelector(".nt-code-block__lang")).toBeNull();
  });

  it("renders the hr token as a horizontal rule", () => {
    const { container } = render(
      <InlineTokens
        tokens={[{ type: "text", text: "above" }, { type: "hr" }, { type: "text", text: "below" }]}
      />,
    );
    expect(container.querySelectorAll("hr.nt-hr")).toHaveLength(1);
    expect(screen.getByText("above")).toBeInTheDocument();
    expect(screen.getByText("below")).toBeInTheDocument();
  });

  it("routes embed_ref card views to the card renderer and defaults to the full embed", () => {
    const card = vi.fn((nodeId: string, view: "small_card" | "wide_card") => (
      <span data-testid={`card-${view}`}>{nodeId}</span>
    ));
    const full = vi.fn((nodeId: string) => <span data-testid="full">{nodeId}</span>);
    render(
      <InlineTokens
        tokens={[
          { type: "embed_ref", nodeId: "n-1", view: "small_card" },
          { type: "embed_ref", nodeId: "n-2", view: "wide_card" },
          { type: "embed_ref", nodeId: "n-3" },
          { type: "embed_ref", nodeId: "n-4", view: "embed" },
        ]}
        renderEmbed={full}
        renderEmbedCard={card}
      />,
    );
    expect(card).toHaveBeenCalledWith("n-1", "small_card");
    expect(card).toHaveBeenCalledWith("n-2", "wide_card");
    expect(screen.getByTestId("card-small_card")).toBeInTheDocument();
    expect(screen.getByTestId("card-wide_card")).toBeInTheDocument();
    // Absent view (and the explicit "embed" default) ride the full embed.
    expect(full).toHaveBeenCalledWith("n-3");
    expect(full).toHaveBeenCalledWith("n-4");
    expect(screen.getAllByTestId("full")).toHaveLength(2);
  });

  it("falls back to the full embed for card views when no card renderer is injected", () => {
    const full = vi.fn((nodeId: string) => <span data-testid="full">{nodeId}</span>);
    render(
      <InlineTokens
        tokens={[{ type: "embed_ref", nodeId: "n-1", view: "small_card" }]}
        renderEmbed={full}
      />,
    );
    expect(full).toHaveBeenCalledWith("n-1");
  });
});

/** Minimal client mock for the Features tab (reads + the chips enumeration). */
function featureClient(overrides: {
  enabled?: Record<string, boolean>;
  instances?: Record<string, number>;
  setFeatureEnabled?: (feature: string, enabled: boolean) => Promise<void>;
}): AnyClient {
  const enabled = overrides.enabled ?? {};
  const instances = overrides.instances ?? {};
  return {
    getWorkspaceId: () => "ws1",
    subscribe: () => () => {},
    listClasses: () => [],
    getClassBindings: () => [],
    getNodeRaw: () => undefined,
    effectiveClassColor: () => null,
    isFeatureEnabled: (feature: string) => enabled[feature] ?? true,
    getFeatureInstanceCount: (feature: string) => instances[feature] ?? 0,
    listFeatureRows: () => [],
    setFeatureEnabled: overrides.setFeatureEnabled ?? (() => Promise.resolve()),
  } as unknown as AnyClient;
}

function renderFeaturesTab(client: AnyClient | undefined) {
  render(
    <WorkspaceSettingsModal
      isOpen
      onClose={() => {}}
      serverUrl="https://notees.example.com"
      credential="session-token"
      workspaceId="ws1"
      workspaceName="Garden"
      workspaceRole="owner"
      client={client}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Features" }));
}

describe("Workspace Settings Features tab (§34.35/§34.55 — lockstep SHIPPED)", () => {
  it("lists the five core families with icon, powers line, and a LIVE ToggleSwitch", () => {
    renderFeaturesTab(featureClient({}));
    const entries = Object.entries(WORKSPACE_FEATURE_MAP);
    expect(entries).toHaveLength(5);
    for (const [, spec] of entries) {
      expect(screen.getByText(spec.label)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(spec.powers.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    }
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(5);
    for (const toggle of switches) {
      // Lockstep shipped (GTK/Flutter v3.0.0): the toggles write.
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveAttribute("aria-checked", "true");
    }
    // The lockstep-pending note is gone.
    expect(screen.queryByText(/mobile and desktop clients catch up/i)).toBeNull();
  });

  it("clicking a toggle writes workspace.feature.set through the client", async () => {
    const setFeatureEnabled = vi.fn().mockResolvedValue(undefined);
    renderFeaturesTab(featureClient({ setFeatureEnabled }));
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]!); // Tasks, currently On → Off
    await waitFor(() => {
      expect(setFeatureEnabled).toHaveBeenCalledWith("tasks", false);
    });
  });

  it("reads the live toggle state and instance counts from the client", () => {
    renderFeaturesTab(
      featureClient({ enabled: { tasks: false }, instances: { tasks: 3, events: 1 } }),
    );
    // Row order follows the feature map (tasks first); the ToggleSwitch's
    // accessible name is its "Off"/"On" labels, so index by row order.
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toHaveAttribute("aria-checked", "false");
    for (const toggle of switches.slice(1)) {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    }
    expect(screen.getByText(/3 existing objects/)).toBeInTheDocument();
    expect(screen.getByText(/1 existing object\b/)).toBeInTheDocument();
  });

  it("renders the honest note when the client belongs to another workspace", () => {
    renderFeaturesTab(undefined);
    expect(screen.getByText(/open this workspace to see its feature toggles/i)).toBeInTheDocument();
  });
});

describe("feature chrome gates (§34.55)", () => {
  it("isClassFamilyEnabled: own feature + managed ancestors (event-off hides the meeting chip too)", async () => {
    const { isClassFamilyEnabled } = await import("../src/ui/components/featureGates.js");
    const { SYSTEM_CLASS_UUIDS } = await import("@notees/domain");
    const client = (disabled: string[]) =>
      ({
        isFeatureEnabled: (feature: string) => !disabled.includes(feature),
      }) as never;

    // Everything on: every family class enabled.
    expect(isClassFamilyEnabled(client([]), SYSTEM_CLASS_UUIDS.meeting)).toBe(true);
    expect(isClassFamilyEnabled(client([]), SYSTEM_CLASS_UUIDS.birthday)).toBe(true);
    // Meetings off: meeting chrome hides; event + birthday stay.
    expect(isClassFamilyEnabled(client(["meetings"]), SYSTEM_CLASS_UUIDS.meeting)).toBe(false);
    expect(isClassFamilyEnabled(client(["meetings"]), SYSTEM_CLASS_UUIDS.event)).toBe(true);
    expect(isClassFamilyEnabled(client(["meetings"]), SYSTEM_CLASS_UUIDS.birthday)).toBe(true);
    // Events off: the cascade hides meeting AND birthday chrome with it.
    expect(isClassFamilyEnabled(client(["events"]), SYSTEM_CLASS_UUIDS.meeting)).toBe(false);
    expect(isClassFamilyEnabled(client(["events"]), SYSTEM_CLASS_UUIDS.birthday)).toBe(false);
    expect(isClassFamilyEnabled(client(["events"]), SYSTEM_CLASS_UUIDS.event)).toBe(false);
    // Sources off hides the whole source family; persons off the person class.
    expect(isClassFamilyEnabled(client(["sources"]), SYSTEM_CLASS_UUIDS.book)).toBe(false);
    expect(isClassFamilyEnabled(client(["sources"]), SYSTEM_CLASS_UUIDS.conference)).toBe(false);
    expect(isClassFamilyEnabled(client(["persons"]), SYSTEM_CLASS_UUIDS.person)).toBe(false);
    // Always-on vocabulary and user classes gate on nothing.
    expect(isClassFamilyEnabled(client(["events"]), SYSTEM_CLASS_UUIDS.day)).toBe(true);
    expect(isClassFamilyEnabled(client(["events"]), SYSTEM_CLASS_UUIDS.agent)).toBe(true);
    expect(isClassFamilyEnabled(client(["events"]), "a-user-class-id")).toBe(true);
  });

  it("the sidebar hides the Tasks hub entry while the tasks family is off", async () => {
    const { Sidebar } = await import("../src/ui/components/Sidebar.js");
    const baseMock = {
      getWorkspaceId: () => "ws1",
      subscribe: () => () => {},
      isFeatureEnabled: (feature: string) => feature !== "tasks",
      listClasses: () => [],
      listPages: () => [],
      roots: () => [],
      search: () => [],
      getNode: () => undefined,
      getDisplayName: () => null,
      getBacklinkCount: () => 0,
      getChildPageCount: () => 0,
    };
    const props = {
      client: baseMock as unknown as AnyClient,
      workspaceName: "Garden",
      workspaceId: "ws1",
      serverUrl: "https://notees.example.com",
      credential: "session-token",
      user: null,
      offline: false,
      showSettings: false,
      onOpenSettings: () => {},
      selectedPageId: null,
      activeNav: "pages" as const,
      onSelectNav: () => {},
      onOpenPage: () => {},
      onRequestSearch: () => {},
      onSwitchWorkspace: () => {},
      onManageWorkspaces: () => {},
      onSignOut: () => {},
    };
    const { unmount } = render(<Sidebar {...props} />);
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    unmount();

    render(
      <Sidebar
        {...props}
        client={{ ...baseMock, isFeatureEnabled: () => true } as unknown as AnyClient}
      />,
    );
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });
});
