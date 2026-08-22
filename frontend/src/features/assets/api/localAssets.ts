/**
 * Local asset store (local-first split, Task 5).
 *
 * In local mode there is no server to hold asset bytes, so blobs are stored in
 * the shared persistence IndexedDB (`assetBlobs` object store, keyed by SHA-256
 * content hash) and asset metadata flows through the canonical operation-log
 * path: the same `node.create`/`class.assign` + `asset.upload` op sequence the
 * server emits in `app/features/assets/service.py::AssetService.upload_asset`
 * (and `node.delete` + `asset.delete` for deletion). Because the op log stays
 * the source of truth, attaching a server later (Task 6 adoption) replays these
 * ops unchanged and only the blob bytes need uploading.
 */
import { Clock } from '@/core/clock';
import { openPersistenceDb, StorageError } from '@/core/persistence/indexedDb';
import {
  createOperation,
  type AssetUploadPayload,
  type Operation,
} from '@/core/types/operation';
import { uuidv7 } from '@/core/uuid';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import type { NodeRow } from '@/core/store';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { getLogger } from '@/utils/logger';
import type { Asset, AssetCategory } from './assets';

const log = getLogger('assets-local');

const ASSET_BLOB_STORE = 'assetBlobs';
const ASSET_CLASS_UUID = SYSTEM_CLASS_UUIDS.asset;

// ─── Blob store (IndexedDB, key = content hash) ─────────────────────────────
//
// Values are stored as raw bytes (Uint8Array) rather than Blob objects: real
// browsers persist Blob natively, but the structured clone used by
// fake-indexeddb (tests) cannot clone jsdom Blobs. The MIME type is recovered
// from the derived `node_asset` row (written by the asset.upload op), so bytes
// alone are sufficient.

export async function putAssetBlob(hash: string, blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const db = await openPersistenceDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ASSET_BLOB_STORE, 'readwrite');
      const request = tx.objectStore(ASSET_BLOB_STORE).put(bytes, hash);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to store asset blob '${hash}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } finally {
    db.close();
  }
}

export async function getAssetBytes(hash: string): Promise<Uint8Array | undefined> {
  const db = await openPersistenceDb();
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const tx = db.transaction(ASSET_BLOB_STORE, 'readonly');
      const request = tx.objectStore(ASSET_BLOB_STORE).get(hash);
      request.onsuccess = () => {
        const result = request.result as Uint8Array | undefined;
        // Defensive copy: fake-indexeddb may hand back plain-object clones.
        resolve(result ? new Uint8Array(result) : undefined);
      };
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to load asset blob '${hash}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } finally {
    db.close();
  }
}

export async function getAssetBlob(hash: string, type = ''): Promise<Blob | undefined> {
  const bytes = await getAssetBytes(hash);
  return bytes ? new Blob([bytes as unknown as BlobPart], { type }) : undefined;
}

export async function deleteAssetBlob(hash: string): Promise<void> {
  const db = await openPersistenceDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ASSET_BLOB_STORE, 'readwrite');
      const request = tx.objectStore(ASSET_BLOB_STORE).delete(hash);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(
          new StorageError(
            `Failed to delete asset blob '${hash}': ${request.error?.message || 'unknown error'}`,
            request.error
          )
        );
    });
  } finally {
    db.close();
  }
}

/** SHA-256 hex digest; matches the server's `hashlib.sha256(...).hexdigest()`. */
export async function hashAssetBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Operation building (mirrors the server op shapes exactly) ──────────────

interface TextAst {
  type: string;
  children: Array<{ type: string; text: string }>;
}

/** Minimal paragraph AST for a plain-text node name (mirrors `parse_ast(PLAIN)`). */
function nameAst(text: string): TextAst[] {
  return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
}

/** `Path(filename).stem`: strip the final extension only. */
function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function getCategory(contentType: string): AssetCategory {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface AssetUploadOpArgs {
  workspaceId: string;
  actorId: string;
  /** Asset node uuid (byte reference); newly generated for the create path. */
  nodeId: string;
  assetHash: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  /** Parent for a newly created asset block; omitted for node conversion. */
  parentId?: string;
  /** True when converting an existing node instead of creating a new one. */
  isExistingNode: boolean;
  /** Display name used as the new node's initial content. */
  name: string;
}

/**
 * Build the exact operation sequence the server emits for an upload:
 * `node.create` (new block with the asset class + name content) or
 * `class.assign` (existing-node conversion), then `asset.upload`.
 */
export function buildAssetUploadOperations(args: AssetUploadOpArgs): Operation[] {
  const clock = new Clock(args.actorId);
  const build = (opType: string, payload: unknown, affectedNodeIds: string[]): Operation =>
    createOperation(
      {
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        hlc: clock.advance(Date.now()),
        affectedNodeIds,
        opType,
      },
      payload
    );

  const operations: Operation[] = [];

  if (args.isExistingNode) {
    operations.push(
      build(
        'class.assign',
        { nodeId: args.nodeId, classId: ASSET_CLASS_UUID },
        [args.nodeId, ASSET_CLASS_UUID]
      )
    );
  } else {
    const payload: Record<string, unknown> = { nodeId: args.nodeId, kind: 'block' };
    if (args.parentId) payload.parentId = args.parentId;
    payload.initialContent = nameAst(args.name);
    payload.classIds = [ASSET_CLASS_UUID];
    operations.push(build('node.create', payload, [args.nodeId]));
  }

  const uploadPayload: AssetUploadPayload & { assetId: string } = {
    assetId: args.nodeId,
    nodeId: args.nodeId,
    assetHash: args.assetHash,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    originalName: args.originalName,
  };
  operations.push(build('asset.upload', uploadPayload, [args.nodeId]));

  return operations;
}

/** Build the deletion sequence the server emits: `node.delete` + `asset.delete`. */
export function buildAssetDeleteOperations(args: {
  workspaceId: string;
  actorId: string;
  nodeId: string;
}): Operation[] {
  const clock = new Clock(args.actorId);
  const build = (opType: string, payload: unknown): Operation =>
    createOperation(
      {
        workspaceId: args.workspaceId,
        actorId: args.actorId,
        hlc: clock.advance(Date.now()),
        affectedNodeIds: [args.nodeId],
        opType,
      },
      payload
    );
  return [
    build('node.delete', { nodeId: args.nodeId }),
    build('asset.delete', { assetId: args.nodeId, nodeId: args.nodeId }),
  ];
}

// ─── Local asset operations ─────────────────────────────────────────────────

interface LocalAssetRow {
  assetHash: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

function toAsset(nodeId: string, row: LocalAssetRow, blob: Blob): Asset {
  return {
    uuid: nodeId,
    node_id: 0, // deprecated numeric id; the server response omits it entirely
    node_uuid: nodeId,
    filename: row.originalName,
    content_type: row.mimeType,
    category: getCategory(row.mimeType),
    size_bytes: row.sizeBytes,
    url: URL.createObjectURL(blob),
  };
}

/**
 * Upload a file as an asset in local mode: store the bytes locally by content
 * hash, then create/annotate the asset node through the canonical local op
 * path (same ops the server would emit, so adoption replays them cleanly).
 */
export async function uploadLocalAsset(
  client: IWorkspaceStoreClient,
  file: File,
  parentUuid?: string,
  existingNodeUuid?: string,
  content?: string
): Promise<Asset> {
  log.info(
    `Uploading asset locally: ${file.name} (${file.type}, ${file.size} bytes)${
      existingNodeUuid ? ` (converting node ${existingNodeUuid})` : ''
    }`
  );

  // Mirror the server's existence checks before writing anything.
  if (parentUuid !== undefined) {
    const parent = await client.query<NodeRow | undefined>('getNode', [parentUuid]);
    if (!parent) throw new Error('Parent node not found');
  }
  if (existingNodeUuid !== undefined) {
    const existing = await client.query<NodeRow | undefined>('getNode', [existingNodeUuid]);
    if (!existing) throw new Error('Existing node not found');
  }

  // Copy into a fresh Uint8Array: jsdom's File.arrayBuffer() returns a
  // cross-realm ArrayBuffer that WebCrypto rejects.
  const assetHash = await hashAssetBytes(new Uint8Array(await file.arrayBuffer()));
  await putAssetBlob(assetHash, file);

  const nodeId = existingNodeUuid ?? uuidv7();
  try {
    const workspaceId = await client.query<string>('getWorkspaceId', []);
    const actorId = await client.query<string>('getActorId', []);
    const operations = buildAssetUploadOperations({
      workspaceId,
      actorId,
      nodeId,
      assetHash,
      mimeType: file.type,
      sizeBytes: file.size,
      originalName: file.name,
      parentId: parentUuid,
      isExistingNode: existingNodeUuid !== undefined,
      name: content ?? stem(file.name),
    });
    await client.mutate<number>('applyMany', [operations]);
  } catch (err) {
    // Roll back the blob so no orphan bytes are left behind, mirroring the
    // server's `delete_asset` on failure.
    await deleteAssetBlob(assetHash).catch((cleanupErr) => {
      log.warn(`Failed to roll back asset blob ${assetHash}:`, cleanupErr);
    });
    throw err;
  }

  log.info(`Asset uploaded locally: ${nodeId} (hash ${assetHash})`);
  return {
    uuid: nodeId,
    node_id: 0,
    node_uuid: nodeId,
    filename: file.name,
    content_type: file.type,
    category: getCategory(file.type),
    size_bytes: file.size,
    url: URL.createObjectURL(file),
  };
}

/**
 * Resolve the content URL for an asset in local mode: look up the asset node's
 * content hash in the local store and return an object URL for its blob.
 * Callers own the returned URL and must revoke it when done (see AssetImage).
 */
export async function getLocalAssetUrl(
  client: IWorkspaceStoreClient,
  assetUuid: string
): Promise<string> {
  const info = await client.query<LocalAssetRow | undefined>('getAssetInfo', [assetUuid]);
  if (!info) throw new Error(`Asset not found: ${assetUuid}`);
  const blob = await getAssetBlob(info.assetHash, info.mimeType);
  if (!blob) throw new Error(`Asset bytes missing locally: ${assetUuid} (hash ${info.assetHash})`);
  return URL.createObjectURL(blob);
}

/** Asset metadata in local mode, read from the derived `node_asset` table. */
export async function getLocalAssetInfo(
  client: IWorkspaceStoreClient,
  assetUuid: string
): Promise<Asset> {
  const info = await client.query<LocalAssetRow | undefined>('getAssetInfo', [assetUuid]);
  if (!info) throw new Error(`Asset not found: ${assetUuid}`);
  const blob = await getAssetBlob(info.assetHash, info.mimeType);
  if (!blob) throw new Error(`Asset bytes missing locally: ${assetUuid} (hash ${info.assetHash})`);
  return toAsset(assetUuid, info, blob);
}

/**
 * Delete an asset in local mode: emit the same `node.delete` + `asset.delete`
 * ops the server path would, then remove the locally stored blob.
 */
export async function deleteLocalAsset(
  client: IWorkspaceStoreClient,
  assetUuid: string
): Promise<{ success: boolean; deleted_file: boolean }> {
  const info = await client.query<LocalAssetRow | undefined>('getAssetInfo', [assetUuid]);
  if (!info) throw new Error(`Asset not found: ${assetUuid}`);

  const workspaceId = await client.query<string>('getWorkspaceId', []);
  const actorId = await client.query<string>('getActorId', []);
  const operations = buildAssetDeleteOperations({ workspaceId, actorId, nodeId: assetUuid });
  await client.mutate<number>('applyMany', [operations]);

  await deleteAssetBlob(info.assetHash);
  log.info(`Asset deleted locally: ${assetUuid} (hash ${info.assetHash})`);
  return { success: true, deleted_file: true };
}
