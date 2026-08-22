/**
 * Connect-later adoption (local-first split, Task 6).
 *
 * When a local-mode user configures a server URL and signs in, the local op
 * log — the source of truth — is replayed into a fresh server workspace:
 *
 * 1. `POST /workspaces` creates a new server workspace. The server seeds it
 *    with its own system-class/page ops carrying FRESH op ids (verified:
 *    `WorkspaceService.create_workspace` → `repository.seed_workspace` +
 *    `ensure_user_page`). Server dedupe is op-id based, so the replayed local
 *    seed ops do NOT collapse against the server seed — but the duplicates are
 *    harmless because the appliers are idempotent on the entity id:
 *    `class.create` is an upsert on class id (`INSERT OR REPLACE`,
 *    app/core/derived/class.py), `node.create` is `INSERT OR IGNORE`
 *    (app/core/derived/node.py), `class.assign` is a set-add and
 *    `asset.upload` upserts on (node_id, asset_hash).
 * 2. The FULL local op log (not just the outbox) is pushed through
 *    `POST /api/relay/batch` in chunks of MAX_BATCH_SIZE (protocol/SPEC.md §6),
 *    with each envelope's `workspaceId`/`actorId` remapped to the new server
 *    workspace and the logged-in user. Original op ids are kept: the workspace
 *    is fresh, so there is no dedupe collision, and keeping the ids makes a
 *    retry after a partial failure idempotent.
 * 3. Local asset blobs (IndexedDB `assetBlobs`, keyed by content hash) are
 *    uploaded via `POST /assets/upload?existing_node_uuid=<nodeId>` after the
 *    replay. The server has no by-hash existence endpoint, so every blob is
 *    uploaded; the server's content-addressed storage reuses existing bytes
 *    (`AssetFileService.create_asset`), making re-uploads idempotent.
 * 4. The caller persists the new workspace as active and reloads; the first
 *    sync then catches up from seq 0 (a fresh local DB for the new workspace
 *    uuid), so no cursor state needs resetting.
 *
 * Failure modes (rollout.md): an unreachable server aborts before anything is
 * written; a failure mid-replay leaves a partially filled server workspace,
 * but replay is idempotent by op id, so re-running `adoptServer` is safe.
 * The old local workspace data is never deleted — it stays dormant.
 */

import api, { isApiError } from '@/api/client';
import { getServerUrl } from '@/config/serverUrl';
import { getLogger } from '@/utils/logger';
import { getAssetBytes } from '@/features/assets/api/localAssets';
import { createWorkspace } from '@/features/workspace/api/workspaces';
import { createDatabase } from './db/connection';
import { loadWorkspaceDatabase } from './persistence/indexedDb';
import { WorkspaceStore } from './store';
import type { Transport } from './transport';
import { createHttpTransport } from './transportHttp';
import type { Operation } from './types/operation';
import type { OperationEnvelope } from './crypto';

const log = getLogger('adoption');

/** protocol/SPEC.md §6: `MAX_BATCH_SIZE = 1000` envelopes per batch. */
export const ADOPTION_BATCH_SIZE = 1000;

const HEALTH_TIMEOUT_MS = 5_000;

/**
 * localStorage marker recording which local workspace has been adopted into a
 * server workspace. Prevents the post-login adoption prompt from reappearing
 * after a successful adoption (the local data itself is kept, dormant).
 */
const ADOPTED_MARKER_KEY = 'notees.adoptedLocalWorkspaceUuid';

export function markLocalWorkspaceAdopted(localWorkspaceId: string): void {
  try {
    localStorage.setItem(ADOPTED_MARKER_KEY, localWorkspaceId);
  } catch {
    // Storage unavailable (private mode) — the prompt may reappear; harmless.
  }
}

export function isLocalWorkspaceAdopted(localWorkspaceId: string): boolean {
  try {
    return localStorage.getItem(ADOPTED_MARKER_KEY) === localWorkspaceId;
  } catch {
    return false;
  }
}

// ─── Reachability ───────────────────────────────────────────────────────────

/**
 * Verify the server answers `/api/health` before anything is persisted or
 * written. Mirrors the timeout pattern of `useBackendHealth.checkHealth`.
 */
export async function checkServerReachable(
  serverUrl: string,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Local source (op log + asset inventory) ────────────────────────────────

export interface AdoptionAsset {
  nodeId: string;
  assetHash: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

export interface AdoptionSource {
  /** The full local op log in causal (HLC) order. */
  operations: Operation[];
  /** Live asset metadata rows from the derived `node_asset` table. */
  assets: AdoptionAsset[];
  /** Read blob bytes by content hash from the local asset store. */
  getAssetBytes: (hash: string) => Promise<Uint8Array | undefined>;
}

/**
 * Open the persisted local workspace database read-only and dump everything
 * adoption needs. Returns null when no local database exists (the profile
 * never ran in local mode).
 *
 * The store is constructed directly (no worker, no SyncEngine): adoption runs
 * in connected mode after login, when the local workspace is not open, and
 * only reads from it.
 */
export async function loadAdoptionSource(
  localWorkspaceId: string
): Promise<AdoptionSource | null> {
  const bytes = await loadWorkspaceDatabase(localWorkspaceId);
  if (!bytes) return null;
  const db = await createDatabase(bytes);
  // The actor id only seeds the store's write clock; adoption never writes.
  const store = new WorkspaceStore(db, localWorkspaceId, 'adoption-reader');
  return {
    operations: store.getAllOperations(),
    assets: store.getAllAssets(),
    getAssetBytes,
  };
}

export interface AdoptionCandidate {
  workspaceId: string;
  operationCount: number;
  assetCount: number;
}

/**
 * Decide whether the post-login adoption prompt should be offered: a local
 * workspace exists, has not been adopted before, and contains operations.
 */
export async function getLocalAdoptionCandidate(
  localWorkspaceId: string
): Promise<AdoptionCandidate | null> {
  if (isLocalWorkspaceAdopted(localWorkspaceId)) return null;
  const source = await loadAdoptionSource(localWorkspaceId);
  if (!source || source.operations.length === 0) return null;
  return {
    workspaceId: localWorkspaceId,
    operationCount: source.operations.length,
    assetCount: source.assets.length,
  };
}

// ─── Envelope remapping + chunking (pure) ───────────────────────────────────

/**
 * Re-stamp an operation for the server workspace: the workspace and actor ids
 * are remapped, everything else (op id, HLC, op type, payload) is preserved.
 * The server additionally overwrites `actor_id` with the authenticated user
 * (app/relay/service.py), so the remap also satisfies that invariant.
 */
export function remapEnvelopeForAdoption(
  op: Operation,
  workspaceId: string,
  actorId: string
): OperationEnvelope {
  return {
    ...op.envelope,
    workspaceId,
    actorId,
    payload: op.payload,
  };
}

/**
 * Remap the full local op log and split it into batches of at most
 * `batchSize` envelopes, preserving order (the relay requires a single
 * workspace per batch — guaranteed here since every envelope is remapped to
 * the same target workspace).
 */
export function buildAdoptionBatches(
  operations: Operation[],
  workspaceId: string,
  actorId: string,
  batchSize: number = ADOPTION_BATCH_SIZE
): OperationEnvelope[][] {
  const batches: OperationEnvelope[][] = [];
  for (let i = 0; i < operations.length; i += batchSize) {
    batches.push(
      operations
        .slice(i, i + batchSize)
        .map((op) => remapEnvelopeForAdoption(op, workspaceId, actorId))
    );
  }
  return batches;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface AdoptServerOptions {
  /** The local op log + asset inventory to replay. */
  source: AdoptionSource;
  /** UUID of the logged-in server user; stamped as actorId on every envelope. */
  actorId: string;
  /** Server origin; defaults to the configured server URL (`getServerUrl`). */
  serverUrl?: string;
  /** Base name for the new server workspace. */
  workspaceName?: string;
  /** Injection points (tests); the defaults hit the real server. */
  checkReachable?: (serverUrl: string) => Promise<boolean>;
  createServerWorkspace?: (name: string) => Promise<string>;
  createTransport?: (workspaceId: string, actorId: string, baseUrl: string) => Transport;
  uploadAssetBytes?: (asset: AdoptionAsset, bytes: Uint8Array) => Promise<void>;
}

export interface AdoptionResult {
  /** UUID of the newly created server workspace. */
  workspaceId: string;
  /** Envelopes actually saved by the server (duplicates excluded on re-runs). */
  operationsReplayed: number;
  assetsUploaded: number;
  /** Assets whose bytes could not be uploaded; adoption continues past them. */
  assetsFailed: Array<{ nodeId: string; error: string }>;
}

async function defaultCreateServerWorkspace(name: string): Promise<string> {
  const workspace = await createWorkspace(name);
  return workspace.uuid;
}

/**
 * Upload one locally stored blob against its replayed asset node. The
 * `existing_node_uuid` conversion path stores the bytes content-addressed
 * (idempotent by hash) and re-emits `class.assign` + `asset.upload` with fresh
 * op ids — harmless: both appliers are idempotent on the entity id.
 */
async function defaultUploadAssetBytes(asset: AdoptionAsset, bytes: Uint8Array): Promise<void> {
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([bytes as unknown as BlobPart], { type: asset.mimeType }),
    asset.originalName || 'asset'
  );
  // `existing_node_uuid` is a query param (only `content` is a Form field in
  // the FastAPI signature).
  await api.post('/assets/upload', formData, {
    params: { existing_node_uuid: asset.nodeId },
  });
}

/**
 * Create the server workspace, retrying with a numeric suffix when the name
 * is already taken (the server rejects duplicate names per owner with a 400).
 * Keeps adoption re-runnable after a previous attempt created the workspace
 * but failed during replay.
 */
async function createWorkspaceWithUniqueName(
  create: (name: string) => Promise<string>,
  baseName: string
): Promise<string> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
    try {
      return await create(name);
    } catch (err) {
      const detail =
        isApiError(err) && err.response && typeof err.response.data === 'object' && err.response.data !== null
          ? String((err.response.data as { detail?: unknown }).detail ?? '')
          : '';
      const isNameTaken = isApiError(err) && err.response?.status === 400 && detail.includes('already exists');
      if (!isNameTaken || attempt === MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Replay a local workspace into a fresh server workspace.
 *
 * Throws (leaving local mode untouched and the retry safe) when the server is
 * unreachable, the workspace cannot be created, or a batch fails. Asset
 * upload failures are collected in the result instead of aborting — the op
 * log is already authoritative on the server at that point.
 */
export async function adoptServer(options: AdoptServerOptions): Promise<AdoptionResult> {
  const serverUrl = (options.serverUrl ?? getServerUrl() ?? '').replace(/\/+$/, '');
  if (!serverUrl) {
    throw new Error('No server URL configured');
  }

  const reachable = await (options.checkReachable ?? checkServerReachable)(serverUrl);
  if (!reachable) {
    throw new Error(
      `The server at ${serverUrl} is unreachable. Your notes remain stored on this device — try again when the server is back.`
    );
  }

  const create = options.createServerWorkspace ?? defaultCreateServerWorkspace;
  const workspaceId = await createWorkspaceWithUniqueName(create, options.workspaceName ?? 'Local notes');
  log.info(`Adoption: created server workspace ${workspaceId}`);

  const createTransport =
    options.createTransport ??
    ((wsId: string, actorId: string, baseUrl: string) => createHttpTransport(wsId, actorId, baseUrl));
  const transport = createTransport(workspaceId, options.actorId, serverUrl);

  const batches = buildAdoptionBatches(options.source.operations, workspaceId, options.actorId);
  let operationsReplayed = 0;
  for (const batch of batches) {
    if (transport.sendBatch) {
      const result = await transport.sendBatch(batch);
      operationsReplayed += result.savedIds.length;
    } else {
      for (const envelope of batch) {
        const result = await transport.send(envelope);
        operationsReplayed += result.savedIds.length;
      }
    }
  }
  log.info(`Adoption: replayed ${operationsReplayed} operations into ${workspaceId}`);

  const upload = options.uploadAssetBytes ?? defaultUploadAssetBytes;
  const seenHashes = new Set<string>();
  let assetsUploaded = 0;
  const assetsFailed: Array<{ nodeId: string; error: string }> = [];
  for (const asset of options.source.assets) {
    // Content-addressed: one upload per distinct hash is enough; replayed
    // `asset.upload` ops already map every node to its hash server-side.
    if (seenHashes.has(asset.assetHash)) continue;
    seenHashes.add(asset.assetHash);
    try {
      const bytes = await options.source.getAssetBytes(asset.assetHash);
      if (!bytes) throw new Error('asset bytes missing locally');
      await upload(asset, bytes);
      assetsUploaded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Adoption: failed to upload asset ${asset.nodeId} (hash ${asset.assetHash}): ${message}`);
      assetsFailed.push({ nodeId: asset.nodeId, error: message });
    }
  }

  return { workspaceId, operationsReplayed, assetsUploaded, assetsFailed };
}
