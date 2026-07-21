import type { Hlc } from './clock';
import type { OperationEnvelope } from './crypto';
import type { SnapshotEnvelope, Transport } from './transport';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Avoid spreading large arrays into String.fromCharCode, which throws
  // "too many function arguments" for snapshots > ~100 KB.
  const CHUNK_SIZE = 0x8000; // 32 KB
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface HttpTransportOptions {
  workspaceId: string;
  actorId: string;
  baseUrl?: string;
}

export class HttpTransport implements Transport {
  private workspaceId: string;
  private actorId: string;
  private baseUrl: string;

  constructor({ workspaceId, actorId, baseUrl = '' }: HttpTransportOptions) {
    this.workspaceId = workspaceId;
    this.actorId = actorId;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async send(envelope: OperationEnvelope): Promise<void> {
    await this.sendBatch([envelope]);
  }

  async sendBatch(envelopes: OperationEnvelope[]): Promise<void> {
    if (envelopes.length === 0) return;

    const response = await fetch(`${this.baseUrl}/api/relay/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-Id': this.actorId,
      },
      credentials: 'include',
      body: JSON.stringify({ envelopes }),
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
  }

  async catchUp(
    afterHlc: Hlc,
    onPage?: (page: OperationEnvelope[], totalSoFar: number, hasMore: boolean) => void
  ): Promise<OperationEnvelope[]> {
    const allEnvelopes: OperationEnvelope[] = [];
    let afterId: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await fetch(`${this.baseUrl}/api/relay/catch-up`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': this.actorId,
        },
        credentials: 'include',
        body: JSON.stringify({
          workspace_id: this.workspaceId,
          hlc: afterHlc,
          after_id: afterId,
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
        next_after_id: string | null;
        has_more: boolean;
      };
      const page = data.envelopes ?? [];
      allEnvelopes.push(...page);
      hasMore = data.has_more ?? false;
      afterId = data.next_after_id ?? undefined;

      onPage?.(page, allEnvelopes.length, hasMore);
    }

    return allEnvelopes;
  }

  async getLatestSnapshot(): Promise<SnapshotEnvelope> {
    const response = await fetch(
      `${this.baseUrl}/api/relay/snapshot?workspace_id=${encodeURIComponent(this.workspaceId)}`,
      {
        method: 'GET',
        headers: {
          'X-Actor-Id': this.actorId,
        },
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
      data_base64: string;
      has_snapshot: boolean;
      restore_epoch: number;
    };

    return {
      snapshotId: data.snapshot_id,
      workspaceId: data.workspace_id,
      hlc: data.hlc,
      data: data.has_snapshot ? base64ToUint8Array(data.data_base64) : new Uint8Array(0),
      restoreEpoch: data.restore_epoch ?? 0,
      hasSnapshot: data.has_snapshot,
    };
  }

  async uploadSnapshot(snapshot: SnapshotEnvelope): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/relay/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-Id': this.actorId,
      },
      credentials: 'include',
      body: JSON.stringify({
        workspace_id: snapshot.workspaceId,
        up_to_hlc: snapshot.hlc,
        data_base64: uint8ArrayToBase64(snapshot.data),
      }),
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
