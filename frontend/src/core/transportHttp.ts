import type { Hlc } from './clock';
import type { OperationEnvelope } from './crypto';
import type { Transport } from './transport';

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
    const response = await fetch(`${this.baseUrl}/api/relay/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Actor-Id': this.actorId,
      },
      credentials: 'include',
      body: JSON.stringify({ envelopes: [envelope] }),
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

  async catchUp(afterHlc: Hlc): Promise<OperationEnvelope[]> {
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

    const data = (await response.json()) as { envelopes: OperationEnvelope[] };
    return data.envelopes ?? [];
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
