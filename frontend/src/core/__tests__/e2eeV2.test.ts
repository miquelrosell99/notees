import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  clearWorkspaceKey,
  decryptBytes,
  decryptEnvelopePayload,
  encryptBytes,
  encryptEnvelopePayload,
  generateWorkspaceKey,
  getLatestKeyVersion,
  getWorkspaceKey,
  getWorkspaceKeyForVersion,
  isWorkspaceE2eeEnabled,
  registerWorkspaceKey,
  setWorkspaceE2eeEnabled,
  unwrapWorkspaceKeyAsMember,
  wrapWorkspaceKeyForMember,
} from '../e2ee';
import {
  ensureIdentityKeyPair,
  rotateWorkspaceKey,
  unlockWithMemberKeys,
  wrapSweep,
} from '../e2eeSetup';
import { uuidv7 } from '../uuid';

vi.mock('@/features/shares/api/shares', () => ({
  listWorkspaceMembers: vi.fn(),
}));

if (!globalThis.crypto?.subtle) {
  vi.stubGlobal('crypto', webcrypto);
}

const OWNER = uuidv7();
const MEMBER = uuidv7();
const WS = uuidv7();

/** Minimal fetch router over the relay E2EE endpoints. */
function installFetchMock(state: {
  publicKeys: Map<string, string>;
  memberKeys: Array<{ user_id: string; wrapped_key: string; key_version: number }>;
  callerId?: string;
  /** The mock publishes identities under this user id (the "current user"). */
  publishAs?: string;
}) {
  const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (u.includes('/api/relay/user-public-key') && init?.method === 'PUT') {
      state.publicKeys.set('me', body.public_key);
      state.publicKeys.set(state.publishAs ?? 'me', body.public_key);
      return new Response(JSON.stringify({ userId: 'me', publicKey: body.public_key }), { status: 200 });
    }
    if (u.includes('/api/relay/user-public-key?user_id=')) {
      const userId = u.split('user_id=')[1];
      return new Response(
        JSON.stringify({ userId, publicKey: state.publicKeys.get(userId) ?? null }),
        { status: 200 }
      );
    }
    if (u.includes('/api/relay/encryption-key/members/') && init?.method === 'DELETE') {
      const parts = u.split('/members/')[1].split('/');
      const userId = parts[1];
      const before = state.memberKeys.length;
      state.memberKeys = state.memberKeys.filter((k) => k.user_id !== userId);
      return new Response(JSON.stringify({ deleted: before - state.memberKeys.length }), { status: 200 });
    }
    if (u.includes('/api/relay/encryption-key/members') && init?.method === 'PUT') {
      for (const m of body.members) {
        state.memberKeys = state.memberKeys.filter(
          (k) => !(k.user_id === m.user_id && k.key_version === m.key_version)
        );
        state.memberKeys.push(m);
      }
      return new Response(JSON.stringify({ stored: body.members.length }), { status: 200 });
    }
    if (u.includes('/api/relay/encryption-key?')) {
      return new Response(
        JSON.stringify({
          workspaceId: WS,
          wrappedKey: null,
          enabled: true,
          memberKeys: state.memberKeys
            .filter((k) => k.user_id === state.callerId)
            .map((k) => ({ wrappedKey: k.wrapped_key, keyVersion: k.key_version })),
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${u}`);
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return state;
}

let state: ReturnType<typeof installFetchMock>;

beforeEach(() => {
  localStorage.clear();
  // The mock must be installed before any identity creation: generating a
  // new keypair publishes the public key.
  state = installFetchMock({ publicKeys: new Map(), memberKeys: [] });
});

afterEach(() => {
  clearWorkspaceKey(WS);
  setWorkspaceE2eeEnabled(WS, false);
  vi.restoreAllMocks();
});

describe('E2EE v2 X25519 member wrapping', () => {
  it('owner wraps for a member; member unwraps to the same workspace key', async () => {
    const ownerIdentity = await ensureIdentityKeyPair(OWNER);
    const memberIdentity = await ensureIdentityKeyPair(MEMBER);
    const wk = await generateWorkspaceKey();

    const blob = await wrapWorkspaceKeyForMember(
      wk,
      ownerIdentity.privateKey,
      ownerIdentity.publicKey,
      memberIdentity.publicKey,
      1
    );
    const { key, keyVersion } = await unwrapWorkspaceKeyAsMember(blob, memberIdentity.privateKey);
    expect(keyVersion).toBe(1);

    const envelope = await encryptEnvelopePayload(wk, {
      id: 'op-1',
      protocolVersion: 1,
      workspaceId: WS,
      actorId: OWNER,
      affectedNodeIds: [],
      opType: 'node.create',
      hlc: { physical: 1, logical: 0 },
      payload: { nodeId: 'n1', kind: 'page' },
    });
    expect((await decryptEnvelopePayload(key, envelope)).payload).toEqual({
      nodeId: 'n1',
      kind: 'page',
    });
  });

  it('a wrong member cannot unwrap another member\'s blob', async () => {
    const ownerIdentity = await ensureIdentityKeyPair(OWNER);
    const memberIdentity = await ensureIdentityKeyPair(MEMBER);
    const stranger = await ensureIdentityKeyPair(uuidv7());
    const wk = await generateWorkspaceKey();

    const blob = await wrapWorkspaceKeyForMember(
      wk,
      ownerIdentity.privateKey,
      ownerIdentity.publicKey,
      memberIdentity.publicKey,
      1
    );
    await expect(unwrapWorkspaceKeyAsMember(blob, stranger.privateKey)).rejects.toThrow();
  });

  it('identity persists in localStorage and publishes the public key once', async () => {
    state.publishAs = OWNER;
    const first = await ensureIdentityKeyPair(OWNER);
    expect(state.publicKeys.get('me')).toBe(first.publicKey);
    const second = await ensureIdentityKeyPair(OWNER);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it('unlockWithMemberKeys populates the ring for every wrapped version', async () => {
    state.publishAs = OWNER;
    const ownerIdentity = await ensureIdentityKeyPair(OWNER);

    const wk1 = await generateWorkspaceKey();
    const wk2 = await generateWorkspaceKey();
    for (const [wk, kv] of [[wk1, 1], [wk2, 2]] as const) {
      state.memberKeys.push({
        user_id: OWNER,
        wrapped_key: await wrapWorkspaceKeyForMember(
          wk,
          ownerIdentity.privateKey,
          ownerIdentity.publicKey,
          ownerIdentity.publicKey,
          kv
        ),
        key_version: kv,
      });
    }
    state.callerId = OWNER;

    const ok = await unlockWithMemberKeys(WS, OWNER);
    expect(ok).toBe(true);
    expect(isWorkspaceE2eeEnabled(WS)).toBe(true);
    expect(getLatestKeyVersion(WS)).toBe(2);
    expect(getWorkspaceKey(WS)).toBeDefined();
    expect(getWorkspaceKeyForVersion(WS, 1)).toBeDefined();

    // History (v1 snapshot) and current (v2 envelope) both decrypt.
    const snapshot = await encryptBytes(wk1, new TextEncoder().encode('old-state'), 1);
    expect(new TextDecoder().decode(await decryptBytes(snapshot, (kv) => getWorkspaceKeyForVersion(WS, kv)))).toBe('old-state');
  });

  it('rotation removes the departed member and issues a new key version to the rest', async () => {
    const { listWorkspaceMembers } = await import('@/features/shares/api/shares');
    (listWorkspaceMembers as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { user_uuid: OWNER, email: 'owner@test', role: 'owner' },
        { user_uuid: MEMBER, email: 'member@test', role: 'editor' },
      ],
    });

    state.publishAs = OWNER;
    const ownerIdentity = await ensureIdentityKeyPair(OWNER);
    state.publishAs = MEMBER;
    await ensureIdentityKeyPair(MEMBER);

    // v1 key held locally by the owner.
    registerWorkspaceKey(WS, await generateWorkspaceKey(), 1);
    setWorkspaceE2eeEnabled(WS, true);
    await wrapSweep(WS, OWNER);
    expect(state.memberKeys.filter((k) => k.user_id === MEMBER)).toHaveLength(1);

    // Member leaves: the membership list no longer includes them, then rotation.
    (listWorkspaceMembers as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ user_uuid: OWNER, email: 'owner@test', role: 'owner' }],
    });
    await rotateWorkspaceKey(WS, OWNER, MEMBER);
    expect(state.memberKeys.filter((k) => k.user_id === MEMBER)).toHaveLength(0);
    expect(getLatestKeyVersion(WS)).toBe(2);
    const ownerV2 = state.memberKeys.filter((k) => k.user_id === OWNER && k.key_version === 2);
    expect(ownerV2).toHaveLength(1);

    // The owner can unwrap the new version; the removed member has no blob.
    state.callerId = OWNER;
    const { key } = await unwrapWorkspaceKeyAsMember(ownerV2[0].wrapped_key, ownerIdentity.privateKey);
    expect(key).toBeDefined();
  });
});
