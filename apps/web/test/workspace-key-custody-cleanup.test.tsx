/**
 * Custody-record cleanup (F1): `notees-custody`'s `workspaceKeys` records
 * must not leak forever. A workspace's device-local key is deleted WITH the
 * workspace (every removal surface) — deleting a missing record is a silent
 * no-op, and a workspace re-created later mints a FRESH key, never
 * resurrecting the old record. Sign-out is NOT a cleanup trigger: custody
 * records survive session end by design (the T9 data-availability ruling —
 * each key protects content sealed under it); the preserved-records pin
 * lives in `offline-keying.test.ts`.
 *
 * fake-indexeddb is not a devDep: the store seam takes an in-memory fake
 * (record-shaped, so the key↔bytes logic is exercised through it).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { importWorkspaceKey } from "@notees/protocol";

import {
  clearCryptoCustody,
  ensureOfflineWorkspaceKey,
} from "../src/core/crypto-custody.js";
import {
  deleteOfflineWorkspaceKey,
  getOfflineWorkspaceKey,
  persistOfflineWorkspaceKey,
  setWorkspaceKeyStoreForTests,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from "../src/core/master-key-storage.js";
import { WorkspacesView } from "../src/features/workspaces/WorkspacesView.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const OTHER_WS = "0192a000-0000-7000-8000-000000000002";

/** In-memory fake standing in for the IndexedDB workspace-key store (per-id). */
function fakeStore(): WorkspaceKeyStore & { records: Map<string, WorkspaceKeyRecord> } {
  const records = new Map<string, WorkspaceKeyRecord>();
  return {
    records,
    async store(id, record) {
      records.set(id, record);
    },
    async load(id) {
      const record = records.get(id);
      return record === undefined ? null : { id, ...record };
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

afterEach(async () => {
  await clearCryptoCustody();
  setWorkspaceKeyStoreForTests(undefined);
  vi.unstubAllGlobals();
});

describe("deleteOfflineWorkspaceKey (workspace removal)", () => {
  it("removes the record: a later ensure mints a FRESH key (the old key is gone)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const first = await ensureOfflineWorkspaceKey(WS);
    expect(store.records.has(WS)).toBe(true);

    await deleteOfflineWorkspaceKey(WS);

    expect(store.records.has(WS)).toBe(false);
    expect(await getOfflineWorkspaceKey(WS)).toBeNull();
    // Re-creating / re-opening the workspace does NOT resurrect the old key:
    // custody empty → generation arm → a fresh, different key.
    const fresh = await ensureOfflineWorkspaceKey(WS);
    expect(fresh).toBeInstanceOf(Uint8Array);
    expect(fresh).not.toEqual(first);
    expect(store.records.has(WS)).toBe(true);
  });

  it("removes only the deleted workspace's record (other workspaces keep theirs)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    await persistOfflineWorkspaceKey(WS, await importWorkspaceKey(crypto.getRandomValues(new Uint8Array(32))));
    await persistOfflineWorkspaceKey(
      OTHER_WS,
      await importWorkspaceKey(crypto.getRandomValues(new Uint8Array(32))),
    );

    await deleteOfflineWorkspaceKey(WS);

    expect(store.records.has(WS)).toBe(false);
    expect(store.records.has(OTHER_WS)).toBe(true);
  });

  it("deleting a missing record resolves without throwing (fresh device / unkeyed workspace)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);

    await expect(deleteOfflineWorkspaceKey("never-existed")).resolves.toBeUndefined();
    expect(store.records.size).toBe(0);
  });
});

describe("WorkspacesView delete flow (the removal surface)", () => {
  function renderManager() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/workspaces") && method === "GET") {
        return Response.json({
          workspaces: [
            {
              id: WS,
              name: "Plots",
              role: "owner",
              createdAt: 1730000000000,
              envelopeCount: 12,
              latestSeq: 40,
            },
          ],
        });
      }
      if (url.endsWith(`/api/workspaces/${WS}`) && method === "DELETE") {
        return Response.json({ ok: true });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspacesView
        serverUrl={SERVER}
        credential={TOKEN}
        user={null}
        activeWorkspaceId="ws-other"
        onEnter={vi.fn()}
      />,
    );
    return fetchMock;
  }

  it("confirming the delete fires the DELETE and clears that workspace's custody record", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    await persistOfflineWorkspaceKey(WS, await importWorkspaceKey(crypto.getRandomValues(new Uint8Array(32))));
    const fetchMock = renderManager();

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Plots" }));
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));

    await waitFor(() => expect(store.records.has(WS)).toBe(false));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith(`/api/workspaces/${WS}`) && (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });
});
