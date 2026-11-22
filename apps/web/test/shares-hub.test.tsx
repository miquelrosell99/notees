/**
 * SharesHub — the Shares management hub behind the account popup's Shares
 * entry: lists the workspace's live public share links (node names resolved
 * through the local projection), copy / open / revoke per row, the honest
 * empty state, and the load-failure retry.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { SharesHub } from "../src/features/sharing/SharesHub.js";
import { fetchConfidentialInbox, fetchGrantInbox, listShares, revokeShare, type ShareEntry } from "../src/features/sharing/shareApi.js";

vi.mock("../src/features/sharing/shareApi.js", () => ({
  listShares: vi.fn(),
  revokeShare: vi.fn(),
  fetchGrantInbox: vi.fn(),
  fetchConfidentialInbox: vi.fn(),
}));

vi.mock("../src/features/modals/clipboard.js", () => ({
  copyToClipboard: vi.fn(() => Promise.resolve()),
}));

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  vi.mocked(listShares).mockReset();
  vi.mocked(revokeShare).mockReset();
  vi.mocked(fetchGrantInbox).mockReset();
  // No grants in the inbox unless a test opts in — full peers see no section.
  vi.mocked(fetchGrantInbox).mockResolvedValue({ grants: [] });
  vi.mocked(fetchConfidentialInbox).mockReset();
  vi.mocked(fetchConfidentialInbox).mockResolvedValue({ shares: [] });
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

function share(partial: Partial<ShareEntry> & { token: string; nodeId: string }): ShareEntry {
  return {
    urlPath: `/public/n/${partial.token}`,
    workspaceId: WS,
    createdBy: null,
    createdAt: 1_800_000_000_000,
    expiresAt: null,
    revokedAt: null,
    ...partial,
  };
}

describe("SharesHub", () => {
  it("lists live shares with resolved node names; revoked links are filtered out", async () => {
    const client = await seedClient();
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    const beta = await client.createObject({ isEmbedded: false, name: "Beta" });
    vi.mocked(listShares).mockResolvedValue({
      shares: [
        share({ token: "t1", nodeId: alpha }),
        share({ token: "t2", nodeId: beta, revokedAt: 1_800_100_000_000 }),
      ],
    });
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);

    expect(await screen.findByText("Alpha")).not.toBeNull();
    expect(screen.queryByText("Beta")).toBeNull();
    // The live link count rides the header.
    expect(document.querySelector(".surface-topbar__count")?.textContent).toBe("1");
    // The absolute URL prefixes the server origin.
    expect(screen.getByText("http://server/public/n/t1")).not.toBeNull();
  });

  it("revoke confirms inline, then calls the API and refreshes", async () => {
    const client = await seedClient();
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    vi.mocked(listShares).mockResolvedValue({ shares: [share({ token: "t1", nodeId: alpha })] });
    vi.mocked(revokeShare).mockResolvedValue({ ok: true });
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    // Inline confirm: the danger aria-label names the consequence.
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke now — anyone holding the link loses access immediately" }),
    );
    expect(vi.mocked(revokeShare)).toHaveBeenCalledWith("http://server", "tok", "t1");
    await act(async () => {});
    expect(vi.mocked(listShares).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Open rides the node id through the host callback", async () => {
    const client = await seedClient();
    const alpha = await client.createObject({ isEmbedded: false, name: "Alpha" });
    vi.mocked(listShares).mockResolvedValue({ shares: [share({ token: "t1", nodeId: alpha })] });
    const onOpenNode = vi.fn();
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={onOpenNode} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(onOpenNode).toHaveBeenCalledWith(alpha);
  });

  it("renders the honest empty state and the failure retry", async () => {
    const client = await seedClient();
    vi.mocked(listShares).mockResolvedValue({ shares: [] });
    const { unmount } = render(
      <SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />,
    );
    expect(await screen.findByText("No shared links yet")).not.toBeNull();
    unmount();

    vi.mocked(listShares).mockRejectedValue(new Error("relay unreachable"));
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);
    expect(await screen.findByText("Failed to load shared links")).not.toBeNull();
    expect(screen.getByText("relay unreachable")).not.toBeNull();

    // Try again re-runs the load.
    vi.mocked(listShares).mockResolvedValue({ shares: [] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No shared links yet")).not.toBeNull();
  });
});

describe("SharesHub — the Shares Inbox (per-node grants)", () => {
  it("renders a Shared-with-me section with role and granter when the inbox has grants", async () => {
    const client = await seedClient();
    const alpha = await client.createObject({ isEmbedded: false, name: "Proyecto" });
    vi.mocked(listShares).mockResolvedValue({ shares: [] });
    vi.mocked(fetchGrantInbox).mockResolvedValue({
      grants: [
        {
          id: "g1",
          nodeId: alpha,
          workspaceId: WS,
          granteeUserId: "u-me",
          granteeEmail: null,
          role: "edit",
          createdBy: "u-owner",
          createdAt: 1_800_000_000_000,
          grantedByEmail: "owner@example.com",
          grantedByDisplayName: null,
          workspaceRole: "member",
        },
      ],
    });
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);

    expect(await screen.findByText("Shared with me")).not.toBeNull();
    expect(screen.getByText("Proyecto")).not.toBeNull();
    expect(screen.getByText(/Can edit/)).not.toBeNull();
    expect(screen.getByText(/Shared by owner@example\.com/)).not.toBeNull();
  });

  it("renders no inbox section for a full peer (empty inbox)", async () => {
    const client = await seedClient();
    await client.createObject({ isEmbedded: false, name: "Alpha" });
    vi.mocked(listShares).mockResolvedValue({ shares: [] });
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);
    await act(async () => {});
    expect(screen.queryByText("Shared with me")).toBeNull();
  });
});

describe("SharesHub — the confidential inbox (password-sealed reads)", () => {
  it("lists a confidential share with its lock + password-required copy; opening prompts for the password", async () => {
    const client = await seedClient();
    vi.mocked(listShares).mockResolvedValue({ shares: [] });
    vi.mocked(fetchConfidentialInbox).mockResolvedValue({
      shares: [
        {
          id: "cs1",
          workspaceId: WS,
          nodeId: "00000000-0000-0000-0000-000000000000",
          displayName: "Proyecto secreto",
          grantedByEmail: "owner@example.com",
          grantedByDisplayName: null,
          createdAt: 1_800_000_000_000,
        },
      ],
    });
    render(<SharesHub client={client} serverUrl="http://server" credential="tok" onOpenNode={() => {}} />);

    expect(await screen.findByText("Shared with me")).not.toBeNull();
    expect(screen.getByText("Proyecto secreto")).not.toBeNull();
    expect(screen.getByText(/password required/)).not.toBeNull();
    // Opening rides the view modal's password prompt.
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(await screen.findByLabelText("Confidential share password")).not.toBeNull();
  });
});
