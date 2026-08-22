import type { Hlc } from './clock';
import { PROTOCOL_VERSION } from './types/operation';

export interface OperationEnvelope {
  id: string;
  /** Relay protocol version (protocol/SPEC.md). Mandatory on the wire. */
  protocolVersion: number;
  workspaceId: string;
  actorId: string;
  affectedNodeIds: string[];
  opType: string;
  hlc: Hlc;
  payload: unknown;
}

export async function encryptEnvelope(
  payload: unknown,
  _key: unknown,
  metadata: {
    id: string;
    workspaceId: string;
    actorId: string;
    affectedNodeIds: string[];
    opType: string;
    hlc: Hlc;
  }
): Promise<OperationEnvelope> {
  return {
    id: metadata.id,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: metadata.workspaceId,
    actorId: metadata.actorId,
    affectedNodeIds: metadata.affectedNodeIds,
    opType: metadata.opType,
    hlc: metadata.hlc,
    payload,
  };
}

export async function decryptEnvelope(envelope: OperationEnvelope, _key?: unknown): Promise<unknown> {
  return envelope.payload;
}
