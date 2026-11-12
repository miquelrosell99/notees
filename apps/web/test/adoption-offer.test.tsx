/**
 * F2 — the offline→online adoption offer. An offline-created workspace (Task
 * 9: device-local custody key, content sealed with it) opened ONLINE against a
 * server that has never seen it (the key route 404s) does not get a bare
 * refusal nor a silent auto-publish: the open pauses on an OFFER to publish —
 * the workspace exists only on this device; confirming publishes it under its
 * EXISTING id, wrapping THE custody device key under the master (publish, not
 * mint — the T9 invariant), and the reconnect drains the outbox sealed.
 *
 * Detection pins (all must hold): online connect, key fetch 404, custody
 * holds a device key, the local store is non-empty (the seed-gate's
 * storeIsEmpty idiom, probed via the local-store-content seam — jsdom has no
 * OPFS). An EMPTY offline workspace has nothing to publish and opens
 * plaintext per the normal flow. Declining opens plaintext with zero writes.
 * API-key sessions get the offer with the directional copy and a disabled
 * confirm (no master key exists to wrap under). A workspace that is
 * server-known-but-keyless (the create answers 409) still publishes through
 * the established PUT path.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  createKdfRecord,
  exportWorkspaceKey,
  generateMasterKey,
  unwrapWorkspaceKey,
} from "@notees/protocol";

import {
  clearCryptoCustody,
  currentMasterKey,
  deriveMasterKey,
  ensureOfflineWorkspaceKey,
} from "../src/core/crypto-custody.js";
import {
  setWorkspaceKeyStoreForTests,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from "../src/core/master-key-storage.js";
import { setLocalStoreContentProbeForTests } from "../src/ui/app/local-store-content.js";
import {
  AdoptionOfferError,
  confirmWorkspaceAdoption,
  resolveWorkspaceKey,
} from "../src/ui/app/store-connection.js";
import { AdoptionOfferModal } from "../src/features/modals/AdoptionOfferModal.js";

const SERVER = "https://notees.example.com";
const TOKEN = "session-token";
const WS = "0192a000-0000-7000-8000-000000000001";
const PASSWORD = "correct horse battery staple";

/** In-memory fake standing in for the IndexedDB workspace-key record. */
function fakeStore(): WorkspaceKeyStore & { record: WorkspaceKeyRecord | null } {
  const state = { record: null as WorkspaceKeyRecord | null };
  return {
    get record() {
      return state.record;
    },
    async store(id, record) {
      state.record = record;
      void id;
    },
    async load() {
      return state.record === null ? null : { id: WS, ...state.record };
    },
    async delete() {
      state.record = null;
    },
  };
}

/** In-memory fake standing in for the sync server (key route + create + listing). */
function adoptionServer() {
  const state = {
    hasWrap: false,
    wrapped: undefined as string | undefined,
    gets: 0,
    puts: 0,
    posts: 0,
    postBodies: [] as Array<{ id?: string; name?: string; wrappedKey?: string }>,
    putBodies: [] as Array<{ wrappedKey: string }>,
    /** Override for the 409 (server-known-but-keyless) pin. */
    postStatus: 201,
    listing: [] as Array<{ id: string; name: string | null; encrypted?: boolean }>,
    listingFails: false,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "GET") {
      state.gets += 1;
      if (!state.hasWrap) {
        return Response.json({ error: { message: "not found" } }, { status: 404 });
      }
      return Response.json({ wrappedKey: state.wrapped });
    }
    if (url.endsWith(`/api/workspaces/${WS}/key`) && method === "PUT") {
      state.puts += 1;
      state.putBodies.push(JSON.parse(String(init?.body)));
      state.wrapped = state.putBodies.at(-1)!.wrappedKey;
      state.hasWrap = true;
      return new Response(null, { status: 204 });
    }
    if (url === `${SERVER}/api/workspaces` && method === "POST") {
      state.posts += 1;
      state.postBodies.push(JSON.parse(String(init?.body)));
      if (state.postStatus !== 201) {
        return Response.json(
          { error: { message: "a workspace with this id already exists" } },
          { status: state.postStatus },
        );
      }
      const body = state.postBodies.at(-1)!;
      state.wrapped = body.wrappedKey;
      state.hasWrap = true;
      return Response.json({ id: body.id ?? WS }, { status: 201 });
    }
    if (url === `${SERVER}/api/workspaces` && method === "GET") {
      if (state.listingFails) {
        return Response.json({ error: { message: "boom" } }, { status: 500 });
      }
      return Response.json({ workspaces: state.listing });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { state, fetchMock };
}

/** Password session + custody device key, the adoption-candidate setup. */
async function sessionWithCustody() {
  const store = fakeStore();
  setWorkspaceKeyStoreForTests(store);
  const master = await generateMasterKey();
  await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
  const deviceKey = await ensureOfflineWorkspaceKey(WS);
  return { deviceKey };
}

afterEach(async () => {
  await clearCryptoCustody();
  setWorkspaceKeyStoreForTests(undefined);
  setLocalStoreContentProbeForTests(undefined);
  vi.unstubAllGlobals();
  delete window.NOTEES_CONFIG;
});

describe("adoption offer detection (online open of an offline-created workspace)", () => {
  it("404 + custody key + non-empty store → the open pauses on the offer; zero writes", async () => {
    const { deviceKey } = await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const failure = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Field notes",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdoptionOfferError);
    const offer = failure as AdoptionOfferError;
    expect(offer.workspaceId).toBe(WS);
    expect(offer.workspaceName).toBe("Field notes");
    expect(offer.credentialType).toBe("session");
    expect(offer.url).toBe(SERVER);
    expect(offer.credential).toBe(TOKEN);
    void deviceKey;
    // Read-only detection: exactly the key GET — no PUT, no POST.
    expect(state.gets).toBe(1);
    expect(state.puts).toBe(0);
    expect(state.posts).toBe(0);
  });

  it("empty local store → no offer: the open proceeds plaintext per the normal flow", async () => {
    await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => false);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.puts).toBe(0);
    expect(state.posts).toBe(0);
  });

  it("no custody device key + 404 → plaintext, no offer (unchanged no-auto-key ruling)", async () => {
    const store = fakeStore();
    setWorkspaceKeyStoreForTests(store);
    const master = await generateMasterKey();
    await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.posts).toBe(0);
  });

  it("declined → plaintext open, zero POSTs, zero PUTs", async () => {
    await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Workspace",
      declinedAdoption: true,
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: true });
    expect(state.posts).toBe(0);
    expect(state.puts).toBe(0);
  });
});

describe("adoption confirm (publish the existing workspace under its existing id)", () => {
  it("POSTs {id, name, wrappedKey} where the wrap unwraps to THE custody device key", async () => {
    const { deviceKey } = await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    await confirmWorkspaceAdoption(SERVER, TOKEN, WS, "Field notes");

    expect(state.posts).toBe(1);
    expect(state.puts).toBe(0);
    const body = state.postBodies[0]!;
    // The EXISTING id rides the create — the local store is keyed by it.
    expect(body.id).toBe(WS);
    expect(body.name).toBe("Field notes");
    // Publish, not mint: the wrap opens under the master to the device key.
    const unwrapped = await unwrapWorkspaceKey(currentMasterKey()!.key, body.wrappedKey!);
    expect(await exportWorkspaceKey(unwrapped)).toEqual(deviceKey);
  });

  it("a second open after the publish is a normal keyed open — GET 200, unwrap, no second offer", async () => {
    const { deviceKey } = await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    await confirmWorkspaceAdoption(SERVER, TOKEN, WS, "Field notes");
    expect(state.posts).toBe(1);

    const second = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "session",
      label: "Field notes",
    });
    expect(second.key).toEqual(deviceKey);
    expect(second.locked).toBe(false);
    expect(second.plaintext).toBe(false);
    expect(state.posts).toBe(1);
    expect(state.puts).toBe(0);
  });

  it("server-known-but-keyless (create 409) → the established PUT publishes the same wrap", async () => {
    const { deviceKey } = await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    state.postStatus = 409;
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    await confirmWorkspaceAdoption(SERVER, TOKEN, WS, "Field notes");

    expect(state.posts).toBe(1);
    expect(state.puts).toBe(1);
    const unwrapped = await unwrapWorkspaceKey(
      currentMasterKey()!.key,
      state.putBodies[0]!.wrappedKey,
    );
    expect(await exportWorkspaceKey(unwrapped)).toEqual(deviceKey);
  });

  it("no master key in memory → the confirm refuses with the directional copy (never a raw wrap)", async () => {
    await sessionWithCustody();
    const { state, fetchMock } = adoptionServer();
    vi.stubGlobal("fetch", fetchMock);
    await clearCryptoCustody(); // master gone (session end / API-key shape)

    await expect(confirmWorkspaceAdoption(SERVER, TOKEN, WS, "Field notes")).rejects.toThrow(
      /email and password/i,
    );
    expect(state.posts).toBe(0);
    expect(state.puts).toBe(0);
  });
});

describe("adoption offer with an API-key session", () => {
  it("listing answers and does not know the workspace + custody + non-empty → offer (apikey arm)", async () => {
    await sessionWithCustody(); // custody exists; the apikey arm never touches the master
    await clearCryptoCustody(); // no master — like a pure API-key session
    const { state, fetchMock } = adoptionServer();
    state.listing = [{ id: "0192a000-0000-7000-8000-000000000099", name: "Other", encrypted: true }];
    vi.stubGlobal("fetch", fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const failure = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "apikey",
      label: "Field notes",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdoptionOfferError);
    expect((failure as AdoptionOfferError).credentialType).toBe("apikey");
    expect(state.posts).toBe(0);
  });

  it("listing unreachable → indeterminate open, NO offer (a miss is not positive knowledge)", async () => {
    await sessionWithCustody();
    await clearCryptoCustody();
    const failing = adoptionServer();
    failing.state.listingFails = true;
    vi.stubGlobal("fetch", failing.fetchMock);
    setLocalStoreContentProbeForTests(async () => true);

    const resolution = await resolveWorkspaceKey(SERVER, TOKEN, WS, {
      isOffline: false,
      credentialType: "apikey",
      label: "Field notes",
    });

    expect(resolution).toEqual({ key: undefined, locked: false, plaintext: false });
  });
});

describe("AdoptionOfferModal (the UnlockWorkspaceModal pattern)", () => {
  it("offers the publish with the honest copy; confirming calls onPublish", async () => {
    const onPublish = vi.fn(async () => {});
    const onKeepLocal = vi.fn();
    render(
      <AdoptionOfferModal
        isOpen
        workspaceName="Field notes"
        onKeepLocal={onKeepLocal}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByText(/exists only on this device/i)).toBeTruthy();
    expect(screen.getByText(/new content will be encrypted/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /publish workspace/i }));
    expect(onPublish).toHaveBeenCalledTimes(1);
    expect(onKeepLocal).not.toHaveBeenCalled();
  });

  it("keep-local declines without publishing", () => {
    const onPublish = vi.fn(async () => {});
    const onKeepLocal = vi.fn();
    render(
      <AdoptionOfferModal
        isOpen
        workspaceName="Field notes"
        onKeepLocal={onKeepLocal}
        onPublish={onPublish}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /keep on this device/i }));
    expect(onKeepLocal).toHaveBeenCalledTimes(1);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it("a failed publish surfaces the error and keeps the offer open", async () => {
    const onPublish = vi.fn(async () => {
      throw new Error("HTTP 401 — session expired");
    });
    render(
      <AdoptionOfferModal
        isOpen
        workspaceName="Field notes"
        onKeepLocal={() => {}}
        onPublish={onPublish}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /publish workspace/i }));
    await waitFor(() => {
      expect(screen.getByText(/session expired/i)).toBeTruthy();
    });
  });

  it("API-key session → the directional copy replaces the offer (no publish action, like the unlock modal)", () => {
    const onPublish = vi.fn(async () => {});
    render(
      <AdoptionOfferModal
        isOpen
        workspaceName="Field notes"
        apiKeySession
        onKeepLocal={() => {}}
        onPublish={onPublish}
      />,
    );

    expect(screen.getByText(/signed in with an API key/i)).toBeTruthy();
    // The UnlockWorkspaceModal idiom: the action is replaced by the copy —
    // no publish button exists to tempt a wrap with no master key.
    expect(screen.queryByRole("button", { name: /publish workspace/i })).toBeNull();
    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
  });
});
