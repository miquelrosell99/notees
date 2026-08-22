/**
 * Tests for connect-later adoption (local-first split, Task 6).
 *
 * Covers the envelope remapping/chunking against a fake deduping relay, the
 * `adoptServer` orchestrator with injected dependencies, and the pinned
 * contracts.md verification: API-created server workspaces are seeded with
 * fresh op ids for the same system class/page ids, so replayed local seed ops
 * must not dedupe-collapse — and must not conflict either, because the
 * derived-state appliers are idempotent on the entity id (class.create is an
 * upsert on class id, node.create is INSERT OR IGNORE, asset.upload upserts
 * on (node_id, asset_hash)).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ApiError } from '@/api/client';
import { WorkspaceStore } from '../store';
import { queryAll } from '../db/sqlite';
import { listClasses } from '../query/classes';
import { saveWorkspaceDatabase } from '../persistence/indexedDb';
import { createOperation, PROTOCOL_VERSION, type Operation } from '../types/operation';
import type { OperationEnvelope } from '../crypto';
import type { CatchUpPage, SendBatchResult, SnapshotEnvelope, Transport } from '../transport';
import { buildWorkspaceSeedOperations } from '../seed';
import { uuidv7 } from '../uuid';
import type { Hlc } from '../clock';
import { createTestDatabase } from './helpers';
import {
  ADOPTION_BATCH_SIZE,
  adoptServer,
  buildAdoptionBatches,
  checkServerReachable,
  isLocalWorkspaceAdopted,
  loadAdoptionSource,
  markLocalWorkspaceAdopted,
  remapEnvelopeForAdoption,
  type AdoptionSource,
} from '../adoption';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';

const CLASS_COUNT = Object.keys(SYSTEM_CLASS_UUIDS).length;

function paragraphAst(text: string) {
  return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
}

let hlcCounter = 1;

function makeOp(
  workspaceId: string,
  actorId: string,
  opType = 'node.updateContent',
  payload?: unknown,
  hlc?: Hlc
): Operation {
  return createOperation(
    {
      workspaceId,
      actorId,
      hlc: hlc ?? { physical: 1_000 + hlcCounter++, logical: 0 },
      affectedNodeIds: [],
      opType,
    },
    payload ?? { nodeId: uuidv7(), content: paragraphAst('note') }
  );
}

/**
 * Fake relay server: dedupes by op id exactly like the real relay storage
 * (`save_envelopes` returns only the ids that were actually inserted), which
 * is what makes a replay retry after a partial failure safe.
 */
class FakeServerTransport implements Transport {
  readonly envelopes = new Map<string, OperationEnvelope>();
  readonly submissionOrder: string[] = [];

  sendBatch(batch: OperationEnvelope[]): SendBatchResult {
    const savedIds: string[] = [];
    for (const envelope of batch) {
      if (this.envelopes.has(envelope.id)) continue;
      this.envelopes.set(envelope.id, envelope);
      this.submissionOrder.push(envelope.id);
      savedIds.push(envelope.id);
    }
    return { savedIds };
  }

  send(envelope: OperationEnvelope): SendBatchResult {
    return this.sendBatch([envelope]);
  }

  catchUp(): CatchUpPage {
    return { envelopes: [], nextAfterSeq: null, hasMore: false };
  }

  getLatestSnapshot(): Promise<SnapshotEnvelope> {
    return Promise.resolve({
      snapshotId: '',
      workspaceId: 'fake',
      hlc: { physical: 0, logical: 0 },
      data: new Uint8Array(0),
      restoreEpoch: 0,
      hasSnapshot: false,
      upToSeq: null,
    });
  }

  subscribe(): void {}
}

function makeSource(operations: Operation[], assets: AdoptionSource['assets'] = []): AdoptionSource {
  const bytesByHash = new Map(assets.map((a) => [a.assetHash, new Uint8Array([1, 2, 3])]));
  return {
    operations,
    assets,
    getAssetBytes: (hash) => Promise.resolve(bytesByHash.get(hash)),
  };
}

describe('adoption', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('remapEnvelopeForAdoption / buildAdoptionBatches', () => {
    it('remaps workspace and actor, preserving op id, HLC, type and payload', () => {
      const localWs = uuidv7();
      const localActor = uuidv7();
      const serverWs = uuidv7();
      const serverActor = uuidv7();
      const op = makeOp(localWs, localActor, 'node.create', {
        nodeId: 'node-1',
        kind: 'page',
        initialContent: paragraphAst('Hello'),
      });
      op.envelope.affectedNodeIds = ['node-1'];

      const remapped = remapEnvelopeForAdoption(op, serverWs, serverActor);

      expect(remapped.id).toBe(op.envelope.id);
      expect(remapped.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(remapped.workspaceId).toBe(serverWs);
      expect(remapped.actorId).toBe(serverActor);
      expect(remapped.hlc).toEqual(op.envelope.hlc);
      expect(remapped.opType).toBe('node.create');
      expect(remapped.affectedNodeIds).toEqual(['node-1']);
      expect(remapped.payload).toEqual(op.payload);
      // The source operation is not mutated.
      expect(op.envelope.workspaceId).toBe(localWs);
      expect(op.envelope.actorId).toBe(localActor);
    });

    it('chunks in batches of at most the given size, preserving order', () => {
      const ops = Array.from({ length: 5 }, () => makeOp(uuidv7(), uuidv7()));
      const batches = buildAdoptionBatches(ops, uuidv7(), uuidv7(), 2);

      expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
      expect(batches.flat().map((e) => e.id)).toEqual(ops.map((op) => op.envelope.id));
    });

    it('defaults to the SPEC batch size (MAX_BATCH_SIZE = 1000)', () => {
      expect(ADOPTION_BATCH_SIZE).toBe(1000);
      const ops = Array.from({ length: 2 }, () => makeOp(uuidv7(), uuidv7()));
      expect(buildAdoptionBatches(ops, uuidv7(), uuidv7())).toHaveLength(1);
    });
  });

  describe('adoptServer', () => {
    it('creates a workspace, replays the full op log in order, uploads assets per hash', async () => {
      const localWs = uuidv7();
      const localActor = uuidv7();
      const serverWs = uuidv7();
      const serverActor = uuidv7();

      const ops = [
        ...buildWorkspaceSeedOperations(localWs, localActor, 'Local user'),
        makeOp(localWs, localActor, 'node.create', {
          nodeId: 'page-1',
          kind: 'page',
          initialContent: paragraphAst('My note'),
        }),
      ];
      const source = makeSource(ops, [
        { nodeId: 'asset-1', assetHash: 'hash-a', mimeType: 'image/png', sizeBytes: 3, originalName: 'a.png' },
        // Two nodes sharing one content hash upload the bytes only once.
        { nodeId: 'asset-2', assetHash: 'hash-a', mimeType: 'image/png', sizeBytes: 3, originalName: 'a.png' },
        { nodeId: 'asset-3', assetHash: 'hash-b', mimeType: 'image/png', sizeBytes: 3, originalName: 'b.png' },
      ]);

      const transport = new FakeServerTransport();
      const createWorkspace = vi.fn().mockResolvedValue(serverWs);
      const uploadAsset = vi.fn().mockResolvedValue(undefined);

      const result = await adoptServer({
        source,
        actorId: serverActor,
        serverUrl: 'https://notes.example.com',
        checkReachable: () => Promise.resolve(true),
        createServerWorkspace: createWorkspace,
        createTransport: () => transport,
        uploadAssetBytes: uploadAsset,
      });

      expect(createWorkspace).toHaveBeenCalledWith('Local notes');
      expect(result.workspaceId).toBe(serverWs);
      expect(result.operationsReplayed).toBe(ops.length);
      expect(result.assetsUploaded).toBe(2);
      expect(result.assetsFailed).toEqual([]);
      expect(uploadAsset).toHaveBeenCalledTimes(2);

      // Every envelope was remapped to the server workspace and actor, in order.
      expect(transport.submissionOrder).toEqual(ops.map((op) => op.envelope.id));
      for (const envelope of transport.envelopes.values()) {
        expect(envelope.workspaceId).toBe(serverWs);
        expect(envelope.actorId).toBe(serverActor);
      }
    });

    it('is idempotent on re-run: the server dedupes by op id', async () => {
      const localWs = uuidv7();
      const ops = buildWorkspaceSeedOperations(localWs, uuidv7(), 'Local user');
      const serverWs = uuidv7();
      const transport = new FakeServerTransport();

      const run = () =>
        adoptServer({
          source: makeSource(ops),
          actorId: uuidv7(),
          serverUrl: 'https://notes.example.com',
          checkReachable: () => Promise.resolve(true),
          createServerWorkspace: () => Promise.resolve(serverWs),
          createTransport: () => transport,
        });

      const first = await run();
      expect(first.operationsReplayed).toBe(ops.length);
      expect(transport.envelopes.size).toBe(ops.length);

      // Simulate a retry after a failure midway: the same ops are pushed again
      // and the server accepts none of them twice.
      const second = await run();
      expect(second.operationsReplayed).toBe(0);
      expect(transport.envelopes.size).toBe(ops.length);
    });

    it('aborts before creating anything when the server is unreachable', async () => {
      const createWorkspace = vi.fn();
      await expect(
        adoptServer({
          source: makeSource([makeOp(uuidv7(), uuidv7())]),
          actorId: uuidv7(),
          serverUrl: 'https://down.example.com',
          checkReachable: () => Promise.resolve(false),
          createServerWorkspace: createWorkspace,
        })
      ).rejects.toThrow('unreachable');
      expect(createWorkspace).not.toHaveBeenCalled();
    });

    it('throws when no server URL is configured', async () => {
      await expect(
        adoptServer({
          source: makeSource([makeOp(uuidv7(), uuidv7())]),
          actorId: uuidv7(),
          serverUrl: '',
          checkReachable: () => Promise.resolve(true),
        })
      ).rejects.toThrow('No server URL configured');
    });

    it('retries workspace creation with a suffixed name when the name is taken', async () => {
      const taken = new ApiError('Request failed');
      taken.response = {
        status: 400,
        data: { detail: "Workspace 'Local notes' already exists" },
        headers: {},
      };
      const createWorkspace = vi
        .fn()
        .mockRejectedValueOnce(taken)
        .mockResolvedValueOnce('server-ws');

      const result = await adoptServer({
        source: makeSource([makeOp(uuidv7(), uuidv7())]),
        actorId: uuidv7(),
        serverUrl: 'https://notes.example.com',
        checkReachable: () => Promise.resolve(true),
        createServerWorkspace: createWorkspace,
        createTransport: () => new FakeServerTransport(),
      });

      expect(createWorkspace.mock.calls.map((call) => call[0])).toEqual([
        'Local notes',
        'Local notes (2)',
      ]);
      expect(result.workspaceId).toBe('server-ws');
    });

    it('collects asset upload failures instead of aborting', async () => {
      const source = makeSource([makeOp(uuidv7(), uuidv7())], [
        { nodeId: 'asset-ok', assetHash: 'hash-ok', mimeType: 'image/png', sizeBytes: 3, originalName: 'ok.png' },
        { nodeId: 'asset-missing', assetHash: 'hash-missing', mimeType: 'image/png', sizeBytes: 3, originalName: 'gone.png' },
      ]);
      // The second asset's bytes are absent from the local store.
      source.getAssetBytes = (hash) =>
        Promise.resolve(hash === 'hash-ok' ? new Uint8Array([1]) : undefined);

      const result = await adoptServer({
        source,
        actorId: uuidv7(),
        serverUrl: 'https://notes.example.com',
        checkReachable: () => Promise.resolve(true),
        createServerWorkspace: () => Promise.resolve('server-ws'),
        createTransport: () => new FakeServerTransport(),
        uploadAssetBytes: () => Promise.resolve(),
      });

      expect(result.assetsUploaded).toBe(1);
      expect(result.assetsFailed).toEqual([
        { nodeId: 'asset-missing', error: 'asset bytes missing locally' },
      ]);
    });
  });

  describe('pinned verification: server seed + replayed local ops', () => {
    it('duplicate system-class/page ops with fresh op ids are harmless (upsert appliers)', async () => {
      const localWs = uuidv7();
      const localActor = uuidv7();
      const serverWs = uuidv7();
      const serverActor = uuidv7();

      // Local profile: client-seeded, then the user created a page.
      const localStore = new WorkspaceStore(await createTestDatabase(), localWs, localActor);
      localStore.applyMany(buildWorkspaceSeedOperations(localWs, localActor, 'Local user'));
      const userPageId = uuidv7();
      localStore.applyMany([
        makeOp(localWs, localActor, 'node.create', {
          nodeId: userPageId,
          kind: 'page',
          initialContent: paragraphAst('My note'),
        }),
      ]);
      const localOps = localStore.getAllOperations();

      // The API-created server workspace is seeded by the server itself
      // (WorkspaceService.create_workspace → repository.seed_workspace) with
      // FRESH op ids for the same system class and page ids.
      const serverSeed = buildWorkspaceSeedOperations(serverWs, serverActor, 'Server user');

      // The adopted client applies the server seed first, then catches up the
      // replayed local ops (remapped to the server workspace/actor).
      const db = await createTestDatabase();
      const store = new WorkspaceStore(db, serverWs, serverActor);
      const seedResult = store.applyMany(serverSeed);
      expect(seedResult.appliedCount).toBe(serverSeed.length);

      const remappedOps: Operation[] = localOps.map((op) => ({
        envelope: { ...op.envelope, workspaceId: serverWs, actorId: serverActor },
        payload: op.payload,
      }));
      const replayResult = store.applyMany(remappedOps);

      // Distinct op ids → nothing dedupe-collapses; every replayed op applies.
      expect(replayResult.appliedCount).toBe(remappedOps.length);

      // class.create is an upsert on class id: still exactly one row per
      // system class, carrying the class name.
      const classes = listClasses(db, serverWs);
      expect(classes).toHaveLength(CLASS_COUNT);
      expect(classes.map((c) => c.id).sort()).toEqual(Object.values(SYSTEM_CLASS_UUIDS).sort());

      // node.create is INSERT OR IGNORE: exactly one Inbox node, and the
      // user's page survived the replay.
      const inboxRows = queryAll(db, 'SELECT id FROM node WHERE id = ?', [SYSTEM_PAGE_UUIDS.inbox]);
      expect(inboxRows).toHaveLength(1);
      expect(store.getNode(SYSTEM_PAGE_UUIDS.inbox)?.kind).toBe('page');
      expect(store.getNode(userPageId)?.kind).toBe('page');

      // Re-applying the very same op ids (e.g. a catch-up overlap) is a no-op.
      const again = store.applyMany([remappedOps[0]]);
      expect(again.appliedCount).toBe(0);

      // asset.upload upserts on (node_id, asset_hash): the server-side
      // re-emission during blob upload does not duplicate the derived row.
      const assetNodeId = uuidv7();
      const uploadPayload = {
        nodeId: assetNodeId,
        assetId: assetNodeId,
        assetHash: 'hash-x',
        mimeType: 'image/png',
        sizeBytes: 3,
        originalName: 'x.png',
      };
      store.applyMany([makeOp(serverWs, serverActor, 'asset.upload', uploadPayload)]);
      store.applyMany([makeOp(serverWs, serverActor, 'asset.upload', uploadPayload)]);
      const assetRows = queryAll(db, 'SELECT node_id FROM node_asset WHERE node_id = ?', [assetNodeId]);
      expect(assetRows).toHaveLength(1);
    });
  });

  describe('loadAdoptionSource', () => {
    it('returns null when no local database exists', async () => {
      await expect(loadAdoptionSource(uuidv7())).resolves.toBeNull();
    });

    it('dumps the persisted op log and asset inventory', async () => {
      const localWs = uuidv7();
      const localActor = uuidv7();
      const store = new WorkspaceStore(await createTestDatabase(), localWs, localActor);
      store.applyMany(buildWorkspaceSeedOperations(localWs, localActor, 'Local user'));
      store.applyMany([
        makeOp(localWs, localActor, 'asset.upload', {
          nodeId: 'asset-1',
          assetId: 'asset-1',
          assetHash: 'hash-1',
          mimeType: 'image/png',
          sizeBytes: 10,
          originalName: 'pic.png',
        }),
      ]);
      await saveWorkspaceDatabase(localWs, store.export());

      const source = await loadAdoptionSource(localWs);
      expect(source).not.toBeNull();
      expect(source!.operations).toHaveLength(store.getAllOperations().length);
      expect(source!.operations.map((op) => op.envelope.id)).toEqual(
        store.getAllOperations().map((op) => op.envelope.id)
      );
      expect(source!.assets).toEqual([
        {
          nodeId: 'asset-1',
          assetHash: 'hash-1',
          mimeType: 'image/png',
          sizeBytes: 10,
          originalName: 'pic.png',
        },
      ]);
    });
  });

  describe('adoption marker', () => {
    it('round-trips the adopted marker per local workspace', () => {
      const ws = uuidv7();
      expect(isLocalWorkspaceAdopted(ws)).toBe(false);
      markLocalWorkspaceAdopted(ws);
      expect(isLocalWorkspaceAdopted(ws)).toBe(true);
      expect(isLocalWorkspaceAdopted(uuidv7())).toBe(false);
    });
  });

  describe('checkServerReachable', () => {
    it('true when /api/health answers OK, false on network failure', async () => {
      const okFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = okFetch as unknown as typeof fetch;
      await expect(checkServerReachable('https://notes.example.com/')).resolves.toBe(true);
      expect(okFetch).toHaveBeenCalledWith(
        'https://notes.example.com/api/health',
        expect.objectContaining({ method: 'GET' })
      );

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
      await expect(checkServerReachable('https://down.example.com')).resolves.toBe(false);
    });
  });
});
