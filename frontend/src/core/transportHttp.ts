import type { Hlc } from './clock';
import type { OperationEnvelope } from './crypto';
import type { CatchUpPage, SnapshotEnvelope, SendBatchResult, Transport } from './transport';
import {
  decryptBytes,
  decryptEnvelopePayload,
  encryptBytes,
  encryptEnvelopePayload,
  getLatestKeyVersion,
  getWorkspaceKey,
  getWorkspaceKeyForVersion,
  isEncryptedPayload,
  isWorkspaceE2eeEnabled,
} from './e2ee';
import { getServerUrl } from '@/config/serverUrl';

const REQUEST_TIMEOUT_MS = 60_000;

const LOCKED_WORKSPACE_ERROR =
  'Workspace is end-to-end encrypted and locked: enter the encryption passphrase to sync.';

/** SQLite database files start with this magic string; ciphertext never does. */
const SQLITE_MAGIC = 'SQLite format 3\0';

// Snapshot upload is best-effort and uses JSON-in-base64. Very large snapshots
// can exceed browser string allocation limits during JSON.stringify, so skip
// client uploads above this threshold. Servers can create their own snapshots
// from the operation log for large workspaces.
const MAX_SNAPSHOT_UPLOAD_BYTES = 10 * 1024 * 1024;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface HttpTransportOptions {
  workspaceId: string;
  actorId: string;
  /**
   * Server origin override (tests, custom endpoints). Defaults to the
   * configured server URL (`getServerUrl()`), falling back to same-origin
   * when none is set.
   */
  baseUrl?: string;
}

export class HttpTransport implements Transport {
  private workspaceId: string;
  private actorId: string;
  private baseUrl: string;

  constructor({ workspaceId, actorId, baseUrl }: HttpTransportOptions) {
    this.workspaceId = workspaceId;
    this.actorId = actorId;
    this.baseUrl = (baseUrl ?? getServerUrl() ?? '').replace(/\/$/, '');
  }

  /**
   * Resolve the workspace key for an E2EE-enabled workspace, or undefined
   * for a plaintext workspace. A locked workspace (enabled, no key in
   * memory) fails loud rather than silently downgrading to plaintext.
   */
  private requireKey(): CryptoKey | undefined {
    if (!isWorkspaceE2eeEnabled(this.workspaceId)) return undefined;
    const key = getWorkspaceKey(this.workspaceId);
    if (!key) throw new Error(LOCKED_WORKSPACE_ERROR);
    return key;
  }

  /** Current key version (1 when only the initial key exists). */
  private currentKeyVersion(): number {
    return getLatestKeyVersion(this.workspaceId) ?? 1;
  }

  /** Key lookup by version for decrypting history (rotation-aware). */
  private keyForVersion(version: number): CryptoKey | undefined {
    return getWorkspaceKeyForVersion(this.workspaceId, version);
  }

  async send(envelope: OperationEnvelope): Promise<SendBatchResult> {
    return this.sendBatch([envelope]);
  }

  async sendBatch(envelopes: OperationEnvelope[]): Promise<SendBatchResult> {
    if (envelopes.length === 0) return { savedIds: [] };

    const key = this.requireKey();
    const keyVersion = this.currentKeyVersion();
    const outgoing = key
      ? await Promise.all(envelopes.map((envelope) => encryptEnvelopePayload(key, envelope, keyVersion)))
      : envelopes;

    const response = await fetchWithTimeout(`${this.baseUrl}/api/relay/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ envelopes: outgoing }),
    });

    if (response.status === 403) {
      throw new Error(
        `Relay write denied for actor ${this.actorId} in workspace ${this.workspaceId}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Relay batch failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      saved_count: number;
      saved_ids: string[];
    };
    return { savedIds: data.saved_ids };
  }

  async catchUp(afterSeq: number): Promise<CatchUpPage> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/relay/catch-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        workspace_id: this.workspaceId,
        after_seq: afterSeq,
        limit: 10000,
      }),
    });

    if (response.status === 403) {
      throw new Error(
        `Relay read denied for actor ${this.actorId} in workspace ${this.workspaceId}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Relay catch-up failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      envelopes: OperationEnvelope[];
      next_after_seq: number | null;
      has_more: boolean;
      total_remaining?: number;
    };
    let envelopes = data.envelopes ?? [];
    if (envelopes.some((envelope) => isEncryptedPayload(envelope.payload))) {
      envelopes = await Promise.all(
        envelopes.map(async (envelope) => {
          if (!isEncryptedPayload(envelope.payload)) return envelope;
          const key = this.keyForVersion(envelope.payload.$e.kv ?? 1);
          if (!key) throw new Error(LOCKED_WORKSPACE_ERROR);
          return decryptEnvelopePayload(key, envelope);
        })
      );
    }
    return {
      envelopes,
      nextAfterSeq: data.next_after_seq ?? null,
      hasMore: data.has_more ?? false,
      // Older servers omit the field; fall back to the page size so progress
      // degrades to per-page reporting instead of NaN.
      totalRemaining: data.total_remaining ?? envelopes.length,
    };
  }

  async getLatestSnapshot(options?: { includeData?: boolean }): Promise<SnapshotEnvelope> {
    const includeData = options?.includeData !== false;
    // Metadata first (cheap probe); the blob comes from the binary endpoint
    // below — no base64-in-JSON.
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/relay/snapshot?workspace_id=${encodeURIComponent(this.workspaceId)}`,
      {
        method: 'GET',
        credentials: 'include',
      }
    );

    if (response.status === 403) {
      throw new Error(
        `Snapshot read denied for actor ${this.actorId} in workspace ${this.workspaceId}`
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Snapshot fetch failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      snapshot_id: string;
      workspace_id: string;
      hlc: Hlc;
      has_snapshot: boolean;
      restore_epoch: number;
      up_to_seq: number | null;
    };

    return {
      snapshotId: data.snapshot_id,
      workspaceId: data.workspace_id,
      hlc: data.hlc,
      data: includeData && data.has_snapshot ? await this.fetchSnapshotData() : new Uint8Array(0),
      restoreEpoch: data.restore_epoch ?? 0,
      hasSnapshot: data.has_snapshot,
      // Null for snapshots recorded before the seq cursor existed; the sync
      // engine resumes catch-up from seq 0 in that case.
      upToSeq: data.up_to_seq ?? null,
    };
  }

  /** Fetch the snapshot blob from the binary endpoint (raw bytes). */
  private async fetchSnapshotData(): Promise<Uint8Array> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/api/relay/snapshot/data?workspace_id=${encodeURIComponent(this.workspaceId)}`,
      {
        method: 'GET',
        credentials: 'include',
      }
    );
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Snapshot data fetch failed (${response.status}): ${text}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return this.decodeSnapshot(bytes);
  }

  /** Decode a downloaded snapshot blob, decrypting when E2EE is enabled. */
  private async decodeSnapshot(bytes: Uint8Array): Promise<Uint8Array> {
    if (!isWorkspaceE2eeEnabled(this.workspaceId) || bytes.length === 0) return bytes;
    // Snapshots written before E2EE was enabled are plaintext; pass them
    // through (ciphertext never starts with the SQLite magic string).
    const header = new TextDecoder().decode(bytes.subarray(0, SQLITE_MAGIC.length));
    if (header === SQLITE_MAGIC) return bytes;
    if (!getWorkspaceKey(this.workspaceId)) throw new Error(LOCKED_WORKSPACE_ERROR);
    return decryptBytes(bytes, (kv) => this.keyForVersion(kv));
  }

  async uploadSnapshot(snapshot: SnapshotEnvelope): Promise<void> {
    let data = snapshot.data;
    if (isWorkspaceE2eeEnabled(this.workspaceId)) {
      const key = getWorkspaceKey(this.workspaceId);
      if (!key) {
        // Locked: snapshot upload is best-effort; skip rather than fail sync.
        return;
      }
      data = await encryptBytes(key, data, this.currentKeyVersion());
    }
    if (data.length > MAX_SNAPSHOT_UPLOAD_BYTES) {
      // Avoid "allocation size overflow" and similar errors when the derived
      // database is too large to serialize into a JSON body in this browser.
      return;
    }

    // Raw binary body — no base64-in-JSON (+33% size, full-buffer memory).
    const params = new URLSearchParams({
      workspace_id: this.workspaceId,
      physical: String(snapshot.hlc.physical),
      logical: String(snapshot.hlc.logical),
    });
    const response = await fetchWithTimeout(`${this.baseUrl}/api/relay/snapshot/data?${params}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      credentials: 'include',
      body: data as unknown as BodyInit,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`Snapshot upload failed (${response.status}): ${text}`);
    }
  }

  subscribe(_callback: (envelope: OperationEnvelope) => void): void {
    // HTTP transport is poll-only; real-time push is handled separately.
  }
}

export function createHttpTransport(
  workspaceId: string,
  actorId: string,
  baseUrl?: string
): HttpTransport {
  return new HttpTransport({ workspaceId, actorId, baseUrl });
}
