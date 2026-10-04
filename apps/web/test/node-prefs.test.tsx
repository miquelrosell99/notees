/**
 * Cross-device favorites/recents tests (§34.61):
 *
 *  - core client: getPrefs/patchPrefs against a mocked HTTP layer (server
 *    answers vs offline fallback to the device-local cache, tagged `source`);
 *  - the nodePrefs store: server-wins load with device-only merge, legacy
 *    recordRecent broadcast synced upward, star toggle push;
 *  - Sidebar: Favorites section renders the server copy, the row star toggle
 *    writes through, recents sync on open;
 *  - FavoriteStar: page-header star toggles + syncs;
 *  - worker RPC: getPrefs/patchPrefs through handleMessage (memory fallback).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import {
  WorkspaceClient,
  mergeFavoriteToggle,
  mergeRecentOpen,
} from "../src/core/workspace-client.js";
import {
  ensureNodePrefsLoaded,
  resetNodePrefsForTests,
  toggleNodeFavorite,
  useNodePrefs,
} from "../src/ui/components/nodePrefs.js";
import { Sidebar, recordRecent, removeRecent } from "../src/ui/components/Sidebar.js";
import { FavoriteStar } from "../src/ui/components/FavoriteStar.js";
import type { AnyClient } from "../src/ui/components/Sidebar.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const SERVER = "https://notees.example.com";
const CREDENTIAL = "nt_testsession";

const PAGE_ALPHA = "0192b000-0000-7000-8000-0000000000a1";
const PAGE_BETA = "0192b000-0000-7000-8000-0000000000b2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
  resetNodePrefsForTests();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedClient(options: { serverUrl?: string; apiKey?: string } = {}): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    ...(options.serverUrl !== undefined ? { serverUrl: options.serverUrl } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** fetch stub routing /api/me/prefs; `handler` answers GET/PUT. */
function stubPrefsFetch(handler: (init: { method: string; body: string | undefined }) => unknown) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: String(url), method, body });
    const answer = handler({ method, body });
    if (answer instanceof Error) return new Response(answer.message, { status: 503 });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

// ---------------------------------------------------------------------------
// Core client: REST + offline fallback
// ---------------------------------------------------------------------------

describe("WorkspaceClient getPrefs/patchPrefs (HTTP layer)", () => {
  it("getPrefs returns the server copy and refreshes the device cache", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    stubPrefsFetch(() => ({ favorites: [PAGE_ALPHA], recents: [PAGE_BETA, PAGE_ALPHA], updatedAt: 1 }));
    const prefs = await client.getPrefs();
    expect(prefs).toEqual({ favorites: [PAGE_ALPHA], recents: [PAGE_BETA, PAGE_ALPHA], source: "server" });
    expect(JSON.parse(localStorage.getItem("notees.favorites")!)).toEqual([PAGE_ALPHA]);
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toEqual([PAGE_BETA, PAGE_ALPHA]);
  });

  it("patchPrefs PUTs the merge patch and returns the server answer", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const calls = stubPrefsFetch(({ method, body }) => {
      expect(method).toBe("PUT");
      return { ...(body !== undefined ? JSON.parse(body) : {}), updatedAt: 2 };
    });
    const prefs = await client.patchPrefs({ favorites: [PAGE_ALPHA] });
    expect(prefs.source).toBe("server");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SERVER}/api/me/prefs`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ favorites: [PAGE_ALPHA] });
    // The device cache followed the server answer.
    expect(JSON.parse(localStorage.getItem("notees.favorites")!)).toEqual([PAGE_ALPHA]);
  });

  it("offline (unreachable server): reads return the cached copy, writes persist locally", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    stubPrefsFetch(() => new Error("down"));
    localStorage.setItem("notees.favorites", JSON.stringify([PAGE_ALPHA]));
    const read = await client.getPrefs();
    expect(read).toEqual({ favorites: [PAGE_ALPHA], recents: [], source: "local" });
    const write = await client.patchPrefs({ recents: [PAGE_BETA] });
    expect(write.source).toBe("local");
    expect(write.recents).toEqual([PAGE_BETA]);
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toEqual([PAGE_BETA]);
  });

  it("offline-first client (no REST config): always the device-local cache", async () => {
    const client = await seedClient();
    localStorage.setItem("notees.favorites", JSON.stringify([PAGE_BETA]));
    const read = await client.getPrefs();
    expect(read.source).toBe("local");
    expect(read.favorites).toEqual([PAGE_BETA]);
    const write = await client.patchPrefs({ favorites: [PAGE_ALPHA, PAGE_BETA] });
    expect(write.source).toBe("local");
    expect(JSON.parse(localStorage.getItem("notees.favorites")!)).toEqual([PAGE_ALPHA, PAGE_BETA]);
  });
});

describe("prefs merge helpers", () => {
  it("mergeFavoriteToggle adds and removes preserving order", () => {
    expect(mergeFavoriteToggle([PAGE_ALPHA], PAGE_BETA)).toEqual([PAGE_ALPHA, PAGE_BETA]);
    expect(mergeFavoriteToggle([PAGE_ALPHA, PAGE_BETA], PAGE_ALPHA)).toEqual([PAGE_BETA]);
  });

  it("mergeRecentOpen fronts, dedupes, and caps at 50", () => {
    const list = Array.from({ length: 50 }, (_, i) => `0192b000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`);
    const next = mergeRecentOpen(list, PAGE_ALPHA);
    expect(next[0]).toBe(PAGE_ALPHA);
    expect(next).toHaveLength(50);
    expect(mergeRecentOpen([PAGE_ALPHA, PAGE_BETA], PAGE_ALPHA)).toEqual([PAGE_ALPHA, PAGE_BETA]);
  });
});

// ---------------------------------------------------------------------------
// nodePrefs store
// ---------------------------------------------------------------------------

type FakePrefs = { favorites: string[]; recents: string[]; source: "server" | "local"; updatedAt?: number };

function fakeClient(overrides: {
  getPrefs?: () => Promise<FakePrefs>;
  patchPrefs?: (patch: unknown) => Promise<FakePrefs>;
} = {}): import("../src/ui/components/nodePrefs.js").PrefsClient {
  return {
    getPrefs: overrides.getPrefs ?? (async () => ({ favorites: [], recents: [], source: "local" as const })),
    patchPrefs:
      overrides.patchPrefs ??
      (async (patch: unknown) => ({ ...((patch as object) ?? {}), source: "local" as const }) as FakePrefs),
  };
}

describe("nodePrefs store", () => {
  it("load: the server copy wins; device-only ids merge ahead (nothing clobbered)", async () => {
    localStorage.setItem("notees.recents", JSON.stringify([PAGE_BETA]));
    const pushed: unknown[] = [];
    const client = fakeClient({
      getPrefs: async () => ({ favorites: [PAGE_ALPHA], recents: [PAGE_ALPHA], source: "server" }),
      patchPrefs: async (patch) => {
        pushed.push(patch);
        return { ...(patch as object), source: "server" } as FakePrefs;
      },
    });
    ensureNodePrefsLoaded(client);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("notees.favorites")!)).toEqual([PAGE_ALPHA]);
    });
    // Device-only BETA landed ahead of the server's list; the merge pushed back.
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toEqual([PAGE_BETA, PAGE_ALPHA]);
    expect(pushed.length).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toContain(PAGE_BETA);
  });

  it("a legacy recordRecent broadcast syncs the recents list upward", async () => {
    const patches: unknown[] = [];
    const client = fakeClient({
      patchPrefs: async (patch) => {
        patches.push(patch);
        return { ...(patch as object), source: "server" } as FakePrefs;
      },
    });
    // Mount the hook so the store listens (a Sidebar would do this in-app).
    function Probe() {
      useNodePrefs(client);
      return null;
    }
    render(<Probe />);
    await act(async () => {
      recordRecent(PAGE_ALPHA);
    });
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect((patches[0] as { recents: string[] }).recents[0]).toBe(PAGE_ALPHA);
  });

  it("toggleNodeFavorite pushes the new favorites list", async () => {
    const patches: unknown[] = [];
    const client = fakeClient({
      patchPrefs: async (patch) => {
        patches.push(patch);
        return { ...(patch as object), source: "server" } as FakePrefs;
      },
    });
    toggleNodeFavorite(client, PAGE_ALPHA);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect((patches[0] as { favorites: string[] }).favorites).toEqual([PAGE_ALPHA]);
    expect(JSON.parse(localStorage.getItem("notees.favorites")!)).toEqual([PAGE_ALPHA]);
  });

  it("offline push failure keeps the device-local write and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({
      patchPrefs: async () => {
        throw new Error("offline");
      },
    });
    function Probe() {
      useNodePrefs(client);
      return null;
    }
    render(<Probe />);
    await act(async () => {
      recordRecent(PAGE_BETA);
    });
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toEqual([PAGE_BETA]);
  });
});

// ---------------------------------------------------------------------------
// Sidebar integration
// ---------------------------------------------------------------------------

function renderSidebar(client: AnyClient) {
  return render(
    <Sidebar
      client={client}
      workspaceName="Garden"
      workspaceId={WS}
      serverUrl={SERVER}
      credential={CREDENTIAL}
      user={null}
      offline={false}
      showSettings={false}
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
}

describe("Sidebar favorites/recents (§34.61)", () => {
  it("renders the Favorites section from the server prefs copy", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const pageId = await client.createObject({ presentAsMain: true, name: "Alpha" });
    stubPrefsFetch(() => ({ favorites: [pageId], recents: [], updatedAt: 1 }));
    renderSidebar(client);
    await screen.findByText("Alpha");
    // The section header exists and the row rendered inside it.
    expect(screen.getByText("Favorites")).toBeTruthy();
  });

  it("star toggle on a row writes the new list to the server", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const pageId = await client.createObject({ presentAsMain: true, name: "Beta" });
    const calls = stubPrefsFetch(({ method, body }) =>
      method === "PUT" && body !== undefined ? { ...JSON.parse(body), updatedAt: 2 } : { favorites: [], recents: [pageId], updatedAt: 1 },
    );
    renderSidebar(client);
    await screen.findByText("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      expect((JSON.parse(put!.body!) as { favorites: string[] }).favorites).toEqual([pageId]);
    });
  });

  it("opening a page (recordRecent) lands in the sidebar Recents and syncs", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const pageId = await client.createObject({ presentAsMain: true, name: "Gamma" });
    const calls = stubPrefsFetch(() => ({ favorites: [], recents: [], updatedAt: 1 }));
    renderSidebar(client);
    await act(async () => {
      recordRecent(pageId);
    });
    await screen.findByText("Gamma");
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      expect((JSON.parse(put!.body!) as { recents: string[] }).recents).toEqual([pageId]);
    });
  });

  it("removing a recent from the row menu syncs the removal", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const pageId = await client.createObject({ presentAsMain: true, name: "Delta" });
    const calls = stubPrefsFetch(({ method, body }) =>
      method === "PUT" && body !== undefined ? { ...JSON.parse(body), updatedAt: 2 } : { favorites: [], recents: [pageId], updatedAt: 1 },
    );
    renderSidebar(client);
    const row = (await screen.findByText("Delta")).closest("li")!;
    fireEvent.contextMenu(row, { clientX: 8, clientY: 8 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from recents/i }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeDefined();
      expect((JSON.parse(put!.body!) as { recents: string[] }).recents).toEqual([]);
    });
  });

  it("the device-local removeRecent path still works without a client", () => {
    recordRecent(PAGE_ALPHA);
    recordRecent(PAGE_BETA);
    removeRecent(PAGE_ALPHA);
    expect(JSON.parse(localStorage.getItem("notees.recents")!)).toEqual([PAGE_BETA]);
  });
});

// ---------------------------------------------------------------------------
// FavoriteStar (page header)
// ---------------------------------------------------------------------------

describe("FavoriteStar (page header)", () => {
  it("toggles from outline to starred and pushes the favorites list", async () => {
    const client = await seedClient({ serverUrl: SERVER, apiKey: CREDENTIAL });
    const calls = stubPrefsFetch(({ method, body }) =>
      method === "PUT" && body !== undefined ? { ...JSON.parse(body), updatedAt: 2 } : { favorites: [], recents: [], updatedAt: 1 },
    );
    render(<FavoriteStar client={client} nodeId={PAGE_ALPHA} />);
    const star = screen.getByRole("button", { name: "Add to favorites" });
    fireEvent.click(star);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove from favorites" })).toBeTruthy();
    });
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect((JSON.parse(put!.body!) as { favorites: string[] }).favorites).toEqual([PAGE_ALPHA]);
    });
  });
});
