/**
 * Protocol batch part 1 — web surface (jsdom): the §34.34 content-token
 * renderers (code_block read-only pre + language badge, the hr rule, the
 * embed_ref card views with the full-embed fallback) and the §34.35
 * Workspace Settings Features tab (live read surface, LOCKSTEP-PENDING
 * inert writes).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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
}): AnyClient {
  const enabled = overrides.enabled ?? {};
  const instances = overrides.instances ?? {};
  return {
    getWorkspaceId: () => "ws1",
    subscribe: () => () => {},
    listClasses: () => [],
    getClassBindings: () => [],
    isFeatureEnabled: (feature: string) => enabled[feature] ?? true,
    getFeatureInstanceCount: (feature: string) => instances[feature] ?? 0,
    listFeatureRows: () => [],
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

describe("Workspace Settings Features tab (§34.35, LOCKSTEP-PENDING)", () => {
  it("lists every feature with its description and a disabled inert toggle", () => {
    renderFeaturesTab(featureClient({}));
    for (const spec of Object.values(WORKSPACE_FEATURE_MAP)) {
      expect(screen.getByText(spec.label)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(spec.description.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    }
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(Object.keys(WORKSPACE_FEATURE_MAP).length);
    for (const toggle of switches) {
      expect(toggle).toBeDisabled();
      expect(toggle).toBeChecked();
    }
    // The lockstep-pending honesty note renders.
    expect(screen.getByText(/mobile and desktop clients catch up/i)).toBeInTheDocument();
  });

  it("reads the live toggle state and instance counts from the client", () => {
    renderFeaturesTab(
      featureClient({ enabled: { tasks: false }, instances: { tasks: 3, journals: 1 } }),
    );
    const tasksToggle = screen.getByRole("switch", { name: /tasks/i });
    expect(tasksToggle).not.toBeChecked();
    expect(screen.getByText(/3 existing objects/)).toBeInTheDocument();
    expect(screen.getByText(/1 existing object in this workspace/)).toBeInTheDocument();
  });

  it("renders the honest note when the client belongs to another workspace", () => {
    renderFeaturesTab(undefined);
    expect(screen.getByText(/open this workspace to see its feature toggles/i)).toBeInTheDocument();
  });
});
