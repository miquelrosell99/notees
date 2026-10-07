/**
 * Shares tests (jsdom): the SharePageModal talks to the
 * /api/shares surface (list on open, create, revoke via the inline confirm,
 * copy through the clipboard seam) and the node menus surface the "Share…"
 * item only where it belongs — pages with a share target, never classes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ClientNode } from "../src/core/workspace-client.js";
import { NodeContextMenu } from "../src/ui/components/NodeContextMenu.js";
import { SharePageModal } from "../src/ui/components/modals/SharePageModal.js";
import type { ShareEntry } from "../src/ui/components/modals/shareApi.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const SERVER = "https://notees.example.com";

const EXISTING = {
  token: "tok_existing_00000000000000000000",
  urlPath: "/s/tok_existing_00000000000000000000",
  nodeId: "page-1",
  workspaceId: "ws1",
  createdBy: null,
  createdAt: 1_727_200_000_000,
  expiresAt: null,
  revokedAt: null,
};

function renderModal() {
  return render(
    <SharePageModal
      isOpen
      onClose={() => {}}
      serverUrl={SERVER}
      token="session-token"
      nodeUuid="page-1"
      nodeName="Quarterly plan"
    />,
  );
}

describe("SharePageModal", () => {
  it("lists the page's shares on open and composes the full URL", async () => {
    const calls = stubFetch({
      "/api/shares?nodeId=page-1": () => ({ shares: [EXISTING] }),
    });
    renderModal();

    await screen.findByText(`${SERVER}/s/tok_existing_00000000000000000000`);
    expect(screen.getByText('Share "Quarterly plan"')).toBeInTheDocument();
    expect(calls[0]?.url).toBe(`${SERVER}/api/shares?nodeId=page-1`);
    expect(calls[0]?.method).toBe("GET");
  });

  it("creates a new link on demand and refreshes the list", async () => {
    let shares = [EXISTING];
    const fresh = { ...EXISTING, token: "tok_fresh_0000000000000000000000", urlPath: "/s/tok_fresh_0000000000000000000000" };
    const calls = stubFetch({
      "/api/shares?nodeId=page-1": () => ({ shares }),
      "/api/shares": () => {
        shares = [fresh, ...shares];
        return { share: fresh };
      },
    });

    renderModal();
    await screen.findByText(`${SERVER}/s/tok_existing_00000000000000000000`);
    fireEvent.click(screen.getByText("Create another link"));

    await screen.findByText(`${SERVER}/s/tok_fresh_0000000000000000000000`);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe(`${SERVER}/api/shares`);
    expect(JSON.parse(post!.body!)).toEqual({ nodeId: "page-1" });
  });

  it("revokes through the inline confirm and shows the row dimmed", async () => {
    let shares: ShareEntry[] = [{ ...EXISTING }];
    const calls = stubFetch({
      "/api/shares?nodeId=page-1": () => ({ shares }),
      [`/api/shares/${EXISTING.token}`]: () => {
        shares = shares.map((s) => ({ ...s, revokedAt: 1_727_200_200_000 }));
        return { ok: true };
      },
    });

    renderModal();
    await screen.findByText(`${SERVER}/s/tok_existing_00000000000000000000`);
    fireEvent.click(screen.getByText("Revoke"));
    // InlineConfirmButton: the trigger arms, the check confirms.
    fireEvent.click(await screen.findByLabelText(/revoke now/i));

    await waitFor(() => {
      expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
        `${SERVER}/api/shares/${EXISTING.token}`,
      );
    });
    await screen.findByText("Revoked");
    // The Modal portals to document.body — query the document, not the container.
    expect(document.querySelector(".nt-share__row--revoked")).not.toBeNull();
    // A revoked row keeps its URL on screen (history) with no live actions.
    expect(screen.queryByText("Revoke")).toBeNull();
  });

  it("copies the link through the clipboard seam and flips the button label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    stubFetch({
      "/api/shares?nodeId=page-1": () => ({ shares: [EXISTING] }),
    });

    renderModal();
    await screen.findByText(`${SERVER}/s/tok_existing_00000000000000000000`);
    fireEvent.click(screen.getByText("Copy"));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${SERVER}/s/tok_existing_00000000000000000000`),
    );
    await screen.findByText("Copied");
  });

  it("shows the empty state with a create action when no links exist", async () => {
    let shares: unknown[] = [];
    stubFetch({
      "/api/shares?nodeId=page-1": () => ({ shares }),
      "/api/shares": () => {
        shares = [EXISTING];
        return { share: EXISTING };
      },
    });

    render(
      <SharePageModal
        isOpen
        onClose={() => {}}
        serverUrl={SERVER}
        token="session-token"
        nodeUuid="page-1"
      />,
    );

    fireEvent.click(await screen.findByText("Create link"));
    await screen.findByText(`${SERVER}/s/tok_existing_00000000000000000000`);
  });
});

describe("NodeContextMenu Share… item", () => {
  function menuNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
    return {
      workspaceId: "ws1",
      isClass: false,
      presentAsMain: true,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [{ type: "text", text: "Share Candidate" }],
      icon: null,
      coverAssetId: null,
      bannerAssetId: null,
      aliasedNodeId: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
      ...partial,
    };
  }

  const client = {
    unassignClass: async () => {},
    deleteObject: async () => {},
    updateObject: async () => {},
    getNode: () => undefined,
    getChildren: () => [],
    getEffectiveProperties: () => [],
    createObject: async () => "unused",
    setProperty: async () => {},
  };

  it("offers Share… for a page when a share target is wired, and fires onShare", () => {
    const onShare = vi.fn();
    render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: menuNode({ id: "page-9" }), isPage: true }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
        onShare={onShare}
      />,
    );
    fireEvent.click(screen.getByText("Share…"));
    expect(onShare).toHaveBeenCalledWith("page-9", "Share Candidate");
  });

  it("hides Share… without a share target and for class nodes", () => {
    const { queryByText, unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: menuNode({ id: "page-10" }), isPage: true }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    expect(queryByText("Share…")).toBeNull();
    unmount();

    render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: menuNode({ id: "class-1", isClass: true }), isPage: true }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
        onShare={() => {}}
      />,
    );
    expect(screen.queryByText("Share…")).toBeNull();
  });
});
