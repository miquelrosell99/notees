import { describe, it, expect, afterEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  clearWorkspaceKey,
  decryptBytes,
  decryptEnvelopePayload,
  decryptPayload,
  encryptBytes,
  encryptEnvelopePayload,
  encryptPayload,
  generateWorkspaceKey,
  getWorkspaceKey,
  isEncryptedPayload,
  isWorkspaceE2eeEnabled,
  readWrappedKeySalt,
  registerWorkspaceKey,
  setWorkspaceE2eeEnabled,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from '../e2ee';
import { createHttpTransport } from '../transportHttp';
import { uuidv7 } from '../uuid';
import { PROTOCOL_VERSION } from '../types/operation';
import { deriveKey } from '@/utils/encryption';

if (!globalThis.crypto?.subtle) {
  vi.stubGlobal('crypto', webcrypto);
}

const WORKSPACE_ID = uuidv7();

function makeEnvelope(id = uuidv7()) {
  return {
    id,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: WORKSPACE_ID,
    actorId: uuidv7(),
    affectedNodeIds: ['node-1'],
    opType: 'node.create',
    hlc: { physical: 1000, logical: 0 },
    payload: { nodeId: 'node-1', kind: 'page' },
  };
}

afterEach(() => {
  clearWorkspaceKey(WORKSPACE_ID);
  setWorkspaceE2eeEnabled(WORKSPACE_ID, false);
  vi.restoreAllMocks();
});

describe('e2ee crypto core', () => {
  it('wraps and unwraps a workspace key with a passphrase-derived KEK', async () => {
    const kek = await deriveKey('correct horse', new Uint8Array(16).fill(1));
    const wk = await generateWorkspaceKey();

    const blob = await wrapWorkspaceKey(wk, kek, 'c2FsdA==');
    expect(readWrappedKeySalt(blob)).toBe('c2FsdA==');

    const unwrapped = await unwrapWorkspaceKey(blob, kek);
    const payload = { hello: 'world' };
    const encrypted = await encryptPayload(unwrapped, payload);
    expect(await decryptPayload(wk, encrypted)).toEqual(payload);
  });

  it('fails to unwrap with the wrong KEK', async () => {
    const kek = await deriveKey('right', new Uint8Array(16).fill(1));
    const wrong = await deriveKey('wrong', new Uint8Array(16).fill(1));
    const wk = await generateWorkspaceKey();
    const blob = await wrapWorkspaceKey(wk, kek, 'c2FsdA==');
    await expect(unwrapWorkspaceKey(blob, wrong)).rejects.toThrow();
  });

  it('encrypts payloads with a detectable marker and rejects tampering', async () => {
    const wk = await generateWorkspaceKey();
    const encrypted = await encryptPayload(wk, { nodeId: 'n1', kind: 'page' });

    expect(isEncryptedPayload(encrypted)).toBe(true);
    expect(isEncryptedPayload({ nodeId: 'n1' })).toBe(false);
    expect(isEncryptedPayload({ $e: { iv: 1, ct: 'x' } })).toBe(false);

    const tampered = {
      $e: { iv: encrypted.$e.iv, ct: encrypted.$e.ct.slice(0, -4) + 'AAAA' },
    };
    await expect(decryptPayload(wk, tampered)).rejects.toThrow();
  });

  it('round-trips snapshot bytes', async () => {
    const wk = await generateWorkspaceKey();
    const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const encrypted = await encryptBytes(wk, data);
    expect(encrypted).not.toEqual(data);
    expect(Array.from(await decryptBytes(encrypted, () => wk))).toEqual(Array.from(data));
  });

  it('stamps protocolVersion 2 on encrypted envelopes', async () => {
    const wk = await generateWorkspaceKey();
    const encrypted = await encryptEnvelopePayload(wk, makeEnvelope());
    expect(encrypted.protocolVersion).toBe(2);
    expect(isEncryptedPayload(encrypted.payload)).toBe(true);

    const decrypted = await decryptEnvelopePayload(wk, encrypted);
    expect(decrypted.payload).toEqual({ nodeId: 'node-1', kind: 'page' });
  });
});

describe('HttpTransport E2EE', () => {
  it('encrypts outgoing batches and decrypts catch-up when enabled', async () => {
    const wk = await generateWorkspaceKey();
    registerWorkspaceKey(WORKSPACE_ID, wk);
    setWorkspaceE2eeEnabled(WORKSPACE_ID, true);
    expect(isWorkspaceE2eeEnabled(WORKSPACE_ID)).toBe(true);

    const envelope = makeEnvelope();
    const seenBodies: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/relay/batch')) {
        seenBodies.push(init?.body as string);
        return new Response(JSON.stringify({ saved_count: 1, saved_ids: [envelope.id] }), { status: 200 });
      }
      // catch-up: return the same (now encrypted) envelope back
      const sent = JSON.parse(seenBodies[0]);
      return new Response(
        JSON.stringify({
          envelopes: sent.envelopes,
          next_after_seq: 5,
          has_more: false,
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const transport = createHttpTransport(WORKSPACE_ID, 'actor-1', 'http://localhost:8000');
    await transport.send(envelope);

    const sent = JSON.parse(seenBodies[0]);
    expect(sent.envelopes[0].protocolVersion).toBe(2);
    expect(isEncryptedPayload(sent.envelopes[0].payload)).toBe(true);
    expect(JSON.stringify(sent.envelopes[0].payload)).not.toContain('node-1');

    const page = await transport.catchUp(0);
    expect(page.envelopes[0].payload).toEqual({ nodeId: 'node-1', kind: 'page' });
    expect(page.nextAfterSeq).toBe(5);
  });

  it('fails loud instead of sending plaintext when the workspace is locked', async () => {
    setWorkspaceE2eeEnabled(WORKSPACE_ID, true);
    expect(getWorkspaceKey(WORKSPACE_ID)).toBeUndefined();

    const transport = createHttpTransport(WORKSPACE_ID, 'actor-1', 'http://localhost:8000');
    await expect(transport.send(makeEnvelope())).rejects.toThrow(/locked/);
  });

  it('encrypts snapshot uploads and decrypts downloads; plaintext snapshots pass through', async () => {
    const wk = await generateWorkspaceKey();
    registerWorkspaceKey(WORKSPACE_ID, wk);
    setWorkspaceE2eeEnabled(WORKSPACE_ID, true);

    const plaintextDbBytes = new TextEncoder().encode('SQLite format 3\0fake-db-bytes');
    const uploaded: Uint8Array[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        // Binary upload: body is the (encrypted) snapshot bytes.
        expect(String(url)).toContain('/api/relay/snapshot/data');
        uploaded.push(new Uint8Array(init.body as Uint8Array));
        return new Response(JSON.stringify({ snapshot_id: 's1' }), { status: 200 });
      }
      if (String(url).includes('/api/relay/snapshot/data')) {
        // Binary download: raw bytes of the uploaded blob.
        const bytes = uploaded[0];
        return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      // Metadata probe.
      return new Response(
        JSON.stringify({
          snapshot_id: 's1',
          workspace_id: WORKSPACE_ID,
          hlc: { physical: 1, logical: 0 },
          has_snapshot: true,
          restore_epoch: 0,
          up_to_seq: 3,
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const transport = createHttpTransport(WORKSPACE_ID, 'actor-1', 'http://localhost:8000');
    await transport.uploadSnapshot({
      snapshotId: '',
      workspaceId: WORKSPACE_ID,
      hlc: { physical: 1, logical: 0 },
      data: plaintextDbBytes,
      restoreEpoch: 0,
      hasSnapshot: true,
      upToSeq: null,
    });

    // The uploaded body is ciphertext — the SQLite magic is not visible.
    expect(new TextDecoder().decode(uploaded[0])).not.toContain('SQLite format 3');

    const downloaded = await transport.getLatestSnapshot();
    expect(new TextDecoder().decode(downloaded.data)).toBe('SQLite format 3\0fake-db-bytes');
  });
});
