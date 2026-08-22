/**
 * Tests for the local asset store (local-first split, Task 5).
 *
 * Runs against a real (in-memory sql.js) WorkspaceStore wrapped in the inline
 * store client, with IndexedDB provided by fake-indexeddb (see tests/setup.ts).
 */
import initSqlJs from 'sql.js';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { WorkspaceStore } from '@/core/store';
import { createSchema } from '@/core/db/schema';
import { createWorkspaceStoreClient } from '@/core/worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { validateOperation } from '@/core/types/operation';
import { openPersistenceDb } from '@/core/persistence/indexedDb';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import {
  buildAssetDeleteOperations,
  buildAssetUploadOperations,
  deleteAssetBlob,
  deleteLocalAsset,
  getAssetBytes,
  getLocalAssetInfo,
  getLocalAssetUrl,
  hashAssetBytes,
  uploadLocalAsset,
} from '../localAssets';

const WORKSPACE_ID = 'ws-local-assets-test';
const ACTOR_ID = 'local-actor';
const ASSET_CLASS_UUID = SYSTEM_CLASS_UUIDS.asset;

// ─── URL.createObjectURL stub (jsdom does not implement it) ─────────────────

let nextObjectUrlId = 0;
const createdUrls = new Map<string, Blob>();

beforeAll(() => {
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:mock-${++nextObjectUrlId}`;
    createdUrls.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    createdUrls.delete(url);
  };
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ─── Store/client helpers ───────────────────────────────────────────────────

async function createStore(
  bytes?: Uint8Array
): Promise<{ store: WorkspaceStore; client: IWorkspaceStoreClient }> {
  const SQL = await initSqlJs();
  const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  if (!bytes) createSchema(db);
  const store = new WorkspaceStore(db, WORKSPACE_ID, ACTOR_ID);
  const client = createWorkspaceStoreClient();
  await client.init(WORKSPACE_ID, ACTOR_ID, { store });
  return { store, client };
}

function pngFile(name = 'photo.png', body = 'fake-png-bytes'): File {
  return new File([body], name, { type: 'image/png' });
}

describe('localAssets', () => {
  let store: WorkspaceStore;
  let client: IWorkspaceStoreClient;

  beforeEach(async () => {
    createdUrls.clear();
    // IndexedDB persists across tests within this file; wipe the blob store so
    // content-addressed hashes from earlier tests cannot leak into assertions.
    const db = await openPersistenceDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('assetBlobs', 'readwrite');
        const request = tx.objectStore('assetBlobs').clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
    ({ store, client } = await createStore());
    store.createNode({ nodeId: 'parent-page', kind: 'page', parentId: null });
  });

  it('hashes bytes with SHA-256, matching the server digest', async () => {
    const hash = await hashAssetBytes(new TextEncoder().encode('hello'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('upload stores the blob by content hash and creates the asset node', async () => {
    const file = pngFile();
    const asset = await uploadLocalAsset(client, file, 'parent-page');
    const hash = await hashAssetBytes(new Uint8Array(await file.arrayBuffer()));

    // Bytes are in IndexedDB under the content hash.
    const bytes = await getAssetBytes(hash);
    expect(bytes).toBeDefined();
    expect(bytes!.length).toBe(file.size);
    expect(new TextDecoder().decode(bytes)).toBe('fake-png-bytes');

    // The asset node exists with the asset class assigned...
    const node = await client.query<{ classIds: string[] } | undefined>('getNode', [asset.uuid]);
    expect(node).toBeDefined();
    expect(node!.classIds).toContain(ASSET_CLASS_UUID);

    // ...and the derived node_asset row mirrors the asset.upload op payload.
    const info = await client.query<{ assetHash: string; mimeType: string; sizeBytes: number; originalName: string } | undefined>(
      'getAssetInfo',
      [asset.uuid]
    );
    expect(info).toEqual({
      assetHash: hash,
      mimeType: 'image/png',
      sizeBytes: file.size,
      originalName: 'photo.png',
    });

    // The returned Asset mirrors the server response shape.
    expect(asset.node_uuid).toBe(asset.uuid);
    expect(asset.filename).toBe('photo.png');
    expect(asset.content_type).toBe('image/png');
    expect(asset.category).toBe('image');
    expect(asset.size_bytes).toBe(file.size);
  });

  it('resolves an object URL for an uploaded asset', async () => {
    const asset = await uploadLocalAsset(client, pngFile(), 'parent-page');

    const url = await getLocalAssetUrl(client, asset.uuid);
    expect(url.startsWith('blob:')).toBe(true);
    const blob = createdUrls.get(url);
    expect(blob).toBeDefined();
    expect(blob!.size).toBe(asset.size_bytes);
    expect(await blob!.text()).toBe('fake-png-bytes');
  });

  it('still resolves after a reload (blob in IndexedDB, op log re-opened)', async () => {
    const asset = await uploadLocalAsset(client, pngFile(), 'parent-page');

    // Simulate a reload: export the sql.js bytes and open a fresh store/client
    // from them; IndexedDB blobs survive on their own.
    const bytes = store.export();
    const reopened = await createStore(bytes);
    try {
      const info = await reopened.client.query<{ assetHash: string } | undefined>('getAssetInfo', [
        asset.uuid,
      ]);
      expect(info).toBeDefined();

      const url = await getLocalAssetUrl(reopened.client, asset.uuid);
      expect(url.startsWith('blob:')).toBe(true);
      expect(await createdUrls.get(url)!.text()).toBe('fake-png-bytes');
    } finally {
      reopened.client.close();
    }
  });

  it('converts an existing node into an asset (class.assign path)', async () => {
    store.createNode({ nodeId: 'block-1', kind: 'block', parentId: 'parent-page' });

    const file = pngFile('sound.mp3');
    const audio = new File([await file.arrayBuffer()], 'sound.mp3', { type: 'audio/mpeg' });
    const asset = await uploadLocalAsset(client, audio, undefined, 'block-1', 'My track');

    expect(asset.uuid).toBe('block-1');
    const node = await client.query<{ classIds: string[] } | undefined>('getNode', ['block-1']);
    expect(node!.classIds).toContain(ASSET_CLASS_UUID);
    expect(asset.category).toBe('audio');

    const info = await client.query<{ assetHash: string; originalName: string } | undefined>(
      'getAssetInfo',
      ['block-1']
    );
    expect(info?.originalName).toBe('sound.mp3');
  });

  it('delete removes the blob, the node, and the asset row', async () => {
    const file = pngFile();
    const asset = await uploadLocalAsset(client, file, 'parent-page');
    const hash = await hashAssetBytes(new Uint8Array(await file.arrayBuffer()));

    const result = await deleteLocalAsset(client, asset.uuid);
    expect(result).toEqual({ success: true, deleted_file: true });

    expect(await getAssetBytes(hash)).toBeUndefined();
    expect(await client.query('getAssetInfo', [asset.uuid])).toBeUndefined();
    expect(await client.query('getNode', [asset.uuid])).toBeUndefined();
  });

  it('getLocalAssetInfo returns metadata without a server call', async () => {
    const asset = await uploadLocalAsset(client, pngFile(), 'parent-page');
    const info = await getLocalAssetInfo(client, asset.uuid);
    expect(info.uuid).toBe(asset.uuid);
    expect(info.filename).toBe('photo.png');
    expect(info.size_bytes).toBe(asset.size_bytes);
  });

  it('rejects an upload to a missing parent without storing bytes', async () => {
    await expect(uploadLocalAsset(client, pngFile(), 'missing-parent')).rejects.toThrow(
      'Parent node not found'
    );
    // No blob may be left behind.
    const hash = await hashAssetBytes(new TextEncoder().encode('fake-png-bytes'));
    expect(await getAssetBytes(hash)).toBeUndefined();
  });

  it('resolving a URL for unknown or byte-less assets throws', async () => {
    await expect(getLocalAssetUrl(client, 'no-such-asset')).rejects.toThrow('Asset not found');

    const asset = await uploadLocalAsset(client, pngFile(), 'parent-page');
    const hash = await hashAssetBytes(new Uint8Array(await pngFile().arrayBuffer()));
    await deleteAssetBlob(hash);
    await expect(getLocalAssetUrl(client, asset.uuid)).rejects.toThrow('Asset bytes missing locally');
  });

  it('delete on an unknown asset throws', async () => {
    await expect(deleteLocalAsset(client, 'no-such-asset')).rejects.toThrow('Asset not found');
  });

  it('emits the exact op shapes the server emits', async () => {
    const ops = buildAssetUploadOperations({
      workspaceId: WORKSPACE_ID,
      actorId: ACTOR_ID,
      nodeId: 'asset-node-1',
      assetHash: 'abc123',
      mimeType: 'image/png',
      sizeBytes: 42,
      originalName: 'photo.png',
      parentId: 'parent-page',
      isExistingNode: false,
      name: 'photo',
    });

    expect(ops.map((op) => op.envelope.opType)).toEqual(['node.create', 'asset.upload']);
    for (const op of ops) expect(validateOperation(op)).toBe(true);

    // node.create — same payload keys as WorkspaceStore.create_node server-side.
    expect(ops[0].payload).toEqual({
      nodeId: 'asset-node-1',
      kind: 'block',
      parentId: 'parent-page',
      initialContent: [{ type: 'paragraph', children: [{ type: 'text', text: 'photo' }] }],
      classIds: [ASSET_CLASS_UUID],
    });
    expect(ops[0].envelope.affectedNodeIds).toEqual(['asset-node-1']);

    // asset.upload — same payload keys as WorkspaceStore.upload_asset server-side.
    expect(ops[1].payload).toEqual({
      assetId: 'asset-node-1',
      nodeId: 'asset-node-1',
      assetHash: 'abc123',
      mimeType: 'image/png',
      sizeBytes: 42,
      originalName: 'photo.png',
    });

    // Existing-node conversion emits class.assign instead of node.create.
    const convertOps = buildAssetUploadOperations({
      workspaceId: WORKSPACE_ID,
      actorId: ACTOR_ID,
      nodeId: 'block-9',
      assetHash: 'def456',
      mimeType: 'image/png',
      sizeBytes: 1,
      originalName: 'x.png',
      isExistingNode: true,
      name: 'x',
    });
    expect(convertOps.map((op) => op.envelope.opType)).toEqual(['class.assign', 'asset.upload']);
    expect(convertOps[0].payload).toEqual({ nodeId: 'block-9', classId: ASSET_CLASS_UUID });
    expect(convertOps[0].envelope.affectedNodeIds).toEqual(['block-9', ASSET_CLASS_UUID]);

    // Delete mirrors the server's node.delete + asset.delete sequence.
    const deleteOps = buildAssetDeleteOperations({
      workspaceId: WORKSPACE_ID,
      actorId: ACTOR_ID,
      nodeId: 'asset-node-1',
    });
    expect(deleteOps.map((op) => op.envelope.opType)).toEqual(['node.delete', 'asset.delete']);
    expect(deleteOps[0].payload).toEqual({ nodeId: 'asset-node-1' });
    expect(deleteOps[1].payload).toEqual({ assetId: 'asset-node-1', nodeId: 'asset-node-1' });
    for (const op of deleteOps) expect(validateOperation(op)).toBe(true);
  });
});
